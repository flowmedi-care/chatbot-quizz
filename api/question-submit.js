/**
 * Practice quiz + categorias pessoais (Hobby: max 12 functions).
 * URLs via rewrites:
 *   GET  /api/question-detail?shortId=&userJid=
 *   POST /api/question-submit
 *   GET  /api/user-categories?userJid=
 *   POST /api/user-categories  { userJid, name }
 *   POST /api/answer-categories { userJid, shortId, categoryIds }
 */
const crypto = require("crypto");
const { getClient, applyCors, isBotCreatorJid } = require("./_lib.js");
const {
  listUserCategories,
  createUserCategory,
  getAnswerRow,
  listCategoriesForAnswer,
  setAnswerCategories
} = require("./_categories.js");

function resolveRoute(req) {
  const url = new URL(req.url || "/", "http://localhost");
  const fromQuery = url.searchParams.get("qz");
  if (
    fromQuery === "detail" ||
    fromQuery === "submit" ||
    fromQuery === "categories" ||
    fromQuery === "set-categories"
  ) {
    return fromQuery;
  }

  const path = String(
    req.headers["x-vercel-original-path"] ||
      req.headers["x-invoke-path"] ||
      url.pathname ||
      ""
  ).toLowerCase();

  if (path.includes("question-detail")) return "detail";
  if (path.includes("answer-categories")) return "set-categories";
  if (path.includes("user-categories")) return "categories";
  if (path.includes("question-submit")) return "submit";
  if (req.method === "GET" && url.searchParams.get("shortId")) return "detail";
  if (req.method === "POST") return "submit";
  return null;
}

function jidComparableKey(jid) {
  const raw = String(jid || "")
    .trim()
    .toLowerCase();
  const at = raw.indexOf("@");
  if (at < 0) return raw;
  const user = raw.slice(0, at).split(":")[0];
  const domain = raw.slice(at + 1);
  return `${user}@${domain}`;
}

function isSameParticipant(a, b) {
  return jidComparableKey(a) === jidComparableKey(b);
}

function normalizeLetter(letterRaw, questionType) {
  const raw = String(letterRaw || "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (questionType === "true_false") {
    if (raw === "c" || raw === "certo") return "c";
    if (raw === "e" || raw === "errado") return "e";
    return null;
  }
  const L = raw.slice(0, 1);
  if (!"abcde".includes(L)) return null;
  return L;
}

