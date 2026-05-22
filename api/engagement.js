const { getClient, pickTargetGroupJid, applyCors } = require("./_lib.js");
const { getMembersForGroup, getNameHintsForGroup, pickDisplayLabel } = require("./_group-members.js");

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
      const { members, warning } = await getMembersForGroup(supabase, groupJid);
      return res.status(200).json({ members, groupJid, warning: warning || undefined });
    }

    if (req.method === "PATCH") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const userJid = body.userJid != null ? String(body.userJid).trim() : "";
      if (!userJid) {
        return res.status(400).json({ error: "Campo userJid e obrigatorio." });
      }
      const engaged = Boolean(body.engaged);

      const nowIso = new Date().toISOString();
      const patch = { engaged, updated_at: nowIso };

      if (engaged) {
        const { data: prev } = await supabase
          .from("group_member_engagement")
          .select("engaged, engaged_since")
          .eq("group_jid", groupJid)
          .eq("user_jid", userJid)
          .maybeSingle();
        const wasEngaged = Boolean(prev && prev.engaged);
        const hadSince = Boolean(prev && prev.engaged_since);
        if (!wasEngaged || !hadSince) {
          patch.engaged_since = nowIso;
        }
      } else {
        patch.engaged_since = null;
      }

      let upd = await supabase
        .from("group_member_engagement")
        .update(patch)
        .eq("group_jid", groupJid)
        .eq("user_jid", userJid)
        .select("user_jid, user_label, quiz_display_name, engaged, updated_at");

      if (
        upd.error &&
        String(upd.error.message || "").toLowerCase().includes("engaged_since")
      ) {
        // Coluna ainda não existe (migração pendente) — tenta sem ela.
        const fallback = { engaged, updated_at: nowIso };
        upd = await supabase
          .from("group_member_engagement")
          .update(fallback)
          .eq("group_jid", groupJid)
          .eq("user_jid", userJid)
          .select("user_jid, user_label, quiz_display_name, engaged, updated_at");
      }

      const updated = upd.data;
      const uErr = upd.error;
      if (uErr) throw uErr;
      if (!updated || updated.length === 0) {
        return res.status(404).json({
          error:
            "Membro nao encontrado para este grupo. Rode /sync-membros no WhatsApp para popular a lista."
        });
      }

      const r = updated[0];
      const memberJid = String(r.user_jid);
      const userLabel = r.user_label ? String(r.user_label) : null;
      const quizDisplayName = r.quiz_display_name != null ? String(r.quiz_display_name) : null;
      const hints = await getNameHintsForGroup(supabase, groupJid);
      const displayLabel = pickDisplayLabel({
        userJid: memberJid,
        userLabel,
        quizDisplayName,
        nameFromQuiz: hints.get(memberJid) || null
      });

      return res.status(200).json({
        member: {
          userJid: memberJid,
          userLabel,
          quizDisplayName,
          displayLabel,
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
