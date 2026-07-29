const { applyCors, getClient } = require("./_lib");
const { todayIso, ledgerReasonLabel } = require("./_economy");

/** Alias amigável: auditoria completa do Diário Oficial no app. */
module.exports = async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabase = getClient();
    const url = new URL(req.url, "http://localhost");
    const day = url.searchParams.get("day") || todayIso();
    const filterUser = url.searchParams.get("userJid");

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
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};
