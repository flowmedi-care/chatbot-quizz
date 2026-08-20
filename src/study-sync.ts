/** Notifica o app de estudo após resposta no WhatsApp (VPS). */

import { createClient } from "@supabase/supabase-js";
import { config } from "./config";

function studyAppBase(): string | null {
  const raw = String(process.env.STUDY_APP_URL || process.env.FLASHCARDS_API_URL || "")
    .trim()
    .replace(/\/+$/, "");
  return raw || null;
}

function studyAppSecret(): string | null {
  return String(process.env.FLASHCARDS_BOT_INBOUND_SECRET || "").trim() || null;
}

function sb() {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

function tecIdFromRaw(raw: unknown): number | null {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cadernoIdFromRaw(raw: unknown): number | null {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseCadernoFromQuestionRow(row: {
  creator_jid?: string | null;
  wa_message_id?: string | null;
}): { cadernoId: number | null; cadernoQuestionId: number | null } {
  const creator = String(row?.creator_jid || "");
  const creatorMatch = creator.match(/^caderno:(\d+)@bot$/i);
  const wa = String(row?.wa_message_id || "");
  const waMatch = wa.match(/^caderno-(\d+)-(\d+)/i);
  return {
    cadernoId: cadernoIdFromRaw(waMatch ? waMatch[1] : creatorMatch ? creatorMatch[1] : null),
    cadernoQuestionId: cadernoIdFromRaw(waMatch ? waMatch[2] : null)
  };
}

async function lookupCadernoContext(opts: {
  shortId?: string | null;
  publishedQuestionId?: number | null;
}): Promise<{ tecId: number | null; cadernoId: number | null }> {
  const client = sb();
  let publishedId = opts.publishedQuestionId != null ? Number(opts.publishedQuestionId) : NaN;
  let questionRow: {
    id?: number;
    creator_jid?: string | null;
    wa_message_id?: string | null;
  } | null = null;
  if (!Number.isFinite(publishedId) || publishedId <= 0) {
    const sid = String(opts.shortId || "").trim().toUpperCase();
    if (!sid) return { tecId: null, cadernoId: null };
    const { data: q } = await client
      .from("questions")
      .select("id, creator_jid, wa_message_id")
      .eq("short_id", sid)
      .limit(1)
      .maybeSingle();
    questionRow = q;
    publishedId = q?.id != null ? Number(q.id) : NaN;
  }
  if (!Number.isFinite(publishedId) || publishedId <= 0) return { tecId: null, cadernoId: null };

  const { data: directRows } = await client
    .from("caderno_questions")
    .select("tec_question_id, caderno_id")
    .eq("published_question_id", publishedId)
    .limit(5);
  const direct = directRows?.[0];
  let tecId = direct ? tecIdFromRaw(direct.tec_question_id) : null;
  let cadernoId = direct ? cadernoIdFromRaw(direct.caderno_id) : null;
  if (tecId && cadernoId) return { tecId, cadernoId };

  const { data: queue } = await client
    .from("caderno_send_queue")
    .select("caderno_id, caderno_question_id")
    .eq("published_question_id", publishedId)
    .limit(1)
    .maybeSingle();
  if (queue?.caderno_question_id) {
    const { data: cq } = await client
      .from("caderno_questions")
      .select("tec_question_id, caderno_id")
      .eq("id", queue.caderno_question_id)
      .maybeSingle();
    tecId = tecId || tecIdFromRaw(cq?.tec_question_id);
    cadernoId = cadernoId || cadernoIdFromRaw(queue.caderno_id) || cadernoIdFromRaw(cq?.caderno_id);
    if (tecId && cadernoId) return { tecId, cadernoId };
  }

  if (!questionRow) {
    const { data: q } = await client
      .from("questions")
      .select("id, creator_jid, wa_message_id")
      .eq("id", publishedId)
      .maybeSingle();
    questionRow = q;
  }
  const parsed = parseCadernoFromQuestionRow(questionRow || {});
  if (parsed.cadernoQuestionId) {
    const { data: cq } = await client
      .from("caderno_questions")
      .select("tec_question_id, caderno_id")
      .eq("id", parsed.cadernoQuestionId)
      .maybeSingle();
    tecId = tecId || tecIdFromRaw(cq?.tec_question_id);
    cadernoId = cadernoId || cadernoIdFromRaw(cq?.caderno_id) || parsed.cadernoId;
  } else if (!cadernoId) {
    cadernoId = parsed.cadernoId;
  }
  return { tecId, cadernoId };
}

export async function notifyStudyAppAnswer(input: {
  tecId?: number | null;
  cadernoId?: number | null;
  shortId: string;
  publishedQuestionId?: number | null;
  userJid: string;
  answerLetter: string;
  comment?: string | null;
  confidenceLevel?: string | null;
  durationMs?: number | null;
  tags?: string[];
  syncSource?: string | null;
}): Promise<void> {
  if (input.syncSource === "app") return;
  const base = studyAppBase();
  const secret = studyAppSecret();
  if (!base || !secret) {
    console.warn("[study-sync] answer skip: STUDY_APP_URL/FLASHCARDS_API_URL ou FLASHCARDS_BOT_INBOUND_SECRET ausente");
    return;
  }
  let tecId = input.tecId != null ? Number(input.tecId) : NaN;
  let cadernoId = input.cadernoId != null ? Number(input.cadernoId) : NaN;
  if (!Number.isFinite(tecId) || tecId <= 0 || !Number.isFinite(cadernoId) || cadernoId <= 0) {
    try {
      const ctx = await lookupCadernoContext({
        shortId: input.shortId,
        publishedQuestionId: input.publishedQuestionId ?? null
      });
      if (!Number.isFinite(tecId) || tecId <= 0) tecId = ctx.tecId ?? NaN;
      if (!Number.isFinite(cadernoId) || cadernoId <= 0) cadernoId = ctx.cadernoId ?? NaN;
    } catch (e) {
      console.warn("[study-sync] lookup", (e as Error).message);
    }
  }
  try {
    const res = await fetch(`${base}/api/quiz-sync/answer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tecId: Number.isFinite(tecId) && tecId > 0 ? tecId : null,
        cadernoId: Number.isFinite(cadernoId) && cadernoId > 0 ? cadernoId : null,
        shortId: input.shortId,
        publishedQuestionId: input.publishedQuestionId ?? null,
        userJid: input.userJid,
        answerLetter: input.answerLetter,
        comment: input.comment ?? null,
        confidenceLevel: input.confidenceLevel ?? "seguro",
        durationMs: null,
        tags: input.tags ?? [],
        source: "whatsapp"
      })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn("[study-sync] answer", res.status, t.slice(0, 200));
    }
  } catch (e) {
    console.warn("[study-sync] answer", (e as Error).message);
  }
}

export async function notifyStudyAppPublished(input: {
  tecId: number | null;
  cadernoId: number;
  shortId: string;
  publishedQuestionId: number;
}): Promise<void> {
  const base = studyAppBase();
  const secret = studyAppSecret();
  if (!base || !secret) return;
  try {
    await fetch(`${base}/api/quiz-sync/flush`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tecId: input.tecId,
        cadernoId: input.cadernoId,
        shortId: input.shortId,
        publishedQuestionId: input.publishedQuestionId,
        source: "whatsapp"
      })
    });
  } catch (e) {
    console.warn("[study-sync] flush", (e as Error).message);
  }
}
