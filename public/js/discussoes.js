(() => {
  const STORAGE_USER = "papaVagasUserJid";

  const els = {
    user: document.getElementById("disc-user"),
    status: document.getElementById("disc-status"),
    feed: document.getElementById("disc-feed"),
    thread: document.getElementById("disc-thread"),
    threadEmpty: document.getElementById("disc-thread-empty")
  };

  /** @type {any[]} */
  let posts = [];
  /** @type {number | null} */
  let activePostId = null;
  /** @type {{ post: any, comments: any[] } | null} */
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

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
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
    });
  }

  async function loadFeed() {
    setStatus("Carregando discussões…");
    try {
      const data = await fetchJson("/api/discussions");
      posts = data.posts || [];
      if (data.warning) setStatus(data.warning);
      else setStatus(posts.length ? "" : "Nenhuma discussão ainda. Aparecem após auto-gabarito ou /gabarito.");
      renderFeed();
    } catch (e) {
      setStatus(e.message || "Erro ao carregar");
      posts = [];
      renderFeed();
    }
  }

  function renderFeed() {
    if (!els.feed) return;
    if (!posts.length) {
      els.feed.innerHTML = `<p class="disc-empty">Nada por aqui ainda.</p>`;
      return;
    }
    els.feed.innerHTML = posts
      .map((p) => {
        const active = p.id === activePostId ? " is-active" : "";
        const preview = p.statementPreview || "Sem enunciado em texto.";
        const when = p.createdAt ? new Date(p.createdAt).toLocaleString("pt-BR") : "";
        return `<button type="button" class="disc-card${active}" data-post-id="${p.id}">
          <div class="disc-card-meta">
            <span>#${esc(p.shortId)}</span>
            <span>${esc(String(p.commentCount || 0))} coment.</span>
          </div>
          <p class="disc-card-title">Questão #${esc(p.shortId)}</p>
          <p class="disc-card-preview">${esc(preview)}</p>
          <div class="disc-card-meta"><span>${esc(when)}</span><span>${esc(p.source)}</span></div>
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

  function buildTree(comments) {
    const byParent = new Map();
    for (const c of comments || []) {
      const key = c.parentId == null ? "root" : String(c.parentId);
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(c);
    }
    function renderNodes(parentKey, depth) {
      const list = byParent.get(parentKey) || [];
      return list
        .map((c) => {
          const when = c.createdAt ? new Date(c.createdAt).toLocaleString("pt-BR") : "";
          const name = c.authorName || "Participante";
          const shared = Boolean(c.sharedToWaAt);
          const children = renderNodes(String(c.id), depth + 1);
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
    return renderNodes("root", 0);
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
    const replyHint =
      replyToId != null
        ? `Respondendo ao comentário #${replyToId}`
        : "Comentário na questão (nível raiz)";

    els.thread.innerHTML = `
      <div class="disc-thread-head">
        <h2>Questão #${esc(p.shortId)}</h2>
        <p>${esc(p.statementText || p.statementPreview || "Sem enunciado em texto.")}</p>
      </div>
      <div class="disc-comments">${tree || `<p class="disc-empty">Nenhum comentário ainda. Seja o primeiro.</p>`}</div>
      <form class="disc-compose" id="disc-compose-form">
        <label class="disc-compose-hint" id="disc-reply-hint">${esc(replyHint)}</label>
        <textarea id="disc-body" placeholder="Escreva seu comentário…" required maxlength="4000"></textarea>
        <div class="disc-compose-row">
          <button type="submit" class="disc-btn disc-btn-primary">Publicar</button>
          <button type="button" class="disc-btn" id="disc-cancel-reply" ${replyToId == null ? "hidden" : ""}>Cancelar reply</button>
        </div>
      </form>
    `;

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
      if (hint) hint.textContent = "Comentário na questão (nível raiz)";
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

  async function init() {
    try {
      await loadMembers();
    } catch (e) {
      console.warn("[discussoes] members", e);
    }
    await loadFeed();
  }

  void init();
})();
