/** Notifica o app de estudo após resposta no WhatsApp (VPS). */

function studyAppBase(): string | null {
  const raw = String(process.env.STUDY_APP_URL || process.env.FLASHCARDS_API_URL || "")
    .trim()
    .replace(/\/+$/, "");
  return raw || null;
}

function studyAppSecret(): string | null {
  return String(process.env.FLASHCARDS_BOT_INBOUND_SECRET || "").trim() || null;
}

export async function notifyStudyAppAnswer(input: {
  tecId?: number | null;
  cadernoId?: number | null;
  shortId: string;
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
  if (!base || !secret) return;
  try {
    const res = await fetch(`${base}/api/quiz-sync/answer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tecId: input.tecId ?? null,
        cadernoId: input.cadernoId ?? null,
        shortId: input.shortId,
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
