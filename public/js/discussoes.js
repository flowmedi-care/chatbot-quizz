(() => {
  const STORAGE_USER = "papaVagasUserJid";

  const els = {
    user: document.getElementById("disc-user"),
    status: document.getElementById("disc-status"),
    feed: document.getElementById("disc-feed"),
    thread: document.getElementById("disc-thread"),
    threadEmpty: document.getElementById("disc-thread-empty"),
    filterDay: document.getElementById("filter-day"),
    filterRole: document.getElementById("filter-role"),
    filterCaderno: document.getElementById("filter-caderno"),
    filterComments: document.getElementById("filter-comments"),
    filterMine: document.getElementById("filter-mine")
  };

  /** @type {any[]} */
  let posts = [];
  /** @type {string[]} */
  let availableDays = [];
  /** @type {{ id: number, name: string }[]} */
  let cadernos = [];
  /** @type {Record<string, { userJid: string, userJidKey: string, engaged: boolean, passive: boolean }[]>} */
  let engagementByCaderno = {};
  /** @type {string} */
  let today = "";
  /** @type {number | null} */
  let activePostId = null;
  /** @type {{ post: any, comments: any[], answers?: any[] } | null} */
  let activeDetail = null;
  /** @type {number | null} */
  let replyToId = null;

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function jidKey(jid) {
    const raw = String(jid || "")
      .trim()
      .toLowerCase();
    const at = raw.indexOf("@");
    if (at < 0) return raw;
    const user = raw.slice(0, at).split(":")[0];
    const domain = raw.slice(at + 1);
    return `${user}@${domain}`;
  }

  function normalizeName(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function setStatus(msg) {
    if (els.status) els.status.textContent = msg || "";
  }

  function getUserJid() {
    return els.user?.value || localStorage.getItem(STORAGE_USER) || "";
  }

  function getUserName() {
    const opt = els.user?.selectedOptions?.[0];
    return opt ? String(opt.textContent || "").trim() : "";
  }

  function userMatchesEngagement(row) {
    const me = jidKey(getUserJid());
    if (!me || !row) return false;
    if (row.userJidKey === me) return true;
    const localMe = me.split("@")[0];
    const localRow = String(row.userJidKey || "").split("@")[0];
    return Boolean(localMe && localMe === localRow && localMe.length >= 8);
  }

  function myRoleOnCaderno(cadernoId) {
    if (cadernoId == null) return { engaged: false, passive: false, linked: false };
    const rows = engagementByCaderno[String(cadernoId)] || engagementByCaderno[cadernoId] || [];
    const hit = rows.find((r) => userMatchesEngagement(r));
    if (!hit) return { engaged: false, passive: false, linked: false };
    return { engaged: Boolean(hit.engaged), passive: Boolean(hit.passive), linked: true };
  }

  const STORAGE_CONTEXT = "papaVagasDiscContextOpen";
  let contextOpen = localStorage.getItem(STORAGE_CONTEXT) !== "0";

  function iCommentedOnPost(p) {
    // Só discussion_comments (raiz OU reply a amigo). NÃO usa answers.answer_comment.
    const me = jidKey(getUserJid());
    const myName = normalizeName(getUserName());
    const discussants = Array.isArray(p.discussants) ? p.discussants : [];

    for (const d of discussants) {
      const dj = jidKey(d.jidKey || d.userJid || "");
      const local = String(d.local || dj.split("@")[0] || "").toLowerCase();
      if (me && (dj === me || (local && local === me.split("@")[0]))) return true;
      const dn = normalizeName(d.name || "");
      if (
        myName &&
        dn &&
        myName !== "participante" &&
        myName !== "selecione…" &&
        dn === myName
      ) {
        return true;
      }
    }

    // fallback legado se API antiga
    const authors = Array.isArray(p.authorJidKeys) ? p.authorJidKeys : [];
    const names = Array.isArray(p.authorNames) ? p.authorNames : [];
    if (me && (authors.includes(me) || authors.includes(me.split("@")[0]))) return true;
    if (myName && names.some((n) => normalizeName(n) === myName)) return true;
    return false;
  }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function fillCadernoFilter() {
    if (!els.filterCaderno) return;
    const prev = els.filterCaderno.value || "__all__";
    const role = els.filterRole?.value || "engaged_passive";

    const options = cadernos.filter((c) => {
      if (role === "all") return true;
      const r = myRoleOnCaderno(c.id);
      if (role === "engaged") return r.engaged;
      if (role === "passive") return r.passive;
      // engaged_passive
      return r.engaged || r.passive;
    });

    els.filterCaderno.innerHTML =
      `<option value="__all__">Todos (do vínculo)</option>` +
      options
        .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
        .join("");

    if ([...els.filterCaderno.options].some((o) => o.value === prev)) {
      els.filterCaderno.value = prev;
    } else {
      els.filterCaderno.value = "__all__";
    }
  }

  function filteredPosts() {
    const day = els.filterDay?.value || "today";
    const comments = els.filterComments?.value || "all";
    const mine = els.filterMine?.value || "all";
    const role = els.filterRole?.value || "engaged_passive";
    const cadernoSel = els.filterCaderno?.value || "__all__";
    const me = jidKey(getUserJid());

    return posts.filter((p) => {
      if (day === "today") {
        if (!today || p.feedDay !== today) return false;
      } else if (day !== "all") {
        if (p.feedDay !== day) return false;
      }

      if (role !== "all") {
        // questões sem caderno só aparecem em "todos"
        if (p.cadernoId == null) return false;
        const r = myRoleOnCaderno(p.cadernoId);
        if (role === "engaged" && !r.engaged) return false;
        if (role === "passive" && !r.passive) return false;
        if (role === "engaged_passive" && !(r.engaged || r.passive)) return false;
      }

      if (cadernoSel !== "__all__") {
        if (String(p.cadernoId) !== String(cadernoSel)) return false;
      }

      const count = Number(p.commentCount || 0);
      if (comments === "with" && count <= 0) return false;
      if (comments === "without" && count > 0) return false;

      if (mine !== "all") {
        if (!me && !getUserName()) return false;
        const iCommented = iCommentedOnPost(p);
        if (mine === "mine" && !iCommented) return false;
        if (mine === "not_mine" && iCommented) return false;
      }
      return true;
    });
  }

  function fillDayFilter() {
    if (!els.filterDay) return;
    const prev = els.filterDay.value;
    const days = [...availableDays];
    if (today && !days.includes(today)) days.unshift(today);

    const opts = [
      `<option value="today">Hoje (${esc(today || "—")})</option>`,
      `<option value="all">Todos os dias</option>`,
      ...days
        .filter((d) => d !== today)
        .map((d) => `<option value="${esc(d)}">${esc(d.split("-").reverse().join("/"))}</option>`)
    ];
    els.filterDay.innerHTML = opts.join("");

    if (prev && [...els.filterDay.options].some((o) => o.value === prev)) {
      els.filterDay.value = prev;
    } else {
      els.filterDay.value = "today";
    }
  }

  async function loadMembers() {
    const data = await fetchJson("/api/engagement");
    const members = data.members || [];
    const saved = localStorage.getItem(STORAGE_USER) || "";
    if (!els.user) return;
    els.user.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Selecione…";
    els.user.appendChild(placeholder);
    for (const m of members) {
      const jid = m.userJid || m.user_jid || "";
      if (!jid) continue;
      const opt = document.createElement("option");
      opt.value = jid;
      opt.textContent = m.displayLabel || m.userLabel || "Participante";
      if (jid === saved) opt.selected = true;
      els.user.appendChild(opt);
    }
    els.user.addEventListener("change", () => {
      if (els.user.value) localStorage.setItem(STORAGE_USER, els.user.value);
      fillCadernoFilter();
      renderFeed();
    });
  }

  async function loadFeed() {
    setStatus("Carregando discussões…");
    try {
      const data = await fetchJson("/api/discussions");
      posts = data.posts || [];
      availableDays = data.availableDays || [];
      today = data.today || "";
      cadernos = data.cadernos || [];
      engagementByCaderno = data.engagementByCaderno || {};
      fillDayFilter();
      fillCadernoFilter();
      if (data.warning) setStatus(data.warning);
      else setStatus("");
      renderFeed();
    } catch (e) {
      setStatus(e.message || "Erro ao carregar");
      posts = [];
      renderFeed();
    }
  }

  function renderFeed() {
    if (!els.feed) return;
    const list = filteredPosts();
    if (!posts.length) {
      els.feed.innerHTML = `<p class="disc-empty">Nada no feed ainda. Aparece após auto-gabarito ou /gabarito.</p>`;
      return;
    }
    if (!list.length) {
      els.feed.innerHTML = `<p class="disc-empty">Nenhuma questão com esses filtros.${
        !getUserJid() ? " Selecione “Quem sou eu”." : ""
      }</p>`;
      return;
    }
    els.feed.innerHTML = list
      .map((p) => {
        const active = p.id === activePostId ? " is-active" : "";
        const preview = p.statementPreview || "Sem enunciado em texto.";
        const when = p.feedAt
          ? new Date(p.feedAt).toLocaleString("pt-BR")
          : p.createdAt
            ? new Date(p.createdAt).toLocaleString("pt-BR")
            : "";
        const cadernoBit = p.cadernoName ? esc(p.cadernoName) : "Sem caderno";
        return `<button type="button" class="disc-card${active}" data-post-id="${p.id}">
          <div class="disc-card-meta">
            <span>#${esc(p.shortId)}</span>
            <span>${esc(String(p.commentCount || 0))} coment.</span>
          </div>
          <p class="disc-card-title">Questão #${esc(p.shortId)}</p>
          <p class="disc-card-preview">${esc(preview)}</p>
          <div class="disc-card-meta"><span>${esc(when)}</span><span>${cadernoBit}</span></div>
        </button>`;
      })
      .join("");

    els.feed.querySelectorAll("[data-post-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-post-id"));
        if (Number.isFinite(id)) void openPost(id);
      });
    });
  }

  async function openPost(postId) {
    activePostId = postId;
    replyToId = null;
    renderFeed();
    setStatus("Carregando thread…");
    try {
      activeDetail = await fetchJson(`/api/discussions?postId=${postId}`);
      setStatus("");
      renderThread();
    } catch (e) {
      setStatus(e.message || "Erro ao abrir discussão");
      activeDetail = null;
      renderThread();
    }
  }

  function buildAnswersPanel(answers, answerKey) {
    if (!answers || !answers.length) {
      return `<div class="disc-panel-block"><h3>5 · Gabarito e marcas</h3><p class="disc-compose-hint">Nenhuma resposta registrada.</p></div>`;
    }
    const rows = answers
      .slice()
      .sort((a, b) => String(a.userName || "").localeCompare(String(b.userName || ""), "pt-BR"))
      .map((a) => {
        const cls = a.correct === true ? "ok" : a.correct === false ? "bad" : "";
        const result =
          a.correct === true ? "certo" : a.correct === false ? "errado" : "—";
        const comment = a.comment ? ` — “${esc(a.comment)}”` : "";
        return `<li class="${cls}"><strong>${esc(a.userName)}</strong> marcou <strong>${esc(a.letter)}</strong> (${result})${comment}</li>`;
      })
      .join("");
    return `<div class="disc-panel-block">
      <h3>5 · Gabarito: ${esc(answerKey || "—")}</h3>
      <ul class="disc-context-list">${rows}</ul>
    </div>`;
  }

  function buildTree(comments) {
    const byParent = new Map();
    for (const c of comments || []) {
      const key = c.parentId == null ? "root" : String(c.parentId);
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(c);
    }
    function renderNodes(parentKey) {
      const list = byParent.get(parentKey) || [];
      return list
        .map((c) => {
          const when = c.createdAt ? new Date(c.createdAt).toLocaleString("pt-BR") : "";
          const name = c.authorName || "Participante";
          const shared = Boolean(c.sharedToWaAt);
          const children = renderNodes(String(c.id));
          return `<article class="disc-comment" data-comment-id="${c.id}">
            <div class="disc-comment-meta">
              <span class="disc-comment-author">${esc(name)}</span>
              <span>${esc(c.source)}</span>
              <span>${esc(when)}</span>
            </div>
            <p class="disc-comment-body">${esc(c.body)}</p>
            <div class="disc-comment-actions">
              <button type="button" class="disc-btn" data-reply="${c.id}">Responder</button>
              <button type="button" class="disc-btn disc-btn-wpp" data-wpp="${c.id}" ${shared ? "disabled" : ""}>
                ${shared ? "No WPP" : "WPP"}
              </button>
            </div>
            ${children ? `<div class="disc-children">${children}</div>` : ""}
          </article>`;
        })
        .join("");
    }
    return renderNodes("root");
  }

  function renderThread() {
    if (!els.thread || !els.threadEmpty) return;
    if (!activeDetail?.post) {
      els.thread.hidden = true;
      els.threadEmpty.hidden = false;
      return;
    }
    els.threadEmpty.hidden = true;
    els.thread.hidden = false;
    const p = activeDetail.post;
    const tree = buildTree(activeDetail.comments || []);
    const answersPanel = buildAnswersPanel(activeDetail.answers || [], p.answerKey);
    const statement = p.statementText || p.statementPreview || "Sem enunciado em texto.";
    const expl = p.explanationText
      ? `\n\n— Comentário do autor —\n${p.explanationText}`
      : "";
    const replyHint =
      replyToId != null
        ? `Respondendo ao comentário #${replyToId}`
        : "Novo comentário na questão (ou responda alguém abaixo)";

    els.thread.innerHTML = `
      <div class="disc-context-toggle">
        <h2>Questão #${esc(p.shortId)}</h2>
        <button type="button" class="disc-btn" id="disc-toggle-context">
          ${contextOpen ? "Ocultar enunciado/gabarito" : "Mostrar enunciado/gabarito"}
        </button>
      </div>
      <div class="disc-context-panels${contextOpen ? "" : " is-hidden"}" id="disc-context-panels">
        <div class="disc-panel-block">
          <h3>4 · Enunciado + comentário do autor</h3>
          <p class="statement">${esc(statement + expl)}</p>
        </div>
        ${answersPanel}
      </div>
      <div class="disc-comments-wrap">
        <h3>6 · Comentários da discussão</h3>
        <div class="disc-comments">${tree || `<p class="disc-empty">Nenhum comentário ainda. Seja o primeiro.</p>`}</div>
        <form class="disc-compose" id="disc-compose-form">
          <label class="disc-compose-hint" id="disc-reply-hint">${esc(replyHint)}</label>
          <textarea id="disc-body" placeholder="Escreva um comentário ou reply…" required maxlength="4000"></textarea>
          <div class="disc-compose-row">
            <button type="submit" class="disc-btn disc-btn-primary">Publicar</button>
            <button type="button" class="disc-btn" id="disc-cancel-reply" ${replyToId == null ? "hidden" : ""}>Cancelar reply</button>
          </div>
        </form>
      </div>
    `;

    document.getElementById("disc-toggle-context")?.addEventListener("click", () => {
      contextOpen = !contextOpen;
      localStorage.setItem(STORAGE_CONTEXT, contextOpen ? "1" : "0");
      const panels = document.getElementById("disc-context-panels");
      const btn = document.getElementById("disc-toggle-context");
      if (panels) panels.classList.toggle("is-hidden", !contextOpen);
      if (btn) {
        btn.textContent = contextOpen
          ? "Ocultar enunciado/gabarito"
          : "Mostrar enunciado/gabarito";
      }
    });

    els.thread.querySelectorAll("[data-reply]").forEach((btn) => {
      btn.addEventListener("click", () => {
        replyToId = Number(btn.getAttribute("data-reply"));
        const hint = document.getElementById("disc-reply-hint");
        const cancel = document.getElementById("disc-cancel-reply");
        if (hint) hint.textContent = `Respondendo ao comentário #${replyToId}`;
        if (cancel) cancel.hidden = false;
        document.getElementById("disc-body")?.focus();
      });
    });

    els.thread.querySelectorAll("[data-wpp]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-wpp"));
        if (Number.isFinite(id)) void shareWpp(id, btn);
      });
    });

    const cancel = document.getElementById("disc-cancel-reply");
    cancel?.addEventListener("click", () => {
      replyToId = null;
      const hint = document.getElementById("disc-reply-hint");
      if (hint) hint.textContent = "Novo comentário na questão (ou responda alguém abaixo)";
      cancel.hidden = true;
    });

    document.getElementById("disc-compose-form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void submitComment();
    });
  }

  async function submitComment() {
    const userJid = getUserJid();
    if (!userJid) {
      setStatus("Selecione quem você é antes de comentar.");
      return;
    }
    if (!activePostId) return;
    const ta = document.getElementById("disc-body");
    const body = String(ta?.value || "").trim();
    if (!body) return;

    setStatus("Publicando…");
    try {
      await fetchJson("/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postId: activePostId,
          userJid,
          userName: getUserName(),
          body,
          parentId: replyToId
        })
      });
      replyToId = null;
      await openPost(activePostId);
      await loadFeed();
      setStatus("Comentário publicado.");
    } catch (e) {
      setStatus(e.message || "Erro ao publicar");
    }
  }

  async function shareWpp(commentId, btn) {
    const userJid = getUserJid();
    if (!userJid) {
      setStatus("Selecione quem você é para enviar ao WhatsApp.");
      return;
    }
    btn.disabled = true;
    setStatus("Enfileirando anúncio no WhatsApp…");
    try {
      const result = await fetchJson("/api/discussions/share-whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentId, userJid })
      });
      if (result.alreadyShared) {
        btn.textContent = "No WPP";
        setStatus("Esse comentário já foi anunciado no grupo.");
      } else {
        btn.textContent = "No WPP";
        setStatus("Pedido enviado. O bot deve anunciar no grupo em instantes.");
        if (activePostId) await openPost(activePostId);
      }
    } catch (e) {
      btn.disabled = false;
      setStatus(e.message || "Erro ao enviar para o WhatsApp");
    }
  }

  function bindFilters() {
    for (const el of [
      els.filterDay,
      els.filterRole,
      els.filterCaderno,
      els.filterComments,
      els.filterMine
    ]) {
      el?.addEventListener("change", () => {
        if (el === els.filterRole) fillCadernoFilter();
        renderFeed();
      });
    }
  }

  async function init() {
    bindFilters();
    try {
      await loadMembers();
    } catch (e) {
      console.warn("[discussoes] members", e);
    }
    await loadFeed();
  }

  void init();
})();
