const { applyCors, getClient, pickTargetGroupJid } = require("./_lib");
const { getMembersForGroup, getNameHintsForGroup, pickDisplayLabel, isCadernoIdentity } = require("./_group-members");
const {
  getAuraLevel,
  ACHIEVEMENTS,
  ensureEconomy,
  ensureStreak,
  todayIso,
  randomToken,
  ledgerReasonLabel
} = require("./_economy");

/**
 * API unificada de gamificação (Hobby plan = máx. 12 functions).
 * GET  ?view=members|profile|shop|diario|rankings|plaza|ledger|transparencia
 * POST body.action = purchase-intent|equip
 */

async function handleDiario(supabase, url, res) {
  const day = url.searchParams.get("day") || todayIso();
  const filterUser = url.searchParams.get("userJid") || url.searchParams.get("filterUserJid");

  let q = supabase
    .from("economy_ledger")
    .select("created_at, user_jid, reason, delta_aura, delta_credits, meta, day_iso")
    .eq("day_iso", day)
    .order("created_at", { ascending: false })
    .limit(200);
  if (filterUser) q = q.eq("user_jid", filterUser);
  const { data, error } = await q;
  if (error) throw error;

  const jids = [...new Set((data || []).map((r) => r.user_jid))];
  const { data: ecos } = jids.length
    ? await supabase.from("user_economy").select("user_jid, display_name").in("user_jid", jids)
    : { data: [] };
  const nameMap = new Map((ecos || []).map((e) => [e.user_jid, e.display_name]));

  const { data: social } = await supabase
    .from("diario_oficial_events")
    .select("*")
    .eq("day_iso", day)
    .order("created_at", { ascending: false })
    .limit(50);

  const events = (data || []).map((r) => {
    const meta = { ...(r.meta || {}), actorLabel: nameMap.get(r.user_jid) || r.user_jid };
    return {
      type: "ledger",
      created_at: r.created_at,
      user_jid: r.user_jid,
      label: ledgerReasonLabel(r.reason, meta),
      delta_aura: r.delta_aura,
      delta_credits: r.delta_credits
    };
  });

  for (const s of social || []) {
    events.push({
      type: "social",
      created_at: s.created_at,
      user_jid: s.actor_jid,
      label: `${s.event_type}: ${s.actor_label || s.actor_jid || ""}`,
      payload: s.payload
    });
  }

  events.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return res.status(200).json({ day, events });
}

async function handleRankings(supabase, url, res) {
  const board = (url.searchParams.get("board") || "aura").toLowerCase();
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));

  if (board === "disciplina" || board === "streak") {
    const { data, error } = await supabase
      .from("user_streak")
      .select("user_jid, current_streak, best_streak")
      .order("current_streak", { ascending: false })
      .order("best_streak", { ascending: false })
      .limit(limit);
    if (error) throw error;
    const jids = (data || []).map((r) => r.user_jid);
    const { data: ecos } = jids.length
      ? await supabase.from("user_economy").select("user_jid, display_name, active_title").in("user_jid", jids)
      : { data: [] };
    const map = new Map((ecos || []).map((e) => [e.user_jid, e]));
    return res.status(200).json({
      board: "disciplina",
      rows: (data || []).map((r) => ({
        userJid: r.user_jid,
        label: map.get(r.user_jid)?.display_name || r.user_jid,
        value: r.current_streak,
        title: map.get(r.user_jid)?.active_title
      }))
    });
  }

  let col = "aura";
  if (board === "producao" || board === "produção") col = "lifetime_answers";
  if (board === "duelo") col = "mandados_won";

  const { data, error } = await supabase
    .from("user_economy")
    .select("user_jid, display_name, active_title, aura, lifetime_answers, mandados_won")
    .order(col, { ascending: false })
    .limit(limit);
  if (error) throw error;

  return res.status(200).json({
    board: board === "producao" || board === "produção" ? "producao" : board === "duelo" ? "duelo" : "aura",
    rows: (data || []).map((r) => ({
      userJid: r.user_jid,
      label: r.display_name || r.user_jid,
      value: Number(r[col] || 0),
      title: r.active_title
    }))
  });
}

async function handleShopGet(supabase, url, res) {
  const token = url.searchParams.get("token");
  if (token) {
    const { data, error } = await supabase
      .from("purchase_confirmations")
      .select("status, item_key, expires_at, price_credits")
      .eq("token", token)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Pedido não encontrado" });
    let status = data.status;
    if (status === "pending" && new Date(data.expires_at).getTime() < Date.now()) {
      await supabase.from("purchase_confirmations").update({ status: "expired" }).eq("token", token);
      status = "expired";
    }
    return res.status(200).json({ status, item_key: data.item_key, price_credits: data.price_credits });
  }

  const { data, error } = await supabase
    .from("shop_catalog")
    .select("*")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return res.status(200).json({ items: data || [] });
}

