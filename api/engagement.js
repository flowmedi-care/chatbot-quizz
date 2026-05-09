const { getClient, pickTargetGroupJid, applyCors } = require("./_lib.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const groupJid = pickTargetGroupJid();
  if (!groupJid) {
    return res.status(200).json({
      members: [],
      groupJid: null,
      warning: "TARGET_GROUP_JIDS nao configurado no Vercel."
    });
  }

  try {
    const supabase = getClient();

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("group_member_engagement")
        .select("user_jid, user_label, engaged, updated_at")
        .eq("group_jid", groupJid)
        .order("user_label", { ascending: true, nullsFirst: false });

      if (error) {
        const msg = String(error.message || "").toLowerCase();
        if (msg.includes("relation") && msg.includes("does not exist")) {
          return res.status(200).json({
            members: [],
            groupJid,
            warning:
              "Tabela group_member_engagement inexistente. Rode a migracao SQL no Supabase e use /sync-membros no grupo."
          });
        }
        throw error;
      }

      const members = (data || []).map((r) => ({
        userJid: String(r.user_jid),
        userLabel: r.user_label ? String(r.user_label) : null,
        engaged: Boolean(r.engaged),
        updatedAt: r.updated_at ? String(r.updated_at) : null
      }));

      return res.status(200).json({ members, groupJid });
    }

    if (req.method === "PATCH") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const userJid = body.userJid != null ? String(body.userJid).trim() : "";
      if (!userJid) {
        return res.status(400).json({ error: "Campo userJid e obrigatorio." });
      }
      const engaged = Boolean(body.engaged);

      const { data: updated, error: uErr } = await supabase
        .from("group_member_engagement")
        .update({ engaged, updated_at: new Date().toISOString() })
        .eq("group_jid", groupJid)
        .eq("user_jid", userJid)
        .select("user_jid, user_label, engaged, updated_at");

      if (uErr) throw uErr;
      if (!updated || updated.length === 0) {
        return res.status(404).json({
          error:
            "Membro nao encontrado para este grupo. Rode /sync-membros no WhatsApp para popular a lista."
        });
      }

      const r = updated[0];
      return res.status(200).json({
        member: {
          userJid: String(r.user_jid),
          userLabel: r.user_label ? String(r.user_label) : null,
          engaged: Boolean(r.engaged),
          updatedAt: r.updated_at ? String(r.updated_at) : null
        }
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro no engajamento" });
  }
};