async function upsertPracticeAnswer(supabase, input) {
  const { questionId, shortId, userJid, userName, letter, comment, creatorJid } = input;

  if (creatorJid && !isBotCreatorJid(creatorJid) && isSameParticipant(creatorJid, userJid)) {
    const err = new Error("Você não pode responder uma questão que você criou.");
    err.code = "SELF_ANSWER";
    throw err;
  }

  const { data: existingRows, error: findErr } = await supabase
    .from("answers")
    .select("id, answer_letter, user_jid")
    .eq("question_id", questionId);
  if (findErr) throw findErr;

  const userKey = jidComparableKey(userJid);
  const existing =
    (existingRows || []).find((r) => jidComparableKey(r.user_jid) === userKey) || null;

  const row = {
    question_id: questionId,
    question_short_id: shortId,
    user_jid: existing ? existing.user_jid : userJid,
    user_name: userName || null,
    answer_letter: letter,
    answer_comment: comment && String(comment).trim() ? String(comment).trim() : null,
    source_message_id: `web:${crypto.randomBytes(8).toString("hex")}`,
    sent_at: new Date().toISOString()
  };

  if (existing) {
    const { data: updated, error } = await supabase
      .from("answers")
      .update(row)
      .eq("id", existing.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return { answerId: Number(updated?.id || existing.id), wasUpdate: true };
  }

  const { data: inserted, error } = await supabase.from("answers").insert(row).select("id").maybeSingle();
  if (error) {
    if (error.code === "23505") {
      const { data: upd, error: upErr } = await supabase
        .from("answers")
        .update(row)
        .eq("question_id", questionId)
        .eq("user_jid", userJid)
        .select("id")
        .maybeSingle();
      if (upErr) throw upErr;
      return { answerId: Number(upd?.id), wasUpdate: true };
    }
    throw error;
  }
  return { answerId: Number(inserted?.id), wasUpdate: false };
}

async function handleDetail(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const shortId = String(req.query.shortId || "")
    .trim()
    .toUpperCase();
  const userJid = String(req.query.userJid || "").trim();
  if (!shortId) return res.status(400).json({ error: "Informe shortId" });

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from("questions")
      .select(
        "id, short_id, creator_name, creator_jid, question_type, statement_text, statement_media_url, statement_media_mime_type, created_at"
      )
      .eq("short_id", shortId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Questao nao encontrada" });

    const payload = {
      shortId: String(data.short_id).toUpperCase(),
      creatorName: data.creator_name || "Autor",
      questionType: data.question_type,
      statementText: data.statement_text || "",
      statementMediaUrl: data.statement_media_url || null,
      statementMediaMimeType: data.statement_media_mime_type || null,
      createdAt: data.created_at,
      existingAnswer: null,
      categories: [],
      userCategories: []
    };

    if (userJid) {
      payload.userCategories = await listUserCategories(supabase, userJid);
      const ans = await getAnswerRow(supabase, shortId, userJid);
      if (ans) {
        const cats = await listCategoriesForAnswer(supabase, ans.id);
        payload.existingAnswer = {
          answerId: Number(ans.id),
          letter: String(ans.answer_letter || "").toLowerCase(),
          comment:
            ans.answer_comment != null && String(ans.answer_comment).trim()
              ? String(ans.answer_comment).trim()
              : null
        };
        payload.categories = cats;
      }
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao carregar questao" });
  }
}

async function handleSubmit(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "JSON invalido" });
  }

  const shortId = String(body.shortId || "")
    .trim()
    .toUpperCase();
  const letterRaw = String(body.letter || "")
    .trim()
    .toLowerCase();
  const userJid = body.userJid != null ? String(body.userJid).trim() : "";
  const userName = body.userName != null ? String(body.userName).trim() : "";
  const comment = body.comment != null ? String(body.comment) : null;
  const categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds : null;

  if (!shortId || !letterRaw) {
    return res.status(400).json({ error: "Informe shortId e letter" });
  }

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from("questions")
      .select(
        "id, answer_key, question_type, creator_jid, explanation_text, explanation_media_url, explanation_media_mime_type"
      )
      .eq("short_id", shortId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Questao nao encontrada" });

    const expected = String(data.answer_key).toUpperCase();
    const qType = data.question_type;
    const letter = normalizeLetter(letterRaw, qType);
    if (!letter) {
      return res.status(400).json({ error: "Letra invalida para este tipo de questao" });
    }

    const userLetter = letter.toUpperCase();
    const correct = userLetter === expected;

    let answerId = null;
    let categories = [];
    let persisted = false;

    if (userJid) {
      try {
        const saved = await upsertPracticeAnswer(supabase, {
          questionId: data.id,
          shortId,
          userJid,
          userName: userName || null,
          letter,
          comment,
          creatorJid: data.creator_jid
        });
        answerId = saved.answerId;
        persisted = true;
        if (categoryIds) {
          categories = await setAnswerCategories(supabase, answerId, categoryIds);
        } else if (answerId) {
          categories = await listCategoriesForAnswer(supabase, answerId);
        }
      } catch (persistErr) {
        if (persistErr.code === "SELF_ANSWER") {
          return res.status(403).json({ error: persistErr.message });
        }
        throw persistErr;
      }
    }

    return res.status(200).json({
      correct,
      answerKey: expected,
      yourAnswer: userLetter,
      explanationText: data.explanation_text || null,
      explanationMediaUrl: data.explanation_media_url || null,
      explanationMediaMimeType: data.explanation_media_mime_type || null,
      persisted,
      answerId,
      categories
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao validar resposta" });
  }
}

async function handleCategories(req, res) {
  const supabase = getClient();

  if (req.method === "GET") {
    const userJid = String(req.query.userJid || "").trim();
    if (!userJid) return res.status(400).json({ error: "Informe userJid" });
    try {
      const categories = await listUserCategories(supabase, userJid);
      return res.status(200).json({ categories });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || "Erro ao listar categorias" });
    }
  }

  if (req.method === "POST") {
    let body = {};
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    } catch {
      return res.status(400).json({ error: "JSON invalido" });
    }
    const userJid = String(body.userJid || "").trim();
    const name = body.name != null ? String(body.name) : "";
    if (!userJid) return res.status(400).json({ error: "Informe userJid" });
    try {
      const category = await createUserCategory(supabase, userJid, name);
      return res.status(200).json({ category });
    } catch (e) {
      if (e.code === "EMPTY_NAME") return res.status(400).json({ error: e.message });
      console.error(e);
      return res.status(500).json({ error: e.message || "Erro ao criar categoria" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

async function handleSetCategories(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "JSON invalido" });
  }

  const userJid = String(body.userJid || "").trim();
  const shortId = String(body.shortId || "")
    .trim()
    .toUpperCase();
  const categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds : [];

  if (!userJid || !shortId) {
    return res.status(400).json({ error: "Informe userJid e shortId" });
  }

  try {
    const supabase = getClient();
    const ans = await getAnswerRow(supabase, shortId, userJid);
    if (!ans) {
      return res.status(404).json({ error: "Resposta nao encontrada. Responda a questao antes de categorizar." });
    }
    const categories = await setAnswerCategories(supabase, ans.id, categoryIds);
    return res.status(200).json({ answerId: Number(ans.id), categories });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao salvar categorias" });
  }
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const route = resolveRoute(req);
  if (route === "detail") return handleDetail(req, res);
  if (route === "submit") return handleSubmit(req, res);
  if (route === "categories") return handleCategories(req, res);
  if (route === "set-categories") return handleSetCategories(req, res);

  return res.status(404).json({ error: "Rota quiz desconhecida" });
};
