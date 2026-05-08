(function () {
  const API = {
    questions: "/api/questions",
    ranking: "/api/ranking",
    detail: (id) => `/api/question-detail?shortId=${encodeURIComponent(id)}`,
    submit: "/api/question-submit"
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
    btnClose: document.getElementById("modal-close")
  };

  let currentShortId = null;
  let submitPayload = null;

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
      els.questionsGrid.innerHTML = '<p class="loading">Nenhuma questão cadastrada.</p>';
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

  async function init() {
    try {
      const [rankRes, qRes] = await Promise.all([
        fetchJson(API.ranking),
        fetchJson(API.questions)
      ]);
      renderRanking(rankRes);
      renderQuestions(qRes.questions || []);
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

  init();
})();
