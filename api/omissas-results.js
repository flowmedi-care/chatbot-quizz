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

    const playable = session.shortIds.filter((sid) => {
      const q = questions.find((x) => String(x.short_id).toUpperCase() === sid);
      return Boolean(q);
    });

    const unanswered = playable.filter((sid) => !answers.has(sid));
    if (unanswered.length > 0 && !session.completedAt) {
      return res.status(409).json({
        error: "Ainda há questões pendentes nesta sessão.",
        pendingCount: unanswered.length
      });
    }

    let correctCount = 0;
    let wrongCount = 0;
    const items = [];

    for (const sid of session.shortIds) {
      const q = questions.find((x) => String(x.short_id).toUpperCase() === sid);
      const ans = answers.get(sid);
      if (!q) {
        items.push({
          shortId: sid,
          missing: true,
          statementText: null,
          yourLetter: ans ? ans.letter : null,
          yourComment: ans ? ans.comment : null,
          answerKey: null,
          correct: null
        });
        continue;
      }

      const expected = String(q.answer_key || "")
        .trim()
        .toLowerCase()
        .slice(0, 1);
      const yours = ans ? String(ans.letter).toLowerCase().slice(0, 1) : null;
      const correct = yours != null && expected ? yours === expected : null;
      if (correct === true) correctCount += 1;
      else if (correct === false) wrongCount += 1;

      items.push({
        shortId: sid,
        missing: false,
        creatorName: q.creator_name || "Autor",
        questionType: q.question_type,
        statementText: q.statement_text || "",
        statementMediaUrl: q.statement_media_url || null,
        statementMediaMimeType: q.statement_media_mime_type || null,
        yourLetter: yours,
        yourComment: ans ? ans.comment : null,
        answerKey: expected ? expected.toUpperCase() : null,
        correct,
        explanationText: q.explanation_text || null,
        explanationMediaUrl: q.explanation_media_url || null,
        explanationMediaMimeType: q.explanation_media_mime_type || null
      });
    }

    return res.status(200).json({
      mode: session.mode,
      correctCount,
      wrongCount,
      total: playable.length,
      items
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao carregar resultados" });
  }
};
