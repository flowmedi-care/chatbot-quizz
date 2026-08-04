(function () {
  "use strict";

  const API = {
    session: (t) => `/api/omissas-session?t=${encodeURIComponent(t)}`,
    answer: "/api/omissas-answer",
    results: (t) => `/api/omissas-results?t=${encodeURIComponent(t)}`
  };

  const els = {
    error: document.getElementById("omissas-error"),
    loading: document.getElementById("omissas-loading"),
    quiz: document.getElementById("omissas-quiz"),
    results: document.getElementById("omissas-results"),
    title: document.getElementById("q-title"),
    meta: document.getElementById("q-meta"),
    progress: document.getElementById("q-progress"),
    statement: document.getElementById("q-statement"),
    comment: document.getElementById("q-comment"),
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

    const doneSoFar = answeredAtStart + index;
    const total = totalInSession;
    els.title.textContent = `Questão #${q.shortId}`;
    els.meta.textContent = q.creatorName ? `Por ${q.creatorName}` : "";
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
      btn.addEventListener("click", () => onChoose(btn.dataset.letter));
    });
  }

  async function onChoose(letter) {
    if (submitting) return;
    const q = pending[index];
    if (!q || !letter) return;

    submitting = true;
    els.choices.querySelectorAll(".btn-choice").forEach((b) => {
      b.disabled = true;
      if (b.dataset.letter === letter) b.classList.add("selected");
    });
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
        b.disabled = false;
        b.classList.remove("selected");
      });
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

      els.summary.innerHTML = `
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
            <article class="omissas-result-item">
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
            </article>
          `;
        })
        .join("");
    } catch (e) {
      if (e.status === 409) {
        showError("Ainda há questões pendentes. Recarregue o link ou continue respondendo.");
        return;
      }
      showError(e.message || "Erro ao carregar resultado.");
    }
  }

  async function init() {
    token = tokenFromUrl();
    if (!token) {
      showError("Link incompleto. No WhatsApp, envie /omissas e use o link pessoal da mensagem.");
      return;
    }

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
