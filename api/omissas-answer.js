const { applyCors } = require("./_lib.js");
const {
  getClient,
  loadSession,
  fetchQuestionsByShortIds,
  fetchUserAnswersForShortIds,
  normalizeLetter,
  upsertAnswer,
  enqueueBotEvent,
  markSessionCompleted
} = require("./_omissas-web.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "JSON inválido" });
  }

  const token = String(body.t || body.token || "").trim();
  const shortId = String(body.shortId || "")
    .trim()
    .toUpperCase();
  const comment = body.comment != null ? String(body.comment) : "";

  try {
    const supabase = getClient();
    const loaded = await loadSession(supabase, token);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { session } = loaded;
    if (!session.shortIds.includes(shortId)) {
      return res.status(403).json({ error: "Esta questão não faz parte da sua sessão." });
    }

    const questions = await fetchQuestionsByShortIds(supabase, [shortId]);
    const q = questions[0];
    if (!q) return res.status(404).json({ error: "Questão não encontrada" });

    const letter = normalizeLetter(body.letter, q.question_type);
    if (!letter) {
      return res.status(400).json({
        error:
          q.question_type === "true_false"
            ? "Resposta inválida. Use C (certo) ou E (errado)."
            : "Resposta inválida. Use A, B, C, D ou E."
      });
    }

    let saveResult;
    try {
      saveResult = await upsertAnswer(supabase, {
        questionId: q.id,
        shortId,
        userJid: session.userJid,
        userName: session.userName,
        letter,
        comment,
        creatorJid: q.creator_jid
      });
    } catch (e) {
      if (e.code === "SELF_ANSWER") {
        return res.status(403).json({ error: e.message });
      }
      throw e;
    }

    await enqueueBotEvent(supabase, "web_answer", {
      userJid: session.userJid,
      userName: session.userName,
      questionShortId: shortId,
      questionId: q.id,
      answerLetter: letter,
      answerKey: q.answer_key,
      groupJid: session.groupJid,
      wasUpdate: saveResult.wasUpdate,
      previousLetter: saveResult.previousLetter,
      sessionToken: session.token
    });

    const answers = await fetchUserAnswersForShortIds(supabase, session.userJid, session.shortIds);
    const pendingIds = session.shortIds.filter((sid) => !answers.has(sid));
    const allDone = pendingIds.length === 0;
    if (allDone) {
      await markSessionCompleted(supabase, session.token);
    }

    // Sem gabarito / certo-errado — só no final da sessão.
    return res.status(200).json({
      ok: true,
      shortId,
      answeredCount: session.shortIds.length - pendingIds.length,
      pendingCount: pendingIds.length,
      sessionComplete: allDone
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao salvar resposta" });
  }
};
