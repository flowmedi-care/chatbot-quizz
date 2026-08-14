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
    .select("id, question_short_id, answer_letter, answer_comment, user_jid, confidence_level, duration_ms")
    .in("question_short_id", shortIds);
  if (error) throw error;

  const userKey = jidComparableKey(userJid);
  const out = new Map();
  for (const row of data || []) {
    if (jidComparableKey(row.user_jid) !== userKey) continue;
    out.set(String(row.question_short_id).toUpperCase(), {
      id: Number(row.id),
      letter: String(row.answer_letter || "").toLowerCase(),
      comment: row.answer_comment != null ? String(row.answer_comment) : null,
      confidence: row.confidence_level != null ? String(row.confidence_level) : null,
      durationMs:
        row.duration_ms != null && Number(row.duration_ms) > 0 ? Number(row.duration_ms) : null
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
    .select("id, answer_letter, user_jid, duration_ms")
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
    sent_at: new Date().toISOString(),
    confidence_level: input.confidenceLevel || null,
    duration_ms:
      existing?.duration_ms != null && Number(existing.duration_ms) > 0
        ? Number(existing.duration_ms)
        : input.durationMs != null && Number.isFinite(Number(input.durationMs))
          ? Math.round(Number(input.durationMs))
          : null,
    sync_source: input.syncSource || "web"
  };

  function slimRow() {
    const s = { ...row };
    delete s.confidence_level;
    delete s.duration_ms;
    delete s.sync_source;
    return s;
  }

  if (existing) {
    let { error } = await supabase.from("answers").update(row).eq("id", existing.id);
    if (error && /column/i.test(error.message || "")) {
      const retry = await supabase.from("answers").update(slimRow()).eq("id", existing.id);
      error = retry.error;
    }
    if (error) throw error;
    return {
      answerId: Number(existing.id),
      wasUpdate: true,
      previousLetter: String(existing.answer_letter || "").toLowerCase()
    };
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
      return {
        answerId: Number(upd?.id),
        wasUpdate: true,
        previousLetter: null
      };
    }
    throw error;
  }
  return {
    answerId: Number(inserted?.id),
    wasUpdate: false,
    previousLetter: null
  };
}

async function resolveSessionUserName(supabase, session) {
  const stored = session.userName != null ? String(session.userName).trim() : "";
  if (stored && !/@/.test(stored) && !/^\d{8,}$/.test(stored)) return stored;

  try {
    const { pickDisplayLabel } = require("./_group-members.js");
    const { data: eco } = await supabase
      .from("user_economy")
      .select("display_name")
      .eq("user_jid", session.userJid)
      .maybeSingle();
    const { data: eng } = await supabase
      .from("group_member_engagement")
      .select("quiz_display_name, user_label")
      .eq("user_jid", session.userJid)
      .limit(3);
    const engRow = (eng || [])[0] || null;
    return pickDisplayLabel({
      userJid: session.userJid,
      userLabel: eco?.display_name || engRow?.user_label || stored || null,
      quizDisplayName: engRow?.quiz_display_name || null,
      nameFromQuiz: stored || null
    });
  } catch {
    return stored || "Participante";
  }
}

async function getAssistEliminateQty(supabase, userJid) {
  const { data } = await supabase
    .from("user_inventory")
    .select("qty")
    .eq("user_jid", userJid)
    .eq("item_key", "assist_eliminate")
    .maybeSingle();
  return data ? Math.max(0, Number(data.qty) || 0) : 0;
}

async function fetchAssistUsedMap(supabase, userJid, shortIds) {
  const out = new Map();
  if (!shortIds.length) return out;
  const refIds = shortIds.map((s) => `elim:${String(s).toUpperCase()}`);
  const { data, error } = await supabase
    .from("economy_ledger")
    .select("ref_id, meta")
    .eq("user_jid", userJid)
    .eq("reason", "assist_eliminate_use")
    .in("ref_id", refIds);
  if (error) return out;
  for (const row of data || []) {
    const sid = String(row.ref_id || "")
      .replace(/^elim:/i, "")
      .toUpperCase();
    const meta = row.meta || {};
    out.set(sid, {
      letter: meta.letter ? String(meta.letter).toUpperCase() : meta.removed ? String(meta.removed).toUpperCase() : null,
      isCorrect: typeof meta.isCorrect === "boolean" ? meta.isCorrect : null,
      removed: meta.removed ? String(meta.removed).toUpperCase() : null
    });
  }
  return out;
}

