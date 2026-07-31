(function () {
  const API = {
    materias: "/api/materias",
    catalog: (userJid) =>
      userJid
        ? `/api/materias?userJid=${encodeURIComponent(userJid)}`
        : "/api/materias"
  };

  const STORAGE_KEY = "papa-vagas-engajamento-user";

  const els = {
    user: document.getElementById("eg-user"),
    search: document.getElementById("eg-search"),
    filterDisciplina: document.getElementById("eg-filter-disciplina"),
    filterStatus: document.getElementById("eg-filter-status"),
    sort: document.getElementById("eg-sort"),
    newName: document.getElementById("eg-new-name"),
    btnAdd: document.getElementById("eg-btn-add"),
    status: document.getElementById("eg-status"),
    list: document.getElementById("eg-list"),
    statMine: document.getElementById("eg-stat-mine"),
    statTotal: document.getElementById("eg-stat-total")
  };

  /** @type {{ id: number, name: string, createdAt: string | null, engagedCount: number, questionCount: number, lastActivityAt: string | null, participating: boolean }[]} */
  let materias = [];
  /** @type {{ userJid: string, displayLabel?: string, userLabel?: string }[]} */
  let members = [];
  let busyId = null;

  async function fetchJson(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    const method = (options.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const r = await fetch(url, { ...options, headers });
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
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function friendlyLabel(m) {
    const t = String(m.displayLabel || m.userLabel || "").trim();
    if (!t) return "Participante";
    if (/^\d{8,}$/.test(t) || t.includes("@")) return "Participante";
    return t;
  }

  function currentUserJid() {
    return els.user && els.user.value ? els.user.value : "";
  }

  function setStatus(msg) {
    if (els.status) els.status.textContent = msg || "";
  }

  function updateSummary(filteredLen) {
    const jid = currentUserJid();
    const mine = jid ? materias.filter((m) => m.participating).length : 0;
    if (els.statMine) els.statMine.textContent = jid ? String(mine) : "—";
    if (els.statTotal) els.statTotal.textContent = String(materias.length);
    if (!jid) {
      setStatus("Selecione quem você é para entrar ou sair das matérias.");
    } else if (filteredLen === 0 && materias.length > 0) {
      setStatus("Nenhuma matéria com esses filtros.");
    } else if (!materias.length) {
      setStatus("Nenhuma matéria ainda. Adicione a primeira abaixo.");
    } else {
      setStatus(
        `Mostrando ${filteredLen} de ${materias.length} · você participa de ${mine}.`
      );
    }
  }

  function populateDisciplinaFilter() {
    if (!els.filterDisciplina) return;
    const keep = els.filterDisciplina.value || "all";
    const names = [...new Set(materias.map((m) => m.name).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "pt-BR")
    );
    els.filterDisciplina.innerHTML =
      '<option value="all">Todas</option>' +
      names.map((n) => `<option value="${escAttr(n)}">${esc(n)}</option>`).join("");
    if ([...els.filterDisciplina.options].some((o) => o.value === keep)) {
      els.filterDisciplina.value = keep;
    }
  }

  function populateUserSelect() {
    if (!els.user) return;
    const keep = els.user.value || localStorage.getItem(STORAGE_KEY) || "";
    const opts = ['<option value="">— Selecione —</option>'].concat(
      members.map(
        (m) =>
          `<option value="${escAttr(m.userJid)}">${esc(friendlyLabel(m))}</option>`
      )
    );
    els.user.innerHTML = opts.join("");
    if (keep && [...els.user.options].some((o) => o.value === keep)) {
      els.user.value = keep;
    }
  }

  function filteredSorted() {
    const q = (els.search?.value || "").trim().toLowerCase();
    const disc = els.filterDisciplina?.value || "all";
    const status = els.filterStatus?.value || "all";
    const sort = els.sort?.value || "alpha";
    const jid = currentUserJid();

    let list = materias.slice();

    if (q) {
      list = list.filter((m) => m.name.toLowerCase().includes(q));
    }
    if (disc !== "all") {
      list = list.filter((m) => m.name === disc);
    }
    if (status === "in") {
      list = list.filter((m) => Boolean(m.participating));
    } else if (status === "out") {
      list = list.filter((m) => !m.participating);
    }

    list.sort((a, b) => {
      if (sort === "popular") {
        return (b.engagedCount || 0) - (a.engagedCount || 0) || a.name.localeCompare(b.name, "pt-BR");
      }
      if (sort === "recent") {
        const ta = a.createdAt || "";
        const tb = b.createdAt || "";
        return tb.localeCompare(ta) || a.name.localeCompare(b.name, "pt-BR");
      }
      if (sort === "activity") {
        const aa = a.questionCount || 0;
        const ba = b.questionCount || 0;
        if (ba !== aa) return ba - aa;
        const la = a.lastActivityAt || "";
        const lb = b.lastActivityAt || "";
        return lb.localeCompare(la) || a.name.localeCompare(b.name, "pt-BR");
      }
      return a.name.localeCompare(b.name, "pt-BR");
    });

    if (!jid && (status === "in" || status === "out")) {
      // sem usuário, "participando" não faz sentido — ainda filtra por flag false
    }

    return list;
  }

  function renderList() {
    if (!els.list) return;
    const list = filteredSorted();
    updateSummary(list.length);

    if (!list.length) {
      els.list.innerHTML = `<li class="eg-empty">${
        materias.length
          ? "Nada encontrado com esses filtros."
          : "Nenhuma matéria cadastrada. Use <strong>Nova matéria</strong> acima."
      }</li>`;
      return;
    }

    const jid = currentUserJid();
    els.list.innerHTML = list
      .map((m) => {
        const inIt = Boolean(m.participating);
        const busy = busyId === m.id;
        const people =
          m.engagedCount === 1
            ? "1 pessoa"
            : `${m.engagedCount || 0} pessoas`;
        const qs =
          m.questionCount === 1
            ? "1 questão"
            : `${m.questionCount || 0} questões`;

        let actions = "";
        if (!jid) {
          actions = `<button type="button" class="eg-btn" disabled title="Selecione quem você é">Entrar</button>`;
        } else if (inIt) {
          actions = `
            <span class="eg-badge-in">Participando</span>
            <button type="button" class="eg-btn eg-btn-leave" data-action="leave" data-id="${m.id}" ${
              busy ? "disabled" : ""
            }>Sair</button>`;
        } else {
          actions = `<button type="button" class="eg-btn eg-btn-enter" data-action="enter" data-id="${m.id}" ${
            busy ? "disabled" : ""
          }>Entrar</button>`;
        }

        return `
      <li class="eg-card ${inIt ? "is-in" : ""} ${busy ? "is-busy" : ""}" data-id="${m.id}">
        <div class="eg-card-main">
          <h2 class="eg-card-title">${esc(m.name)}</h2>
          <p class="eg-card-meta">
            <span>${esc(people)}</span>
            <span>${esc(qs)}</span>
          </p>
        </div>
        <div class="eg-card-actions">${actions}</div>
      </li>`;
      })
      .join("");
  }

  async function loadCatalog() {
    setStatus("Carregando…");
    const jid = currentUserJid();
    const data = await fetchJson(API.catalog(jid));
    materias = (data.materias || []).map((m) => ({
      id: Number(m.id),
      name: String(m.name || "").trim(),
      createdAt: m.createdAt || null,
      engagedCount: Number(m.engagedCount) || 0,
      questionCount: Number(m.questionCount) || 0,
      lastActivityAt: m.lastActivityAt || m.createdAt || null,
      participating: Boolean(m.participating)
    }));
    members = data.members || [];
    populateUserSelect();
    populateDisciplinaFilter();
    if (data.warning) setStatus(data.warning);
    renderList();
  }

  async function toggleParticipation(materiaId, want) {
    const jid = currentUserJid();
    if (!jid) {
      setStatus("Selecione quem você é.");
      return;
    }
    const m = materias.find((x) => x.id === materiaId);
    if (!m) return;

    busyId = materiaId;
    renderList();
    try {
      await fetchJson(API.materias, {
        method: "PATCH",
        body: JSON.stringify({ materiaId, userJid: jid, engaged: want })
      });
      m.participating = want;
      m.engagedCount = Math.max(0, (m.engagedCount || 0) + (want ? 1 : -1));
      m.lastActivityAt = new Date().toISOString();
      setStatus(want ? `Você entrou em “${m.name}”.` : `Você saiu de “${m.name}”.`);
    } catch (e) {
      setStatus(e.message || "Não foi possível atualizar.");
    } finally {
      busyId = null;
      renderList();
    }
  }

  async function addMateria() {
    const name = els.newName ? els.newName.value.trim() : "";
    if (!name) {
      setStatus("Digite o nome da matéria.");
      return;
    }
    if (els.btnAdd) els.btnAdd.disabled = true;
    try {
      await fetchJson(API.materias, {
        method: "POST",
        body: JSON.stringify({ name })
      });
      if (els.newName) els.newName.value = "";
      setStatus(`Matéria “${name}” criada.`);
      await loadCatalog();
    } catch (e) {
      setStatus(e.message || "Erro ao criar matéria.");
    } finally {
      if (els.btnAdd) els.btnAdd.disabled = false;
    }
  }

  if (els.user) {
    els.user.addEventListener("change", async () => {
      const jid = currentUserJid();
      if (jid) localStorage.setItem(STORAGE_KEY, jid);
      else localStorage.removeItem(STORAGE_KEY);
      try {
        await loadCatalog();
      } catch (e) {
        setStatus(e.message || "Erro ao carregar.");
      }
    });
  }

  ["input", "change"].forEach((ev) => {
    if (els.search) els.search.addEventListener(ev, renderList);
  });
  if (els.filterDisciplina) els.filterDisciplina.addEventListener("change", renderList);
  if (els.filterStatus) els.filterStatus.addEventListener("change", renderList);
  if (els.sort) els.sort.addEventListener("change", renderList);

  if (els.list) {
    els.list.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;
      const id = Number(btn.getAttribute("data-id"));
      if (!Number.isFinite(id)) return;
      const action = btn.getAttribute("data-action");
      if (action === "enter") toggleParticipation(id, true);
      if (action === "leave") toggleParticipation(id, false);
    });
  }

  if (els.btnAdd) els.btnAdd.addEventListener("click", addMateria);
  if (els.newName) {
    els.newName.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        addMateria();
      }
    });
  }

  loadCatalog().catch((e) => {
    setStatus(e.message || "Não foi possível carregar.");
    if (els.list) {
      els.list.innerHTML =
        '<li class="eg-empty">Falha ao carregar. Confira o grupo no Vercel e a migration de matérias.</li>';
    }
  });
})();
