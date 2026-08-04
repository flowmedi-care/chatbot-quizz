const { applyCors } = require("./_lib.js");
const {
  getClient,
  loadSession,
  fetchQuestionsByShortIds,
  fetchUserAnswersForShortIds
} = require("./_omissas-web.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const token = String(req.query.t || req.query.token || "").trim();

  try {
    const supabase = getClient();
    const loaded = await loadSession(supabase, token);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { session } = loaded;
    const questions = await fetchQuestionsByShortIds(supabase, session.shortIds);
    const answers = await fetchUserAnswersForShortIds(supabase, session.userJid, session.shortIds);

    const list = session.shortIds.map((sid) => {
      const q = questions.find((x) => String(x.short_id).toUpperCase() === sid);
      const ans = answers.get(sid) || null;
      if (!q) {
        return {
          shortId: sid,
          missing: true,
          alreadyAnswered: Boolean(ans),
          yourLetter: ans ? ans.letter : null
        };
      }
      return {
        shortId: sid,
        creatorName: q.creator_name || "Autor",
        questionType: q.question_type,
        statementText: q.statement_text || "",
        statementMediaUrl: q.statement_media_url || null,
        statementMediaMimeType: q.statement_media_mime_type || null,
        alreadyAnswered: Boolean(ans),
        yourLetter: ans ? ans.letter : null,
        yourComment: ans ? ans.comment : null,
        missing: false
      };
    });

    const pending = list.filter((q) => !q.missing && !q.alreadyAnswered);
    const answeredCount = list.filter((q) => q.alreadyAnswered).length;

    return res.status(200).json({
      mode: session.mode,
      expiresAt: session.expiresAt,
      completedAt: session.completedAt,
      total: list.length,
      answeredCount,
      pendingCount: pending.length,
      questions: list
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao carregar sessão" });
  }
};
