(function () {
  const API = {
    questions: "/api/questions",
    ranking: "/api/ranking",
    reportData: "/api/report-data",
    detail: (id) => `/api/question-detail?shortId=${encodeURIComponent(id)}`,
    submit: "/api/question-submit",
    engagement: "/api/engagement"
  };

  const els = {
    rankingPodium: document.getElementById("ranking-podium"),
    rankingTable: document.getElementById("ranking-table-body"),
    rankingTableWrap: document.getElementById("ranking-table-wrap"),
    rankingWarning: document.getElementById("ranking-warning"),
    questionsGrid: document.getElementById("questions-grid"),
    loadErr: document.getElementById("load-error"),
    modal: document.getElementById("modal-overlay"),
    modalTitle: document.getElementById("modal-title"),
    modalAuthor: document.getElementById("modal-author"),
    modalStatement: document.getElementById("modal-statement"),
    modalChoices: document.getElementById("modal-choices"),
    modalFeedback: document.getElementById("modal-feedback"),
    modalRevealBtn: document.getElementById("modal-reveal-btn"),
    modalRevealBox: document.getElementById("modal-reveal-box"),
    modalGabarito: document.getElementById("modal-gabarito"),
    modalComment: document.getElementById("modal-comment"),
    modalCommentMedia: document.getElementById("modal-comment-media"),
    btnClose: document.getElementById("modal-close"),
    questionsFilters: document.getElementById("questions-filters"),
    filterPerson: document.getElementById("filter-person"),
    filterOutcome: document.getElementById("filter-outcome"),
    filtersHint: document.getElementById("filters-hint"),
    reportOverlay: document.getElementById("report-overlay"),
    reportClose: document.getElementById("report-close"),
    reportPerson: document.getElementById("report-person"),
    reportStatus: document.getElementById("report-status"),
    reportGenerate: document.getElementById("report-generate"),
    btnReportOpen: document.getElementById("btn-report-open"),
    engagementOverlay: document.getElementById("engagement-overlay"),
    engagementClose: document.getElementById("engagement-close"),
    engagementStatus: document.getElementById("engagement-status"),
    engagementList: document.getElementById("engagement-list"),
    btnEngagementOpen: document.getElementById("btn-engagement-open")
  };

  let questionsList = [];
  /** @type {null | { questions: any[], answers: any[], participants: any[], warning?: string }} */
  let reportData = null;

  let currentShortId = null;
  let submitPayload = null;
  /** @type {{ userJid: string, userLabel: string | null, engaged: boolean }[]} */
  let engagementMembersCache = [];

  async function fetchJson(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    const method = (options.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const r = await fetch(url, {
      ...options,
      headers
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(text || r.statusText);
    }
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function escAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function truncate(text, max) {
    if (!text || typeof text !== "string") return "";
    const t = text.trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max)}…`;
  }

  function renderRanking(data) {
    if (data.warning) {
      els.rankingWarning.textContent = data.warning;
      els.rankingWarning.classList.remove("hidden");
    } else {
      els.rankingWarning.textContent = "";
      els.rankingWarning.classList.add("hidden");
    }

    const entries = data.entries || [];
    if (!entries.length) {
      els.rankingPodium.innerHTML =
        '<p class="loading">Ninguém no ranking ainda ou sem dados de grupo.</p>';
      els.rankingTable.innerHTML = "";
      if (els.rankingTableWrap) els.rankingTableWrap.style.display = "none";
      return;
    }

    const top = entries.slice(0, 3);
    els.rankingPodium.innerHTML = top
      .map(
        (e, i) => `
      <div class="rank-card rank-${i + 1}">
        <div class="place">${i + 1}º</div>
        <div class="name">${esc(e.userLabel)}</div>
        <div class="score">${e.correctCount} acerto(s)</div>
      </div>`
      )
      .join("");

    const rest = entries.slice(3);
    els.rankingTable.innerHTML = rest.length
      ? rest
          .map(
            (e, i) => `
        <tr>
          <td>${i + 4}º</td>
          <td>${esc(e.userLabel)}</td>
          <td>${e.correctCount}</td>
        </tr>`
          )
          .join("")
      : "";
    if (els.rankingTableWrap) {
      els.rankingTableWrap.style.display = rest.length ? "" : "none";
    }
  }

  function renderQuestions(list) {
    if (!list.length) {
      els.questionsGrid.innerHTML =
        '<p class="loading">Nenhuma questão cadastrada ou nenhuma combina com os filtros.</p>';
      return;
    }
    els.questionsGrid.innerHTML = list
      .map((q) => {
        const typeLabel = q.questionType === "true_false" ? "Certo / errado" : "Múltipla escolha";
        const mediaHint = q.hasMedia ? " · com mídia" : "";
        return `
      <button type="button" class="q-card" data-short="${esc(q.shortId)}">
        <div class="id">#${esc(q.shortId)}</div>
        <div class="author">Por ${esc(q.creatorName)}</div>
        <div class="preview">${esc(q.statementPreview || "(sem texto)")}</div>
        <div class="meta">${typeLabel}${mediaHint}</div>
      </button>`;
      })
      .join("");

    els.questionsGrid.querySelectorAll(".q-card").forEach((btn) => {
      btn.addEventListener("click", () => openModal(btn.dataset.short));
    });
  }

  function userAnswerFor(shortId, userJid) {
    if (!reportData || !reportData.answers) return null;
    return reportData.answers.find(
      (a) => a.questionShortId === shortId && a.userJid === userJid
    );
  }

  function questionPasses(shortId) {
    if (!reportData || !els.filterPerson || els.filterPerson.value === "__all__") return true;
    const person = els.filterPerson.value;
    const ua = userAnswerFor(shortId, person);
    const outcome = els.filterOutcome.value;
    if (outcome === "all") return true;
    if (outcome === "correct") return Boolean(ua && ua.correct);
    if (outcome === "wrong") return Boolean(ua && !ua.correct);
    if (outcome === "unanswered") return !ua;
    return true;
  }

  function applyFiltersAndRender() {
    const filtered = (questionsList || []).filter((q) => questionPasses(q.shortId));
    renderQuestions(filtered);
    if (els.filtersHint) {
      if (!reportData || !questionsList.length) {
        els.filtersHint.textContent = "";
      } else if (els.filterPerson.value === "__all__") {
        els.filtersHint.textContent = `${questionsList.length} questão(ões) no grupo.`;
      } else {
        els.filtersHint.textContent = `Mostrando ${filtered.length} de ${questionsList.length} com os filtros atuais.`;
      }
    }
  }

  function updateOutcomeOptions() {
    if (!els.filterOutcome || !els.filterPerson) return;
    const person = els.filterPerson.value;
    if (person === "__all__") {
      els.filterOutcome.innerHTML = '<option value="all">Todas as questões</option>';
      els.filterOutcome.disabled = true;
    } else {
      els.filterOutcome.disabled = false;
      els.filterOutcome.innerHTML = `
        <option value="all">Todas</option>
        <option value="correct">Só acertos</option>
        <option value="wrong">Só erros</option>
        <option value="unanswered">Sem resposta (esta pessoa)</option>`;
    }
  }

  function populateFilters() {
    if (!els.filterPerson || !els.questionsFilters) return;
    if (!reportData || !reportData.questions || !reportData.questions.length) {
      els.questionsFilters.classList.add("hidden");
      return;
    }
    els.questionsFilters.classList.remove("hidden");
    const parts =
      reportData.participants && reportData.participants.length
        ? reportData.participants
        : uniqueParticipantsFromAnswers(reportData.answers || []);

    els.filterPerson.innerHTML =
      '<option value="__all__">Todos</option>' +
      parts
        .map(
          (p) =>
            `<option value="${escAttr(p.userJid)}">${esc(p.userName)}</option>`
        )
        .join("");

    updateOutcomeOptions();
  }

  function uniqueParticipantsFromAnswers(answers) {
    const m = new Map();
    for (const a of answers) {
      if (!m.has(a.userJid)) m.set(a.userJid, { userJid: a.userJid, userName: a.userName });
    }
    return Array.from(m.values()).sort((a, b) =>
      a.userName.localeCompare(b.userName, "pt-BR")
    );
  }

  function populateReportSelect() {
    if (!els.reportPerson) return;
    if (!reportData || !(reportData.questions && reportData.questions.length)) {
      els.reportPerson.innerHTML = '<option value="">— Sem dados —</option>';
      return;
    }
    const parts = reportData.participants && reportData.participants.length
      ? reportData.participants
      : uniqueParticipantsFromAnswers(reportData.answers || []);

    els.reportPerson.innerHTML =
      '<option value="__all__">Todos (tabela consolidada)</option>' +
      parts
        .map(
          (p) =>
            `<option value="${escAttr(p.userJid)}">${esc(p.userName)}</option>`
        )
        .join("");
  }

  function resetModal() {
    els.modalFeedback.classList.add("hidden");
    els.modalFeedback.classList.remove("ok", "bad");
    els.modalRevealBox.classList.add("hidden");
    els.modalRevealBtn.classList.add("hidden");
    els.modalCommentMedia.innerHTML = "";
    submitPayload = null;
    els.modalChoices.innerHTML = "";
  }

  async function openModal(shortId) {
    currentShortId = shortId;
    resetModal();
    els.modal.classList.add("open");
    els.modal.setAttribute("aria-hidden", "false");
    els.modalStatement.innerHTML = '<p class="loading">Carregando…</p>';

    try {
      const q = await fetchJson(API.detail(shortId));
      els.modalTitle.textContent = `Questão #${q.shortId}`;
      els.modalAuthor.textContent = `Por ${q.creatorName}`;

      let html = "";
      if (q.statementText) html += `<div class="statement-text">${esc(q.statementText)}</div>`;

      if (q.statementMediaUrl && q.statementMediaMimeType) {
        if (q.statementMediaMimeType.startsWith("image/")) {
          html += `<img src="${esc(q.statementMediaUrl)}" alt="Enunciado" crossorigin="anonymous" />`;
        } else {
          html += `<p><a href="${esc(q.statementMediaUrl)}" target="_blank" rel="noopener">Abrir documento (PDF/arquivo)</a></p>`;
        }
      }
      els.modalStatement.innerHTML = html || "<p>(Sem enunciado)</p>";

      const isTf = q.questionType === "true_false";
      els.modalChoices.classList.toggle("tf", isTf);

      if (isTf) {
        els.modalChoices.innerHTML = `
          <button type="button" class="btn-choice" data-letter="c">C — Certo</button>
          <button type="button" class="btn-choice" data-letter="e">E — Errado</button>`;
      } else {
        els.modalChoices.innerHTML = ["A", "B", "C", "D", "E"]
          .map(
            (L) =>
              `<button type="button" class="btn-choice" data-letter="${L.toLowerCase()}">${L}</button>`
          )
          .join("");
      }

      els.modalChoices.querySelectorAll(".btn-choice").forEach((b) => {
        b.addEventListener("click", () => onAnswer(b.dataset.letter));
      });
    } catch (e) {
      els.modalStatement.innerHTML = `<p class="error-banner">${esc(e.message)}</p>`;
    }
  }

  function closeModal() {
    els.modal.classList.remove("open");
    els.modal.setAttribute("aria-hidden", "true");
    currentShortId = null;
  }

  async function onAnswer(letter) {
    if (!currentShortId) return;
    els.modalChoices.querySelectorAll(".btn-choice").forEach((b) => {
      b.disabled = true;
      if (b.dataset.letter === letter) b.classList.add("selected");
    });

    try {
      const data = await fetchJson(API.submit, {
        method: "POST",
        body: JSON.stringify({ shortId: currentShortId, letter })
      });
      submitPayload = data;

      els.modalFeedback.classList.remove("hidden");
      els.modalFeedback.classList.toggle("ok", data.correct);
      els.modalFeedback.classList.toggle("bad", !data.correct);
      els.modalFeedback.textContent = data.correct
        ? "Resposta correta!"
        : `Não foi dessa vez. Sua resposta: ${data.yourAnswer}.`;

      els.modalRevealBtn.classList.remove("hidden");
      els.modalRevealBox.classList.add("hidden");
    } catch (e) {
      els.modalFeedback.classList.remove("hidden");
      els.modalFeedback.classList.add("bad");
      els.modalFeedback.textContent = e.message || "Erro ao enviar.";
    }
  }

  function showReveal() {
    if (!submitPayload) return;
    els.modalRevealBtn.classList.add("hidden");
    els.modalRevealBox.classList.remove("hidden");
    els.modalGabarito.textContent = `Gabarito oficial: ${submitPayload.answerKey}`;
    els.modalComment.textContent = submitPayload.explanationText || "Sem comentário do autor.";

    els.modalCommentMedia.innerHTML = "";
    if (submitPayload.explanationMediaUrl && submitPayload.explanationMediaMimeType) {
      if (submitPayload.explanationMediaMimeType.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = submitPayload.explanationMediaUrl;
        img.alt = "Comentário";
        els.modalCommentMedia.appendChild(img);
      } else {
        const a = document.createElement("a");
        a.href = submitPayload.explanationMediaUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "Abrir comentário (arquivo)";
        els.modalCommentMedia.appendChild(a);
      }
    }
  }

  /* ——— Relatório ZIP ——— */

  function mimeToExt(mime) {
    if (!mime) return "bin";
    const m = String(mime).toLowerCase();
    if (m.includes("jpeg") || m === "image/jpg") return "jpg";
    if (m === "image/png") return "png";
    if (m === "image/webp") return "webp";
    if (m === "image/gif") return "gif";
    if (m === "application/pdf") return "pdf";
    return "bin";
  }

  function urlBasename(url) {
    if (!url) return "arquivo";
    try {
      const u = new URL(url);
      const seg = u.pathname.split("/").filter(Boolean).pop() || "arquivo";
      return decodeURIComponent(seg.split("?")[0]);
    } catch {
      return "arquivo";
    }
  }

  function mdCell(t) {
    return String(t ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, " ");
  }

  function formatGabarito(q) {
    const k = String(q.answerKey || "").toUpperCase().slice(0, 1);
    if (q.questionType === "true_false") {
      return k === "C" ? "C (certo)" : "E (errado)";
    }
    return k;
  }

  function formatMarcada(letterDisplay, q) {
    const L = String(letterDisplay || "").toUpperCase().slice(0, 1);
    if (q.questionType === "true_false") {
      return L === "C" ? "C (certo)" : "E (errado)";
    }
    return L;
  }

  async function fetchBlobMaybe(url) {
    const r = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.blob();
  }

  async function addMediaToZip(zip, folder, logicalName, url, mime, errors) {
    if (!url) return null;
    const ext = mimeToExt(mime);
    const safeName = `${logicalName}.${ext}`;
    const path = `${folder}/${safeName}`;
    try {
      const blob = await fetchBlobMaybe(url);
      zip.file(path, blob);
      return safeName;
    } catch (e) {
      errors.push({ url, path, err: e.message || String(e) });
      return null;
    }
  }

  function slugName(s) {
    const t = String(s || "usuario")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 48);
    return t || "usuario";
  }

  async function buildReportZip(scopeJid) {
    if (typeof JSZip === "undefined") throw new Error("JSZip não carregou. Recarregue a página.");

    const qs = reportData.questions || [];
    const ans = reportData.answers || [];
    if (!qs.length) throw new Error("Não há questões para exportar.");

    const zip = new JSZip();
    const midiasFolder = "midias";
    const errors = [];
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");

    const lines = [];
    lines.push("# Relatório Papa Vagas — Quiz");
    lines.push("");
    lines.push(`> Gerado em: ${stamp}`);
    lines.push(`> Escopo: ${scopeJid === "__all__" ? "Todos os participantes (consolidado)" : nomeParticipante(scopeJid)}`);
    lines.push("");
    lines.push(
      "Este relatório usa **respostas registradas pelo WhatsApp** (tabela `answers`). Respostas feitas só no navegador não entram aqui."
    );
    lines.push("");

    if (scopeJid === "__all__") {
      lines.push("## Sumário");
      lines.push("");
      lines.push(`- Questões no grupo: **${qs.length}**`);
      lines.push(`- Registros de resposta: **${ans.length}**`);
      lines.push(`- Participantes distintos: **${new Set(ans.map((a) => a.userJid)).size}**`);
      lines.push("");
    } else {
      const mine = ans.filter((a) => a.userJid === scopeJid);
      const ok = mine.filter((a) => a.correct).length;
      const bad = mine.filter((a) => !a.correct).length;
      lines.push("## Sumário (esta pessoa)");
      lines.push("");
      lines.push(`- Respostas registradas: **${mine.length}**`);
      lines.push(`- Acertos: **${ok}** · Erros: **${bad}**`);
      lines.push("");
    }

    for (const q of qs) {
      const shortId = q.shortId;
      lines.push(`---`);
      lines.push("");
      lines.push(`## Questão #${shortId}`);
      lines.push("");
      lines.push(
        `- **Tipo:** ${q.questionType === "true_false" ? "Certo / errado" : "Múltipla escolha"}`
      );
      lines.push(`- **Autor:** ${mdCell(q.creatorName)}`);
      lines.push("");

      let stmtMediaName = null;
      if (q.statementText && q.statementText.trim()) {
        lines.push("### Enunciado (texto)");
        lines.push("");
        lines.push(q.statementText.trim());
        lines.push("");
      }

      if (q.statementMediaUrl) {
        stmtMediaName = await addMediaToZip(
          zip,
          midiasFolder,
          `questao_${shortId}_enunciado`,
          q.statementMediaUrl,
          q.statementMediaMimeType,
          errors
        );
        lines.push("### Enunciado (arquivo)");
        lines.push("");
        if (stmtMediaName) {
          lines.push(
            `- **Arquivo no ZIP:** \`midias/${stmtMediaName}\` (${mdCell(q.statementMediaMimeType || "tipo desconhecido")})`
          );
        } else {
          lines.push(
            `- **Referência:** não foi possível copiar o arquivo (CORS ou rede). Nome sugerido: \`${mdCell(urlBasename(q.statementMediaUrl))}\`. URL: ${q.statementMediaUrl}`
          );
        }
        lines.push("");
      }

      lines.push(`- **Gabarito oficial:** ${formatGabarito(q)}`);
      lines.push("");

      if (q.explanationText && String(q.explanationText).trim()) {
        lines.push("### Comentário / resolução (texto)");
        lines.push("");
        lines.push(String(q.explanationText).trim());
        lines.push("");
      }

      let expMediaName = null;
      if (q.explanationMediaUrl) {
        expMediaName = await addMediaToZip(
          zip,
          midiasFolder,
          `questao_${shortId}_comentario`,
          q.explanationMediaUrl,
          q.explanationMediaMimeType,
          errors
        );
        lines.push("### Comentário (arquivo)");
        lines.push("");
        if (expMediaName) {
          lines.push(`- **Arquivo no ZIP:** \`midias/${expMediaName}\``);
        } else {
          lines.push(
            `- **Referência:** download falhou; nome sugerido \`${mdCell(urlBasename(q.explanationMediaUrl))}\`. URL: ${q.explanationMediaUrl}`
          );
        }
        lines.push("");
      }

      const answersHere = ans.filter((a) => a.questionShortId === shortId);

      if (scopeJid === "__all__") {
        lines.push("### Respostas (WhatsApp)");
        lines.push("");
        lines.push("| Participante | Marcou | Gabarito | Resultado |");
        lines.push("| --- | --- | --- | --- |");
        if (!answersHere.length) {
          lines.push("| — | — | — | Nenhuma resposta registrada |");
        } else {
          for (const row of answersHere.sort((a, b) =>
            a.userName.localeCompare(b.userName, "pt-BR")
          )) {
            lines.push(
              `| ${mdCell(row.userName)} | ${formatMarcada(row.answerLetterDisplay, q)} | ${formatGabarito(q)} | ${row.correct ? "Certo" : "Errado"} |`
            );
          }
        }
        lines.push("");
      } else {
        const row = answersHere.find((a) => a.userJid === scopeJid);
        lines.push("### Esta pessoa");
        lines.push("");
        if (!row) {
          lines.push("*Sem resposta registrada para esta questão.*");
        } else {
          lines.push(`- **Marcou:** ${formatMarcada(row.answerLetterDisplay, q)}`);
          lines.push(`- **Gabarito:** ${formatGabarito(q)}`);
          lines.push(`- **Resultado:** ${row.correct ? "Certo" : "Errado"}`);
        }
        lines.push("");
      }
    }

    if (errors.length) {
      lines.push("---");
      lines.push("");
      lines.push("## Mídias não baixadas");
      lines.push("");
      for (const e of errors) {
        lines.push(`- ${e.url} (${mdCell(e.err)})`);
      }
      lines.push("");
    }

    zip.file("relatorio.md", lines.join("\n"), { binary: false });

    const scopeSlug =
      scopeJid === "__all__" ? "consolidado" : slugName(nomeParticipante(scopeJid));
    const fname = `relatorio-papa-vagas-${scopeSlug}-${stamp.slice(0, 10)}.zip`;

    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function nomeParticipante(jid) {
    const p = (reportData.participants || []).find((x) => x.userJid === jid);
    if (p) return p.userName;
    const a = (reportData.answers || []).find((x) => x.userJid === jid);
    return a ? a.userName : jid;
  }

  function openReportModal() {
    populateReportSelect();
    if (els.reportStatus) els.reportStatus.textContent = "";
    els.reportOverlay.classList.add("open");
    els.reportOverlay.setAttribute("aria-hidden", "false");
  }

  function closeReportModal() {
    els.reportOverlay.classList.remove("open");
    els.reportOverlay.setAttribute("aria-hidden", "true");
  }

  function renderEngagementList() {
    if (!els.engagementList) return;
    const members = engagementMembersCache;
    if (!members.length) {
      els.engagementList.innerHTML =
        '<li class="engagement-empty">Nenhum membro na lista. No grupo do WhatsApp envie <code>/sync-membros</code>.</li>';
      return;
    }
    els.engagementList.innerHTML = members
      .map(
        (m) => `
      <li class="engagement-row" data-jid="${escAttr(m.userJid)}">
        <label class="engagement-label">
          <input type="checkbox" class="engagement-cb" ${m.engaged ? "checked" : ""} aria-label="Engajado" />
          <span class="engagement-name">${esc(m.userLabel || m.userJid)}</span>
        </label>
      </li>`
      )
      .join("");
  }

  async function openEngagementModal() {
    if (!els.engagementOverlay || !els.engagementStatus) return;
    els.engagementStatus.textContent = "Carregando…";
    engagementMembersCache = [];
    renderEngagementList();
    els.engagementOverlay.classList.add("open");
    els.engagementOverlay.setAttribute("aria-hidden", "false");
    try {
      const data = await fetchJson(API.engagement);
      engagementMembersCache = data.members || [];
      if (data.warning) {
        els.engagementStatus.textContent = data.warning;
      } else if (!engagementMembersCache.length) {
        els.engagementStatus.textContent =
          "Lista vazia. Sincronize os membros no grupo com /sync-membros.";
      } else {
        els.engagementStatus.textContent = `${engagementMembersCache.length} participante(s).`;
      }
      renderEngagementList();
    } catch (e) {
      els.engagementStatus.textContent = e.message || "Não foi possível carregar.";
      engagementMembersCache = [];
      renderEngagementList();
    }
  }

  function closeEngagementModal() {
    if (!els.engagementOverlay) return;
    els.engagementOverlay.classList.remove("open");
    els.engagementOverlay.setAttribute("aria-hidden", "true");
  }

  async function onEngagementToggle(ev) {
    const cb = ev.target;
    if (!cb.classList || !cb.classList.contains("engagement-cb")) return;
    const row = cb.closest(".engagement-row");
    const jid = row && row.dataset.jid;
    if (!jid) return;
    const want = cb.checked;
    cb.disabled = true;
    try {
      await fetchJson(API.engagement, {
        method: "PATCH",
        body: JSON.stringify({ userJid: jid, engaged: want })
      });
      const m = engagementMembersCache.find((x) => x.userJid === jid);
      if (m) m.engaged = want;
      if (els.engagementStatus && !els.engagementStatus.textContent.startsWith("Carregando")) {
        const n = engagementMembersCache.filter((x) => x.engaged).length;
        els.engagementStatus.textContent = `${engagementMembersCache.length} participante(s), ${n} engajado(s).`;
      }
    } catch (err) {
      cb.checked = !want;
      if (els.engagementStatus) {
        els.engagementStatus.textContent = err.message || "Erro ao salvar.";
      }
    } finally {
      cb.disabled = false;
    }
  }

  async function onGenerateReport() {
    if (!reportData || !reportData.questions || !reportData.questions.length) {
      if (els.reportStatus) els.reportStatus.textContent = "Sem dados de relatório. Confira o grupo no Vercel.";
      return;
    }
    const scope = els.reportPerson.value;
    if (!scope) return;
    if (els.reportStatus) els.reportStatus.textContent = "Gerando ZIP… pode levar alguns segundos.";
    els.reportGenerate.disabled = true;
    try {
      await buildReportZip(scope);
      if (els.reportStatus) els.reportStatus.textContent = "Download iniciado.";
      closeReportModal();
    } catch (e) {
      if (els.reportStatus) els.reportStatus.textContent = e.message || "Erro ao gerar.";
    } finally {
      els.reportGenerate.disabled = false;
    }
  }

  async function init() {
    try {
      const [rankRes, qRes, repOrErr] = await Promise.all([
        fetchJson(API.ranking),
        fetchJson(API.questions),
        fetchJson(API.reportData).catch(() => null)
      ]);

      renderRanking(rankRes);
      reportData =
        repOrErr && Array.isArray(repOrErr.questions) && repOrErr.questions.length > 0 ? repOrErr : null;

      if (reportData) {
        questionsList = reportData.questions.map((q) => ({
          shortId: q.shortId,
          creatorName: q.creatorName,
          questionType: q.questionType,
          statementPreview: truncate(q.statementText || "", 220),
          hasMedia: Boolean(q.statementMediaUrl),
          statementMediaMimeType: q.statementMediaMimeType || null
        }));
      } else {
        questionsList = qRes.questions || [];
      }

      populateFilters();
      populateReportSelect();

      if (els.filterPerson) {
        els.filterPerson.addEventListener("change", () => {
          updateOutcomeOptions();
          applyFiltersAndRender();
        });
      }
      if (els.filterOutcome) {
        els.filterOutcome.addEventListener("change", applyFiltersAndRender);
      }

      applyFiltersAndRender();
    } catch (e) {
      els.loadErr.textContent =
        e.message ||
        "Não foi possível carregar dados. Confira as variáveis de ambiente no Vercel (Supabase).";
      els.loadErr.classList.remove("hidden");
    }
  }

  els.btnClose.addEventListener("click", closeModal);
  els.modal.addEventListener("click", (ev) => {
    if (ev.target === els.modal) closeModal();
  });
  els.modalRevealBtn.addEventListener("click", showReveal);

  if (els.btnReportOpen) els.btnReportOpen.addEventListener("click", openReportModal);
  if (els.reportClose) els.reportClose.addEventListener("click", closeReportModal);
  if (els.reportOverlay) {
    els.reportOverlay.addEventListener("click", (ev) => {
      if (ev.target === els.reportOverlay) closeReportModal();
    });
  }
  if (els.reportGenerate) els.reportGenerate.addEventListener("click", onGenerateReport);

  if (els.btnEngagementOpen) els.btnEngagementOpen.addEventListener("click", openEngagementModal);
  if (els.engagementClose) els.engagementClose.addEventListener("click", closeEngagementModal);
  if (els.engagementOverlay) {
    els.engagementOverlay.addEventListener("click", (ev) => {
      if (ev.target === els.engagementOverlay) closeEngagementModal();
    });
  }
  if (els.engagementList) els.engagementList.addEventListener("change", onEngagementToggle);

  init();
})();
