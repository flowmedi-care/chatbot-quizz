/**
 * UI compartilhada do solver (Atividades + Omissas) — mesmo fluxo da Via Aprovação:
 * enunciado separado, clique para marcar, duplo clique para riscar, Resolver.
 */
(function (global) {
  "use strict";

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function optionsOf(q) {
    if (!q) return [];
    if (q.questionType === "true_false") {
      return [
        { letter: "c", label: "Certo", text: "Certo" },
        { letter: "e", label: "Errado", text: "Errado" }
      ];
    }
    const raw =
      Array.isArray(q.options) && q.options.length
        ? q.options
        : ["A", "B", "C", "D", "E"].map((L) => ({ label: L, text: "" }));
    return raw.map((o) => {
      const L = String(o.label || o.letter || "")
        .trim()
        .toUpperCase()
        .slice(0, 1);
      const text = String(o.text || "").trim();
      return { letter: L.toLowerCase(), label: L, text: text || L };
    });
  }

  function isOptionLine(line) {
    const t = String(line || "").trim();
    if (!t) return false;
    if (/^[A-Ea-e]\s*[\)\.\-–:]\s*\S/.test(t)) return true;
    if (/^[A-Ea-e]\s*[\)\.\-–:]\s*$/.test(t)) return true;
    if (/^(Certo|Errado)\s*$/i.test(t)) return true;
    return false;
  }

  function stripStatementChoices(raw, options, questionType) {
    let text = String(raw || "")
      .replace(/\r/g, "")
      .trim();
    if (!text) return "";

    if (questionType === "true_false") {
      text = text.replace(/\s*\bCerto\s+Errado\s*$/i, "").trim();
      const lines = text.split("\n");
      if (lines.length >= 2) {
        const a = lines[lines.length - 2].trim();
        const b = lines[lines.length - 1].trim();
        if (/^certo$/i.test(a) && /^errado$/i.test(b)) {
          return lines.slice(0, -2).join("\n").trim();
        }
      }
      return text;
    }

    const opts = Array.isArray(options) ? options : [];
    const firstText = String((opts[0] && opts[0].text) || "").trim();
    const firstLabel = String((opts[0] && (opts[0].label || opts[0].letter)) || "A").trim();
    if (firstText && firstText.length > 1) {
      const idx = text.lastIndexOf(firstText);
      if (idx > 24) {
        const before = text.slice(0, idx);
        const cut = before.search(
          new RegExp(`[\\s\\n]*${firstLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[\\)\\.]\\s*$`, "i")
        );
        if (cut > 24) return before.slice(0, cut).trim();
      }
    }

    const lines = text.split("\n");
    let i = lines.length - 1;
    while (i >= 0 && !String(lines[i]).trim()) i--;
    const end = i;
    while (i >= 0 && isOptionLine(lines[i])) i--;
    if (end - i >= 2) return lines.slice(0, i + 1).join("\n").trim();

    const inline = text.search(/\s+[Aa]\s*\)\s+\S/);
    if (inline > 24) {
      const tail = text.slice(inline);
      const labels = tail.match(/\b[A-Ea-e]\s*\)/g) || [];
      if (labels.length >= 3) return text.slice(0, inline).trim();
    }
    return text;
  }

  function statementHtml(q) {
    const opts = optionsOf(q);
    const body = stripStatementChoices(q.statementText, opts, q.questionType);
    let html = "";
    if (body) html += `<div class="statement-text">${esc(body)}</div>`;
    if (q.statementMediaUrl && q.statementMediaMimeType) {
      if (String(q.statementMediaMimeType).startsWith("image/")) {
        html += `<img src="${esc(q.statementMediaUrl)}" alt="Enunciado" crossorigin="anonymous" />`;
      } else {
        html += `<p><a href="${esc(q.statementMediaUrl)}" target="_blank" rel="noopener">Abrir documento</a></p>`;
      }
    }
    return html || "<p>(Sem enunciado)</p>";
  }

  function optionInner(opt, questionType) {
    const same =
      questionType === "true_false" ||
      opt.text.trim().toLowerCase() === opt.label.trim().toLowerCase();
    if (same) return `<span class="solver-opt-text">${esc(opt.text)}</span>`;
    return `<span class="solver-opt-prefix">${esc(opt.label)})</span> <span class="solver-opt-text">${esc(opt.text)}</span>`;
  }

  function renderChoices(el, q) {
    if (!el) return;
    const opts = optionsOf(q);
    el.classList.remove("choice-grid", "tf");
    el.classList.add("solver-choices");
    el.innerHTML = opts
      .map(
        (opt) =>
          `<button type="button" class="solver-opt btn-choice" data-letter="${esc(opt.letter)}">${optionInner(
            opt,
            q.questionType
          )}</button>`
      )
      .join("");
  }

  function paintChoices(el, state) {
    if (!el) return;
    const selected = String(state.selected || "").toLowerCase();
    const eliminated = state.eliminated || new Set();
    const locked = Boolean(state.locked);
    const answerKey = String(state.answerKey || "").toLowerCase().slice(0, 1);
    const yours = String(state.yourLetter || selected || "").toLowerCase();
    const showResult = Boolean(state.showResult && answerKey);

    el.querySelectorAll(".solver-opt").forEach((btn) => {
      const letter = String(btn.dataset.letter || "").toLowerCase();
      btn.classList.toggle("selected", letter === selected && !showResult);
      btn.classList.toggle("eliminated", eliminated.has(letter));
      btn.classList.toggle("is-correct", showResult && letter === answerKey);
      btn.classList.toggle("is-wrong", showResult && letter === yours && letter !== answerKey);
      btn.disabled =
        locked || showResult || btn.classList.contains("assist-false");
    });
  }

  function fillResult(el, q) {
    if (!el) return;
    if (!q || !q.alreadyAnswered || q.correct == null) {
      el.classList.add("hidden");
      el.textContent = "";
      el.classList.remove("ok", "bad");
      return;
    }
    el.classList.remove("hidden");
    el.classList.toggle("ok", Boolean(q.correct));
    el.classList.toggle("bad", !q.correct);
    el.textContent = q.correct
      ? "Você acertou!"
      : `Você errou! Gabarito: ${String(q.answerKey || "").toUpperCase()}.`;
  }

  function bindChoices(el, handlers) {
    if (!el) return;
    el.querySelectorAll(".solver-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const letter = btn.dataset.letter;
        if (!letter || btn.classList.contains("eliminated")) return;
        if (handlers.onAssist && handlers.assistMode && handlers.assistMode()) {
          void handlers.onAssist(letter);
          return;
        }
        if (handlers.onSelect) handlers.onSelect(letter);
      });
      btn.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        const letter = btn.dataset.letter;
        if (!letter || (handlers.isLocked && handlers.isLocked())) return;
        if (handlers.onToggleEliminated) handlers.onToggleEliminated(letter);
      });
    });
  }

  function formatQuestionMs(ms) {
    const s = Math.floor(Math.max(0, ms) / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m > 0) return `${m}:${String(rem).padStart(2, "0")}`;
    return `${s}s`;
  }

  function createTimer(els) {
    let openedAt = 0;
    let frozenMs = null;
    let tick = null;

    function paint() {
      if (!els.timer) return;
      if (frozenMs != null) {
        els.timer.textContent = formatQuestionMs(frozenMs);
        return;
      }
      els.timer.textContent = formatQuestionMs(openedAt ? Date.now() - openedAt : 0);
    }

    function stop() {
      if (tick) {
        clearInterval(tick);
        tick = null;
      }
    }

    function start(frozen) {
      stop();
      openedAt = Date.now();
      frozenMs = frozen != null && Number(frozen) > 0 ? Number(frozen) : null;
      if (els.hint) {
        els.hint.textContent = frozenMs ? "Tempo do app" : "Visual — não entra nas estatísticas";
      }
      paint();
      if (frozenMs != null) return;
      tick = setInterval(paint, 1000);
    }

    return { start, stop, paint };
  }

  function createViaPanel(els, deps) {
    function renderNotes(notes) {
      const list = Array.isArray(notes) ? notes : [];
      if (!els.notes) return;
      els.notes.innerHTML = list
        .map((n) => {
          const when = n.created_at
            ? new Date(n.created_at).toLocaleString("pt-BR", {
                dateStyle: "short",
                timeStyle: "short"
              })
            : "";
          return `<li><p class="via-note-meta">${esc(when)}</p><p class="via-note-body">${esc(n.body)}</p></li>`;
        })
        .join("");
      if (els.empty) {
        els.empty.classList.toggle("hidden", list.length > 0);
        if (!list.length && !els.empty.textContent) els.empty.textContent = "Nenhuma anotação ainda.";
      }
    }

    async function load(shortId) {
      if (!els.panel) return { durationMs: null, linked: false };
      els.panel.classList.remove("hidden");
      if (els.draft) els.draft.value = "";
      if (els.status) els.status.textContent = "";
      try {
        const data = await deps.fetchJson(deps.viaGetUrl(shortId));
        if (data.linked) {
          if (els.empty) els.empty.textContent = "Nenhuma anotação ainda.";
          renderNotes(data.notes);
          return data;
        }
        renderNotes([]);
        if (els.empty) {
          els.empty.classList.remove("hidden");
          els.empty.textContent =
            data.reason === "jid_not_linked"
              ? "WhatsApp ainda não vinculado na Via Aprovação."
              : "Caderno não sincronizado com a Via Aprovação.";
        }
        return data;
      } catch {
        renderNotes([]);
        if (els.empty) {
          els.empty.classList.remove("hidden");
          els.empty.textContent = "Não foi possível carregar as anotações do app.";
        }
        return { linked: false, durationMs: null };
      }
    }

    async function send(shortId) {
      const body = els.draft ? els.draft.value.trim() : "";
      if (!shortId || !body) return;
      if (els.send) els.send.disabled = true;
      if (els.status) els.status.textContent = "Salvando…";
      try {
        await deps.fetchJson("/api/omissas-via", {
          method: "POST",
          body: JSON.stringify({ t: deps.token(), shortId, body })
        });
        if (els.draft) els.draft.value = "";
        await load(shortId);
        if (els.status) els.status.textContent = "Salvo no app.";
      } catch (e) {
        if (els.status) els.status.textContent = e.message || "Erro ao salvar.";
      } finally {
        if (els.send) els.send.disabled = false;
      }
    }

    if (els.send && !els.send.dataset.bound) {
      els.send.dataset.bound = "1";
      els.send.addEventListener("click", () => {
        const sid = deps.currentShortId ? deps.currentShortId() : "";
        void send(sid);
      });
    }

    return { load, send, renderNotes };
  }

  global.PapaQuizUi = {
    esc,
    optionsOf,
    stripStatementChoices,
    statementHtml,
    renderChoices,
    paintChoices,
    bindChoices,
    fillResult,
    formatQuestionMs,
    createTimer,
    createViaPanel
  };
})(window);
