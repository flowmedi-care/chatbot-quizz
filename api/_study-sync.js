/**
 * Avisa o app de estudo (app-vercel-next) após resposta no WhatsApp/omissas.
 * STUDY_APP_URL ou FLASHCARDS_API_URL + FLASHCARDS_BOT_INBOUND_SECRET.
 */

function getStudyAppBaseUrl() {
  const raw = String(process.env.STUDY_APP_URL || process.env.FLASHCARDS_API_URL || "")
    .trim()
    .replace(/\/+$/, "");
  return raw || null;
}

function getStudyAppSecret() {
  return String(process.env.FLASHCARDS_BOT_INBOUND_SECRET || "").trim() || null;
}

async function notifyStudyApp(path, body) {
  const base = getStudyAppBaseUrl();
  const secret = getStudyAppSecret();
  if (!base || !secret) return { skipped: true };
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[study-sync]", res.status, text.slice(0, 300));
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[study-sync]", e.message || e);
    return { ok: false };
  }
}

async function getStudyApp(path) {
  const base = getStudyAppBaseUrl();
  const secret = getStudyAppSecret();
  if (!base || !secret) return { skipped: true };
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[study-sync] GET", res.status, JSON.stringify(data).slice(0, 200));
      return { ok: false, status: res.status, data };
    }
    return { ok: true, data };
  } catch (e) {
    console.warn("[study-sync] GET", e.message || e);
    return { ok: false };
  }
}

async function lookupCadernoContextForPublishedQuestion(supabase, publishedQuestionId) {
  if (!publishedQuestionId) return { tecId: null, cadernoId: null };
  const { data, error } = await supabase
    .from("caderno_questions")
    .select("tec_question_id, caderno_id")
    .eq("published_question_id", publishedQuestionId)
    .maybeSingle();
  if (error || !data) return { tecId: null, cadernoId: null };
  const raw = data.tec_question_id;
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return {
    tecId: Number.isFinite(n) ? n : null,
    cadernoId: data.caderno_id != null ? Number(data.caderno_id) : null
  };
}

async function lookupTecIdForPublishedQuestion(supabase, publishedQuestionId) {
  const ctx = await lookupCadernoContextForPublishedQuestion(supabase, publishedQuestionId);
  return ctx.tecId;
}

async function lookupCadernoContextForShortId(supabase, shortId) {
  const sid = String(shortId || "").trim().toUpperCase();
  if (!sid) return { tecId: null, cadernoId: null };
  const { data: q, error } = await supabase
    .from("questions")
    .select("id")
    .eq("short_id", sid)
    .maybeSingle();
  if (error || !q) return { tecId: null, cadernoId: null };
  return lookupCadernoContextForPublishedQuestion(supabase, q.id);
}

async function lookupTecIdForShortId(supabase, shortId) {
  const ctx = await lookupCadernoContextForShortId(supabase, shortId);
  return ctx.tecId;
}

function normalizeConfidence(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "inseguro" || v === "chute") return v;
  return "seguro";
}

function capDurationMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  const n = Math.round(Number(ms));
  if (n < 0) return null;
  const CAP = 30 * 60 * 1000;
  if (n > CAP) return null;
  return n;
}

async function notifyStudyAppAnswer(supabase, input) {
  if (input.syncSource === "app") return;
  let tecId = input.tecId != null ? Number(input.tecId) : null;
  let cadernoId = input.cadernoId != null ? Number(input.cadernoId) : null;
  if (!Number.isFinite(tecId) || tecId <= 0 || !Number.isFinite(cadernoId) || cadernoId <= 0) {
    const ctx = await lookupCadernoContextForShortId(supabase, input.shortId);
    if (!Number.isFinite(tecId) || tecId <= 0) tecId = ctx.tecId;
    if (!Number.isFinite(cadernoId) || cadernoId <= 0) cadernoId = ctx.cadernoId;
  }
  if (!tecId) return;
  await notifyStudyApp("/api/quiz-sync/answer", {
    tecId,
    cadernoId: Number.isFinite(cadernoId) && cadernoId > 0 ? cadernoId : null,
    userJid: input.userJid,
    answerLetter: String(input.answerLetter || "").toLowerCase().slice(0, 1),
    comment: input.comment || null,
    confidenceLevel: normalizeConfidence(input.confidenceLevel),
    durationMs: capDurationMs(input.durationMs),
    tags: Array.isArray(input.tags) ? input.tags : [],
    shortId: input.shortId || null,
    source: "whatsapp"
  });
}

async function notifyStudyAppPublished(input) {
  await notifyStudyApp("/api/quiz-sync/flush", {
    tecId: input.tecId,
    cadernoId: input.cadernoId,
    shortId: input.shortId,
    publishedQuestionId: input.publishedQuestionId,
    source: "whatsapp"
  });
}

module.exports = {
  getStudyAppBaseUrl,
  getStudyAppSecret,
  notifyStudyApp,
  getStudyApp,
  notifyStudyAppAnswer,
  notifyStudyAppPublished,
  lookupCadernoContextForShortId,
  lookupCadernoContextForPublishedQuestion,
  lookupTecIdForShortId,
  lookupTecIdForPublishedQuestion,
  normalizeConfidence,
  capDurationMs
};
