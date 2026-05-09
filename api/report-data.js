const { getClient, pickTargetGroupJid, applyCors, fetchQuestionsForGroup } = require("./_lib.js");

function normalizeLetter(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "certo") return "C";
  if (s === "errado") return "E";
  return s.slice(0, 1).toUpperCase();
}

function answerIsCorrect(answerLetter, answerKey) {
  return normalizeLetter(answerLetter) === String(answerKey || "").toUpperCase().slice(0, 1);
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const groupJid = pickTargetGroupJid();
    if (!groupJid) {
      return res.status(200).json({
        groupJid: null,
        questions: [],
        answers: [],
        participants: [],
        warning: "TARGET_GROUP_JIDS nao configurado no Vercel."
      });
    }

    const supabase = getClient();
    const rows = (await fetchQuestionsForGroup(supabase, groupJid, { extended: true })).slice(0, 500);

    const questionIds = rows.map((r) => r.id);
    let answersRaw = [];
    if (questionIds.length) {
      const { data: ans, error: aErr } = await supabase
        .from("answers")
        .select("question_id, question_short_id, user_jid, user_name, answer_letter")
        .in("question_id", questionIds);

      if (aErr) throw aErr;
      answersRaw = ans || [];
    }

    const qById = new Map(rows.map((r) => [r.id, r]));

    const answers = answersRaw.map((row) => {
      const q = qById.get(row.question_id);
      const key = q ? q.answer_key : null;
      const correct = q ? answerIsCorrect(row.answer_letter, key) : false;
      return {
        questionId: row.question_id,
        questionShortId: String(row.question_short_id || "").toUpperCase(),
        userJid: row.user_jid,
        userName: (row.user_name && String(row.user_name).trim()) || row.user_jid,
        answerLetter: String(row.answer_letter || "").toLowerCase(),
        answerLetterDisplay: normalizeLetter(row.answer_letter),
        correct
      };
    });

    const partMap = new Map();
    for (const a of answers) {
      if (!partMap.has(a.userJid)) {
        partMap.set(a.userJid, { userJid: a.userJid, userName: a.userName });
      }
    }
    const participants = Array.from(partMap.values()).sort((x, y) =>
      x.userName.localeCompare(y.userName, "pt-BR")
    );

    const questions = rows.map((row) => ({
      id: row.id,
      shortId: String(row.short_id || "").toUpperCase(),
      creatorName: row.creator_name || "Autor",
      questionType: row.question_type,
      statementText: row.statement_text || "",
      statementMediaUrl: row.statement_media_url || null,
      statementMediaMimeType: row.statement_media_mime_type || null,
      answerKey: String(row.answer_key || "").toUpperCase().slice(0, 1),
      explanationText: row.explanation_text || null,
      explanationMediaUrl: row.explanation_media_url || null,
      explanationMediaMimeType: row.explanation_media_mime_type || null,
      createdAt: row.created_at
    }));

    return res.status(200).json({
      groupJid,
      questions,
      answers,
      participants
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao montar relatorio" });
  }
};
