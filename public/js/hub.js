(() => {
  const API = "/api/economy";
  const STORAGE_USER = "papaVagasHubUser";

  const state = {
    userJid: localStorage.getItem(STORAGE_USER) || "",
    members: [],
    profile: null,
    shopItems: [],
    shopTab: "destaques",
    shopSelected: null,
    rankBoard: "aura",
    page: "diario"
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    } catch {
      return String(iso);
    }
  }

  function todayInputValue() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  }

  function initials(name) {
    const cleaned = String(name || "").trim();
    if (!cleaned || cleaned.includes("@") || /^\+?\d{6,}$/.test(cleaned)) return "?";
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function looksLikeId(s) {
    const t = String(s || "").trim();
    if (!t) return true;
    if (t.includes("@")) return true;
    if (/^\+?\d{8,}$/.test(t)) return true;
    if (/^\d{10,}/.test(t)) return true;
    return false;
  }

  function resolveMemberName(jid, fallback) {
    const m = state.members.find((x) => memberJid(x) === jid);
    if (m) {
      const label = memberLabel(m);
      if (label && !looksLikeId(label)) return label;
    }
    if (fallback && !looksLikeId(fallback)) return fallback;
    return "Participante";
  }

  function rarityOf(aura) {
    if (aura >= 5000) return { key: "lendaria", label: "Lendária" };
    if (aura >= 2000) return { key: "suprema", label: "Suprema" };
    if (aura >= 1000) return { key: "institucional", label: "Institucional" };
    if (aura >= 600) return { key: "elevada", label: "Elevada" };
    if (aura >= 300) return { key: "incandescente", label: "Incandescente" };
    if (aura >= 100) return { key: "desperta", label: "Desperta" };
    return { key: "comum", label: "Latente" };
  }

  async function apiGet(params = {}) {
    const url = new URL(API, location.origin);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "") url.searchParams.set(k, v);
    });
    const res = await fetch(url.toString());
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  async function apiPost(body) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function setPage(page) {
    state.page = page;
    $$(".hub-nav [data-go]").forEach((b) => b.classList.toggle("active", b.dataset.go === page));
    $$(".hub-page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
    location.hash = page;
    loadPage(page).catch((e) => console.error(e));
  }

  function memberLabel(m) {
    return m.displayLabel || m.displayName || m.name || m.jid || m.userJid || "—";
  }

  function memberJid(m) {
    return m.userJid || m.jid || m.user_jid || "";
  }

  async function loadMembers() {
    const data = await apiGet({ view: "members" });
    state.members = data.members || [];
    const sel = $("#hub-user");
    if (!sel) return;
    const prev = state.userJid;
    sel.innerHTML =
      `<option value="">Selecione…</option>` +
      state.members
        .map((m) => {
          const jid = memberJid(m);
          return `<option value="${esc(jid)}" ${jid === prev ? "selected" : ""}>${esc(memberLabel(m))}</option>`;
        })
        .join("");
    if (prev && !state.members.some((m) => memberJid(m) === prev) && prev) {
      sel.insertAdjacentHTML("beforeend", `<option value="${esc(prev)}" selected>${esc(prev)}</option>`);
    }
  }

  async function loadProfile() {
    if (!state.userJid) {
      $("#perfil-root").innerHTML =
        `<div class="hub-card"><p style="margin:0;color:var(--muted)">Selecione quem você é no topo para ver o perfil completo.</p></div>`;
      return;
    }
    const data = await apiGet({ view: "profile", userJid: state.userJid });
    state.profile = data;
    const eco = data.economy || {};
    const streak = data.streak || {};
    const aura = data.aura || {};
    const rarity = rarityOf(eco.aura || 0);
    const name = resolveMemberName(state.userJid, eco.display_name);
    const unlocked = (data.achievements || []).filter((a) => a.unlocked);
    const equipped = (data.inventory || []).filter((i) => i.equipped);
    const bySlot = Object.fromEntries(
      equipped.filter((i) => i.metadata?.slot).map((i) => [i.metadata.slot, i])
    );
    const frameCss = bySlot.frame?.metadata?.css || "frame-none";
    const auraFx = bySlot.aura_fx?.metadata?.css || "";
    const avatarCss = bySlot.avatar?.metadata?.css || "";
    const nameCss = bySlot.name_color?.metadata?.css || "";
    const bannerCss = bySlot.banner?.metadata?.css || "";
    const emoji = bySlot.emoji?.metadata?.emoji || "";
    const nextNeed = aura.remainingToNext != null ? `${aura.remainingToNext} Aura até o próximo nível` : "Topo da escala";

    $("#perfil-root").innerHTML = `
      <div class="profile-hero hub-card ${esc(bannerCss)}">
        <div class="plaza-avatar lg ${esc(frameCss)} ${esc(auraFx)} ${esc(avatarCss)}" aria-hidden="true">
          <span class="plaza-initials">${esc(initials(name))}</span>
          ${emoji ? `<span class="plaza-emoji">${esc(emoji)}</span>` : ""}
        </div>
        <div class="profile-meta">
          <h2 class="${esc(nameCss)}">${esc(name)}</h2>
          <p class="profile-title-line">${esc(eco.active_title || "Sem título equipado")} · ${esc(aura.label || "Aura Latente")}</p>
          <div class="profile-tags">
            <span class="tag rarity-${esc(rarity.key)}">Raridade: ${esc(rarity.label)}</span>
            <span class="tag">🏛️ ${esc(aura.shortLabel || "Latente")}</span>
            <span class="tag">🔥 ${esc(streak.current_streak || 0)} dias</span>
          </div>
          <div class="progress-bar" title="${esc(nextNeed)}">
            <span style="width:${esc(aura.progressPct || 0)}%"></span>
          </div>
          <p class="progress-caption">${esc(nextNeed)}</p>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-card"><span class="stat-label">Aura total</span><strong>${esc(eco.aura || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Créditos disponíveis</span><strong>${esc(data.availableCredits ?? 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Em escrow</span><strong>${esc(eco.credits_escrowed || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Questões (vida)</span><strong>${esc(eco.lifetime_answers || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Streak atual</span><strong>${esc(streak.current_streak || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Melhor streak</span><strong>${esc(streak.best_streak || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Mandados vencidos</span><strong>${esc(eco.mandados_won || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Conquistas</span><strong>${unlocked.length}/${(data.achievements || []).length}</strong></div>
      </div>

      <div class="hub-grid-2" style="margin-top:1rem">
        <div class="hub-card">
          <h3>Equipado agora</h3>
          ${
            equipped.length
              ? `<ul class="plain-list">${equipped
                  .map((i) => `<li><strong>${esc(i.name || i.item_key)}</strong>${i.metadata?.slot ? ` · ${esc(i.metadata.slot)}` : ""}</li>`)
                  .join("")}</ul>`
              : `<p class="muted">Nada equipado. Visite o inventário ou a loja.</p>`
          }
        </div>
        <div class="hub-card">
          <h3>Aplicação & mandados</h3>
          ${
            data.aplicacao
              ? `<p>Aplicação ativa: <strong>${esc(data.aplicacao.principal)}</strong> Créditos · dia ${esc(data.aplicacao.days_elapsed || 0)}/${esc(data.aplicacao.streak_days || 10)}</p>`
              : `<p class="muted">Sem Aplicação Orçamentária ativa.</p>`
          }
          ${(data.mandados || []).length
            ? `<p>${(data.mandados || []).length} mandado(s) pendente(s).</p>`
            : `<p class="muted">Nenhum Mandado de Intimação aberto.</p>`}
        </div>
      </div>

      <div class="hub-card" style="margin-top:1rem">
        <h3>Conquistas recentes</h3>
        <div class="badge-grid compact">
          ${(data.achievements || [])
            .map(
              (a) => `
            <div class="badge-card ${a.unlocked ? "unlocked" : "locked"}">
              <strong>${esc(a.title)}</strong>
              <span>${a.unlocked ? "Desbloqueada" : `${esc(a.minAnswers)} respostas`}</span>
              <small>+${esc(a.aura)} Aura · +${esc(a.credits)} Créditos</small>
            </div>`
            )
            .join("")}
        </div>
        <p class="muted" style="margin-top:1rem;font-size:0.85rem">
          Foto, cargo e órgão entram quando ligarmos perfil enriquecido no WhatsApp — por enquanto o prestígio vem de Aura, título e moldura.
        </p>
      </div>
    `;
  }

  function avatarMarkup(m, sizeClass = "") {
    const frame = m.frameCss || "frame-none";
    const fx = m.auraFxCss || "";
    const av = m.avatarCss || "";
    const emoji = m.emoji ? `<span class="plaza-emoji">${esc(m.emoji)}</span>` : "";
    return `
      <div class="plaza-avatar ${esc(sizeClass)} ${esc(frame)} ${esc(fx)} ${esc(av)}" aria-hidden="true">
        <span class="plaza-initials">${esc(initials(m.name))}</span>
        ${emoji}
      </div>`;
  }

  async function loadPlaza() {
    const root = $("#plaza-root");
    if (!root) return;
    try {
      const data = await apiGet({ view: "plaza", limit: 48 });
      const members = data.members || [];
      if (!members.length) {
        root.innerHTML = `<div class="hub-card"><p class="muted" style="margin:0">Ainda não há perfis com economia. Assim que o grupo responder no WhatsApp, a praça enche.</p></div>`;
        return;
      }
      root.innerHTML = members
        .map((m) => {
          const nameClass = m.nameCss || "";
          const banner = m.bannerCss || "";
          const displayName = resolveMemberName(m.userJid, m.name);
          const person = { ...m, name: displayName };
          return `
          <button type="button" class="plaza-tile ${esc(banner)}" data-open-profile="${esc(m.userJid)}">
            ${avatarMarkup(person)}
            <div class="plaza-info">
              <strong class="plaza-name ${esc(nameClass)}">${esc(displayName)}</strong>
              <span class="plaza-title">${esc(m.title || m.auraLevel?.shortLabel || "Sem título")}</span>
              <span class="plaza-aura">${esc(m.auraLevel?.emoji || "🌱")} ${esc(m.aura)} Aura</span>
              <span class="plaza-streak">🔥 ${esc(m.streak)} dias</span>
            </div>
          </button>`;
        })
        .join("");
      $$("[data-open-profile]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.userJid = btn.dataset.openProfile;
          localStorage.setItem(STORAGE_USER, state.userJid);
          const sel = $("#hub-user");
          if (sel) sel.value = state.userJid;
          setPage("perfil");
        });
      });
    } catch (e) {
      root.innerHTML = `<div class="hub-card"><p class="muted" style="margin:0">${esc(e.message || String(e))}</p></div>`;
    }
  }

  async function loadDiario() {
    await loadPlaza();
    const dayEl = $("#diario-day");
    if (dayEl && !dayEl.value) dayEl.value = todayInputValue();
    const day = dayEl?.value || todayInputValue();
    const data = await apiGet({ view: "diario", day });
    const feed = $("#diario-feed");
    const events = data.events || [];
    if (!events.length) {
      feed.innerHTML = `<p class="muted">Nenhum lançamento neste dia. Responda no WhatsApp e volte aqui.</p>`;
      return;
    }
    feed.innerHTML = events
      .map((e) => {
        const da = Number(e.delta_aura || 0);
        const dc = Number(e.delta_credits || 0);
        const deltas =
          da || dc
            ? `<span class="feed-delta">${da ? `${da > 0 ? "+" : ""}${da} Aura` : ""}${da && dc ? " · " : ""}${
                dc ? `${dc > 0 ? "+" : ""}${dc} Créd.` : ""
              }</span>`
            : "";
        return `
          <article class="feed-item ${e.type === "social" ? "social" : ""}">
            <div class="feed-time">${esc(fmtTime(e.created_at))}</div>
            <div class="feed-body">
              <p>${esc(e.label)}</p>
              ${deltas}
            </div>
          </article>`;
      })
      .join("");
  }

  async function loadRankings() {
    const data = await apiGet({ view: "rankings", board: state.rankBoard, limit: 30 });
    const list = $("#rank-list");
    const rows = data.rows || [];
    const unit =
      state.rankBoard === "disciplina"
        ? "dias"
        : state.rankBoard === "duelo"
          ? "vitórias"
          : state.rankBoard === "producao"
            ? "questões"
            : "Aura";
    if (!rows.length) {
      list.innerHTML = `<li class="muted">Sem dados ainda.</li>`;
      return;
    }
    list.innerHTML = rows
      .map(
        (r, i) => `
      <li class="rank-row ${i < 3 ? "podium" : ""}">
        <span class="rank-pos">${i + 1}</span>
        <span class="rank-name">${esc(r.label)}${r.title ? ` <em>${esc(r.title)}</em>` : ""}</span>
        <span class="rank-value">${esc(r.value)} <small>${unit}</small></span>
      </li>`
      )
      .join("");
  }

  async function loadConquistas() {
    let achievements = [];
    if (state.userJid) {
      const data = await apiGet({ view: "profile", userJid: state.userJid });
      achievements = data.achievements || [];
    } else {
      achievements = [
        { key: "calouro", title: "Calouro", minAnswers: 10, aura: 5, credits: 10, unlocked: false },
        { key: "estudante", title: "Estudante", minAnswers: 30, aura: 15, credits: 15, unlocked: false },
        { key: "tecnico", title: "Técnico", minAnswers: 100, aura: 50, credits: 50, unlocked: false },
        { key: "analista", title: "Analista", minAnswers: 500, aura: 250, credits: 250, unlocked: false },
        { key: "auditor", title: "Auditor", minAnswers: 1000, aura: 500, credits: 500, unlocked: false },
        { key: "nazli", title: "Nazli Setton Filippini", minAnswers: 2000, aura: 1000, credits: 1000, unlocked: false }
      ];
    }
    const cats = [
      { id: "carreira", title: "Carreira pública", keys: ["calouro", "estudante", "tecnico", "analista", "auditor", "nazli"] },
      { id: "secretas", title: "Secretas (em breve)", keys: [] }
    ];
    const byKey = new Map(achievements.map((a) => [a.key, a]));
    $("#conquistas-root").innerHTML = cats
      .map((cat) => {
        const items =
          cat.keys.length > 0
            ? cat.keys
                .map((k) => byKey.get(k))
                .filter(Boolean)
                .map((a) => {
                  const rarity = a.minAnswers >= 1000 ? "lendaria" : a.minAnswers >= 500 ? "rara" : "comum";
                  return `
                <div class="badge-card ${a.unlocked ? "unlocked" : "locked"} rarity-${rarity}">
                  <strong>${esc(a.title)}</strong>
                  <span>${a.unlocked ? "✓ Desbloqueada" : `${esc(a.minAnswers)} respostas`}</span>
                  <small>Recompensa: +${esc(a.aura)} Aura · +${esc(a.credits)} Créditos</small>
                  <div class="mini-bar"><span style="width:${a.unlocked ? 100 : 0}%"></span></div>
                </div>`;
                })
                .join("")
            : `<p class="muted">Conquistas secretas aparecem só quando alguém as desbloquear — FOMO saudável + compartilhamento no Diário.</p>`;
        return `<div class="hub-card" style="grid-column:1/-1;margin-bottom:1rem"><h3>${esc(cat.title)}</h3><div class="badge-grid">${items}</div></div>`;
      })
      .join("");
  }

  async function loadInventario() {
    if (!state.userJid) {
      $("#inventario-root").innerHTML = `<p class="muted">Selecione quem você é para ver o inventário.</p>`;
      return;
    }
    const data = await apiGet({ view: "profile", userJid: state.userJid });
    const inv = data.inventory || [];
    if (!inv.length) {
      $("#inventario-root").innerHTML = `<div class="hub-card"><p class="muted" style="margin:0">Inventário vazio. O Portal de compras espera você.</p></div>`;
      return;
    }
    $("#inventario-root").innerHTML = inv
      .map(
        (i) => `
      <div class="inv-card ${i.equipped ? "equipped" : ""}">
        <strong>${esc(i.name || i.item_key)}</strong>
        <span>${esc(i.metadata?.slot || (i.consumable ? "Consumível" : "Item"))}</span>
        <span>Qtd: ${esc(i.qty || 1)}</span>
        ${
          i.equipped
            ? `<em class="eq-badge">Equipado</em>`
            : i.metadata?.slot
              ? `<button type="button" class="hub-chip primary" data-equip="${esc(i.item_key)}">Equipar</button>`
              : ""
        }
      </div>`
      )
      .join("");
    $$("[data-equip]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await apiPost({ action: "equip", userJid: state.userJid, itemKey: btn.dataset.equip });
          await loadInventario();
        } catch (e) {
          alert(e.message || String(e));
        }
      });
    });
  }

  const SHOP_LABELS = {
    destaques: "Destaques",
    cosmeticos: "Cosméticos",
    aura: "Efeitos de Aura",
    assistencias: "Assistências",
    protecao: "Proteção",
    geral: "Geral"
  };

  function shopThumb(item) {
    const meta = item?.metadata || {};
    const css = meta.css || "";
    if (item?.item_key?.includes("streak")) return `<span class="thumb-emoji">🛡️</span>`;
    if (item?.item_key?.includes("eliminate")) return `<span class="thumb-emoji">✂️</span>`;
    if (meta.emoji) return `<span class="thumb-emoji">${esc(meta.emoji)}</span>`;
    if (meta.slot === "frame") return `<span class="thumb-swatch ${esc(css)}"></span>`;
    if (meta.slot === "aura_fx" || item?.category === "aura")
      return `<span class="thumb-swatch aura ${esc(css)}"></span>`;
    if (meta.slot === "avatar") return `<span class="thumb-emoji">⭐</span>`;
    if (meta.slot === "banner") return `<span class="thumb-emoji">🏳️</span>`;
    if (meta.slot === "name_color") return `<span class="thumb-emoji">🎨</span>`;
    return `<span class="thumb-emoji">🏛️</span>`;
  }

  function shopPreviewFor(item, buyerName) {
    const meta = item?.metadata || {};
    const css = meta.css || "";
    const slot = meta.slot || "";
    const name = looksLikeId(buyerName) ? "Você" : buyerName || "Você";
    if (slot === "frame" || item?.item_key?.startsWith("frame_")) {
      return `
        <div class="shop-mannequin">
          <div class="plaza-avatar lg ${esc(css)}"><span class="plaza-initials">${esc(initials(name))}</span></div>
          <p>Preview da moldura</p>
        </div>`;
    }
    if (slot === "aura_fx" || item?.category === "aura") {
      return `
        <div class="shop-mannequin">
          <div class="plaza-avatar lg frame-none ${esc(css)}"><span class="plaza-initials">${esc(initials(name))}</span></div>
          <p>Efeito de Aura</p>
        </div>`;
    }
    if (slot === "avatar") {
      return `
        <div class="shop-mannequin">
          <div class="plaza-avatar lg frame-rare ${esc(css)}"><span class="plaza-initials">${esc(initials(name))}</span></div>
          <p>Avatar exclusivo</p>
        </div>`;
    }
    if (slot === "banner") {
      return `
        <div class="shop-mannequin banner-preview ${esc(css)}">
          <div class="plaza-avatar md frame-basic"><span class="plaza-initials">${esc(initials(name))}</span></div>
          <strong class="plaza-name">${esc(name)}</strong>
          <p>Banner de perfil</p>
        </div>`;
    }
    if (slot === "name_color") {
      return `
        <div class="shop-mannequin">
          <strong class="plaza-name ${esc(css)}" style="font-size:1.4rem">${esc(name)}</strong>
          <p>Cor do nome no Hub</p>
        </div>`;
    }
    if (slot === "emoji" || meta.emoji) {
      return `
        <div class="shop-mannequin">
          <div class="plaza-avatar lg frame-basic">
            <span class="plaza-initials">${esc(initials(name))}</span>
            <span class="plaza-emoji">${esc(meta.emoji || "⚡")}</span>
          </div>
          <p>Emoji exclusivo</p>
        </div>`;
    }
    if (item?.consumable || item?.category === "assistencias" || item?.category === "protecao") {
      const icon = item?.item_key?.includes("streak") ? "🛡️" : item?.item_key?.includes("eliminate") ? "✂️" : "📦";
      return `
        <div class="shop-mannequin consumable-preview">
          <div class="shop-icon-blob">${icon}</div>
          <p>Consumível — vai para o inventário</p>
        </div>`;
    }
    return `
      <div class="shop-mannequin">
        <div class="shop-icon-blob">🏛️</div>
        <p>Item do Portal</p>
      </div>`;
  }

  function buyerLabel(profile) {
    if (!state.userJid) return "Você";
    return resolveMemberName(state.userJid, profile?.economy?.display_name);
  }

  function renderShopDetail(item, profile) {
    const detail = $("#shop-detail");
    if (!detail) return;
    if (!item) {
      detail.innerHTML = `<p class="muted">Selecione um item na lista.</p>`;
      return;
    }
    const name = buyerLabel(profile);
    const canBuy = Boolean(state.userJid);
    const auraOk = !item.min_aura || (profile?.economy?.aura || 0) >= item.min_aura;
    const credOk = (profile?.availableCredits ?? 0) >= item.price_credits;
    const tipo = item.consumable
      ? "Consumível"
      : item.metadata?.slot === "aura_fx"
        ? "Efeito de Aura"
        : item.metadata?.slot === "frame"
          ? "Moldura"
          : item.metadata?.slot || "Cosmético";
    detail.innerHTML = `
      ${shopPreviewFor(item, name)}
      <div class="shop-detail-copy">
        <p class="shop-dept">${esc(SHOP_LABELS[item.category] || item.category || "Portal")}</p>
        <h2>${esc(item.name)}</h2>
        <p>${esc(item.description || "Empenhe a despesa e confirme com sim no WhatsApp.")}</p>
        <dl class="shop-specs">
          <div><dt>Preço</dt><dd>${esc(item.price_credits)} Créditos</dd></div>
          <div><dt>Aura mínima</dt><dd>${item.min_aura ? esc(item.min_aura) : "—"}</dd></div>
          <div><dt>Tipo</dt><dd>${esc(tipo)}</dd></div>
        </dl>
        <button type="button" class="shop-buy-btn" data-buy="${esc(item.item_key)}" ${!canBuy || !auraOk ? "disabled" : ""}>
          Empenhar despesa · ${esc(item.price_credits)} Créd.
        </button>
        ${!canBuy ? `<p class="muted">Selecione quem você é no topo.</p>` : ""}
        ${canBuy && !auraOk ? `<p class="muted">Aura insuficiente (precisa ${esc(item.min_aura)}).</p>` : ""}
        ${canBuy && auraOk && !credOk ? `<p class="muted">Saldo disponível pode ser curto — o bot confirma no WhatsApp.</p>` : ""}
      </div>`;
    detail.querySelector("[data-buy]")?.addEventListener("click", async () => {
      const status = $("#shop-status");
      status.textContent = "Criando pedido…";
      try {
        const r = await apiPost({
          action: "purchase-intent",
          userJid: state.userJid,
          itemKey: item.item_key
        });
        status.textContent = r.message || "Confirme com *sim* no WhatsApp.";
      } catch (e) {
        status.textContent = e.message || String(e);
      }
    });
  }

  async function loadLoja() {
    const [shop, profile] = await Promise.all([
      apiGet({ view: "shop" }),
      state.userJid ? apiGet({ view: "profile", userJid: state.userJid }).catch(() => null) : Promise.resolve(null)
    ]);
    state.shopItems = shop.items || [];
    const featured = [...state.shopItems].sort((a, b) => (b.price_credits || 0) - (a.price_credits || 0)).slice(0, 4);
    const cats = ["destaques", ...new Set(state.shopItems.map((i) => i.category || "geral"))];

    const bal = $("#shop-balance");
    if (profile) {
      const who = buyerLabel(profile);
      bal.innerHTML = `
        <div class="wallet-chip wide"><span>Comprador</span><strong>${esc(who)}</strong></div>
        <div class="wallet-chip"><span>Disponível</span><strong>${esc(profile.availableCredits)}</strong></div>
        <div class="wallet-chip"><span>Escrow</span><strong>${esc(profile.economy?.credits_escrowed || 0)}</strong></div>
        <div class="wallet-chip"><span>Aura</span><strong>${esc(profile.economy?.aura || 0)}</strong></div>`;
    } else {
      bal.innerHTML = `<p class="muted" style="margin:0">Selecione quem você é para empenhar despesas neste balcão.</p>`;
    }

    const tabs = $("#shop-tabs");
    tabs.innerHTML = cats
      .map(
        (c) =>
          `<button type="button" class="aisle-btn ${state.shopTab === c ? "active" : ""}" data-shop-tab="${esc(c)}">${esc(
            SHOP_LABELS[c] || c
          )}</button>`
      )
      .join("");
    $$("[data-shop-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        state.shopTab = b.dataset.shopTab;
        loadLoja();
      })
    );

    const filtered =
      state.shopTab === "destaques"
        ? featured
        : state.shopItems.filter((i) => (i.category || "geral") === state.shopTab);

    if (!state.shopSelected || !filtered.some((i) => i.item_key === state.shopSelected)) {
      state.shopSelected = filtered[0]?.item_key || state.shopItems[0]?.item_key || null;
    }
    const selected = state.shopItems.find((i) => i.item_key === state.shopSelected) || null;

    const showcase = $("#shop-showcase");
    showcase.innerHTML = `
      ${
        state.shopTab === "destaques"
          ? `<div class="shop-featured-banner">
              <div>
                <p class="shop-dept">Oficina do dia</p>
                <h2>Vitrine orçamentária</h2>
                <p>Escolha na lista — o preview aparece ao lado.</p>
              </div>
            </div>`
          : ""
      }
      <div class="shop-list">
        ${
          filtered
            .map(
              (item) => `
          <button type="button" class="shop-list-row ${item.item_key === state.shopSelected ? "selected" : ""}" data-select="${esc(item.item_key)}">
            <span class="shop-thumb">${shopThumb(item)}</span>
            <span class="shop-list-copy">
              <strong>${esc(item.name)}</strong>
              <small>${esc(item.description || metaSlot(item))}${item.min_aura ? ` · Aura mín. ${esc(item.min_aura)}` : ""}</small>
            </span>
            <span class="shop-list-price">${esc(item.price_credits)} <em>Créd.</em></span>
          </button>`
            )
            .join("") || `<p class="muted">Nenhum item neste corredor.</p>`
        }
      </div>`;

    $$("[data-select]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.shopSelected = btn.dataset.select;
        const item = state.shopItems.find((i) => i.item_key === state.shopSelected);
        $$("[data-select]").forEach((b) => b.classList.toggle("selected", b.dataset.select === state.shopSelected));
        renderShopDetail(item, profile);
      });
    });

    renderShopDetail(selected, profile);
  }

  function metaSlot(item) {
    if (item.consumable) return "Consumível";
    return item.metadata?.slot || "Item do Portal";
  }

  async function loadHistorico() {
    if (!state.userJid) {
      $("#historico-feed").innerHTML = `<p class="muted">Selecione quem você é.</p>`;
      return;
    }
    const data = await apiGet({ view: "ledger", userJid: state.userJid, limit: 120 });
    const events = data.events || [];
    if (!events.length) {
      $("#historico-feed").innerHTML = `<p class="muted">Ainda sem movimentos nesta conta.</p>`;
      return;
    }
    $("#historico-feed").innerHTML = events
      .map(
        (e) => `
      <article class="feed-item">
        <div class="feed-time">${esc(fmtTime(e.created_at))}</div>
        <div class="feed-body">
          <p>${esc(e.label)}</p>
          <span class="feed-delta">${Number(e.delta_aura) ? `${e.delta_aura > 0 ? "+" : ""}${e.delta_aura} Aura` : ""}${
            Number(e.delta_aura) && Number(e.delta_credits) ? " · " : ""
          }${Number(e.delta_credits) ? `${e.delta_credits > 0 ? "+" : ""}${e.delta_credits} Créd.` : ""}</span>
        </div>
      </article>`
      )
      .join("");
  }

  async function loadTransparencia() {
    const data = await apiGet({
      view: "transparencia",
      userJid: state.userJid || undefined,
      limit: 150
    });
    const s = data.stats || {};
    const scope = state.userJid ? "sua conta" : "todo o sistema (amostra recente)";
    $("#transparencia-root").innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><span class="stat-label">Aura ganha</span><strong>+${esc(s.auraGained || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Aura perdida</span><strong>−${esc(s.auraLost || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Créditos recebidos</span><strong>+${esc(s.creditsGained || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Créditos empenhados</span><strong>−${esc(s.creditsSpent || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Movimentos</span><strong>${esc(s.movements || 0)}</strong></div>
        <div class="stat-card"><span class="stat-label">Escopo</span><strong style="font-size:1rem">${esc(scope)}</strong></div>
      </div>
      <div class="hub-card" style="margin-top:1rem">
        <h3>Extrato recente</h3>
        <div class="feed-list">
          ${(data.events || [])
            .slice(0, 40)
            .map(
              (e) => `
            <article class="feed-item">
              <div class="feed-time">${esc(e.day_iso || "")} · ${esc(fmtTime(e.created_at))}</div>
              <div class="feed-body"><p>${esc(e.label)}</p></div>
            </article>`
            )
            .join("") || `<p class="muted">Sem lançamentos.</p>`}
        </div>
      </div>
      <div class="hub-card" style="margin-top:1rem">
        <h3>O que este portal cobre</h3>
        <ul>
          <li>Ganhos e perdas de Aura e Créditos (ledger)</li>
          <li>Compras (despesas empenhadas) e recompensas</li>
          <li>Escrow de mandados e aplicações (no perfil)</li>
        </ul>
        <p class="muted">Impostos, vendas P2P e multas sociais entram nas próximas temporadas — a UI já está preparada para isso.</p>
      </div>
    `;
  }

  const MANUAL = {
    aura: `
      <h2>O que é Aura</h2>
      <p>Aura é <strong>prestígio</strong>. Não se gasta na loja — desbloqueia status, raridade de perfil e sensação de carreira.</p>
      <h3>Como ganhar</h3>
      <ul>
        <li>Acertar questão: <strong>+2</strong></li>
        <li>Errar questão: <strong>+1</strong> (participação conta)</li>
        <li>1º a zerar omissas: <strong>+4</strong></li>
        <li>Manter streak diário: <strong>+1</strong></li>
        <li>Criar questão: <strong>+1</strong></li>
        <li>Marcos de streak (3/7/15/30) e conquistas de carreira</li>
        <li>Vencer Mandado / defender com sucesso</li>
      </ul>
      <h3>Níveis</h3>
      <p>Latente (0) → Desperta (100) → Incandescente (300) → Elevada (600) → Institucional (1000) → Suprema (2000) → Lendária (5000).</p>
      <h3>Como perder</h3>
      <p>Abandono de streak (−4), dia zerado (−1), trancar caderno (−50). Penalidades são raras e legíveis — justiça procedural aumenta confiança.</p>
    `,
    creditos: `
      <h2>Créditos Orçamentários</h2>
      <p>Moeda de <strong>gasto</strong>. Ganha junto com a prática; gasta no Portal de compras, em Mandados e em Aplicações.</p>
      <ul>
        <li>Acerto +2 · Erro +1 · Omissas first +4 · Streak diário +1</li>
        <li>Disponível = saldo − escrow (mandados/aplicações)</li>
        <li>Compras no site só debitam após <code>sim</code> no WhatsApp</li>
      </ul>
      <p><em>Princípio:</em> dual currency separa status (Aura) de poder de compra (Créditos) — evita inflação de ego e mantém sink saudável.</p>
    `,
    streak: `
      <h2>Streak</h2>
      <p>Sequência diária de participação (America/São_Paulo). Manter = +1 Aura/+1 Crédito. Marcos em 3, 7, 15 e 30 dias com bônus maiores.</p>
      <ul>
        <li>Quebrar: −4 Aura (abandono)</li>
        <li>Adiantar N dias (engajados) pode pré-pagar o hábito</li>
        <li>Seguro de streak (item de loja, quando disponível) = proteção psicológica sem anular disciplina</li>
      </ul>
      <p><em>Hook:</em> loss aversion — ninguém quer “zerar a sequência”.</p>
    `,
    niveis: `
      <h2>Experiência / níveis de Aura</h2>
      <p>Não há XP separado: a Aura <em>é</em> a curva de progressão. Cada faixa muda o rótulo do perfil e a raridade visual.</p>
      <table class="actions-table">
        <thead><tr><th>Nível</th><th>Aura mín.</th></tr></thead>
        <tbody>
          <tr><td>Latente</td><td>0</td></tr>
          <tr><td>Desperta</td><td>100</td></tr>
          <tr><td>Incandescente</td><td>300</td></tr>
          <tr><td>Elevada</td><td>600</td></tr>
          <tr><td>Institucional</td><td>1000</td></tr>
          <tr><td>Suprema</td><td>2000</td></tr>
          <tr><td>Lendária</td><td>5000</td></tr>
        </tbody>
      </table>
    `,
    loja: `
      <h2>Portal de compras</h2>
      <ol>
        <li>Escolha “quem sou eu”</li>
        <li>Empenhe a despesa no site</li>
        <li>Receba pedido no WhatsApp e confirme com <strong>sim</strong></li>
        <li>Equipe moldura/título/efeito</li>
      </ol>
      <p>Itens podem exigir Aura mínima. Consumíveis (ex.: eliminar alternativa) saem do inventário ao usar.</p>
    `,
    mandado: `
      <h2>Mandado de Intimação</h2>
      <p>Duelo público com stake em Créditos (taxa 10% queimada). Escrow até resolução em até 24h.</p>
      <ul>
        <li>Stake típico: 20–200</li>
        <li>Vitória do desafiado: +10 Aura · desafiante: +5 Aura</li>
        <li>Derrota do defensor: −2 Aura</li>
      </ul>
      <p>Card no grupo = prova social + espetáculo (competição saudável).</p>
    `,
    aplicar: `
      <h2>Aplicação Orçamentária</h2>
      <p>Trave ≥100 Créditos por 10 dias de streak. Retorno ~12% se cumprir. É sink + meta de médio prazo (goal gradient).</p>
    `,
    penalidades: `
      <h2>Sistema de Penalidades</h2>
      <ul>
        <li>Quebra de streak: −4 Aura</li>
        <li>Dia com zero respostas: −1 Aura</li>
        <li>Trancar caderno: −50 Aura</li>
        <li>Derrota em Mandado (defensor): −2 Aura</li>
      </ul>
      <p>Sem “punição obscura”: cada perda aparece no Diário e no Portal da Transparência — clareza aumenta justiça percebida.</p>
    `
  };

  function loadManual(doc = "aura") {
    $$("#manual-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.doc === doc));
    $("#manual-body").innerHTML = MANUAL[doc] || MANUAL.aura;
  }

  const ACTIONS = [
    ["Acertar questão", "Resposta correta via WhatsApp", "+2", "—", "+2", "+2", "—", "Sem limite diário rígido"],
    ["Errar questão", "Resposta incorreta", "+1", "—", "+1", "+1", "—", "Ainda recompensa esforço"],
    ["Criar questão", "nova questao publicada", "+1", "—", "+1", "+1", "—", "—"],
    ["1º zerar omissas", "Primeiro do dia", "+4", "—", "+4", "+4", "1×/dia", "Flag diária"],
    ["Manter streak", "Participou no dia", "+1", "—", "+1", "+1", "1×/dia", "—"],
    ["Marco streak 3/7/15/30", "Atingiu marco", "bônus", "—", "2–30", "5–50", "por marco", "Ver tabela de marcos"],
    ["Conquista carreira", "Atingiu N respostas", "título", "—", "5–1000", "10–1000", "1×", "Calouro→Nazli"],
    ["Completar caderno", "Fator 0,25×Q (5–40)", "créditos", "—", "0", "5–40", "por caderno", "Capado"],
    ["Comprar item", "Portal / /comprar", "—", "preço", "0", "−preço", "confirm 5 min", "Sim no WhatsApp"],
    ["Equipar item", "/equipar ou Hub", "—", "—", "0", "0", "—", "Cosmético"],
    ["Eliminar alternativa", "/eliminar N", "ajuda", "1 consumível", "0", "0", "por uso", "Item de inventário"],
    ["Aplicar créditos", "/aplicar N", "meta", "lock N", "0", "escrow", "10 dias", "Retorno 12%"],
    ["Intimar", "/intimar …", "duelo", "stake+taxa", "var", "escrow", "24h · máx 2", "Taxa 10% burn"],
    ["Quebrar streak", "Dia perdido", "—", "−4 Aura", "−4", "0", "—", "Loss aversion"],
    ["Dia zerado", "0 respostas", "—", "−1 Aura", "−1", "0", "1×/dia", "—"],
    ["Trancar caderno", "Admin/fluxo", "—", "−50 Aura", "−50", "0", "—", "Grave"]
  ];

  function loadAcoes() {
    $("#acoes-table").innerHTML = `
      <thead>
        <tr>
          <th>Ação</th><th>Descrição</th><th>Recompensa</th><th>Penalidade</th>
          <th>Aura</th><th>Créditos</th><th>Limite/CD</th><th>Obs.</th>
        </tr>
      </thead>
      <tbody>
        ${ACTIONS.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}
      </tbody>`;
  }

  const CMDS = {
    sessao: [
      ["/quiz", "Ativa modo quiz no privado"],
      ["/quizoff", "Sai do modo quiz"],
      ["/ajuda", "Guia completo no chat"]
    ],
    questoes: [
      ["nova questao", "Fluxo de criação (ME ou C/E)"],
      ["a 5 / c 5", "Responder questão #5"],
      ["b 5, comentário", "Responder com comentário"],
      ["/questao 5", "Reenviar enunciado"],
      ["/gabarito 5", "Ver resultado"],
      ["quem respondeu 5", "Lista de respondentes"]
    ],
    cadernos: [
      ["/omissas", "Lista o que falta (engajado/passivo)"],
      ["sim / nao", "Confirma recebimento de enunciados"],
      ["adiantar 2", "Reserva próximos 2 dias (máx. 7)"],
      ["/sync-membros", "Atualiza lista do grupo (no grupo)"]
    ],
    grupo: [
      ["/q&a", "Estatísticas criadas × respondidas"],
      ["ranking", "Atalho para ranking de Aura"]
    ],
    economia: [
      ["/perfil ou /aura", "Carteira, nível, streak, conquistas"],
      ["/loja", "Catálogo do Portal"],
      ["/comprar <item>", "Inicia compra"],
      ["/equipar <item>", "Equipa cosmético"],
      ["/eliminar N", "Remove 1 alternativa errada"],
      ["/aplicar 500", "Aplicação Orçamentária"],
      ["/intimar Nome 50 123", "Mandado de Intimação"],
      ["/ranking aura|producao|disciplina|duelo", "Placares"],
      ["/diario", "Resumo diário enxuto"]
    ]
  };

  function loadComandos(cat = "sessao") {
    $$("#cmd-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.cmd === cat));
    const rows = CMDS[cat] || [];
    $("#cmd-body").innerHTML = rows
      .map(
        ([cmd, desc]) => `
      <div class="cmd-card">
        <code>${esc(cmd)}</code>
        <p>${esc(desc)}</p>
      </div>`
      )
      .join("");
  }

  const IDEIAS = [
    {
      t: "Missão diária de 12 questões",
      d: "Meta alinhada à calibração econômica. Goal-gradient: barra que “quase fecha” puxa a última sessão do dia."
    },
    {
      t: "Temporadas com skin exclusiva",
      d: "Escassez temporal (FOMO ético) + colecionismo. Cada temporada vira capítulo no Diário Oficial."
    },
    {
      t: "Guilda / órgão fictício",
      d: "Cooperação: bônus se 3 membros mantiverem streak. Pertencimento > ranking solitário."
    },
    {
      t: "Cartão de visita compartilhável",
      d: "Imagem do perfil com moldura + Aura. Viralização orgânica no WhatsApp Status."
    },
    {
      t: "Recorde da semana no grupo",
      d: "Prova social periódica sem spam diário — anúncio só de marcos (3/7/15/30)."
    },
    {
      t: "Inventário com raridade visual",
      d: "Endowment effect: item “seu” aumenta retenção mesmo sem poder mecânico."
    },
    {
      t: "Proteção de streak limitada",
      d: "Seguro caro = alívio pontual sem matar a tensão da sequência."
    },
    {
      t: "Hall da Fama no Hub",
      d: "Orgulho de perfil + história institucional (aposentadorias honoríficas, lendas)."
    }
  ];

  function loadIdeias() {
    $("#ideias-root").innerHTML = IDEIAS.map(
      (i) => `
      <article class="idea-card">
        <h3>${esc(i.t)}</h3>
        <p>${esc(i.d)}</p>
      </article>`
    ).join("");
  }

  async function loadPage(page) {
    switch (page) {
      case "diario":
        return loadDiario();
      case "perfil":
        return loadProfile();
      case "rankings":
        return loadRankings();
      case "conquistas":
        return loadConquistas();
      case "inventario":
        return loadInventario();
      case "loja":
        return loadLoja();
      case "historico":
        return loadHistorico();
      case "transparencia":
        return loadTransparencia();
      case "manual":
        return loadManual($("#manual-tabs .active")?.dataset.doc || "aura");
      case "acoes":
        return loadAcoes();
      case "comandos":
        return loadComandos($("#cmd-tabs .active")?.dataset.cmd || "sessao");
      case "ideias":
        return loadIdeias();
      default:
        return loadDiario();
    }
  }

  function bind() {
    $$("[data-go]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        setPage(el.dataset.go);
      });
    });

    $("#hub-user")?.addEventListener("change", async (e) => {
      state.userJid = e.target.value;
      localStorage.setItem(STORAGE_USER, state.userJid);
      await loadPage(state.page);
    });

    $("#diario-reload")?.addEventListener("click", () => loadDiario());
    $("#diario-day")?.addEventListener("change", () => loadDiario());

    $$("#rank-tabs button").forEach((b) => {
      b.addEventListener("click", () => {
        state.rankBoard = b.dataset.board;
        $$("#rank-tabs button").forEach((x) => x.classList.toggle("active", x === b));
        loadRankings();
      });
    });

    $$("#manual-tabs button").forEach((b) => {
      b.addEventListener("click", () => loadManual(b.dataset.doc));
    });

    $$("#cmd-tabs button").forEach((b) => {
      b.addEventListener("click", () => loadComandos(b.dataset.cmd));
    });
  }

  async function boot() {
    bind();
    const hash = (location.hash || "#diario").replace(/^#/, "") || "diario";
    try {
      await loadMembers();
    } catch (e) {
      console.warn(e);
    }
    setPage(hash);
  }

  boot();
})();
