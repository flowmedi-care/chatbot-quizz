const { applyCors, getClient, pickTargetGroupJid } = require("./_lib");
const { getMembersForGroup } = require("./_group-members");
const {
  getAuraLevel,
  ACHIEVEMENTS,
  ensureEconomy,
  ensureStreak,
  todayIso,
  ledgerReasonLabel
} = require("./_economy");

module.exports = async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const supabase = getClient();
    const groupJid = pickTargetGroupJid();
    const url = new URL(req.url, "http://localhost");
    const userJid = url.searchParams.get("userJid");
    const view = url.searchParams.get("view") || "profile";

    if (req.method === "GET" && view === "members") {
      if (!groupJid) return res.status(500).json({ error: "TARGET_GROUP_JIDS não configurado" });
      const { members } = await getMembersForGroup(supabase, groupJid);
      return res.status(200).json({ members });
    }

    if (req.method === "GET" && view === "audit") {
      const day = url.searchParams.get("day") || todayIso();
      const filterUser = url.searchParams.get("filterUserJid");
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
      const events = (data || []).map((r) => {
        const meta = { ...(r.meta || {}), actorLabel: nameMap.get(r.user_jid) || r.user_jid };
        return {
          ...r,
          label: ledgerReasonLabel(r.reason, meta)
        };
      });
      return res.status(200).json({ day, events });
    }

    if (req.method === "GET" && userJid) {
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

      return res.status(200).json({
        economy: eco,
        streak,
        availableCredits: Math.max(0, (eco.credits || 0) - (eco.credits_escrowed || 0)),
        aura: getAuraLevel(eco.aura),
        inventory,
        achievements: ACHIEVEMENTS.map((a) => ({ ...a, unlocked: have.has(a.key) })),
        aplicacao: app,
        mandados: mandados || []
      });
    }

    return res.status(400).json({ error: "Informe userJid ou view=members|audit" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};
