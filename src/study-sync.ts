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

async function lookupCadernoContext(opts: {
  shortId?: string | null;
  publishedQuestionId?: number | null;
}): Promise<{ tecId: number | null; cadernoId: number | null }> {
  const client = sb();
  let publishedId = opts.publishedQuestionId != null ? Number(opts.publishedQuestionId) : NaN;
  if (!Number.isFinite(publishedId) || publishedId <= 0) {
    const sid = String(opts.shortId || "").trim().toUpperCase();
    if (!sid) return { tecId: null, cadernoId: null };
    const { data: q } = await client
      .from("questions")
      .select("id")
      .eq("short_id", sid)
      .limit(1)
      .maybeSingle();
    publishedId = q?.id != null ? Number(q.id) : NaN;
  }
  if (!Number.isFinite(publishedId) || publishedId <= 0) return { tecId: null, cadernoId: null };
  const { data } = await client
    .from("caderno_questions")
    .select("tec_question_id, caderno_id")
    .eq("published_question_id", publishedId)
    .limit(1)
    .maybeSingle();
  if (!data) return { tecId: null, cadernoId: null };
  const n = data.tec_question_id == null || data.tec_question_id === "" ? NaN : Number(data.tec_question_id);
  return {
    tecId: Number.isFinite(n) ? n : null,
    cadernoId: data.caderno_id != null ? Number(data.caderno_id) : null
  };
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
        durationMs: input.durationMs ?? null,
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
