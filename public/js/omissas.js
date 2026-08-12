(function () {
  "use strict";

  const API = {
    session: (t) => `/api/omissas-session?t=${encodeURIComponent(t)}`,
    answer: "/api/omissas-answer",
    assist: "/api/omissas-assist",
    results: (t) => `/api/omissas-results?t=${encodeURIComponent(t)}`
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
    assistHint: document.getElementById("assist-hint"),
    choices: document.getElementById("q-choices"),
    status: document.getElementById("q-status"),
    summary: document.getElementById("results-summary"),
    list: document.getElementById("results-list")
  };

  /** @type {string} */
  let token = "";
  /** @type {any[]} */
  let pending = [];
  let index = 0;
  let totalInSession = 0;
  let answeredAtStart = 0;
  let submitting = false;
  let assistQty = 0;
  let userName = "";
  let userJid = "";
  let assistMode = false;
  let assistBusy = false;

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

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

  function firstName(name) {
    const t = String(name || "").trim();
    if (!t || t === "Participante") return "";
    return t.split(/\s+/)[0];
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
    if (!els.assist) return;
    if (!q || q.assistUsed) {
      els.assist.classList.remove("hidden");
      els.btnAssist.disabled = true;
      els.btnAssist.classList.remove("active");
      els.btnAssist.textContent = "Assistência usada nesta questão";
      const r = q && q.assistReveal;
      if (r) {
        const L = (r.letter || r.removed || "?").toString().toUpperCase();
        els.assistHint.textContent =
          r.isCorrect === true
            ? `${L} é verdadeira (gabarito).`
            : `${L} é falsa — descartada.`;
      } else {
        els.assistHint.textContent = "";
      }
      return;
    }

    els.assist.classList.remove("hidden");
    els.btnAssist.disabled = assistQty < 1 || submitting;
    els.btnAssist.classList.remove("active");
    els.btnAssist.textContent =
      assistQty > 0
        ? `Verificar alternativa (${assistQty} no inventário)`
        : "Sem assistência no inventário";
    els.assistHint.textContent =
      assistQty > 0
        ? "Gasta 1 consumível · escolha uma letra · máx. 1 por questão"
        : "Compre “Eliminar uma alternativa” no Hub /loja (50 Créditos)";
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
    els.comment.value = "";
    assistMode = false;

    const doneSoFar = answeredAtStart + index;
    const total = totalInSession;
    const hello = firstName(userName);
    els.title.textContent = `Questão #${q.shortId}`;
    const metaParts = [];
    if (hello) metaParts.push(`Olá, ${hello}`);
    if (q.creatorName) metaParts.push(`Por ${q.creatorName}`);
    els.meta.textContent = metaParts.join(" · ");
    els.progress.textContent = `${doneSoFar + 1} / ${total}`;

    let html = "";
    if (q.statementText) {
      html += `<div class="statement-text">${esc(q.statementText)}</div>`;
    }
    if (q.statementMediaUrl && q.statementMediaMimeType) {
      if (String(q.statementMediaMimeType).startsWith("image/")) {
        html += `<img src="${esc(q.statementMediaUrl)}" alt="Enunciado" crossorigin="anonymous" />`;
      } else {
        html += `<p><a href="${esc(q.statementMediaUrl)}" target="_blank" rel="noopener">Abrir documento</a></p>`;
      }
    }
    els.statement.innerHTML = html || "<p>(Sem enunciado)</p>";

    const isTf = q.questionType === "true_false";
    els.choices.classList.toggle("tf", isTf);
    if (isTf) {
      els.choices.innerHTML = `
        <button type="button" class="btn-choice" data-letter="c">C — Certo</button>
        <button type="button" class="btn-choice" data-letter="e">E — Errado</button>`;
    } else {
      els.choices.innerHTML = ["A", "B", "C", "D", "E"]
        .map(
          (L) =>
            `<button type="button" class="btn-choice" data-letter="${L.toLowerCase()}">${L}</button>`
        )
        .join("");
    }

    els.choices.querySelectorAll(".btn-choice").forEach((btn) => {
      btn.addEventListener("click", () => onChoiceClick(btn.dataset.letter));
    });

    if (q.assistReveal) applyAssistReveal(q, q.assistReveal);
    syncAssistUi(q);
  }

  async function onChoiceClick(letter) {
    if (assistMode) {
      await useAssistOnLetter(letter);
      return;
    }
    await onChoose(letter);
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
      els.status.textContent = data.message || "Assistência usada.";
      syncAssistUi(q);
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
    if (!q || !letter) return;

    submitting = true;
    assistMode = false;
    els.choices.querySelectorAll(".btn-choice").forEach((b) => {
      b.disabled = true;
      if (b.dataset.letter === letter) b.classList.add("selected");
    });
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
          comment: els.comment.value || ""
        })
      });

      if (data.sessionComplete) {
        await showResults();
        return;
      }

      index += 1;
      submitting = false;
      renderQuestion();
    } catch (e) {
      submitting = false;
      els.status.textContent = e.message || "Erro ao salvar.";
      els.choices.querySelectorAll(".btn-choice").forEach((b) => {
        if (!b.classList.contains("assist-false")) b.disabled = false;
        b.classList.remove("selected");
      });
      syncAssistUi(q);
    }
  }

  async function showResults() {
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
        if (!q || q.assistUsed || assistQty < 1 || submitting || assistBusy) return;
        assistMode = !assistMode;
        els.btnAssist.classList.toggle("active", assistMode);
        els.assistHint.textContent = assistMode
          ? "Modo verificação: toque na alternativa que quer checar (verdadeira ou falsa)."
          : "Gasta 1 consumível · escolha uma letra · máx. 1 por questão";
        els.choices.classList.toggle("assist-picking", assistMode);
      });
    }

    try {
      const data = await fetchJson(API.session(token));
      totalInSession = data.total || 0;
      answeredAtStart = data.answeredCount || 0;
      assistQty = data.assistEliminateQty || 0;
      userName = data.userName || "";
      userJid = data.userJid || data.user_jid || "";
      if (els.greeting && userName && userName !== "Participante") {
        els.greeting.textContent = `${firstName(userName)}, suas omissas · sessão pessoal`;
      }
      pending = (data.questions || []).filter((q) => !q.missing && !q.alreadyAnswered);

      if (!pending.length) {
        if ((data.questions || []).some((q) => q.alreadyAnswered) || data.completedAt) {
          await showResults();
          return;
        }
        showError("Nenhuma questão pendente nesta sessão.");
        return;
      }

      index = 0;
      renderQuestion();
    } catch (e) {
      showError(e.message || "Não foi possível abrir a sessão.");
    }
  }

  void init();
})();
