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

  function mapStoredOptions(raw) {
    if (!Array.isArray(raw) || !raw.length) return [];
    return raw
      .map((o) => {
        const L = String((o && (o.label || o.letter)) || "")
          .trim()
          .toUpperCase()
          .slice(0, 1);
        if (!L) return null;
        return { letter: L.toLowerCase(), label: L, text: String((o && o.text) || "").trim() };
      })
      .filter(Boolean);
  }

  function hasRealOptionText(opts) {
    return (opts || []).some((o) => {
      const t = String(o.text || "").trim();
      const L = String(o.label || "").trim();
      return t.length > 1 && t.toLowerCase() !== L.toLowerCase();
    });
  }

  function parseChoiceBlock(raw) {
    const text = String(raw || "")
      .replace(/\r/g, "")
      .trim();
    if (!text) return { statement: "", options: [] };

    const lines = text.split("\n");
    let last = lines.length - 1;
    while (last >= 0 && !String(lines[last]).trim()) last--;
    let first = last;
    const found = [];
    while (first >= 0) {
      const t = String(lines[first]).trim();
      if (!t) {
        first--;
        continue;
      }
      const m = t.match(/^([A-Ea-e])\s*[\)\.\-–:]\s*(.*)$/);
      if (m) {
        found.push({ letter: m[1].toUpperCase(), text: String(m[2] || "").trim() });
        first--;
        continue;
      }
      break;
    }
    found.reverse();
    const letters = found.map((c) => c.letter).join("");
    const sequential =
      found.length >= 2 &&
      found[0].letter === "A" &&
      letters === "ABCDE".slice(0, found.length) &&
      found.some((c) => c.text.length > 0);
    if (sequential) {
      return {
        statement: lines.slice(0, first + 1).join("\n").trim(),
        options: found.map((c) => ({
          letter: c.letter.toLowerCase(),
          label: c.letter,
          text: c.text
        }))
      };
    }

    const start = text.search(/(?:^|[\s\n])[Aa]\s*\)\s+\S/);
    if (start >= 0) {
      const cut = text[start] && /\s/.test(text[start]) ? start + 1 : start;
      const head = text.slice(0, cut).trim();
      const tail = text.slice(cut).trim();
      const re = /([A-Ea-e])\s*\)\s+/g;
      const marks = [];
      let m;
      while ((m = re.exec(tail))) {
        marks.push({ letter: m[1].toUpperCase(), at: m.index, len: m[0].length });
      }
      if (marks.length >= 3 && marks[0].letter === "A") {
        const options = marks.map((mark, idx) => {
          const from = mark.at + mark.len;
          const to = idx + 1 < marks.length ? marks[idx + 1].at : tail.length;
          return {
            letter: mark.letter.toLowerCase(),
            label: mark.letter,
            text: tail.slice(from, to).trim()
          };
        });
        if (options.filter((o) => o.text.length > 1).length >= 3) {
          return { statement: head, options };
        }
      }
    }

    return { statement: text, options: [] };
  }

  function letterFallback(stored) {
    const labels = stored.length
      ? stored.map((o) => o.label)
      : ["A", "B", "C", "D", "E"];
    return labels.map((L) => ({
      letter: L.toLowerCase(),
      label: L,
      text: ""
    }));
  }

  function optionsOf(q) {
    return normalizeQuestion(q).options;
  }

  function stripStatementChoices(raw, options, questionType) {
    return normalizeQuestion({
      statementText: raw,
      options,
      questionType
    }).statement;
  }

  function normalizeQuestion(q) {
    if (!q) return { statement: "", options: [] };
    const rawStatement = String(q.statementText || "").replace(/\r/g, "").trim();

    if (q.questionType === "true_false") {
      let text = rawStatement.replace(/\s*\bCerto\s+Errado\s*$/i, "").trim();
      const lines = text.split("\n");
      if (lines.length >= 2) {
        const a = lines[lines.length - 2].trim();
        const b = lines[lines.length - 1].trim();
        if (/^certo$/i.test(a) && /^errado$/i.test(b)) {
          text = lines.slice(0, -2).join("\n").trim();
        }
      }
      return {
        statement: text,
        options: [
          { letter: "c", label: "Certo", text: "Certo" },
          { letter: "e", label: "Errado", text: "Errado" }
        ]
      };
    }

    const parsed = parseChoiceBlock(rawStatement);
    const stored = mapStoredOptions(q.options);
    const options = hasRealOptionText(stored)
      ? stored.map((o) => ({ ...o, text: o.text || o.label }))
      : parsed.options.length
        ? parsed.options
        : letterFallback(stored);

    let statement = rawStatement;
    if (hasRealOptionText(options)) {
      if (parsed.options.length) statement = parsed.statement;
      else {
        const first = options[0];
        const idx = statement.lastIndexOf(first.text);
        if (idx > 24) {
          const before = statement.slice(0, idx);
          const cut = before.search(
            new RegExp(
              `[\\s\\n]*${first.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[\\)\\.]\\s*$`,
              "i"
            )
          );
          if (cut > 24) statement = before.slice(0, cut).trim();
        }
      }
    }

    return { statement, options };
  }

  function statementHtml(q) {
    const { statement } = normalizeQuestion(q);
    let html = "";
    if (statement) html += `<div class="statement-text">${esc(statement)}</div>`;
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
    const text = String(opt.text || "").trim();
    const same =
      questionType === "true_false" ||
      !text ||
      text.toLowerCase() === opt.label.trim().toLowerCase();
    if (same) {
      return `<span class="solver-opt-prefix">${esc(opt.label)}</span>${
        text && text.toLowerCase() !== opt.label.toLowerCase()
          ? ` <span class="solver-opt-text">${esc(text)}</span>`
          : ""
      }`;
    }
    return `<span class="solver-opt-prefix">${esc(opt.label)})</span> <span class="solver-opt-text">${esc(text)}</span>`;
  }

  function renderChoices(el, q) {
    if (!el) return;
    const opts = normalizeQuestion(q).options;
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

  function paintAiComment(text, opts) {
    const wrap = document.getElementById("q-ai-comment");
    const body = document.getElementById("q-ai-comment-body");
    const kicker = wrap ? wrap.querySelector(".solver-ai-kicker") : null;
    if (!wrap || !body) return;
    const t = String(text || "").trim();
    const pending = Boolean(opts && opts.pending) && !t;
    const warn = Boolean(opts && opts.warn) && !t;
    wrap.classList.toggle("hidden", !t && !pending && !warn);
    wrap.classList.toggle("is-warn", warn);
    wrap.classList.toggle("is-pending", pending);
    if (kicker) {
      kicker.textContent = warn ? "IA" : pending ? "IA" : "Resposta da IA";
    }
    body.textContent = warn
      ? "Sem resposta — crédito da API esgotado ou Via Aprovação ainda não vinculada."
      : pending
        ? "Aguardando resposta da IA…"
        : t;
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

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const type = String(el.type || "text").toLowerCase();
      return type !== "button" && type !== "checkbox" && type !== "radio" && type !== "submit";
    }
    return Boolean(el.isContentEditable);
  }

  function bindSwipeNav(el, handlers) {
    if (!el || el.dataset.swipeBound) return;
    el.dataset.swipeBound = "1";
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const threshold = 56;

    el.addEventListener(
      "touchstart",
      (e) => {
        if (handlers.isEnabled && !handlers.isEnabled()) return;
        if (e.touches.length !== 1) return;
        if (isTypingTarget(e.target)) return;
        tracking = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      },
      { passive: true }
    );

    el.addEventListener(
      "touchend",
      (e) => {
        if (!tracking) return;
        tracking = false;
        if (handlers.isEnabled && !handlers.isEnabled()) return;
        const t = e.changedTouches[0];
        if (!t) return;
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy) * 1.2) return;
        if (dx < 0) {
          if (handlers.onNext) handlers.onNext();
        } else if (handlers.onPrev) {
          handlers.onPrev();
        }
      },
      { passive: true }
    );
  }

  function createTimer(els) {
    let openedAt = 0;
    let accumulatedMs = 0;
    let frozenMs = null;
    let paused = false;
    let tick = null;

    function currentMs() {
      if (frozenMs != null) return frozenMs;
      if (paused) return accumulatedMs;
      return accumulatedMs + (openedAt ? Date.now() - openedAt : 0);
    }

    function stopTick() {
      if (tick) {
        clearInterval(tick);
        tick = null;
      }
    }

    function startTick() {
      stopTick();
      if (frozenMs != null || paused) return;
      tick = setInterval(paint, 1000);
    }

    function syncControls() {
      if (els.pauseBtn) {
        const frozen = frozenMs != null;
        els.pauseBtn.disabled = frozen;
        els.pauseBtn.textContent = paused && !frozen ? "Continuar" : "Pausar";
        els.pauseBtn.setAttribute("aria-pressed", paused && !frozen ? "true" : "false");
        els.pauseBtn.title = paused ? "Continuar cronômetro" : "Pausar cronômetro";
      }
      if (els.resetBtn) {
        els.resetBtn.disabled = frozenMs != null;
      }
      if (els.hint) {
        if (frozenMs != null) els.hint.textContent = "Tempo nesta questão";
        else if (paused) els.hint.textContent = "Pausado";
        else els.hint.textContent = "";
      }
    }

    function paint() {
      if (els.timer) els.timer.textContent = formatQuestionMs(currentMs());
      syncControls();
    }

    function stop() {
      stopTick();
    }

    function start(frozen) {
      stopTick();
      paused = false;
      accumulatedMs = 0;
      openedAt = Date.now();
      frozenMs = frozen != null && Number(frozen) > 0 ? Number(frozen) : null;
      paint();
      startTick();
    }

    function pause() {
      if (frozenMs != null || paused) return;
      accumulatedMs = currentMs();
      paused = true;
      openedAt = 0;
      stopTick();
      paint();
    }

    function resume() {
      if (frozenMs != null || !paused) return;
      paused = false;
      openedAt = Date.now();
      startTick();
      paint();
    }

    function togglePause() {
      if (paused) resume();
      else pause();
    }

    function reset() {
      if (frozenMs != null) return;
      accumulatedMs = 0;
      openedAt = paused ? 0 : Date.now();
      paint();
    }

    function elapsed() {
      return currentMs();
    }

    if (els.pauseBtn && !els.pauseBtn.dataset.timerBound) {
      els.pauseBtn.dataset.timerBound = "1";
      els.pauseBtn.addEventListener("click", () => togglePause());
    }
    if (els.resetBtn && !els.resetBtn.dataset.timerBound) {
      els.resetBtn.dataset.timerBound = "1";
      els.resetBtn.addEventListener("click", () => reset());
    }

    return { start, stop, paint, elapsed, pause, resume, reset, togglePause };
  }

  function fetchViaDuration(fetchJson, url) {
    return fetchJson(url)
      .then((data) => (data && data.durationMs) || null)
      .catch(() => null);
  }

  global.PapaQuizUi = {
    esc,
    optionsOf,
    stripStatementChoices,
    parseChoiceBlock,
    normalizeQuestion,
    statementHtml,
    renderChoices,
    paintChoices,
    bindChoices,
    fillResult,
    paintAiComment,
    formatQuestionMs,
    isTypingTarget,
    bindSwipeNav,
    createTimer,
    fetchViaDuration
  };
})(window);
