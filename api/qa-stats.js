const {
  getClient,
  pickTargetGroupJid,
  applyCors,
  fetchQuestionsForGroup,
  fetchPublishedCadernoQuestionIdsForGroup,
  isBotCreatorJid
} = require("./_lib.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const groupJid = pickTargetGroupJid();
    if (!groupJid) {
      return res.status(200).json({
        groupJid: null,
        participants: [],
        botCreatedCount: 0,
        totals: { questionsCreated: 0, answersRecorded: 0 },
        warning: "TARGET_GROUP_JIDS nao configurado no Vercel."
      });
    }

    const supabase = getClient();
    const [questions, publishedCadernoIds] = await Promise.all([
      fetchQuestionsForGroup(supabase, groupJid, {
        extended: true,
        includeCreatorJid: true
      }),
      fetchPublishedCadernoQuestionIdsForGroup(supabase, groupJid)
    ]);

    const botCreatedCount = publishedCadernoIds.size;
    const questionIds = questions.map((q) => q.id);
    let answersRaw = [];
    if (questionIds.length) {
      const { data: ans, error: aErr } = await supabase
        .from("answers")
        .select("question_id, user_jid, user_name")
        .in("question_id", questionIds);
      if (aErr) throw aErr;
      answersRaw = ans || [];
    }

    const byUser = new Map();

    function touch(jid, label) {
      const key = jid || label;
      if (!byUser.has(key)) {
        byUser.set(key, { userJid: jid || key, userLabel: label, createdCount: 0, answeredCount: 0 });
      }
      return byUser.get(key);
    }

    for (const q of questions) {
      if (isBotCreatorJid(q.creator_jid)) continue;
      const label = (q.creator_name && String(q.creator_name).trim()) || q.creator_jid || "Autor";
      touch(q.creator_jid, label).createdCount += 1;
    }

    for (const a of answersRaw) {
      const label = (a.user_name && String(a.user_name).trim()) || a.user_jid;
      touch(a.user_jid, label).answeredCount += 1;
    }

    const participants = Array.from(byUser.values()).sort((a, b) => {
      if (b.answeredCount !== a.answeredCount) return b.answeredCount - a.answeredCount;
      if (b.createdCount !== a.createdCount) return b.createdCount - a.createdCount;
      return a.userLabel.localeCompare(b.userLabel, "pt-BR");
    });

    return res.status(200).json({
      groupJid,
      participants,
      botCreatedCount,
      totals: {
        questionsCreated: questions.length,
        answersRecorded: answersRaw.length
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao carregar Q&A" });
  }
};
