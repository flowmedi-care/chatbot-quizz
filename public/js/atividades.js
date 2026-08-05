(function () {
  "use strict";

  const STORAGE_USER = "papaVagasHubUser";
  const API = {
    members: "/api/economy?view=members",
    atividades: (qs) => `/api/atividades?${qs}`,
    post: "/api/atividades",
    session: (t) => `/api/omissas-session?t=${encodeURIComponent(t)}`,
    answer: "/api/omissas-answer",
    results: (t) => `/api/omissas-results?t=${encodeURIComponent(t)}`
  };

  const $ = (id) => document.getElementById(id);

  let userJid = "";
  let userName = "";
  let view = "day";
  let weekAnchor = null;
  let monthAnchor = null;
  let selectedDays = new Set();
  let weekData = null;
  let monthData = null;

  // quiz state
  let token = "";
  let pending = [];
  let index = 0;
  let totalInSession = 0;
  let answeredAtStart = 0;
  let submitting = false;

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statusLabel(s) {
    if (s === "feito") return "feito";
    if (s === "atrasado") return "atrasado";
    if (s === "hoje") return "hoje";
    if (s === "pendente") return "a fazer";
    if (s === "passou") return "—";
    return s || "—";
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

  function showStatus(msg) {
    const el = $("atv-status");
    if (!msg) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.classList.remove("hidden");
    el.textContent = msg;
  }

  function setGate(hasUser) {
    $("atv-gate").classList.toggle("hidden", hasUser);
    $("atv-main").classList.toggle("hidden", !hasUser);
  }

  function addDaysIso(iso, n) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + n);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  function startOfWeekMonday(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const utcDay = dt.getUTCDay();
    const idx = utcDay === 0 ? 6 : utcDay - 1;
    return addDaysIso(iso, -idx);
  }

  async function loadMembers() {
    const data = await fetchJson(API.members);
    const members = data.members || data.items || data || [];
    const list = Array.isArray(members) ? members : [];
    const sel = $("atv-user");
    sel.innerHTML = `<option value="">— escolher —</option>`;
    for (const m of list) {
      const jid = m.userJid || m.user_jid || m.jid || "";
      if (!jid) continue;
      const label =
        m.displayLabel ||
        m.displayName ||
        m.quizDisplayName ||
        m.quiz_display_name ||
        m.userLabel ||
        m.user_label ||
        m.name ||
        "Participante";
      const opt = document.createElement("option");
      opt.value = jid;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    const saved = localStorage.getItem(STORAGE_USER) || "";
    if (saved && [...sel.options].some((o) => o.value === saved)) {
      sel.value = saved;
      userJid = saved;
      userName = sel.options[sel.selectedIndex]?.textContent || "";
    }
  }

  function switchView(next) {
    view = next;
    document.querySelectorAll(".atv-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === next);
    });
    $("panel-day").classList.toggle("hidden", next !== "day");
    $("panel-week").classList.toggle("hidden", next !== "week");
    $("panel-month").classList.toggle("hidden", next !== "month");
    selectedDays.clear();
    updateSelectedLabels();
    void refresh();
  }

  async function refresh() {
    if (!userJid) return;
    showStatus("Carregando…");
    try {
      if (view === "day") await loadDay();
      else if (view === "week") await loadWeek();
      else await loadMonth();
      showStatus("");
    } catch (e) {
      showStatus(e.message || "Erro ao carregar");
    }
  }

  async function loadDay() {
    const data = await fetchJson(
      API.atividades(`view=day&userJid=${encodeURIComponent(userJid)}`)
    );
    $("day-subtitle").textContent = `Hoje ${data.dayIso || data.todayIso || ""}`;
    const body = $("day-body");
    const cards = data.byCaderno || [];
    if (!cards.length) {
      body.innerHTML = `<p class="atv-muted">Você não está engajado em cadernos ativos.</p>`;
      return;
    }
    body.innerHTML = cards
      .map((c) => {
        const open = (c.totalCount || 0) - (c.answeredCount || 0);
        return `<article class="atv-caderno-card">
          <h3>#${esc(c.cadernoId)} ${esc(c.name)}</h3>
          <p class="atv-muted">${statusLabel(c.status)} · ${c.answeredCount || 0}/${c.totalCount || 0} respondidas
          ${open > 0 ? ` · ${open} pendente(s)` : ""}</p>
        </article>`;
      })
      .join("");
  }

  async function loadWeek() {
    if (!weekAnchor) weekAnchor = null;
    const qs = new URLSearchParams({ view: "week", userJid });
    if (weekAnchor) qs.set("weekStart", weekAnchor);
    weekData = await fetchJson(API.atividades(qs.toString()));
    weekAnchor = weekData.weekStart;
    $("week-range").textContent = `${weekData.weekStart} → ${weekData.weekEnd}`;
    const grid = $("week-grid");
    grid.innerHTML = (weekData.days || [])
      .map((d) => {
        const sel = selectedDays.has(d.dayIso) ? " selected" : "";
        const selectable = d.selectable ? " selectable" : "";
        return `<button type="button" class="atv-day-cell${selectable}${sel}" data-day="${esc(
          d.dayIso
        )}" data-status="${esc(d.status)}" data-selectable="${d.selectable ? "1" : "0"}">
          <span class="wd">${esc((d.weekday || "").slice(0, 3))}</span>
          <span class="dn">${esc((d.dayIso || "").slice(8))}</span>
          <span class="st">${esc(statusLabel(d.status))}</span>
        </button>`;
      })
      .join("");
    grid.querySelectorAll(".atv-day-cell.selectable").forEach((btn) => {
      btn.addEventListener("click", () => toggleDay(btn.dataset.day));
    });
    updateSelectedLabels();
  }

  async function loadMonth() {
    const qs = new URLSearchParams({ view: "month", userJid });
    if (monthAnchor) qs.set("month", monthAnchor);
    monthData = await fetchJson(API.atividades(qs.toString()));
    monthAnchor = monthData.month;
    const [y, m] = (monthData.month || "").split("-");
    const monthNames = [
      "",
      "janeiro",
      "fevereiro",
      "março",
      "abril",
      "maio",
      "junho",
      "julho",
      "agosto",
      "setembro",
      "outubro",
      "novembro",
      "dezembro"
    ];
    $("month-title").textContent = `${monthNames[Number(m)] || m} ${y}`;
    const c = monthData.counts || {};
    $("month-counts").textContent = `feito ${c.feito || 0} · atrasado ${c.atrasado || 0} · a fazer ${
      c.pendente || 0
    }`;

    const days = monthData.days || [];
    const first = days[0]?.dayIso;
    let pad = 0;
    if (first) {
      const [yy, mm, dd] = first.split("-").map(Number);
      const utcDay = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0)).getUTCDay();
      pad = utcDay === 0 ? 6 : utcDay - 1;
    }
    const dows = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"]
      .map((d) => `<div class="dow">${d}</div>`)
      .join("");
    const empties = Array.from({ length: pad }, () => `<div class="atv-month-cell empty"></div>`).join(
      ""
    );
    const cells = days
      .map((d) => {
        const sel = selectedDays.has(d.dayIso) ? " selected" : "";
        const selectable = d.selectable ? " selectable" : "";
        return `<button type="button" class="atv-month-cell${selectable}${sel}" data-day="${esc(
          d.dayIso
        )}" data-status="${esc(d.status)}" data-selectable="${d.selectable ? "1" : "0"}">
          <span>${esc((d.dayIso || "").slice(8))}</span>
        </button>`;
      })
      .join("");
    $("month-grid").innerHTML = dows + empties + cells;
    $("month-grid").querySelectorAll(".atv-month-cell.selectable").forEach((btn) => {
      btn.addEventListener("click", () => toggleDay(btn.dataset.day));
    });
    updateSelectedLabels();
  }

  function toggleDay(dayIso) {
    if (!dayIso) return;
    if (selectedDays.has(dayIso)) selectedDays.delete(dayIso);
    else selectedDays.add(dayIso);
    document.querySelectorAll(`[data-day="${dayIso}"]`).forEach((el) => {
      el.classList.toggle("selected", selectedDays.has(dayIso));
    });
    updateSelectedLabels();
  }

  function updateSelectedLabels() {
    const n = selectedDays.size;
    const label = n ? `${n} dia(s) selecionado(s)` : "Selecione dias futuros";
    $("week-selected-label").textContent = label;
    $("month-selected-label").textContent = label;
    $("btn-adiantar-week").disabled = n === 0;
    $("btn-adiantar-month").disabled = n === 0;
  }

  async function adiantarSelected() {
    const dayIsos = [...selectedDays].sort();
    if (!dayIsos.length) return;
    showStatus("Adiantando…");
    try {
      const data = await fetchJson(API.post, {
        method: "POST",
        body: JSON.stringify({
          action: "adiantar",
          userJid,
          userName,
          dayIsos
        })
      });
      showStatus(data.summary || data.message || "Ok");
      selectedDays.clear();
      await refresh();
      if (data.token) await openQuiz(data.token);
    } catch (e) {
      showStatus(e.message || "Erro ao adiantar");
    }
  }

  async function startSession(mode) {
    showStatus("Abrindo sessão…");
    try {
      const data = await fetchJson(API.post, {
        method: "POST",
        body: JSON.stringify({ action: "session", userJid, userName, mode })
      });
      if (!data.token) {
        showStatus(data.message || "Nada pendente.");
        return;
      }
      showStatus("");
      await openQuiz(data.token);
    } catch (e) {
      showStatus(e.message || "Erro ao abrir sessão");
    }
  }

  function showQuizWrap(on) {
    $("atv-quiz-wrap").classList.toggle("hidden", !on);
    $("atv-main").classList.toggle("hidden", on || !userJid);
  }

  async function openQuiz(t) {
    token = t;
    pending = [];
    index = 0;
    submitting = false;
    showQuizWrap(true);
    $("omissas-error").classList.add("hidden");
    $("omissas-results").classList.add("hidden");
    $("omissas-quiz").classList.add("hidden");
    $("omissas-loading").classList.remove("hidden");
    $("omissas-loading").textContent = "Carregando questões…";

    try {
      const data = await fetchJson(API.session(token));
      totalInSession = data.total || 0;
      answeredAtStart = data.answeredCount || 0;
      pending = (data.questions || []).filter((q) => !q.missing && !q.alreadyAnswered);
      if (!pending.length) {
        if ((data.questions || []).some((q) => q.alreadyAnswered) || data.completedAt) {
          await showResults();
          return;
        }
        $("omissas-loading").classList.add("hidden");
        $("omissas-error").classList.remove("hidden");
        $("omissas-error").textContent = "Nenhuma questão pendente nesta sessão.";
        return;
      }
      index = 0;
      renderQuestion();
    } catch (e) {
      $("omissas-loading").classList.add("hidden");
      $("omissas-error").classList.remove("hidden");
      $("omissas-error").textContent = e.message || "Não foi possível abrir a sessão.";
    }
  }

  function renderQuestion() {
    const q = pending[index];
    if (!q) {
      void showResults();
      return;
    }
    $("omissas-loading").classList.add("hidden");
    $("omissas-results").classList.add("hidden");
    $("omissas-quiz").classList.remove("hidden");
    $("q-status").classList.add("hidden");
    $("q-comment").value = "";

    const doneSoFar = answeredAtStart + index;
    $("q-title").textContent = `Questão #${q.shortId}`;
    $("q-meta").textContent = q.creatorName ? `Por ${q.creatorName}` : "";
    $("q-progress").textContent = `${doneSoFar + 1} / ${totalInSession}`;

    let html = "";
    if (q.statementText) html += `<div class="statement-text">${esc(q.statementText)}</div>`;
    if (q.statementMediaUrl && q.statementMediaMimeType) {
      if (String(q.statementMediaMimeType).startsWith("image/")) {
        html += `<img src="${esc(q.statementMediaUrl)}" alt="Enunciado" crossorigin="anonymous" />`;
      } else {
        html += `<p><a href="${esc(q.statementMediaUrl)}" target="_blank" rel="noopener">Abrir documento</a></p>`;
      }
    }
    $("q-statement").innerHTML = html || "<p>(Sem enunciado)</p>";

    const isTf = q.questionType === "true_false";
    const choices = $("q-choices");
    choices.classList.toggle("tf", isTf);
    if (isTf) {
      choices.innerHTML = `
        <button type="button" class="btn-choice" data-letter="c">C — Certo</button>
        <button type="button" class="btn-choice" data-letter="e">E — Errado</button>`;
    } else {
      choices.innerHTML = ["A", "B", "C", "D", "E"]
        .map(
          (L) =>
            `<button type="button" class="btn-choice" data-letter="${L.toLowerCase()}">${L}</button>`
        )
        .join("");
    }
    choices.querySelectorAll(".btn-choice").forEach((btn) => {
      btn.addEventListener("click", () => onChoose(btn.dataset.letter));
    });
  }

  async function onChoose(letter) {
    if (submitting) return;
    const q = pending[index];
    if (!q || !letter) return;
    submitting = true;
    $("q-choices").querySelectorAll(".btn-choice").forEach((b) => {
      b.disabled = true;
      if (b.dataset.letter === letter) b.classList.add("selected");
    });
    $("q-status").classList.remove("hidden");
    $("q-status").textContent = "Salvando…";
    try {
      const data = await fetchJson(API.answer, {
        method: "POST",
        body: JSON.stringify({
          t: token,
          shortId: q.shortId,
          letter,
          comment: $("q-comment").value || ""
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
      $("q-status").textContent = e.message || "Erro ao salvar.";
      $("q-choices").querySelectorAll(".btn-choice").forEach((b) => {
        b.disabled = false;
        b.classList.remove("selected");
      });
    }
  }

  async function showResults() {
    $("omissas-quiz").classList.add("hidden");
    $("omissas-loading").classList.remove("hidden");
    $("omissas-loading").textContent = "Montando resultado…";
    try {
      const data = await fetchJson(API.results(token));
      $("omissas-loading").classList.add("hidden");
      $("omissas-results").classList.remove("hidden");
      $("results-summary").innerHTML = `
        <div class="omissas-stat ok"><span>${data.correctCount}</span> acertos</div>
        <div class="omissas-stat bad"><span>${data.wrongCount}</span> erros</div>
        <div class="omissas-stat"><span>${data.total}</span> no total</div>`;
      $("results-list").innerHTML = (data.items || [])
        .map((item) => {
          if (item.missing) {
            return `<article class="omissas-result-item"><h3>#${esc(item.shortId)}</h3><p>Indisponível.</p></article>`;
          }
          const badge =
            item.correct === true
              ? '<span class="omissas-badge ok">Acerto</span>'
              : item.correct === false
                ? '<span class="omissas-badge bad">Erro</span>'
                : '<span class="omissas-badge">—</span>';
          return `<article class="omissas-result-item">
            <div class="omissas-result-head"><h3>#${esc(item.shortId)}</h3>${badge}</div>
            <p><strong>Sua:</strong> ${(item.yourLetter || "—").toUpperCase()}
              · <strong>Gabarito:</strong> ${esc(item.answerKey || "—")}</p>
          </article>`;
        })
        .join("");
    } catch (e) {
      $("omissas-loading").classList.add("hidden");
      $("omissas-error").classList.remove("hidden");
      $("omissas-error").textContent = e.message || "Erro no resultado.";
    }
  }

  async function init() {
    try {
      await loadMembers();
    } catch (e) {
      showStatus(e.message || "Erro ao carregar membros");
    }

    setGate(Boolean(userJid));
    if (userJid) void refresh();

    $("atv-user").addEventListener("change", (e) => {
      userJid = e.target.value || "";
      userName = e.target.options[e.target.selectedIndex]?.textContent || "";
      if (userJid) localStorage.setItem(STORAGE_USER, userJid);
      else localStorage.removeItem(STORAGE_USER);
      selectedDays.clear();
      weekAnchor = null;
      monthAnchor = null;
      setGate(Boolean(userJid));
      showQuizWrap(false);
      if (userJid) void refresh();
    });

    document.querySelectorAll(".atv-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    $("btn-responder-hoje").addEventListener("click", () => startSession("hoje"));
    $("btn-atrasadas").addEventListener("click", () => startSession("atrasadas"));
    $("btn-adiantar-week").addEventListener("click", () => adiantarSelected());
    $("btn-adiantar-month").addEventListener("click", () => adiantarSelected());

    $("week-prev").addEventListener("click", () => {
      if (!weekAnchor) return;
      weekAnchor = addDaysIso(startOfWeekMonday(weekAnchor), -7);
      selectedDays.clear();
      void loadWeek();
    });
    $("week-next").addEventListener("click", () => {
      if (!weekAnchor) return;
      weekAnchor = addDaysIso(startOfWeekMonday(weekAnchor), 7);
      selectedDays.clear();
      void loadWeek();
    });
    $("month-prev").addEventListener("click", () => {
      if (!monthAnchor) return;
      const [y, m] = monthAnchor.split("-").map(Number);
      const nm = m === 1 ? 12 : m - 1;
      const ny = m === 1 ? y - 1 : y;
      monthAnchor = `${ny}-${String(nm).padStart(2, "0")}`;
      selectedDays.clear();
      void loadMonth();
    });
    $("month-next").addEventListener("click", () => {
      if (!monthAnchor) return;
      const [y, m] = monthAnchor.split("-").map(Number);
      const nm = m === 12 ? 1 : m + 1;
      const ny = m === 12 ? y + 1 : y;
      monthAnchor = `${ny}-${String(nm).padStart(2, "0")}`;
      selectedDays.clear();
      void loadMonth();
    });

    $("btn-close-quiz").addEventListener("click", () => {
      showQuizWrap(false);
      void refresh();
    });
  }

  void init();
})();
