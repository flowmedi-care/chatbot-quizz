const { getClient, pickTargetGroupJid, applyCors } = require("./_lib.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const groupJid = pickTargetGroupJid();
    if (!groupJid) {
      return res.status(200).json({
        entries: [],
        warning: "TARGET_GROUP_JIDS nao configurado no Vercel."
      });
    }

    const supabase = getClient();

    const { data: byTarget, error: errTarget } = await supabase
      .from("questions")
      .select("id, answer_key")
      .eq("target_group_jid", groupJid);

    if (errTarget) throw errTarget;

    let byLegacy = [];
    const legacyRes = await supabase.from("questions").select("id, answer_key").eq("group_jid", groupJid);
    if (!legacyRes.error && legacyRes.data) byLegacy = legacyRes.data;

    const answerKeyByQuestionId = new Map();
    for (const q of [...(byTarget || []), ...byLegacy]) {
      answerKeyByQuestionId.set(q.id, String(q.answer_key).toUpperCase());
    }

    const questionIds = [...answerKeyByQuestionId.keys()];
    if (questionIds.length === 0) {
      return res.status(200).json({ entries: [], groupJid });
    }

    const { data: answers, error: aErr } = await supabase
      .from("answers")
      .select("question_id, user_jid, user_name, answer_letter")
      .in("question_id", questionIds);

    if (aErr) throw aErr;

    const counts = new Map();

    for (const row of answers || []) {
      const expected = answerKeyByQuestionId.get(row.question_id);
      if (!expected) continue;
      const given = String(row.answer_letter).toUpperCase();
      if (given !== expected) continue;

      const key = row.user_jid;
      const label = (row.user_name && String(row.user_name).trim()) || key;
      const prev = counts.get(key);
      if (prev) prev.correctCount += 1;
      else counts.set(key, { userLabel: label, userJid: key, correctCount: 1 });
    }

    const entries = Array.from(counts.values()).sort((a, b) => {
      if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
      return a.userLabel.localeCompare(b.userLabel, "pt-BR");
    });

    return res.status(200).json({ entries, groupJid });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro no ranking" });
  }
};
