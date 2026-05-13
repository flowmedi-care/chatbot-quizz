(function () {
  const API = {
    questions: "/api/questions",
    ranking: "/api/ranking",
    reportData: "/api/report-data",
    detail: (id) => `/api/question-detail?shortId=${encodeURIComponent(id)}`,
    submit: "/api/question-submit",
    engagement: "/api/engagement",
    cadernos: "/api/cadernos",
    cadernoUpload: "/api/caderno-upload",
    cadernoDelete: "/api/caderno-delete"
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
    btnEngagementOpen: document.getElementById("btn-engagement-open"),
    btnCadernosOpen: document.getElementById("btn-cadernos-open"),
    cadernosOverlay: document.getElementById("cadernos-overlay"),
    cadernosClose: document.getElementById("cadernos-close"),
    cadernosStatus: document.getElementById("cadernos-status"),
    cadernosList: document.getElementById("cadernos-list"),
    btnCadernoAdd: document.getElementById("btn-caderno-add"),
    cadernoAddOverlay: document.getElementById("caderno-add-overlay"),
    cadernoAddClose: document.getElementById("caderno-add-close"),
    cadernoName: document.getElementById("caderno-name"),
    cadernoPdf: document.getElementById("caderno-pdf"),
    cadernoPerDay: document.getElementById("caderno-per-day"),
    cadernoTime: document.getElementById("caderno-time"),
    cadernoAddStatus: document.getElementById("caderno-add-status"),
    cadernoPreviewBox: document.getElementById("caderno-preview-box"),
    cadernoRandom: document.getElementById("caderno-random"),
    cadernoWait: document.getElementById("caderno-wait"),
    cadernoDeliveryGroup: document.getElementById("caderno-delivery-group"),
    cadernoDeliveryPrivate: document.getElementById("caderno-delivery-private"),
    cadernoPrivateAddPanel: document.getElementById("caderno-private-add-panel"),
    cadernoOwnerPhone: document.getElementById("caderno-owner-phone"),
    btnCadernoPreview: document.getElementById("btn-caderno-preview"),
    btnCadernoSave: document.getElementById("btn-caderno-save"),
    btnCadernoSaveActivate: document.getElementById("btn-caderno-save-activate"),
    cadernoEditOverlay: document.getElementById("caderno-edit-overlay"),
    cadernoEditClose: document.getElementById("caderno-edit-close"),
    cadernoEditId: document.getElementById("caderno-edit-id"),
    cadernoEditName: document.getElementById("caderno-edit-name"),
    cadernoEditPerDay: document.getElementById("caderno-edit-per-day"),
    cadernoEditTime: document.getElementById("caderno-edit-time"),
    cadernoEditRandom: document.getElementById("caderno-edit-random"),
    cadernoEditWait: document.getElementById("caderno-edit-wait"),
    cadernoEditDeliveryGroup: document.getElementById("caderno-edit-delivery-group"),
    cadernoEditDeliveryPrivate: document.getElementById("caderno-edit-delivery-private"),
    cadernoEditPrivatePanel: document.getElementById("caderno-edit-private-panel"),
    cadernoEditPrivateList: document.getElementById("caderno-edit-private-list"),
    btnCadernoEditLoadMembers: document.getElementById("btn-caderno-edit-load-members"),
    cadernoEditStatus: document.getElementById("caderno-edit-status"),
    btnCadernoEditSave: document.getElementById("btn-caderno-edit-save"),
    btnCadernoEditCancel: document.getElementById("btn-caderno-edit-cancel")
  };

  let cadernosCache = [];
  let cadernoUploadInFlight = false;

  let questionsList = [];
  /** @type {null | { questions: any[], answers: any[], participants: any[], warning?: string }} */
  let reportData = null;

  let currentShortId = null;
  let submitPayload = null;
  /** @type {{ userJid: string, userLabel: string | null, displayLabel?: string | null, engaged: boolean }[]} */
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
          <span class="engagement-name" title="${escAttr(m.userJid)}">${esc(
          m.displayLabel || m.userLabel || m.userJid
        )}</span>
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
      const patchRes = await fetchJson(API.engagement, {
        method: "PATCH",
        body: JSON.stringify({ userJid: jid, engaged: want })
      });
      const m = engagementMembersCache.find((x) => x.userJid === jid);
      if (m) {
        m.engaged = want;
        if (patchRes.member && patchRes.member.displayLabel) {
          m.displayLabel = patchRes.member.displayLabel;
        }
      }
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

  function formatStatusLabel(status) {
    switch (status) {
      case "active":
        return "Ativo";
      case "inactive":
        return "Inativo";
      case "paused_waiting_decision":
        return "Aguardando decisão";
      case "finished":
        return "Encerrado";
      default:
        return status || "—";
    }
  }

  function formatNextRunPretty(iso, timeZone) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return new Intl.DateTimeFormat("pt-BR", {
        timeZone: timeZone || "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      }).format(d);
    } catch {
      return iso;
    }
  }

  function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
  }

  function digitsToWhatsAppJid(raw) {
    const d = String(raw || "").replace(/\D/g, "");
    if (d.length < 10 || d.length > 15) return null;
    return `${d}@s.whatsapp.net`;
  }

  function getCadernoAddDeliveryMode() {
    return els.cadernoDeliveryPrivate && els.cadernoDeliveryPrivate.checked ? "private" : "group";
  }

  function syncCadernoAddPrivatePanel() {
    const priv = getCadernoAddDeliveryMode() === "private";
    if (els.cadernoPrivateAddPanel) els.cadernoPrivateAddPanel.classList.toggle("hidden", !priv);
  }

  function getCadernoEditDeliveryMode() {
    return els.cadernoEditDeliveryPrivate && els.cadernoEditDeliveryPrivate.checked
      ? "private"
      : "group";
  }

  function syncCadernoEditPrivatePanel() {
    const priv = getCadernoEditDeliveryMode() === "private";
    if (els.cadernoEditPrivatePanel) els.cadernoEditPrivatePanel.classList.toggle("hidden", !priv);
  }

  function renderPrivateRecipientEditRow(r) {
    const jid = r.userJid || "";
    const label = r.displayLabel || jid;
    const qpd =
      r.questionsPerDay != null && Number.isFinite(Number(r.questionsPerDay))
        ? String(r.questionsPerDay)
        : "";
    let timeVal = "";
    if (r.startHour != null && r.startMinute != null) {
      timeVal = `${pad2(Number(r.startHour))}:${pad2(Number(r.startMinute))}`;
    }
    const checked = r.active !== false ? "checked" : "";
    return `<li data-jid="${escAttr(jid)}">
      <label class="caderno-priv-label"><input type="checkbox" class="caderno-priv-active" ${checked} /> ${esc(
      label
    )}</label>
      <input class="caderno-priv-qpd" type="number" min="1" max="24" placeholder="—" value="${escAttr(
      qpd
    )}" title="Questões/dia (vazio = herdado)" />
      <input class="caderno-priv-time" type="time" value="${escAttr(timeVal)}" title="Início (vazio = herdado)" />
      <span class="caderno-priv-meta">${esc(jid)}</span>
    </li>`;
  }

  function collectEditPrivateRecipients() {
    if (!els.cadernoEditPrivateList) return [];
    const out = [];
    els.cadernoEditPrivateList.querySelectorAll("li[data-jid]").forEach((li) => {
      const userJid = li.getAttribute("data-jid") || "";
      if (!userJid) return;
      const active = li.querySelector(".caderno-priv-active")?.checked !== false;
      const qRaw = li.querySelector(".caderno-priv-qpd")?.value?.trim() ?? "";
      const tRaw = li.querySelector(".caderno-priv-time")?.value?.trim() ?? "";
      let questionsPerDay = null;
      if (qRaw !== "") {
        const n = Number(qRaw);
        if (Number.isFinite(n)) questionsPerDay = n;
      }
      let startHour = null;
      let startMinute = null;
      if (tRaw && tRaw.includes(":")) {
        const [hh, mm] = tRaw.split(":");
        const h = Number(hh);
        const m = Number(mm);
        if (Number.isFinite(h) && Number.isFinite(m)) {
          startHour = h;
          startMinute = m;
        }
      }
      out.push({ userJid, active, questionsPerDay, startHour, startMinute });
    });
    return out;
  }

  async function onCadernoEditLoadMembers() {
    if (!els.cadernoEditPrivateList || !els.cadernoEditStatus) return;
    els.cadernoEditStatus.textContent = "Carregando membros…";
    try {
      const data = await fetchJson(API.engagement);
      const members = data.members || [];
      const existing = new Set(
        [...els.cadernoEditPrivateList.querySelectorAll("li[data-jid]")].map(
          (li) => li.getAttribute("data-jid") || ""
        )
      );
      for (const m of members) {
        const jid = m.userJid;
        if (!jid || existing.has(jid)) continue;
        existing.add(jid);
        const row = renderPrivateRecipientEditRow({
          userJid: jid,
          active: true,
          displayLabel: m.displayLabel || m.userLabel || jid
        });
        els.cadernoEditPrivateList.insertAdjacentHTML("beforeend", row);
      }
      els.cadernoEditPrivateList.dataset.touched = "1";
      els.cadernoEditStatus.textContent = members.length
        ? `${members.length} membro(s) no grupo — adicionados os que faltavam na lista.`
        : "Lista vazia. Rode /sync-membros no WhatsApp.";
    } catch (e) {
      els.cadernoEditStatus.textContent = e.message || "Falha ao carregar.";
    }
  }

  function markCadernoEditPrivateRecipientsTouched() {
    if (els.cadernoEditPrivateList) els.cadernoEditPrivateList.dataset.touched = "1";
  }

  async function onCadernoEditDeliveryChange() {
    syncCadernoEditPrivatePanel();
    if (getCadernoEditDeliveryMode() !== "private" || !els.cadernoEditPrivateList) return;
    const has = els.cadernoEditPrivateList.querySelector("li[data-jid]");
    if (!has) await onCadernoEditLoadMembers();
  }

  function renderCadernos() {
    if (!els.cadernosList) return;
    if (!cadernosCache.length) {
      els.cadernosList.innerHTML =
        '<li class="engagement-empty">Nenhum caderno cadastrado. Clique em "Adicionar caderno" para enviar um PDF.</li>';
      return;
    }
    els.cadernosList.innerHTML = cadernosCache
      .map((c) => {
        const privBadge =
          c.deliveryMode === "private"
            ? '<span class="badge-mini" title="Envio no WhatsApp privado">Privado</span>'
            : "";
        let next =
          c.status === "active" ? formatNextRunPretty(c.nextRunAt, c.timezone) : "—";
        if (c.deliveryMode === "private" && c.status === "active") {
          const recs = c.privateRecipients || [];
          const times = recs
            .filter((r) => r.active && r.nextRunAt)
            .map((r) => new Date(r.nextRunAt).getTime())
            .filter((t) => !Number.isNaN(t));
          if (times.length) {
            next = formatNextRunPretty(new Date(Math.min(...times)).toISOString(), c.timezone);
          } else {
            next = "—";
          }
        }
        const last = c.lastRunAt ? formatNextRunPretty(c.lastRunAt, c.timezone) : "—";
        const published = typeof c.publishedCount === "number" ? c.publishedCount : c.cursor;
        const totalLabel = `${published}/${c.totalQuestions}`;
        const startHour = c.startHour != null ? c.startHour : c.sendHour;
        const startMinute = c.startMinute != null ? c.startMinute : c.sendMinute;
        const horario = `${pad2(startHour)}:${pad2(startMinute)}`;
        const perDay = c.questionsPerDay != null ? c.questionsPerDay : c.questionsPerRun;
        const isActive = c.status === "active";
        const canResume = c.status !== "active" && c.status !== "finished";
        const canRecycle =
          c.status === "paused_waiting_decision" || c.status === "finished";
        const randomBadge = c.randomOrder
          ? '<span class="badge-mini" title="Sorteia entre as não enviadas">Aleatório</span>'
          : "";
        const waitBadge = c.waitForAnswers
          ? '<span class="badge-mini" title="Só inicia o próximo dia quando engajados responderem">Esperar resposta</span>'
          : "";
        const todaySent = Number(c.currentDaySent || 0);
        const dayLine =
          c.currentDayDate && isActive
            ? `<div><strong>Hoje:</strong> ${todaySent}/${perDay} enviada(s)</div>`
            : "";
        return `
        <li class="caderno-card" data-id="${c.id}">
          <div class="caderno-card-head">
            <h4 class="caderno-card-name">${esc(c.name)} <small style="color:var(--muted);font-weight:500;">#${c.id}</small>${randomBadge}${waitBadge}${privBadge}</h4>
            <span class="caderno-card-status status-${esc(c.status)}">${esc(formatStatusLabel(c.status))}</span>
          </div>
          <div class="caderno-card-meta">
            <div><strong>Envio:</strong> ${
              c.deliveryMode === "private"
                ? `Privado — até ${(c.privateRecipients || []).filter((r) => r.active).length} destinatário(s); base ${perDay} q./dia às ${horario}`
                : `${perDay} q./dia a partir das ${horario}`
            }</div>
            <div><strong>Progresso:</strong> ${totalLabel}</div>
            ${dayLine}
            <div><strong>Próximo envio:</strong> ${esc(next)}</div>
            <div><strong>Último envio:</strong> ${esc(last)}</div>
          </div>
          <div class="caderno-card-actions">
            <button type="button" data-action="trigger" ${isActive ? "" : "disabled"} title="Envia a próxima questão agora (até 60s)">Enviar questão</button>
            <button type="button" data-action="edit" title="Editar nome, agenda e modo">Editar</button>
            <button type="button" data-action="toggle-random" title="${c.randomOrder ? "Desligar" : "Ligar"} ordem aleatória">${c.randomOrder ? "Ordem do PDF" : "Ordem aleatória"}</button>
            <button type="button" data-action="pause" ${isActive ? "" : "disabled"}>Pausar</button>
            <button type="button" data-action="resume" ${canResume ? "" : "disabled"}>${
          canRecycle ? "Retomar do começo" : "Retomar"
        }</button>
            <button type="button" data-action="recycle" ${canRecycle ? "" : "disabled"}>Reciclar (zerar cursor)</button>
            <button type="button" class="btn-caderno-danger" data-action="delete">Excluir</button>
          </div>
        </li>`;
      })
      .join("");
  }

  async function loadCadernos() {
    if (!els.cadernosList || !els.cadernosStatus) return;
    els.cadernosStatus.textContent = "Carregando…";
    try {
      const data = await fetchJson(API.cadernos);
      cadernosCache = data.cadernos || [];
      if (data.warning) {
        els.cadernosStatus.textContent = data.warning;
      } else if (!cadernosCache.length) {
        els.cadernosStatus.textContent = "Você ainda não tem cadernos cadastrados.";
      } else {
        const ativos = cadernosCache.filter((c) => c.status === "active").length;
        els.cadernosStatus.textContent = `${cadernosCache.length} caderno(s) — ${ativos} ativo(s).`;
      }
      renderCadernos();
    } catch (e) {
      els.cadernosStatus.textContent = e.message || "Não foi possível carregar.";
      cadernosCache = [];
      renderCadernos();
    }
  }

  function openCadernosModal() {
    if (!els.cadernosOverlay) return;
    els.cadernosOverlay.classList.add("open");
    els.cadernosOverlay.setAttribute("aria-hidden", "false");
    loadCadernos();
  }

  function closeCadernosModal() {
    if (!els.cadernosOverlay) return;
    els.cadernosOverlay.classList.remove("open");
    els.cadernosOverlay.setAttribute("aria-hidden", "true");
  }

  async function patchCadernoStatus(id, payload) {
    return fetchJson(API.cadernos, {
      method: "PATCH",
      body: JSON.stringify({ id, ...payload })
    });
  }

  async function onCadernosListClick(ev) {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    const card = btn.closest(".caderno-card");
    if (!card) return;
    const id = Number(card.dataset.id);
    if (!Number.isFinite(id)) return;
    const action = btn.dataset.action;
    const c = cadernosCache.find((x) => x.id === id);
    if (!c) return;

    const allButtons = card.querySelectorAll("button");
    allButtons.forEach((b) => (b.disabled = true));

    try {
      if (action === "edit") {
        openCadernoEditModal(c);
        return;
      }
      if (action === "pause") {
        await patchCadernoStatus(id, { status: "inactive" });
      } else if (action === "resume") {
        await patchCadernoStatus(id, { status: "active", recomputeNextRun: true });
      } else if (action === "trigger") {
        if (els.cadernosStatus) {
          els.cadernosStatus.textContent =
            "Pedido enviado. O bot publica a próxima questão em até 60s.";
        }
        await patchCadernoStatus(id, { triggerNow: true });
      } else if (action === "toggle-random") {
        await patchCadernoStatus(id, { randomOrder: !c.randomOrder });
      } else if (action === "recycle") {
        if (
          !confirm(
            `Reciclar o caderno "${c.name}"? Todas as questões voltam a ficar disponíveis para envio (zera o cursor).`
          )
        ) {
          return;
        }
        await patchCadernoStatus(id, {
          status: "active",
          cursor: 0,
          recomputeNextRun: true,
          recyclePublished: true
        });
      } else if (action === "delete") {
        if (!confirm(`Excluir o caderno "${c.name}" e todas as suas questões? Esta ação é permanente.`)) {
          return;
        }
        await fetchJson(API.cadernoDelete, {
          method: "POST",
          body: JSON.stringify({ id })
        });
      }
      await loadCadernos();
    } catch (e) {
      els.cadernosStatus.textContent = e.message || "Falha na ação.";
    } finally {
      renderCadernos();
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Falha ao ler arquivo"));
      reader.readAsDataURL(file);
    });
  }

  function getCadernoFormPayload() {
    const file = els.cadernoPdf && els.cadernoPdf.files && els.cadernoPdf.files[0];
    const name = (els.cadernoName.value || "").trim();
    const questionsPerDay = Number((els.cadernoPerDay && els.cadernoPerDay.value) || 3);
    const [hh, mm] = String((els.cadernoTime && els.cadernoTime.value) || "07:00").split(":");
    const startHour = Number(hh);
    const startMinute = Number(mm);
    const randomOrder = Boolean(els.cadernoRandom && els.cadernoRandom.checked);
    const waitForAnswers = Boolean(els.cadernoWait && els.cadernoWait.checked);
    const deliveryMode = getCadernoAddDeliveryMode();
    const createdByJid =
      deliveryMode === "private" ? digitsToWhatsAppJid((els.cadernoOwnerPhone && els.cadernoOwnerPhone.value) || "") : null;
    return {
      file,
      name,
      deliveryMode,
      createdByJid,
      schedule: {
        questionsPerDay: Number.isFinite(questionsPerDay) ? questionsPerDay : 3,
        startHour: Number.isFinite(startHour) ? startHour : 7,
        startMinute: Number.isFinite(startMinute) ? startMinute : 0,
        timezone: "America/Sao_Paulo",
        randomOrder,
        waitForAnswers
      }
    };
  }

  function renderCadernoPreview(result) {
    if (!els.cadernoPreviewBox) return;
    if (!result) {
      els.cadernoPreviewBox.classList.add("hidden");
      els.cadernoPreviewBox.innerHTML = "";
      return;
    }
    const summary = result.summary || {};
    const lines = [];
    lines.push("<h4>Pré-visualização</h4>");
    lines.push(
      `<div><strong>Total de questões extraídas:</strong> ${result.totalQuestions}</div>`
    );
    lines.push(
      `<div><strong>Entradas no gabarito:</strong> ${result.totalGabaritoEntries ?? "?"}</div>`
    );
    lines.push(
      `<div><strong>Múltipla escolha / Certo-Errado:</strong> ${summary.multipleChoice || 0} / ${
        summary.trueFalse || 0
      }</div>`
    );
    if (summary.withoutAnswerKey) {
      lines.push(
        `<div class="caderno-preview-warning"><strong>${summary.withoutAnswerKey}</strong> questão(ões) sem gabarito mapeado.</div>`
      );
    }
    if (result.warnings && result.warnings.length) {
      lines.push(
        `<div style="margin-top:0.5rem"><strong>Avisos do parser:</strong></div><ul>${result.warnings
          .slice(0, 12)
          .map((w) => `<li>${esc(w)}</li>`)
          .join("")}${result.warnings.length > 12 ? "<li>…</li>" : ""}</ul>`
      );
    }
    if (result.preview && result.preview.length) {
      const first = result.preview[0];
      lines.push("<div style='margin-top:0.65rem'><strong>Primeira questão:</strong></div>");
      lines.push(`<div style="opacity:.8">${esc(first.banca || "")}</div>`);
      lines.push(`<div style="opacity:.8;margin-bottom:.35rem">${esc(first.subject || "")}</div>`);
      lines.push(`<pre style="white-space:pre-wrap;font:inherit;margin:0">${esc(first.statementText)}</pre>`);
      lines.push(
        `<div style="margin-top:.3rem"><strong>Gabarito:</strong> ${esc(first.answerKey || "?")}</div>`
      );
      lines.push(`<div><a href="${escAttr(first.tecUrl)}" target="_blank" rel="noreferrer">${esc(first.tecUrl)}</a></div>`);
    }
    els.cadernoPreviewBox.innerHTML = lines.join("");
    els.cadernoPreviewBox.classList.remove("hidden");
  }

  async function callCadernoUpload(extra) {
    const form = getCadernoFormPayload();
    if (!form.file) throw new Error("Selecione um PDF.");
    if (!extra.previewOnly && !form.name) throw new Error("Informe um nome para o caderno.");
    const dataUrl = await readFileAsDataUrl(form.file);
    const body = {
      name: form.name,
      schedule: form.schedule,
      pdfBase64: dataUrl,
      deliveryMode: form.deliveryMode,
      createdByJid: form.createdByJid,
      ...extra
    };
    return fetchJson(API.cadernoUpload, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async function onCadernoPreview() {
    if (cadernoUploadInFlight) return;
    cadernoUploadInFlight = true;
    els.cadernoAddStatus.textContent = "Lendo PDF e extraindo…";
    renderCadernoPreview(null);
    try {
      const result = await callCadernoUpload({ previewOnly: true });
      els.cadernoAddStatus.textContent = `${result.totalQuestions} questão(ões) extraída(s).`;
      renderCadernoPreview(result);
    } catch (e) {
      els.cadernoAddStatus.textContent = e.message || "Falha no preview.";
    } finally {
      cadernoUploadInFlight = false;
    }
  }

  async function onCadernoSave(activate) {
    if (cadernoUploadInFlight) return;
    cadernoUploadInFlight = true;
    els.cadernoAddStatus.textContent = activate ? "Salvando e ativando…" : "Salvando…";
    try {
      const form = getCadernoFormPayload();
      if (form.deliveryMode === "private" && !form.createdByJid) {
        els.cadernoAddStatus.textContent =
          "Modo privado: preencha seu WhatsApp (DDI+DDD+número, só dígitos).";
        return;
      }
      const result = await callCadernoUpload({ activate });
      els.cadernoAddStatus.textContent = `Caderno #${result.cadernoId} salvo (${result.totalQuestions} questões).`;
      renderCadernoPreview(result);
      await loadCadernos();
      setTimeout(() => {
        closeCadernoAddModal();
      }, 1200);
    } catch (e) {
      els.cadernoAddStatus.textContent = e.message || "Falha ao salvar.";
    } finally {
      cadernoUploadInFlight = false;
    }
  }

  function openCadernoEditModal(caderno) {
    if (!els.cadernoEditOverlay) return;
    els.cadernoEditId.value = String(caderno.id);
    els.cadernoEditName.value = caderno.name || "";
    const perDay =
      caderno.questionsPerDay != null
        ? Number(caderno.questionsPerDay)
        : Number(caderno.questionsPerRun || 3);
    const startHour =
      caderno.startHour != null ? Number(caderno.startHour) : Number(caderno.sendHour || 7);
    const startMinute =
      caderno.startMinute != null
        ? Number(caderno.startMinute)
        : Number(caderno.sendMinute || 0);
    els.cadernoEditPerDay.value = String(perDay);
    els.cadernoEditTime.value = `${pad2(startHour)}:${pad2(startMinute)}`;
    els.cadernoEditRandom.checked = Boolean(caderno.randomOrder);
    if (els.cadernoEditWait) els.cadernoEditWait.checked = Boolean(caderno.waitForAnswers);
    const dm = caderno.deliveryMode === "private" ? "private" : "group";
    if (els.cadernoEditDeliveryGroup) els.cadernoEditDeliveryGroup.checked = dm === "group";
    if (els.cadernoEditDeliveryPrivate) els.cadernoEditDeliveryPrivate.checked = dm === "private";
    syncCadernoEditPrivatePanel();
    if (els.cadernoEditPrivateList) {
      els.cadernoEditPrivateList.dataset.touched = "0";
      els.cadernoEditPrivateList.innerHTML = (caderno.privateRecipients || [])
        .map((r) =>
          renderPrivateRecipientEditRow({
            userJid: r.userJid,
            active: r.active,
            questionsPerDay: r.questionsPerDay,
            startHour: r.startHour,
            startMinute: r.startMinute,
            displayLabel: r.userJid
          })
        )
        .join("");
    }
    els.cadernoEditStatus.textContent = "";
    els.cadernoEditOverlay.classList.add("open");
    els.cadernoEditOverlay.setAttribute("aria-hidden", "false");
  }

  function closeCadernoEditModal() {
    if (!els.cadernoEditOverlay) return;
    els.cadernoEditOverlay.classList.remove("open");
    els.cadernoEditOverlay.setAttribute("aria-hidden", "true");
  }

  async function onCadernoEditSave() {
    const id = Number(els.cadernoEditId.value);
    if (!Number.isFinite(id) || id <= 0) return;
    const current = cadernosCache.find((x) => x.id === id);
    if (!current) {
      els.cadernoEditStatus.textContent = "Caderno não encontrado na lista.";
      return;
    }

    const name = (els.cadernoEditName.value || "").trim();
    const questionsPerDay = Number(els.cadernoEditPerDay.value || 3);
    const [hh, mm] = String(els.cadernoEditTime.value || "07:00").split(":");
    const startHour = Number(hh);
    const startMinute = Number(mm);
    const randomOrder = Boolean(els.cadernoEditRandom.checked);
    const waitForAnswers = Boolean(els.cadernoEditWait && els.cadernoEditWait.checked);
    const editDm = getCadernoEditDeliveryMode();
    const currentDm = current.deliveryMode === "private" ? "private" : "group";

    const currentPerDay =
      current.questionsPerDay != null ? Number(current.questionsPerDay) : Number(current.questionsPerRun);
    const currentStartHour =
      current.startHour != null ? Number(current.startHour) : Number(current.sendHour);
    const currentStartMinute =
      current.startMinute != null ? Number(current.startMinute) : Number(current.sendMinute);

    const payload = { id };
    if (name && name !== current.name) payload.name = name;
    if (questionsPerDay !== currentPerDay) payload.questionsPerDay = questionsPerDay;
    if (Number.isFinite(startHour) && startHour !== currentStartHour)
      payload.startHour = startHour;
    if (Number.isFinite(startMinute) && startMinute !== currentStartMinute)
      payload.startMinute = startMinute;
    if (randomOrder !== Boolean(current.randomOrder)) payload.randomOrder = randomOrder;
    if (waitForAnswers !== Boolean(current.waitForAnswers))
      payload.waitForAnswers = waitForAnswers;

    if (editDm !== currentDm) payload.deliveryMode = editDm;
    let includePrivateRecipients = false;
    if (editDm === "private") {
      if (editDm !== currentDm) includePrivateRecipients = true;
      if (els.cadernoEditPrivateList && els.cadernoEditPrivateList.dataset.touched === "1") {
        includePrivateRecipients = true;
      }
      if (includePrivateRecipients) {
        const pr = collectEditPrivateRecipients();
        if (pr.length === 0) {
          els.cadernoEditStatus.textContent =
            "Modo privado: marque ao menos um destinatário (use “Carregar membros do grupo”).";
          return;
        }
        payload.privateRecipients = pr;
      }
    }

    if (Object.keys(payload).length === 1) {
      els.cadernoEditStatus.textContent = "Nada para salvar — sem alterações.";
      return;
    }

    els.btnCadernoEditSave.disabled = true;
    els.cadernoEditStatus.textContent = "Salvando…";
    try {
      await fetchJson(API.cadernos, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      els.cadernoEditStatus.textContent = "Alterações salvas.";
      await loadCadernos();
      setTimeout(() => closeCadernoEditModal(), 700);
    } catch (e) {
      els.cadernoEditStatus.textContent = e.message || "Falha ao salvar.";
    } finally {
      els.btnCadernoEditSave.disabled = false;
    }
  }

  function openCadernoAddModal() {
    if (!els.cadernoAddOverlay) return;
    if (els.cadernoName) els.cadernoName.value = "";
    if (els.cadernoPdf) els.cadernoPdf.value = "";
    if (els.cadernoPerDay) els.cadernoPerDay.value = "3";
    if (els.cadernoTime) els.cadernoTime.value = "07:00";
    if (els.cadernoRandom) els.cadernoRandom.checked = false;
    if (els.cadernoWait) els.cadernoWait.checked = false;
    if (els.cadernoDeliveryGroup) els.cadernoDeliveryGroup.checked = true;
    if (els.cadernoDeliveryPrivate) els.cadernoDeliveryPrivate.checked = false;
    if (els.cadernoOwnerPhone) els.cadernoOwnerPhone.value = "";
    syncCadernoAddPrivatePanel();
    if (els.cadernoAddStatus) els.cadernoAddStatus.textContent = "";
    renderCadernoPreview(null);
    els.cadernoAddOverlay.classList.add("open");
    els.cadernoAddOverlay.setAttribute("aria-hidden", "false");
  }

  function closeCadernoAddModal() {
    if (!els.cadernoAddOverlay) return;
    els.cadernoAddOverlay.classList.remove("open");
    els.cadernoAddOverlay.setAttribute("aria-hidden", "true");
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

  if (els.btnCadernosOpen) els.btnCadernosOpen.addEventListener("click", openCadernosModal);
  if (els.cadernosClose) els.cadernosClose.addEventListener("click", closeCadernosModal);
  if (els.cadernosOverlay) {
    els.cadernosOverlay.addEventListener("click", (ev) => {
      if (ev.target === els.cadernosOverlay) closeCadernosModal();
    });
  }
  if (els.cadernosList) els.cadernosList.addEventListener("click", onCadernosListClick);
  if (els.btnCadernoAdd) els.btnCadernoAdd.addEventListener("click", openCadernoAddModal);
  if (els.cadernoAddClose) els.cadernoAddClose.addEventListener("click", closeCadernoAddModal);
  if (els.cadernoAddOverlay) {
    els.cadernoAddOverlay.addEventListener("click", (ev) => {
      if (ev.target === els.cadernoAddOverlay) closeCadernoAddModal();
    });
  }
  if (els.btnCadernoPreview) els.btnCadernoPreview.addEventListener("click", onCadernoPreview);
  if (els.btnCadernoSave) els.btnCadernoSave.addEventListener("click", () => onCadernoSave(false));
  if (els.btnCadernoSaveActivate)
    els.btnCadernoSaveActivate.addEventListener("click", () => onCadernoSave(true));

  if (els.cadernoEditClose) els.cadernoEditClose.addEventListener("click", closeCadernoEditModal);
  if (els.btnCadernoEditCancel)
    els.btnCadernoEditCancel.addEventListener("click", closeCadernoEditModal);
  if (els.cadernoEditOverlay) {
    els.cadernoEditOverlay.addEventListener("click", (ev) => {
      if (ev.target === els.cadernoEditOverlay) closeCadernoEditModal();
    });
  }
  if (els.btnCadernoEditSave) els.btnCadernoEditSave.addEventListener("click", onCadernoEditSave);

  if (els.cadernoDeliveryGroup) els.cadernoDeliveryGroup.addEventListener("change", syncCadernoAddPrivatePanel);
  if (els.cadernoDeliveryPrivate) els.cadernoDeliveryPrivate.addEventListener("change", syncCadernoAddPrivatePanel);
  if (els.cadernoEditDeliveryGroup) els.cadernoEditDeliveryGroup.addEventListener("change", onCadernoEditDeliveryChange);
  if (els.cadernoEditDeliveryPrivate) els.cadernoEditDeliveryPrivate.addEventListener("change", onCadernoEditDeliveryChange);
  if (els.btnCadernoEditLoadMembers) {
    els.btnCadernoEditLoadMembers.addEventListener("click", () => onCadernoEditLoadMembers());
  }
  if (els.cadernoEditPrivateList) {
    els.cadernoEditPrivateList.addEventListener("change", (ev) => {
      if (ev.target.closest(".caderno-priv-active, .caderno-priv-qpd, .caderno-priv-time")) {
        markCadernoEditPrivateRecipientsTouched();
      }
    });
    els.cadernoEditPrivateList.addEventListener("input", (ev) => {
      if (ev.target.closest(".caderno-priv-qpd, .caderno-priv-time")) {
        markCadernoEditPrivateRecipientsTouched();
      }
    });
  }

  init();
})();
