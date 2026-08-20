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
  if (!base) return { skipped: true, reason: "missing_url" };
  if (!secret) return { skipped: true, reason: "missing_secret" };
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[study-sync]", res.status, JSON.stringify(data).slice(0, 300));
      return { ok: false, status: res.status, data };
    }
    return { ok: true, data };
  } catch (e) {
    console.warn("[study-sync]", e.message || e);
    return { ok: false, reason: "unreachable" };
  }
}

async function getStudyApp(path) {
  const base = getStudyAppBaseUrl();
  const secret = getStudyAppSecret();
  if (!base) return { skipped: true, reason: "missing_url" };
  if (!secret) return { skipped: true, reason: "missing_secret" };
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
      return { ok: false, status: res.status, data, reason: `http_${res.status}` };
    }
    return { ok: true, data };
  } catch (e) {
    console.warn("[study-sync] GET", e.message || e);
    return { ok: false, reason: "unreachable" };
  }
}

function tecIdFromRaw(raw) {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cadernoIdFromRaw(raw) {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseCadernoFromQuestionRow(row) {
  const creator = String(row?.creator_jid || "");
  const creatorMatch = creator.match(/^caderno:(\d+)@bot$/i);
  const wa = String(row?.wa_message_id || "");
  const waMatch = wa.match(/^caderno-(\d+)-(\d+)/i);
  return {
    cadernoId: cadernoIdFromRaw(waMatch ? waMatch[1] : creatorMatch ? creatorMatch[1] : null),
    cadernoQuestionId: cadernoIdFromRaw(waMatch ? waMatch[2] : null)
  };
}

function contextFromCadernoQuestionRow(row) {
  if (!row) return { tecId: null, cadernoId: null };
  return {
    tecId: tecIdFromRaw(row.tec_question_id),
    cadernoId: cadernoIdFromRaw(row.caderno_id)
  };
}

function mergeCadernoContext(current, next) {
  const cur = current || { tecId: null, cadernoId: null };
  if (!next) return cur;
  return {
    tecId: cur.tecId || next.tecId || null,
    cadernoId: cur.cadernoId || next.cadernoId || null
  };
}

function chunkIds(ids, size = 80) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

async function fetchCadernoQuestionsByIds(supabase, ids) {
  const uniq = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const byId = new Map();
  if (!uniq.length) return byId;
  for (const part of chunkIds(uniq)) {
    const { data, error } = await supabase
      .from("caderno_questions")
      .select("id, tec_question_id, caderno_id")
      .in("id", part);
    if (error || !data) continue;
    for (const row of data) byId.set(Number(row.id), row);
  }
  return byId;
}

/**
 * Atrasadas / adiantadas muitas vezes não têm published_question_id em caderno_questions
 * (fila de adiantar, publicação antiga). Cai em caderno_send_queue e no wa_message_id.
 */
async function lookupCadernoContextsByPublishedIds(supabase, publishedIds) {
  const map = new Map();
  const ids = [...new Set(publishedIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return map;

  for (const part of chunkIds(ids)) {
    const { data } = await supabase
      .from("caderno_questions")
      .select("published_question_id, tec_question_id, caderno_id")
      .in("published_question_id", part);
    for (const row of data || []) {
      map.set(Number(row.published_question_id), contextFromCadernoQuestionRow(row));
    }
  }

  const missing = ids.filter((id) => !map.get(id)?.tecId);
  if (missing.length) {
    try {
      const queue = [];
      let queueFailed = false;
      for (const part of chunkIds(missing)) {
        const r = await supabase
          .from("caderno_send_queue")
          .select("published_question_id, caderno_id, caderno_question_id")
          .in("published_question_id", part);
        if (r.error) {
          queueFailed = true;
          break;
        }
        queue.push(...(r.data || []));
      }
      if (!queueFailed && queue.length) {
        const byCq = await fetchCadernoQuestionsByIds(
          supabase,
          queue.map((r) => r.caderno_question_id)
        );
        for (const row of queue) {
          const pubId = Number(row.published_question_id);
          const extra = byCq.get(Number(row.caderno_question_id));
          map.set(
            pubId,
            mergeCadernoContext(map.get(pubId), {
              tecId: extra ? tecIdFromRaw(extra.tec_question_id) : null,
              cadernoId:
                cadernoIdFromRaw(row.caderno_id) ||
                (extra ? cadernoIdFromRaw(extra.caderno_id) : null)
            })
          );
        }
      }
    } catch (e) {
      console.warn("[study-sync] send_queue lookup", e.message || e);
    }
  }

  const stillMissing = ids.filter((id) => !map.get(id)?.tecId);
  if (stillMissing.length) {
    const qs = [];
    for (const part of chunkIds(stillMissing)) {
      const r = await supabase
        .from("questions")
        .select("id, creator_jid, wa_message_id")
        .in("id", part);
      qs.push(...(r.data || []));
    }
    const parsed = [];
    for (const q of qs || []) {
      const p = parseCadernoFromQuestionRow(q);
      parsed.push({ pubId: Number(q.id), ...p });
    }
    const byCq = await fetchCadernoQuestionsByIds(
      supabase,
      parsed.map((p) => p.cadernoQuestionId)
    );
    for (const p of parsed) {
      const extra = p.cadernoQuestionId ? byCq.get(p.cadernoQuestionId) : null;
      map.set(
        p.pubId,
        mergeCadernoContext(map.get(p.pubId), {
          tecId: extra ? tecIdFromRaw(extra.tec_question_id) : null,
          cadernoId: extra ? cadernoIdFromRaw(extra.caderno_id) : p.cadernoId
        })
      );
    }
  }

  return map;
}

async function lookupCadernoContextForPublishedQuestion(supabase, publishedQuestionId) {
  if (!publishedQuestionId) return { tecId: null, cadernoId: null };
  const map = await lookupCadernoContextsByPublishedIds(supabase, [publishedQuestionId]);
  return map.get(Number(publishedQuestionId)) || { tecId: null, cadernoId: null };
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
    .limit(1)
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
  if (n > CAP) return CAP;
  return n;
}

async function notifyStudyAppAnswer(supabase, input) {
  if (input.syncSource === "app") return { skipped: true, reason: "sync_source_app" };
  const shortId = input.shortId ? String(input.shortId).trim() : "";
  if (!shortId && input.tecId == null && input.publishedQuestionId == null) {
    console.warn("[study-sync] answer skip: sem shortId/tecId");
    return { skipped: true, reason: "no_ids" };
  }
  let tecId = input.tecId != null ? Number(input.tecId) : NaN;
  let cadernoId = input.cadernoId != null ? Number(input.cadernoId) : NaN;
  if (!Number.isFinite(tecId) || tecId <= 0 || !Number.isFinite(cadernoId) || cadernoId <= 0) {
    if (input.publishedQuestionId) {
      const ctx = await lookupCadernoContextForPublishedQuestion(supabase, input.publishedQuestionId);
      if (!Number.isFinite(tecId) || tecId <= 0) tecId = ctx.tecId;
      if (!Number.isFinite(cadernoId) || cadernoId <= 0) cadernoId = ctx.cadernoId;
    }
    if ((!Number.isFinite(tecId) || tecId <= 0 || !Number.isFinite(cadernoId) || cadernoId <= 0) && shortId) {
      const ctx = await lookupCadernoContextForShortId(supabase, shortId);
      if (!Number.isFinite(tecId) || tecId <= 0) tecId = ctx.tecId;
      if (!Number.isFinite(cadernoId) || cadernoId <= 0) cadernoId = ctx.cadernoId;
    }
  }
  const body = {
    tecId: Number.isFinite(tecId) && tecId > 0 ? tecId : null,
    cadernoId: Number.isFinite(cadernoId) && cadernoId > 0 ? cadernoId : null,
    userJid: input.userJid,
    answerLetter: String(input.answerLetter || "").toLowerCase().slice(0, 1),
    comment: input.comment || null,
    confidenceLevel: normalizeConfidence(input.confidenceLevel),
    durationMs: capDurationMs(input.durationMs),
    tags: Array.isArray(input.tags) ? input.tags : [],
    shortId: shortId || null,
    publishedQuestionId: input.publishedQuestionId ?? null,
    source: "whatsapp"
  };
  if (!body.userJid || !body.answerLetter) {
    console.warn("[study-sync] answer skip: userJid/letter");
    return { skipped: true, reason: "no_user_or_letter" };
  }
  return notifyStudyApp("/api/quiz-sync/answer", body);
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
  lookupCadernoContextsByPublishedIds,
  lookupTecIdForShortId,
  lookupTecIdForPublishedQuestion,
  normalizeConfidence,
  capDurationMs
};
