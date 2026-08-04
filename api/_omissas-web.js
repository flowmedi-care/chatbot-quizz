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
  upsertAnswer
};