async function handleShopPost(supabase, req, res) {
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const action = body.action || "purchase-intent";

  if (action === "equip") {
    const { userJid, itemKey } = body;
    if (!userJid || !itemKey) return res.status(400).json({ error: "userJid e itemKey obrigatórios" });
    const { data: item } = await supabase.from("shop_catalog").select("*").eq("item_key", itemKey).maybeSingle();
    if (!item || item.consumable) return res.status(400).json({ error: "Item inválido para equipar" });
    const { data: inv } = await supabase
      .from("user_inventory")
      .select("*")
      .eq("user_jid", userJid)
      .eq("item_key", itemKey)
      .maybeSingle();
    if (!inv) return res.status(400).json({ error: "Você não possui este item" });
    const slot = item.metadata?.slot;
    if (slot) {
      const { data: catalog } = await supabase.from("shop_catalog").select("item_key, metadata");
      const same = (catalog || []).filter((c) => c.metadata?.slot === slot).map((c) => c.item_key);
      if (same.length) {
        await supabase.from("user_inventory").update({ equipped: false }).eq("user_jid", userJid).in("item_key", same);
      }
    }
    await supabase
      .from("user_inventory")
      .update({ equipped: true, updated_at: new Date().toISOString() })
      .eq("user_jid", userJid)
      .eq("item_key", itemKey);
    return res.status(200).json({ ok: true, message: `Equipado: ${item.name}` });
  }

  const { userJid, itemKey } = body;
  if (!userJid || !itemKey) return res.status(400).json({ error: "userJid e itemKey obrigatórios" });

  const { data: item, error: itemErr } = await supabase
    .from("shop_catalog")
    .select("*")
    .eq("item_key", itemKey)
    .eq("active", true)
    .maybeSingle();
  if (itemErr) throw itemErr;
  if (!item) return res.status(404).json({ error: "Item não encontrado" });

  const eco = await ensureEconomy(supabase, userJid);
  if ((eco.aura || 0) < (item.min_aura || 0)) {
    return res.status(400).json({ error: `Aura insuficiente (precisa ${item.min_aura})` });
  }
  const available = Math.max(0, (eco.credits || 0) - (eco.credits_escrowed || 0));
  if (available < item.price_credits) {
    return res.status(400).json({ error: "Saldo disponível insuficiente" });
  }

  await supabase
    .from("purchase_confirmations")
    .update({ status: "cancelled" })
    .eq("user_jid", userJid)
    .eq("status", "pending");

  const token = randomToken();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const { error: insErr } = await supabase.from("purchase_confirmations").insert({
    token,
    user_jid: userJid,
    item_key: item.item_key,
    qty: 1,
    price_credits: item.price_credits,
    status: "pending",
    source: "site",
    expires_at: expiresAt
  });
  if (insErr) throw insErr;

  return res.status(200).json({
    token,
    expiresAt,
    item,
    price: item.price_credits,
    balance: available,
    message:
      "Aguardando confirmação no WhatsApp. Responda *sim* no privado com o bot (pedido enviado a esta pessoa)."
  });
}

