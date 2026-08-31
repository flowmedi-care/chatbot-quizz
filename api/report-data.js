const {
  getClient,
  pickTargetGroupJid,
  applyCors,
  fetchQuestionsForGroup,
  fetchAllIn,
  jidComparableKey
} = require("./_lib.js");
const { mapCategoriesByAnswerIds, listUserCategories } = require("./_categories.js");
const { listThreadsForShortIds } = require("./_discussions.js");
const { publishedDayIso } = require("./_schedule.js");

const REPORT_TZ = "America/Sao_Paulo";

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

function parseCadernoIdFromCreator(creatorJid) {
  const m = String(creatorJid || "").match(/^caderno:(\d+)@bot$/i);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
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
        categoriesByUser: {},
        warning: "TARGET_GROUP_JIDS nao configurado no Vercel."
      });
    }

    const supabase = getClient();
    const rows = await fetchQuestionsForGroup(supabase, groupJid, { extended: true });

    const questionIds = rows.map((r) => r.id);
    let answersRaw = [];
    if (questionIds.length) {
      try {
        answersRaw = await fetchAllIn(
          supabase,
          "answers",
          "id, question_id, question_short_id, user_jid, user_name, answer_letter, answer_comment, ai_comment, created_at, sent_at",
          "question_id",
          questionIds
        );
      } catch (ansErr) {
        if (!String(ansErr.message || "").toLowerCase().includes("sent_at")) throw ansErr;
        answersRaw = await fetchAllIn(
          supabase,
          "answers",
          "id, question_id, question_short_id, user_jid, user_name, answer_letter, answer_comment, ai_comment, created_at",
          "question_id",
          questionIds
        );
      }
    }

    const answerIds = answersRaw.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
    let categoriesByAnswer = new Map();
    try {
      categoriesByAnswer = await mapCategoriesByAnswerIds(supabase, answerIds);
    } catch (catErr) {
      console.warn("[report-data] categories:", catErr.message || catErr);
    }

    const cadernoByQuestionId = new Map();
    const publishedAtByQuestionId = new Map();
    if (questionIds.length) {
      try {
        let cqRows = [];
        try {
          cqRows = await fetchAllIn(
            supabase,
            "caderno_questions",
            "published_question_id, caderno_id, published_at",
            "published_question_id",
            questionIds
          );
        } catch (pubErr) {
          if (!String(pubErr.message || "").toLowerCase().includes("published_at")) throw pubErr;
          cqRows = await fetchAllIn(
            supabase,
            "caderno_questions",
            "published_question_id, caderno_id",
            "published_question_id",
            questionIds
          );
        }
        for (const row of cqRows || []) {
          const qid = Number(row.published_question_id);
          const cid = Number(row.caderno_id);
          if (Number.isFinite(qid) && Number.isFinite(cid)) {
            cadernoByQuestionId.set(qid, cid);
          }
          if (Number.isFinite(qid) && row.published_at) {
            publishedAtByQuestionId.set(qid, String(row.published_at));
          }
        }
      } catch (cqErr) {
        console.warn("[report-data] caderno_questions:", cqErr.message || cqErr);
      }
    }

    const cadernoIds = [...new Set(cadernoByQuestionId.values())];
    for (const row of rows) {
      const fromCreator = parseCadernoIdFromCreator(row.creator_jid);
      if (fromCreator && !cadernoByQuestionId.has(row.id)) {
        cadernoByQuestionId.set(row.id, fromCreator);
        if (!cadernoIds.includes(fromCreator)) cadernoIds.push(fromCreator);
      }
    }

    const cadernoNames = new Map();
    if (cadernoIds.length) {
      const { data: cRows, error: cErr } = await supabase
        .from("cadernos")
        .select("id, name")
        .in("id", cadernoIds);
      if (!cErr) {
        for (const c of cRows || []) {
          cadernoNames.set(Number(c.id), String(c.name || `Caderno #${c.id}`));
        }
      }
    }

    const qById = new Map(rows.map((r) => [r.id, r]));

    const answers = answersRaw.map((row) => {
      const q = qById.get(row.question_id);
      const key = q ? q.answer_key : null;
      const correct = q ? answerIsCorrect(row.answer_letter, key) : false;
      const { splitAnswerComments } = require("./_answer-comments.js");
      const split = splitAnswerComments(row);
      const answerId = Number(row.id);
      return {
        answerId: Number.isFinite(answerId) ? answerId : null,
        questionId: row.question_id,
        questionShortId: String(row.question_short_id || "").toUpperCase(),
        userJid: row.user_jid,
        userJidKey: jidComparableKey(row.user_jid),
        userName: (row.user_name && String(row.user_name).trim()) || row.user_jid,
        answerLetter: String(row.answer_letter || "").toLowerCase(),
        answerLetterDisplay: normalizeLetter(row.answer_letter),
        answerComment: split.comment,
        answerAiComment: split.aiComment,
        correct,
        categories: categoriesByAnswer.get(answerId) || [],
        answeredAt: row.sent_at || row.created_at || null,
        answeredDay: row.sent_at || row.created_at
          ? publishedDayIso(row.sent_at || row.created_at, REPORT_TZ)
          : null
      };
    });

    const partMap = new Map();
    for (const a of answers) {
      if (!partMap.has(a.userJid)) {
        partMap.set(a.userJid, {
          userJid: a.userJid,
          userJidKey: a.userJidKey,
          userName: a.userName
        });
      }
    }
    const participants = Array.from(partMap.values()).sort((x, y) =>
      x.userName.localeCompare(y.userName, "pt-BR")
    );

    const categoriesByUser = {};
    for (const p of participants) {
      try {
        categoriesByUser[p.userJid] = await listUserCategories(supabase, p.userJid);
      } catch {
        categoriesByUser[p.userJid] = [];
      }
    }

    const questions = rows.map((row) => {
      const cadernoId = cadernoByQuestionId.get(row.id) ?? null;
      const pubAt = publishedAtByQuestionId.get(row.id) || row.created_at;
      return {
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
        createdAt: row.created_at,
        publishedDay: pubAt ? publishedDayIso(pubAt, REPORT_TZ) : null,
        cadernoId,
        cadernoName: cadernoId != null ? cadernoNames.get(cadernoId) || `Caderno #${cadernoId}` : null
      };
    });

    let discussions = {};
    try {
      discussions = await listThreadsForShortIds(
        supabase,
        questions.map((q) => q.shortId)
      );
    } catch (discErr) {
      console.warn("[report-data] discussions:", discErr.message || discErr);
    }

    return res.status(200).json({
      groupJid,
      questions,
      answers,
      participants,
      categoriesByUser,
      discussions
    });
  } catch (e) {
    console.error("[report-data]", e);
    return res.status(500).json({ error: e.message || "Erro interno" });
  }
};
