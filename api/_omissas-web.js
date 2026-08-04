/**
 * Helpers para sessão pessoal de omissas no site.
 */
const crypto = require("crypto");
const { getClient, pickTargetGroupJid } = require("./_lib.js");

function jidComparableKey(jid) {
  const raw = String(jid || "").trim().toLowerCase();
  const at = raw.indexOf("@");
  if (at < 0) return raw;
  const user = raw.slice(0, at).split(":")[0];
  const domain = raw.slice(at + 1);
  return `${user}@${domain}`;
}

function isSameParticipant(a, b) {
  return jidComparableKey(a) === jidComparableKey(b);
}

function isBotCreatorJid(creatorJid) {
  return String(creatorJid || "")
    .trim()
    .toLowerCase()
    .startsWith("caderno:");
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

async function loadSession(supabase, token) {
  const t = String(token || "").trim();
  if (!t) return { error: "Informe o token", status: 400 };

  const { data, error } = await supabase
    .from("omissas_web_sessions")
    .select(
      "token, user_jid, user_name, group_jid, mode, short_ids, created_at, expires_at, completed_at"
    )
    .eq("token", t)
    .maybeSingle();

  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      return {
        error: "Sessões web de omissas ainda não configuradas no banco.",
        status: 503
      };
    }
    throw error;
  }
  if (!data) return { error: "Link inválido. Peça um novo com /omissas no WhatsApp.", status: 404 };

  const expiresAt = data.expires_at ? Date.parse(data.expires_at) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
    return { error: "Link expirado. Envie /omissas de novo no WhatsApp.", status: 410 };
  }

  const shortIds = Array.isArray(data.short_ids)
    ? data.short_ids.map((s) => String(s).toUpperCase())
    : [];

  return {
    session: {
      token: String(data.token),
      userJid: String(data.user_jid),
      userName: data.user_name != null ? String(data.user_name) : null,
      groupJid: String(data.group_jid),
      mode: String(data.mode),
      shortIds,
      createdAt: data.created_at,
      expiresAt: data.expires_at,
      completedAt: data.completed_at || null
    }
  };
}

async function fetchQuestionsByShortIds(supabase, shortIds) {
  if (!shortIds.length) return [];
  const { data, error } = await supabase
    .from("questions")
    .select(
      "id, short_id, creator_name, creator_jid, question_type, statement_text, statement_media_url, statement_media_mime_type, answer_key, explanation_text, explanation_media_url, explanation_media_mime_type"
    )
    .in("short_id", shortIds);
  if (error) throw error;
  const map = new Map();
  for (const q of data || []) {
    map.set(String(q.short_id).toUpperCase(), q);
  }
  return shortIds.map((sid) => map.get(sid)).filter(Boolean);
}

async function fetchUserAnswersForShortIds(supabase, userJid, shortIds) {
  if (!shortIds.length) return new Map();
  const { data, error } = await supabase
    .from("answers")
    .select("question_short_id, answer_letter, answer_comment, user_jid")
    .in("question_short_id", shortIds);
  if (error) throw error;

  const userKey = jidComparableKey(userJid);
  const out = new Map();
  for (const row of data || []) {
    if (jidComparableKey(row.user_jid) !== userKey) continue;
    out.set(String(row.question_short_id).toUpperCase(), {
      letter: String(row.answer_letter || "").toLowerCase(),
      comment: row.answer_comment != null ? String(row.answer_comment) : null
    });
  }
  return out;
}

async function enqueueBotEvent(supabase, kind, payload) {
  const { error } = await supabase.from("bot_pending_events").insert({ kind, payload });
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      console.warn("[omissas-web] bot_pending_events ausente — economia/anúncios ficam só no próximo deploy SQL");
      return;
    }
    throw error;
  }
}

async function markSessionCompleted(supabase, token) {
  await supabase
    .from("omissas_web_sessions")
    .update({ completed_at: new Date().toISOString() })
    .eq("token", token)
    .is("completed_at", null);
}

async function upsertAnswer(supabase, input) {
  const {
    questionId,
    shortId,
    userJid,
    userName,
    letter,
    comment,
    creatorJid
  } = input;

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
  const existing = (existingRows || []).find((r) => jidComparableKey(r.user_jid) === userKey) || null;

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
    const { error } = await supabase.from("answers").update(row).eq("id", existing.id);
    if (error) throw error;
    return {
      wasUpdate: true,
      previousLetter: String(existing.answer_letter || "").toLowerCase()
    };
  }

  const { error } = await supabase.from("answers").insert(row);
  if (error) {
    if (error.code === "23505") {
      const { error: upErr } = await supabase
        .from("answers")
        .update(row)
        .eq("question_id", questionId)
        .eq("user_jid", userJid);
      if (upErr) throw upErr;
      return { wasUpdate: true, previousLetter: null };
    }
    throw error;
  }
  return { wasUpdate: false, previousLetter: null };
}

async function handleOmissasSession(req, res) {
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
}

async function handleOmissasAnswer(req, res) {
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
}

async function handleOmissasResults(req, res) {
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
}

module.exports = {
  getClient,
  pickTargetGroupJid,
  jidComparableKey,
  isSameParticipant,
  isBotCreatorJid,
  normalizeLetter,
  loadSession,
  fetchQuestionsByShortIds,
  fetchUserAnswersForShortIds,
  enqueueBotEvent,
  markSessionCompleted,
  upsertAnswer,
  handleOmissasSession,
  handleOmissasAnswer,
  handleOmissasResults
};