async function consumeAssistEliminate(supabase, userJid) {
  const { data: inv } = await supabase
    .from("user_inventory")
    .select("qty")
    .eq("user_jid", userJid)
    .eq("item_key", "assist_eliminate")
    .maybeSingle();
  if (!inv || (inv.qty || 0) < 1) return -1;
  const newQty = (inv.qty || 1) - 1;
  if (newQty <= 0) {
    await supabase.from("user_inventory").delete().eq("user_jid", userJid).eq("item_key", "assist_eliminate");
  } else {
    await supabase
      .from("user_inventory")
      .update({ qty: newQty, updated_at: new Date().toISOString() })
      .eq("user_jid", userJid)
      .eq("item_key", "assist_eliminate");
  }
  return Math.max(0, newQty);
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
    const qids = questions.map((q) => q.id).filter(Boolean);
    const optionsByQid = new Map();
    if (qids.length) {
      const { data: cqRows } = await supabase
        .from("caderno_questions")
        .select("published_question_id, options")
        .in("published_question_id", qids);
      for (const row of cqRows || []) {
        if (Array.isArray(row.options) && row.options.length) {
          optionsByQid.set(Number(row.published_question_id), row.options);
        }
      }
    }
    const userName = await resolveSessionUserName(supabase, session);
    const assistQty = await getAssistEliminateQty(supabase, session.userJid);
    const assistUsed = await fetchAssistUsedMap(supabase, session.userJid, session.shortIds);
    const { mapCategoriesByAnswerIds } = require("./_categories.js");
    const catsByAnswer = await mapCategoriesByAnswerIds(
      supabase,
      [...answers.values()].map((a) => a.id).filter((id) => Number.isFinite(id) && id > 0)
    );

    const list = session.shortIds.map((sid) => {
      const q = questions.find((x) => String(x.short_id).toUpperCase() === sid);
      const ans = answers.get(sid) || null;
      const assist = assistUsed.get(sid) || null;
      const cats = ans && ans.id ? catsByAnswer.get(ans.id) || [] : [];
      const categoryIds = cats.map((c) => c.id);
      const yourLetter = ans ? String(ans.letter || "").toUpperCase() : null;
      const answerKey =
        ans && q
          ? String(q.answer_key || "")
              .toUpperCase()
              .slice(0, 1) || null
          : null;
      const correct =
        yourLetter && answerKey ? yourLetter.slice(0, 1) === answerKey : null;
      if (!q) {
        return {
          shortId: sid,
          missing: true,
          alreadyAnswered: Boolean(ans),
          yourLetter,
          categoryIds,
          assistUsed: Boolean(assist),
          assistReveal: assist
        };
      }
      return {
        shortId: sid,
        creatorName: q.creator_name || "Autor",
        questionType: q.question_type,
        statementText: q.statement_text || "",
        statementMediaUrl: q.statement_media_url || null,
        statementMediaMimeType: q.statement_media_mime_type || null,
        options: optionsByQid.get(Number(q.id)) || [],
        alreadyAnswered: Boolean(ans),
        yourConfidence: ans && ans.confidence ? ans.confidence : null,
        yourLetter,
        yourComment: ans ? ans.comment : null,
        durationMs: ans && ans.durationMs ? ans.durationMs : null,
        categoryIds,
        answerKey,
        correct,
        missing: false,
        assistUsed: Boolean(assist),
        assistReveal: assist
      };
    });

    const pending = list.filter((q) => !q.missing && !q.alreadyAnswered);
    const answeredCount = list.filter((q) => q.alreadyAnswered).length;

    return res.status(200).json({
      mode: session.mode,
      userName,
      userJid: session.userJid,
      assistEliminateQty: assistQty,
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
  const categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds : null;
  const confidenceLevel = ["seguro", "inseguro", "chute"].includes(String(body.confidenceLevel || "").toLowerCase())
    ? String(body.confidenceLevel).toLowerCase()
    : "seguro";
  const { capDurationMs } = require("./_study-sync.js");
  const durationMs = capDurationMs(body.durationMs);

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
        creatorJid: q.creator_jid,
        confidenceLevel,
        durationMs,
        syncSource: "web"
      });
    } catch (e) {
      if (e.code === "SELF_ANSWER") {
        return res.status(403).json({ error: e.message });
      }
      throw e;
    }

    let categories = [];
    if (categoryIds && saveResult.answerId) {
      try {
        const { setAnswerCategories } = require("./_categories.js");
        categories = await setAnswerCategories(supabase, saveResult.answerId, categoryIds);
      } catch (catErr) {
        console.warn("[omissas-answer] categories:", catErr.message || catErr);
      }
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

    try {
      const { notifyStudyAppAnswer } = require("./_study-sync.js");
      await notifyStudyAppAnswer(supabase, {
        userJid: session.userJid,
        shortId,
        publishedQuestionId: q.id,
        answerLetter: letter,
        comment,
        confidenceLevel,
        durationMs,
        tags: (categories || []).map((c) => c.name).filter(Boolean),
        syncSource: "web"
      });
    } catch (syncErr) {
      console.warn("[omissas-answer] study-sync:", syncErr.message || syncErr);
    }

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
      sessionComplete: allDone,
      categories,
      answerId: saveResult.answerId || null,
      yourAnswer: letter.toUpperCase(),
      answerKey: String(q.answer_key || "").toUpperCase().slice(0, 1),
      durationMs,
      correct:
        String(letter || "").toUpperCase().slice(0, 1) ===
        String(q.answer_key || "")
          .toUpperCase()
          .slice(0, 1)
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
    const userName = await resolveSessionUserName(supabase, session);

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
      userName,
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

/**
 * POST: usa assistência na sessão — escolhe 1 alternativa e revela se é verdadeira/falsa.
 * Body: { t, shortId, letter }
 */
async function handleOmissasAssist(req, res) {
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
  const letter = String(body.letter || "")
    .trim()
    .toLowerCase()
    .slice(0, 1);

  try {
    const supabase = getClient();
    const loaded = await loadSession(supabase, token);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

    const { session } = loaded;
    if (!session.shortIds.includes(shortId)) {
      return res.status(403).json({ error: "Esta questão não faz parte da sua sessão." });
    }

    const usedMap = await fetchAssistUsedMap(supabase, session.userJid, [shortId]);
    if (usedMap.has(shortId)) {
      return res.status(409).json({
        error: "Você já usou assistência nesta questão (máximo 1).",
        assistReveal: usedMap.get(shortId)
      });
    }

    const questions = await fetchQuestionsByShortIds(supabase, [shortId]);
    const q = questions[0];
    if (!q) return res.status(404).json({ error: "Questão não encontrada" });

    const normalized = normalizeLetter(letter, q.question_type);
    if (!normalized) {
      return res.status(400).json({
        error:
          q.question_type === "true_false"
            ? "Escolha C ou E para verificar."
            : "Escolha A, B, C, D ou E para verificar."
      });
    }

    const key = String(q.answer_key || "")
      .trim()
      .toLowerCase()
      .slice(0, 1);
    const isCorrect = normalized === key;
    const letterUp = normalized.toUpperCase();

    const newQty = await consumeAssistEliminate(supabase, session.userJid);
    if (newQty < 0) {
      return res.status(400).json({
        error: "Você não tem 'Eliminar uma alternativa' no inventário. Compre no Hub/loja (50 Créditos)."
      });
    }

    const { todayIso } = require("./_economy.js");
    const meta = {
      letter: letterUp,
      removed: isCorrect ? null : letterUp,
      isCorrect,
      mode: "check",
      questionShortId: shortId
    };
    const { error: ledErr } = await supabase.from("economy_ledger").insert({
      user_jid: session.userJid,
      delta_aura: 0,
      delta_credits: 0,
      reason: "assist_eliminate_use",
      ref_type: "assist",
      ref_id: `elim:${shortId}`,
      day_iso: todayIso(),
      meta
    });
    if (ledErr) {
      if (ledErr.code === "23505") {
        return res.status(409).json({ error: "Assistência já usada nesta questão." });
      }
      throw ledErr;
    }

    return res.status(200).json({
      ok: true,
      shortId,
      letter: letterUp,
      isCorrect,
      message: isCorrect
        ? `Alternativa ${letterUp} é VERDADEIRA (gabarito).`
        : `Alternativa ${letterUp} é FALSA — pode descartar.`,
      assistEliminateQty: newQty,
      assistReveal: { letter: letterUp, isCorrect, removed: isCorrect ? null : letterUp }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao usar assistência" });
  }
}

async function handleOmissasVia(req, res) {
  const { getStudyApp, notifyStudyApp } = require("./_study-sync.js");
  const url = new URL(req.url || "/", "http://localhost");
  let body = {};
  if (req.method === "POST") {
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    } catch {
      return res.status(400).json({ error: "JSON inválido" });
    }
  }
  const token = String(body.t || url.searchParams.get("t") || "").trim();
  const shortId = String(body.shortId || url.searchParams.get("shortId") || "")
    .trim()
    .toUpperCase();
  if (!token || !shortId) return res.status(400).json({ error: "t e shortId obrigatórios" });

  const supabase = getClient();
  const loaded = await loadSession(supabase, token);
  if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
  const { session } = loaded;
  if (!session.shortIds.includes(shortId)) {
    return res.status(403).json({ error: "Questão fora da sessão." });
  }

  if (req.method === "GET") {
    const r = await getStudyApp(
      `/api/quiz-sync/context?userJid=${encodeURIComponent(session.userJid)}&shortId=${encodeURIComponent(shortId)}`
    );
    if (!r.ok || r.skipped) {
      return res.status(200).json({
        linked: false,
        reason: r.reason || "unreachable",
        notes: [],
        durationMs: null
      });
    }
    return res.status(200).json(r.data || { linked: false, notes: [], durationMs: null });
  }

  if (req.method === "POST") {
    const noteBody = String(body.body || "").trim();
    if (!noteBody) return res.status(400).json({ error: "Escreva a anotação." });
    const r = await notifyStudyApp("/api/quiz-sync/context", {
      userJid: session.userJid,
      shortId,
      body: noteBody
    });
    if (r.skipped || !r.ok) {
      return res.status(502).json({ error: "Não foi possível salvar na Via Aprovação." });
    }
    return res.status(200).json(r.data || { ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
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
  handleOmissasResults,
  handleOmissasAssist,
  handleOmissasVia,
  consumeAssistEliminate,
  fetchAssistUsedMap
};
