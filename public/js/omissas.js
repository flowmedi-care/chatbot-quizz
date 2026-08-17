(function () {
  "use strict";

  const API = {
    session: (t) => `/api/omissas-session?t=${encodeURIComponent(t)}`,
    answer: "/api/omissas-answer",
    assist: "/api/omissas-assist",
    via: (t, shortId) =>
      `/api/omissas-via?t=${encodeURIComponent(t)}&shortId=${encodeURIComponent(shortId)}`,
    results: (t) => `/api/omissas-results?t=${encodeURIComponent(t)}`,
    userCategories: "/api/user-categories",
    answerCategories: "/api/answer-categories"
  };

  const els = {
    error: document.getElementById("omissas-error"),
    loading: document.getElementById("omissas-loading"),
    quiz: document.getElementById("omissas-quiz"),
    results: document.getElementById("omissas-results"),
    greeting: document.getElementById("omissas-greeting"),
    title: document.getElementById("q-title"),
    meta: document.getElementById("q-meta"),
    progress: document.getElementById("q-progress"),
    statement: document.getElementById("q-statement"),
    comment: document.getElementById("q-comment"),
    assist: document.getElementById("q-assist"),
    btnAssist: document.getElementById("btn-assist"),
    choices: document.getElementById("q-choices"),
    choicesHint: document.getElementById("q-choices-hint"),
    btnResolve: document.getElementById("btn-resolve"),
    result: document.getElementById("q-result"),
    btnNextQ: document.getElementById("btn-next-q"),
    status: document.getElementById("q-status"),
    timer: document.getElementById("q-timer"),
    timerHint: document.getElementById("q-timer-hint"),
    viaPanel: document.getElementById("via-panel"),
    viaNotes: document.getElementById("via-notes"),
    viaEmpty: document.getElementById("via-empty"),
    viaDraft: document.getElementById("via-draft"),
    viaSend: document.getElementById("via-send"),
    viaStatus: document.getElementById("via-status"),
    summary: document.getElementById("results-summary"),
    list: document.getElementById("results-list")
  };

  /** @type {string} */
  let token = "";
  /** @type {any[]} */
  let pending = [];
  let index = 0;
  let submitting = false;
  let assistQty = 0;
  let userName = "";
  let currentConfidence = "seguro";
  let userJid = "";
  let assistMode = false;
  let assistBusy = false;
  let selectedLetter = null;
  let eliminated = new Set();
  /** @type {{ id: number, name: string }[]} */
  let userCategories = [];
  /** @type {Set<number>} */
  let selectedCategoryIds = new Set();
  /** @type {Map<string, number[]>} */
  let draftCatsByShortId = new Map();
  let resultsTimer = 0;

  const quizUi = window.PapaQuizUi;

  const timer = quizUi.createTimer({
    timer: els.timer,
    hint: els.timerHint,
    pauseBtn: document.getElementById("q-timer-pause"),
    resetBtn: document.getElementById("q-timer-reset")
  });
  const via = quizUi.createViaPanel(
    {
      panel: els.viaPanel,
      notes: els.viaNotes,
      empty: els.viaEmpty,
      draft: els.viaDraft,
      send: els.viaSend,
      status: els.viaStatus
    },
    {
      fetchJson,
      token: () => token,
      currentShortId: () => (pending[index] && pending[index].shortId) || "",
      viaGetUrl: (shortId) => API.via(token, shortId)
    }
  );

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function firstName(name) {
    const t = String(name || "").trim();
    if (!t || t === "Participante") return "";
    return t.split(/\s+/)[0];
  }

  function catKey(q) {
    return String(q && q.shortId ? q.shortId : "").toUpperCase();
  }

  function sessionAllAnswered() {
    return pending.length > 0 && pending.every((q) => q.alreadyAnswered);
  }

  function quizIsOpen() {
    return Boolean(els.quiz && !els.quiz.classList.contains("hidden"));
  }

  function cancelScheduledResults() {
    if (resultsTimer) {
      window.clearTimeout(resultsTimer);
      resultsTimer = 0;
    }
  }

  function scheduleShowResultsIfComplete() {
    cancelScheduledResults();
    if (!sessionAllAnswered()) return;
    resultsTimer = window.setTimeout(() => {
      resultsTimer = 0;
      void showResults();
    }, 1100);
  }

  function saveDraftCatsForCurrent() {
    const q = pending[index];
    if (!q) return;
    const ids = Array.from(selectedCategoryIds);
    draftCatsByShortId.set(catKey(q), ids);
    q.categoryIds = ids;
  }

  function loadDraftCatsForCurrent() {
    const q = pending[index];
    selectedCategoryIds = new Set();
    if (!q) return;
    const draft = draftCatsByShortId.get(catKey(q));
    if (draft) {
      selectedCategoryIds = new Set(draft.map(Number));
      return;
    }
    if (Array.isArray(q.categoryIds) && q.categoryIds.length) {
      selectedCategoryIds = new Set(q.categoryIds.map(Number));
    }
  }

  async function persistCatsIfAnswered() {
    const q = pending[index];
    if (!q || !q.alreadyAnswered || !userJid) return;
    const ids = Array.from(selectedCategoryIds);
    q.categoryIds = ids;
    draftCatsByShortId.set(catKey(q), ids);
    try {
      await fetchJson(API.answerCategories, {
        method: "POST",
        body: JSON.stringify({ userJid, shortId: q.shortId, categoryIds: ids })
      });
    } catch (e) {
      if (els.status) {
        els.status.classList.remove("hidden");
        els.status.textContent = e.message || "Erro ao salvar categorias.";
      }
    }
  }

  function formatAssistDetail(q) {
    if (!q || !q.assistUsed || !q.assistReveal) return null;
    const r = q.assistReveal;
    const L = (r.letter || r.removed || "?").toString().toUpperCase();
    if (r.isCorrect === true) return `Utilizado item Verificar alternativa · ${L} é verdadeira`;
    return `Utilizado item Verificar alternativa · ${L} é falsa`;
  }

  function updateQuestionDetails() {
    const el = document.getElementById("q-details-text");
    if (!el) return;
    const parts = [];
    const selected = userCategories.filter((c) => selectedCategoryIds.has(Number(c.id)));
    if (selected.length) {
      parts.push(`Categorias: <strong>${esc(selected.map((c) => c.name).join(", "))}</strong>`);
    } else {
      parts.push("Questão sem categoria");
    }
    const q = pending[index];
    const assistLine = formatAssistDetail(q);
    if (assistLine) parts.push(esc(assistLine));
    el.innerHTML = parts.join(" · ");
  }

  function setCatsPanelOpen(open) {
    const panel = document.getElementById("q-cats-panel");
    const toggle = document.getElementById("q-cats-toggle");
    if (!panel || !toggle) return;
    panel.classList.toggle("hidden", !open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function syncCatsToggleLabel() {
    const countEl = document.getElementById("q-cats-toggle-count");
    if (!countEl) return;
    const n = selectedCategoryIds.size;
    countEl.textContent = n > 0 ? String(n) : "";
  }

  function renderQuizCategoryToggles() {
    const wrap = document.getElementById("q-categories-toggles");
    if (!wrap) return;
    if (!userCategories.length) {
      wrap.innerHTML =
        '<p class="atv-muted" style="margin:0 0 0.35rem;font-size:0.78rem;font-weight:500">Nenhuma ainda.</p>';
    } else {
      wrap.innerHTML = userCategories
        .map((c) => {
          const id = Number(c.id);
          const on = selectedCategoryIds.has(id);
          return `<label class="atv-cat-check">
            <input type="checkbox" data-id="${esc(String(id))}" ${on ? "checked" : ""} />
            <span>${esc(c.name)}</span>
          </label>`;
        })
        .join("");
      wrap.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.addEventListener("change", () => {
          const id = Number(input.dataset.id);
          if (input.checked) selectedCategoryIds.add(id);
          else selectedCategoryIds.delete(id);
          saveDraftCatsForCurrent();
          if (pending[index] && pending[index].alreadyAnswered) {
            void persistCatsIfAnswered();
          }
          syncCatsToggleLabel();
          updateQuestionDetails();
        });
      });
    }
    syncCatsToggleLabel();
    updateQuestionDetails();
  }

  async function loadUserCategories() {
    if (!userJid) {
      userCategories = [];
      renderQuizCategoryToggles();
      return;
    }
    try {
      const data = await fetchJson(`${API.userCategories}?userJid=${encodeURIComponent(userJid)}`);
      userCategories = data.categories || [];
      renderQuizCategoryToggles();
    } catch {
      userCategories = [];
      renderQuizCategoryToggles();
    }
  }

  async function createUserCategory(name) {
    const trimmed = String(name || "").trim();
    if (!userJid || !trimmed) return null;
    try {
      const data = await fetchJson(API.userCategories, {
        method: "POST",
        body: JSON.stringify({ userJid, name: trimmed })
      });
      const cat = data.category;
      if (cat && !userCategories.some((c) => Number(c.id) === Number(cat.id))) {
        userCategories.push(cat);
        userCategories.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
      }
      return cat;
    } catch (e) {
      if (els.status) {
        els.status.classList.remove("hidden");
        els.status.textContent = e.message || "Erro ao criar categoria.";
      }
      return null;
    }
  }

  function navigateQuiz(delta) {
    if (submitting || !pending.length) return;
    cancelScheduledResults();
    saveDraftCatsForCurrent();
    setCatsPanelOpen(false);
    const next = index + delta;
    if (delta > 0 && next >= pending.length && sessionAllAnswered()) {
      void showResults();
      return;
    }
    if (next < 0 || next >= pending.length) return;
    index = next;
    renderQuestion();
  }

  function syncQuizNavButtons() {
    const prevBtns = [document.getElementById("q-prev"), document.getElementById("q-prev-bottom")].filter(
      Boolean
    );
    const nextBtns = [document.getElementById("q-next"), document.getElementById("q-next-bottom")].filter(
      Boolean
    );
    const allDone = sessionAllAnswered();
    const canGoResults = allDone && index >= pending.length - 1;
    const nextTitle = canGoResults ? "Ver resultado da seção (→)" : "Próxima (→)";
    prevBtns.forEach((prev) => {
      prev.disabled = submitting || index <= 0;
      prev.title = "Anterior (←)";
    });
    nextBtns.forEach((next) => {
      next.disabled = submitting || (index >= pending.length - 1 && !canGoResults);
      if (next.id === "q-next-bottom") {
        next.textContent = canGoResults ? "Ver resultado ›" : "Próxima ›";
      } else {
        next.textContent = canGoResults ? "Resultado ›" : "Próx. ›";
      }
      next.title = nextTitle;
    });
  }

  function paintCurrentChoices() {
    const q = pending[index];
    if (els.choicesHint) {
      els.choicesHint.classList.toggle("hidden", Boolean(q && q.alreadyAnswered));
    }
    if (els.btnResolve) {
      els.btnResolve.disabled = !selectedLetter || submitting || Boolean(q && q.alreadyAnswered);
      els.btnResolve.textContent = submitting ? "Resolvendo..." : "Resolver questão";
    }
    quizUi.paintChoices(els.choices, {
      selected: selectedLetter,
      eliminated,
      locked: Boolean(q && q.alreadyAnswered) || submitting,
      answerKey: "",
      yourLetter: (q && (q.yourLetter || q.yourAnswer)) || selectedLetter,
      showResult: false
    });
    quizUi.fillResult(els.result, null);
    if (els.btnNextQ) {
      els.btnNextQ.classList.toggle("hidden", !sessionAllAnswered());
    }
  }

  function bindCurrentChoices() {
    quizUi.bindChoices(els.choices, {
      assistMode: () => assistMode,
      isLocked: () => submitting || Boolean(pending[index] && pending[index].alreadyAnswered),
      onAssist: (letter) => useAssistOnLetter(letter),
      onSelect: (letter) => {
        const cur = pending[index];
        if (!cur || cur.alreadyAnswered || submitting) return;
        selectedLetter = letter;
        paintCurrentChoices();
      },
      onToggleEliminated: (letter) => {
        const cur = pending[index];
        if (!cur || cur.alreadyAnswered || submitting) return;
        if (eliminated.has(letter)) eliminated.delete(letter);
        else {
          eliminated.add(letter);
          if (selectedLetter === letter) selectedLetter = null;
        }
        paintCurrentChoices();
      }
    });
  }

  document.addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest && ev.target.closest(".btn-conf");
    if (!btn) return;
    const q = pending[index];
    if (q && q.alreadyAnswered) return;
    const key = btn.dataset.conf;
    currentConfidence = currentConfidence === key ? "seguro" : key;
    document.querySelectorAll(".btn-conf").forEach((b) => {
      const on = b.dataset.conf === currentConfidence;
      b.style.background = on ? "#1e293b" : "#fff";
      b.style.color = on ? "#fff" : "#334155";
    });
    const hint = document.getElementById("q-conf-hint");
    if (hint) hint.textContent = currentConfidence === "seguro" ? "(Seguro — padrão)" : "";
  });

  function showError(msg) {
    els.loading.classList.add("hidden");
    els.quiz.classList.add("hidden");
    els.results.classList.add("hidden");
    els.error.classList.remove("hidden");
    els.error.textContent = msg;
  }

  async function fetchJson(url, opts) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(opts && opts.headers) },
      ...opts
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText || "Erro");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function tokenFromUrl() {
    const u = new URL(window.location.href);
    return (u.searchParams.get("t") || u.searchParams.get("token") || "").trim();
  }

  function applyAssistReveal(q, reveal) {
    if (!reveal) return;
    q.assistUsed = true;
    q.assistReveal = reveal;
    const letter = String(reveal.letter || reveal.removed || "").toLowerCase();
    els.choices.querySelectorAll(".btn-choice").forEach((btn) => {
      if (btn.dataset.letter !== letter) return;
      if (reveal.isCorrect === true) {
        btn.classList.add("assist-true");
        btn.insertAdjacentHTML("beforeend", '<span class="assist-tag">Verdadeira</span>');
      } else {
        btn.classList.add("assist-false");
        btn.disabled = true;
        btn.insertAdjacentHTML("beforeend", '<span class="assist-tag">Falsa</span>');
      }
    });
  }

  function syncAssistUi(q) {
    assistMode = false;
    if (!els.assist || !els.btnAssist) return;
    els.assist.classList.remove("hidden");
    if (!q || q.assistUsed || q.alreadyAnswered) {
      els.btnAssist.disabled = true;
      els.btnAssist.classList.remove("active");
      els.btnAssist.textContent = q && q.alreadyAnswered ? "Respondida" : "Item usado";
      updateQuestionDetails();
      return;
    }
    els.btnAssist.disabled = assistQty < 1 || submitting;
    els.btnAssist.classList.remove("active");
    els.btnAssist.textContent =
      assistQty > 0 ? `Verificar alt. (${assistQty})` : "Sem item loja";
    updateQuestionDetails();
  }

  function renderQuestion() {
    const q = pending[index];
    if (!q) {
      void showResults();
      return;
    }

    els.loading.classList.add("hidden");
    els.results.classList.add("hidden");
    els.quiz.classList.remove("hidden");
    els.status.classList.add("hidden");
    els.comment.value = q.alreadyAnswered ? q.yourComment || "" : "";
    els.comment.readOnly = Boolean(q.alreadyAnswered);
    assistMode = false;
    currentConfidence = q.yourConfidence || "seguro";
    setCatsPanelOpen(false);
    loadDraftCatsForCurrent();
    selectedLetter = q.alreadyAnswered
      ? String(q.yourLetter || q.yourAnswer || "").toLowerCase()
      : null;
    eliminated = new Set();
    timer.start(q.alreadyAnswered && q.durationMs ? q.durationMs : null);
    const sid = q.shortId;
    void via.load(sid).then((data) => {
      if (!pending[index] || pending[index].shortId !== sid) return;
      if (q.alreadyAnswered && data && data.durationMs) timer.start(data.durationMs);
    });
    document.querySelectorAll(".btn-conf").forEach((btn) => {
      const on = btn.dataset.conf === currentConfidence;
      btn.style.background = on ? "#1e293b" : "#fff";
      btn.style.color = on ? "#fff" : "#334155";
      btn.style.border = "1px solid #cbd5e1";
      btn.style.borderRadius = "6px";
      btn.style.padding = "4px 10px";
      btn.style.fontSize = "12px";
    });
    const hint = document.getElementById("q-conf-hint");
    if (hint) hint.textContent = currentConfidence === "seguro" ? "(Seguro — padrão)" : "";

    const hello = firstName(userName);
    els.title.textContent = `Questão #${q.shortId}`;
    const metaParts = [];
    if (hello) metaParts.push(`Olá, ${hello}`);
    if (q.creatorName) metaParts.push(`Por ${q.creatorName}`);
    els.meta.textContent = metaParts.join(" · ");
    els.progress.textContent = q.alreadyAnswered
      ? `${index + 1} / ${pending.length} · respondida`
      : `${index + 1} / ${pending.length}`;

    els.statement.innerHTML = quizUi.statementHtml(q) || "<p>(Sem enunciado)</p>";

    renderQuizCategoryToggles();
    syncQuizNavButtons();

    els.choices.classList.remove("assist-picking");
    quizUi.renderChoices(els.choices, q);
    bindCurrentChoices();
    if (q.assistReveal) applyAssistReveal(q, q.assistReveal);
    paintCurrentChoices();
    syncAssistUi(q);
    updateQuestionDetails();
  }

  async function useAssistOnLetter(letter) {
    if (assistBusy || submitting) return;
    const q = pending[index];
    if (!q || !letter || q.assistUsed) return;

    assistBusy = true;
    els.status.classList.remove("hidden");
    els.status.textContent = "Verificando alternativa…";

    try {
      const data = await fetchJson(API.assist, {
        method: "POST",
        body: JSON.stringify({ t: token, shortId: q.shortId, letter })
      });
      assistQty = data.assistEliminateQty != null ? data.assistEliminateQty : Math.max(0, assistQty - 1);
      applyAssistReveal(q, data.assistReveal || { letter: letter.toUpperCase(), isCorrect: data.isCorrect });
      els.status.classList.add("hidden");
      syncAssistUi(q);
      updateQuestionDetails();
    } catch (e) {
      els.status.textContent = e.message || "Erro ao usar assistência.";
      assistMode = false;
      syncAssistUi(q);
    } finally {
      assistBusy = false;
    }
  }

  async function onChoose(letter) {
    if (submitting) return;
    const q = pending[index];
    if (!q || !letter || q.alreadyAnswered) return;

    submitting = true;
    assistMode = false;
    syncQuizNavButtons();
    paintCurrentChoices();
    if (els.btnAssist) els.btnAssist.disabled = true;
    els.status.classList.remove("hidden");
    els.status.textContent = "Salvando…";

    try {
      const data = await fetchJson(API.answer, {
        method: "POST",
        body: JSON.stringify({
          t: token,
          shortId: q.shortId,
          letter,
          comment: els.comment.value || "",
          categoryIds: Array.from(selectedCategoryIds),
          confidenceLevel: currentConfidence,
          durationMs: timer.elapsed()
        })
      });

      q.alreadyAnswered = true;
      q.yourLetter = data.yourAnswer || letter;
      q.yourAnswer = data.yourAnswer || letter;
      q.yourComment = els.comment.value || "";
      q.answerKey = data.answerKey;
      q.correct = data.correct;
      q.categoryIds = Array.from(selectedCategoryIds);
      draftCatsByShortId.set(catKey(q), q.categoryIds);
      selectedLetter = String(q.yourLetter || letter).toLowerCase();
      q.durationMs = data.durationMs != null ? data.durationMs : timer.elapsed();
      timer.start(q.durationMs);
      els.comment.readOnly = true;
      els.status.classList.add("hidden");
      updateQuestionDetails();
      submitting = false;
      syncQuizNavButtons();
      paintCurrentChoices();
      syncAssistUi(q);
      if (sessionAllAnswered()) scheduleShowResultsIfComplete();
    } catch (e) {
      submitting = false;
      syncQuizNavButtons();
      els.status.textContent = e.message || "Erro ao salvar.";
      paintCurrentChoices();
      syncAssistUi(q);
    }
  }

  async function showResults() {
    cancelScheduledResults();
    timer.stop();
    els.quiz.classList.add("hidden");
    els.loading.classList.remove("hidden");
    els.loading.textContent = "Montando resultado…";

    try {
      const data = await fetchJson(API.results(token));
      els.loading.classList.add("hidden");
      els.results.classList.remove("hidden");

      const hello = firstName(data.userName || userName);
      els.summary.innerHTML = `
        ${hello ? `<p class="omissas-hello">Boa, ${esc(hello)}!</p>` : ""}
        <div class="omissas-stat ok"><span>${data.correctCount}</span> acertos</div>
        <div class="omissas-stat bad"><span>${data.wrongCount}</span> erros</div>
        <div class="omissas-stat"><span>${data.total}</span> no total</div>
      `;

      els.list.innerHTML = (data.items || [])
        .map((item) => {
          if (item.missing) {
            return `<article class="omissas-result-item"><h3>#${esc(item.shortId)}</h3><p>Questão indisponível.</p></article>`;
          }
          const badge =
            item.correct === true
              ? '<span class="omissas-badge ok">Acerto</span>'
              : item.correct === false
                ? '<span class="omissas-badge bad">Erro</span>'
                : '<span class="omissas-badge">—</span>';
          let media = "";
          if (item.statementMediaUrl && item.statementMediaMimeType) {
            if (String(item.statementMediaMimeType).startsWith("image/")) {
              media = `<img src="${esc(item.statementMediaUrl)}" alt="" crossorigin="anonymous" />`;
            }
          }
          let explMedia = "";
          if (item.explanationMediaUrl && item.explanationMediaMimeType) {
            if (String(item.explanationMediaMimeType).startsWith("image/")) {
              explMedia = `<img src="${esc(item.explanationMediaUrl)}" alt="Comentário do autor" crossorigin="anonymous" />`;
            }
          }
          return `
            <article class="omissas-result-item" data-short-id="${esc(item.shortId)}">
              <div class="omissas-result-head">
                <h3>Questão #${esc(item.shortId)}</h3>
                ${badge}
              </div>
              <div class="statement-box">
                <div class="statement-text">${esc(item.statementText || "")}</div>
                ${media}
              </div>
              <p><strong>Sua resposta:</strong> ${(item.yourLetter || "—").toUpperCase()}
                · <strong>Gabarito:</strong> ${esc(item.answerKey || "—")}</p>
              ${
                item.yourComment
                  ? `<p class="omissas-your-comment"><strong>Seu comentário:</strong> ${esc(item.yourComment)}</p>`
                  : ""
              }
              <div class="reveal-box">
                <h4>Comentário do autor</h4>
                <div class="comment">${esc(item.explanationText || "Sem comentário do autor.")}</div>
                ${explMedia}
              </div>
              <div class="omissas-discuss">
                <label class="omissas-discuss-label">Discussão antecipada
                  <textarea class="omissas-discuss-input" rows="2" maxlength="4000" placeholder="Comente agora — vai no feed quando o gabarito sair no grupo"></textarea>
                </label>
                <button type="button" class="btn-secondary btn-sm omissas-discuss-btn" data-discuss="${esc(item.shortId)}">Discutir</button>
                <p class="omissas-discuss-status" hidden></p>
              </div>
            </article>
          `;
        })
        .join("");

      els.list.querySelectorAll("[data-discuss]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const shortId = btn.getAttribute("data-discuss");
          const card = btn.closest(".omissas-result-item");
          const ta = card?.querySelector(".omissas-discuss-input");
          const st = card?.querySelector(".omissas-discuss-status");
          void postEarlyDiscussion(shortId, ta, st, btn);
        });
      });
    } catch (e) {
      if (e.status === 409) {
        showError("Ainda há questões pendentes. Recarregue o link ou continue respondendo.");
        return;
      }
      showError(e.message || "Erro ao carregar resultado.");
    }
  }

  async function postEarlyDiscussion(shortId, ta, st, btn) {
    const body = String(ta?.value || "").trim();
    if (!body) {
      if (st) {
        st.hidden = false;
        st.textContent = "Escreva um comentário.";
      }
      return;
    }
    if (!userJid) {
      if (st) {
        st.hidden = false;
        st.textContent = "Identidade da sessão ausente.";
      }
      return;
    }
    btn.disabled = true;
    if (st) {
      st.hidden = false;
      st.textContent = "Salvando…";
    }
    try {
      await fetchJson("/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortId,
          userJid,
          userName,
          body
        })
      });
      if (ta) ta.value = "";
      if (st) {
        st.textContent =
          "Discussão salva. Quando o gabarito for ao grupo, o bot manda enunciado + resultado + discussão.";
      }
    } catch (e) {
      if (st) st.textContent = e.message || "Erro ao salvar discussão";
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
  }

  async function init() {
    token = tokenFromUrl();
    if (!token) {
      showError("Link incompleto. No WhatsApp, envie /omissas e use o link pessoal da mensagem.");
      return;
    }

    if (els.btnAssist) {
      els.btnAssist.addEventListener("click", () => {
        const q = pending[index];
        if (!q || q.alreadyAnswered || q.assistUsed || assistQty < 1 || submitting || assistBusy) return;
        assistMode = !assistMode;
        els.btnAssist.classList.toggle("active", assistMode);
        els.choices.classList.toggle("assist-picking", assistMode);
      });
    }
    if (els.btnResolve) {
      els.btnResolve.addEventListener("click", () => {
        if (!selectedLetter) return;
        void onChoose(selectedLetter);
      });
    }
    if (els.btnNextQ) {
      els.btnNextQ.addEventListener("click", () => {
        if (submitting) return;
        void showResults();
      });
    }
    ["q-prev", "q-prev-bottom"].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener("click", () => navigateQuiz(-1));
    });
    ["q-next", "q-next-bottom"].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener("click", () => navigateQuiz(1));
    });
    document.addEventListener("keydown", (ev) => {
      if (!quizIsOpen() || submitting) return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (quizUi.isTypingTarget(ev.target)) return;
      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        navigateQuiz(-1);
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        navigateQuiz(1);
      }
    });
    quizUi.bindSwipeNav(els.quiz, {
      isEnabled: () => quizIsOpen() && !submitting,
      onPrev: () => navigateQuiz(-1),
      onNext: () => navigateQuiz(1)
    });
    const catsToggle = document.getElementById("q-cats-toggle");
    if (catsToggle) {
      catsToggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const panel = document.getElementById("q-cats-panel");
        const open = panel && !panel.classList.contains("hidden");
        setCatsPanelOpen(!open);
      });
    }
    const newCat = document.getElementById("q-new-cat");
    if (newCat) {
      newCat.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const name = window.prompt("Nome da nova categoria:");
        if (!name) return;
        const cat = await createUserCategory(name);
        if (cat) {
          selectedCategoryIds.add(Number(cat.id));
          saveDraftCatsForCurrent();
          if (pending[index] && pending[index].alreadyAnswered) {
            void persistCatsIfAnswered();
          }
          renderQuizCategoryToggles();
          setCatsPanelOpen(true);
        }
      });
    }
    document.addEventListener("click", (ev) => {
      const wrap = document.querySelector(".atv-toolbar-cats-wrap");
      if (!wrap || wrap.contains(ev.target)) return;
      setCatsPanelOpen(false);
    });

    try {
      const data = await fetchJson(API.session(token));
      assistQty = data.assistEliminateQty || 0;
      userName = data.userName || "";
      userJid = data.userJid || data.user_jid || "";
      if (els.greeting && userName && userName !== "Participante") {
        els.greeting.textContent = `${firstName(userName)}, suas omissas · sessão pessoal`;
      }
      pending = (data.questions || []).filter((q) => !q.missing);
      draftCatsByShortId = new Map();
      for (const q of pending) {
        if (Array.isArray(q.categoryIds) && q.categoryIds.length) {
          draftCatsByShortId.set(catKey(q), q.categoryIds.map(Number));
        }
      }
      await loadUserCategories();

      if (!pending.length) {
        showError("Nenhuma questão pendente nesta sessão.");
        return;
      }

      if (pending.every((q) => q.alreadyAnswered) || data.completedAt) {
        await showResults();
        return;
      }

      const firstOpen = pending.findIndex((q) => !q.alreadyAnswered);
      index = firstOpen >= 0 ? firstOpen : 0;
      renderQuestion();
    } catch (e) {
      showError(e.message || "Não foi possível abrir a sessão.");
    }
  }

  void init();
})();