module.exports = async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const supabase = getClient();
    const groupJid = pickTargetGroupJid();
    const url = new URL(req.url, "http://localhost");
    const view = (url.searchParams.get("view") || "").toLowerCase();

    // POST: compras / equipar
    if (req.method === "POST") {
      return await handleShopPost(supabase, req, res);
    }

    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    if (view === "members") {
      if (!groupJid) return res.status(500).json({ error: "TARGET_GROUP_JIDS não configurado" });
      const { members } = await getMembersForGroup(supabase, groupJid);
      return res.status(200).json({ members });
    }

    if (view === "diario" || view === "audit") {
      return await handleDiario(supabase, url, res);
    }

    if (view === "ledger" || view === "transparencia") {
      const userJid = url.searchParams.get("userJid");
      const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      let q = supabase
        .from("economy_ledger")
        .select("created_at, user_jid, reason, delta_aura, delta_credits, meta, day_iso")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (userJid) q = q.eq("user_jid", userJid);
      const { data, error } = await q;
      if (error) throw error;
      const jids = [...new Set((data || []).map((r) => r.user_jid))];
      const { data: ecos } = jids.length
        ? await supabase.from("user_economy").select("user_jid, display_name").in("user_jid", jids)
        : { data: [] };
      const nameMap = new Map((ecos || []).map((e) => [e.user_jid, e.display_name]));
      const events = (data || []).map((r) => {
        const meta = { ...(r.meta || {}), actorLabel: nameMap.get(r.user_jid) || r.user_jid };
        return {
          created_at: r.created_at,
          day_iso: r.day_iso,
          user_jid: r.user_jid,
          reason: r.reason,
          label: ledgerReasonLabel(r.reason, meta),
          delta_aura: r.delta_aura,
          delta_credits: r.delta_credits,
          meta
        };
      });
      const sum = (arr, key) => arr.reduce((a, r) => a + Number(r[key] || 0), 0);
      const gains = events.filter((e) => Number(e.delta_aura) > 0 || Number(e.delta_credits) > 0);
      const losses = events.filter((e) => Number(e.delta_aura) < 0 || Number(e.delta_credits) < 0);
      return res.status(200).json({
        events,
        stats: {
          auraGained: sum(
            events.filter((e) => Number(e.delta_aura) > 0),
            "delta_aura"
          ),
          auraLost: Math.abs(
            sum(
              events.filter((e) => Number(e.delta_aura) < 0),
              "delta_aura"
            )
          ),
          creditsGained: sum(
            events.filter((e) => Number(e.delta_credits) > 0),
            "delta_credits"
          ),
          creditsSpent: Math.abs(
            sum(
              events.filter((e) => Number(e.delta_credits) < 0),
              "delta_credits"
            )
          ),
          movements: events.length,
          gainEvents: gains.length,
          lossEvents: losses.length
        }
      });
    }

    if (view === "plaza" || view === "roster") {
      const limit = Math.min(80, Math.max(1, Number(url.searchParams.get("limit") || 48)));
      const nameByJid = new Map();
      const groupJids = new Set();
      if (groupJid) {
        try {
          const { members: groupMembers } = await getMembersForGroup(supabase, groupJid);
          for (const m of groupMembers || []) {
            if (!m.userJid || isCadernoIdentity(m.userJid)) continue;
            groupJids.add(m.userJid);
            if (m.displayLabel) nameByJid.set(m.userJid, m.displayLabel);
          }
        } catch (_) {
          /* lista de membros opcional */
        }
        try {
          const hints = await getNameHintsForGroup(supabase, groupJid);
          for (const [jid, name] of hints || []) {
            if (!groupJids.has(jid)) continue;
            if (isCadernoIdentity(jid) || isCadernoIdentity(name)) continue;
            if (!nameByJid.has(jid) && name) nameByJid.set(jid, name);
          }
        } catch (_) {
          /* hints opcionais */
        }
      }

      const resolveName = (userJid, displayName) => {
        if (isCadernoIdentity(userJid) || isCadernoIdentity(displayName)) return null;
        const fromGroup = nameByJid.get(userJid);
        if (fromGroup) return fromGroup;
        return pickDisplayLabel({
          userJid,
          userLabel: displayName || null,
          quizDisplayName: displayName || null,
          nameFromQuiz: null
        });
      };

      const { data: ecos, error } = await supabase
        .from("user_economy")
        .select("user_jid, display_name, active_title, aura, lifetime_answers, mandados_won")
        .order("aura", { ascending: false })
        .limit(limit * 2);
      if (error) throw error;

      // Só pessoas reais: economia (sem caderno:@bot) + membros do grupo
      const ecoMap = new Map();
      for (const e of ecos || []) {
        if (!e.user_jid || isCadernoIdentity(e.user_jid) || isCadernoIdentity(e.display_name)) continue;
        ecoMap.set(e.user_jid, e);
      }
      for (const jid of groupJids) {
        if (!ecoMap.has(jid)) {
          ecoMap.set(jid, {
            user_jid: jid,
            display_name: nameByJid.get(jid) || null,
            active_title: null,
            aura: 0,
            lifetime_answers: 0,
            mandados_won: 0
          });
        }
      }
      const roster = [...ecoMap.values()]
        .sort((a, b) => Number(b.aura || 0) - Number(a.aura || 0))
        .slice(0, limit);

      const jids = roster.map((e) => e.user_jid);
      const { data: streaks } = jids.length
        ? await supabase.from("user_streak").select("user_jid, current_streak, best_streak").in("user_jid", jids)
        : { data: [] };
      const streakMap = new Map((streaks || []).map((s) => [s.user_jid, s]));
      const { data: inv } = jids.length
        ? await supabase
            .from("user_inventory")
            .select("user_jid, item_key, equipped")
            .in("user_jid", jids)
            .eq("equipped", true)
        : { data: [] };
      const { data: catalog } = await supabase.from("shop_catalog").select("item_key, name, metadata, category");
      const catMap = new Map((catalog || []).map((c) => [c.item_key, c]));
      const equippedByUser = new Map();
      for (const row of inv || []) {
        const list = equippedByUser.get(row.user_jid) || [];
        const item = catMap.get(row.item_key);
        list.push({
          item_key: row.item_key,
          name: item?.name || row.item_key,
          slot: item?.metadata?.slot || null,
          css: item?.metadata?.css || null,
          emoji: item?.metadata?.emoji || null,
          metadata: item?.metadata || {}
        });
        equippedByUser.set(row.user_jid, list);
      }
      const members = roster.map((e) => {
        const equipped = equippedByUser.get(e.user_jid) || [];
        const bySlot = Object.fromEntries(equipped.filter((x) => x.slot).map((x) => [x.slot, x]));
        const aura = getAuraLevel(e.aura);
        return {
          userJid: e.user_jid,
          name: resolveName(e.user_jid, e.display_name) || "Participante",
          title: e.active_title || null,
          aura: e.aura || 0,
          auraLevel: aura,
          lifetimeAnswers: e.lifetime_answers || 0,
          mandadosWon: e.mandados_won || 0,
          streak: streakMap.get(e.user_jid)?.current_streak || 0,
          bestStreak: streakMap.get(e.user_jid)?.best_streak || 0,
          equipped,
          frameCss: bySlot.frame?.css || null,
          auraFxCss: bySlot.aura_fx?.css || null,
          nameCss: bySlot.name_color?.css || null,
          bannerCss: bySlot.banner?.css || null,
          avatarCss: bySlot.avatar?.css || null,
          emoji: bySlot.emoji?.emoji || null
        };
      });
      return res.status(200).json({ members });
    }

    if (view === "rankings" || view === "ranking") {
      return await handleRankings(supabase, url, res);
    }

    if (view === "shop" || url.searchParams.get("token")) {
      return await handleShopGet(supabase, url, res);
    }

    const userJid = url.searchParams.get("userJid");
    if (userJid || view === "profile") {
      if (!userJid) return res.status(400).json({ error: "Informe userJid" });
      const eco = await ensureEconomy(supabase, userJid);
      const streak = await ensureStreak(supabase, userJid);
      const { data: inv } = await supabase.from("user_inventory").select("*").eq("user_jid", userJid);
      const { data: catalog } = await supabase.from("shop_catalog").select("*").eq("active", true);
      const byKey = new Map((catalog || []).map((c) => [c.item_key, c]));
      const inventory = (inv || []).map((row) => ({
        ...row,
        name: byKey.get(row.item_key)?.name,
        metadata: byKey.get(row.item_key)?.metadata
      }));
      const { data: unlocked } = await supabase
        .from("user_achievements")
        .select("achievement_key")
        .eq("user_jid", userJid);
      const have = new Set((unlocked || []).map((u) => u.achievement_key));
      const { data: app } = await supabase
        .from("aplicacoes_orcamentarias")
        .select("*")
        .eq("user_jid", userJid)
        .eq("status", "active")
        .maybeSingle();
      const { data: mandados } = await supabase
        .from("intimacoes")
        .select("*")
        .or(`challenger_jid.eq.${userJid},defender_jid.eq.${userJid}`)
        .eq("status", "pending");

      let displayName = eco.display_name;
      if (groupJid) {
        try {
          const { members: groupMembers } = await getMembersForGroup(supabase, groupJid);
          const hit = (groupMembers || []).find((m) => m.userJid === userJid);
          if (hit?.displayLabel) displayName = hit.displayLabel;
        } catch (_) {
          /* ignore */
        }
      }
      displayName = pickDisplayLabel({
        userJid,
        userLabel: displayName || null,
        quizDisplayName: displayName || null,
        nameFromQuiz: null
      });

      return res.status(200).json({
        economy: { ...eco, display_name: displayName },
        streak,
        availableCredits: Math.max(0, (eco.credits || 0) - (eco.credits_escrowed || 0)),
        aura: getAuraLevel(eco.aura),
        inventory,
        achievements: ACHIEVEMENTS.map((a) => ({ ...a, unlocked: have.has(a.key) })),
        aplicacao: app,
        mandados: mandados || []
      });
    }

    return res.status(400).json({
      error: "Use view=members|profile|shop|diario|rankings|plaza|ledger|transparencia (ou userJid / token)"
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};
