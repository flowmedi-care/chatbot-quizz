const { applyCors, getClient } = require("./_lib");

module.exports = async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabase = getClient();
    const url = new URL(req.url, "http://localhost");
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
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};
