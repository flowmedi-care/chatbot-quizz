import type { WASocket } from "@whiskeysockets/baileys";
import { dateIsoInTimezone } from "../schedule";
import type { FlashcardsConfig } from "./config";
import { getFlashcardsConfig } from "./config";
import {
  cancelFlashcardsSession,
  confirmFlashcardsSession,
  createFlashcardsSession,
  getFlashcardsActiveSession,
  getFlashcardsBotSettings,
  getFlashcardsPending,
  listFlashcardsDispatchDue,
  markFlashcardsDispatchSent,
  submitFlashcardsDispatchAnswer
} from "./client";
import type { FlashcardCard } from "./types";

const RATING_LINE =
  "Avalie (FSRS):\n1 = Again\n2 = Hard\n3 = Good\n4 = Easy";

/** Sessão aguardando SIM/NÃO após lembrete matinal. */
const pendingConfirmSessionByJid = new Map<string, string>();

/** Após enviar a frente: qualquer mensagem revela o verso. */
const awaitingRevealByJid = new Map<
  string,
  { dispatchId: string; card: FlashcardCard }
>();

/** Aguardando nota 1–4. */
const awaitingRatingByJid = new Map<
  string,
  { dispatchId: string; card: FlashcardCard }
>();

let pollTimer: NodeJS.Timeout | null = null;
let cfg: FlashcardsConfig | null = null;
let lastMorningIsoDate: string | null = null;

function normalizeInboundText(text: string): string {
  return text.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function isPrivateJid(jid: string): boolean {
  const t = jid.toLowerCase();
  return t.endsWith("@s.whatsapp.net") || t.endsWith("@lid");
}

function resolveTargetJid(settings: { whatsapp_jid?: string | null; user_whatsapp_jid?: string | null }): string | null {
  const j =
    (settings.whatsapp_jid && String(settings.whatsapp_jid).trim()) ||
    (settings.user_whatsapp_jid && String(settings.user_whatsapp_jid).trim()) ||
    "";
  return j || null;
}

function formatCardCaption(card: FlashcardCard, phase: "front" | "reveal"): string {
  const deck = card.deck_name ? `[${card.deck_name}] ` : "";
  const side = phase === "front" ? card.front : card.on_reveal;
  const text = side.text?.trim();
  if (text) return `${deck}${text}`;
  return deck.trim() || (phase === "front" ? "Flashcard" : "Resposta");
}

async function sendFlashcardSide(
  sock: WASocket,
  jid: string,
  card: FlashcardCard,
  phase: "front" | "reveal"
): Promise<void> {
  const side = phase === "front" ? card.front : card.on_reveal;
  const caption = formatCardCaption(card, phase);
  if (side.image_url) {
    await sock.sendMessage(jid, {
      image: { url: side.image_url },
      caption
    });
    return;
  }
  await sock.sendMessage(jid, { text: caption });
}

async function sendQuestion(sock: WASocket, jid: string, card: FlashcardCard): Promise<void> {
  await sendFlashcardSide(sock, jid, card, "front");
  await sock.sendMessage(jid, {
    text: "Responda mentalmente (ou anote) e envie qualquer mensagem para ver o verso."
  });
}

async function sendRevealAndRatingPrompt(
  sock: WASocket,
  jid: string,
  card: FlashcardCard
): Promise<void> {
  await sendFlashcardSide(sock, jid, card, "reveal");
  await sock.sendMessage(jid, { text: RATING_LINE });
}

function parseRating(text: string): number | null {
  const t = normalizeInboundText(text);
  if (/^[1-4]$/.test(t)) return Number(t);
  const m = t.match(/\b([1-4])\b/);
  return m ? Number(m[1]) : null;
}

function isYes(text: string): boolean {
  const t = normalizeInboundText(text);
  return t === "sim" || t === "s";
}

function isNo(text: string): boolean {
  const t = normalizeInboundText(text);
  return t === "nao" || t === "n";
}

function hourInTimezone(timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number(h === "24" ? "0" : h);
}

function withinSendWindow(
  settings: { start_hour?: number; end_hour?: number; timezone?: string },
  timeZone: string
): boolean {
  const h = hourInTimezone(timeZone);
  const start = settings.start_hour != null ? Number(settings.start_hour) : 7;
  const end = settings.end_hour != null ? Number(settings.end_hour) : 22;
  if (end > start) return h >= start && h <= end;
  return h >= start || h <= end;
}

async function runMorningReminder(sock: WASocket): Promise<void> {
  if (!cfg) return;
  let settings;
  try {
    settings = await getFlashcardsBotSettings(cfg);
  } catch (e) {
    console.warn("[flashcards] settings:", (e as Error).message);
    return;
  }

  if (settings.enabled === false) return;

  const tz = settings.timezone || "America/Sao_Paulo";
  const today = dateIsoInTimezone(new Date(), tz);
  const startHour = settings.start_hour != null ? Number(settings.start_hour) : 7;
  if (hourInTimezone(tz) !== startHour) return;
  if (lastMorningIsoDate === today) return;

  const targetJid = resolveTargetJid(settings);
  if (!targetJid || !isPrivateJid(targetJid)) {
    console.warn("[flashcards] whatsapp_jid nao configurado no app Flashcards (settings).");
    return;
  }

  let pending;
  try {
    pending = await getFlashcardsPending(cfg);
  } catch (e) {
    console.warn("[flashcards] pending:", (e as Error).message);
    return;
  }

  if (!pending.should_remind) {
    lastMorningIsoDate = today;
    return;
  }

  const template =
    pending.message_template?.trim() ||
    "Voce tem flashcards para revisar hoje. Responda SIM para comecar ou NAO para adiar.";

  try {
    await sock.sendMessage(targetJid, { text: template });
    const cardIds = pending.card_ids ?? [];
    if (cardIds.length > 0) {
      const session = await createFlashcardsSession(cfg, cardIds);
      if (session?.id) {
        pendingConfirmSessionByJid.set(targetJid, session.id);
      }
    }
    lastMorningIsoDate = today;
    console.log(`[flashcards] lembrete matinal enviado para ${targetJid}`);
  } catch (e) {
    console.error("[flashcards] lembrete matinal:", (e as Error).message);
  }
}

async function runDispatchPoller(sock: WASocket): Promise<void> {
  if (!cfg) return;
  let settings;
  try {
    settings = await getFlashcardsBotSettings(cfg);
  } catch (e) {
    console.warn("[flashcards] settings (poll):", (e as Error).message);
    return;
  }

  if (settings.enabled === false) return;

  const tz = settings.timezone || "America/Sao_Paulo";
  if (!withinSendWindow(settings, tz)) return;

  const targetJid = resolveTargetJid(settings);
  if (!targetJid || !isPrivateJid(targetJid)) return;

  if (awaitingRevealByJid.has(targetJid) || awaitingRatingByJid.has(targetJid)) {
    return;
  }

  let items;
  try {
    items = await listFlashcardsDispatchDue(cfg);
  } catch (e) {
    console.warn("[flashcards] dispatch/due:", (e as Error).message);
    return;
  }

  const list = Array.isArray(items) ? items : [];

  for (const item of list) {
    if (!item.card) continue;
    try {
      await sendQuestion(sock, targetJid, item.card);
      await markFlashcardsDispatchSent(cfg, item.dispatch_id);
      awaitingRevealByJid.set(targetJid, {
        dispatchId: item.dispatch_id,
        card: item.card
      });
      console.log(
        `[flashcards] card enviado dispatch=${item.dispatch_id} deck=${item.card.deck_name ?? "?"}`
      );
      return;
    } catch (e) {
      console.error(`[flashcards] falha dispatch ${item.dispatch_id}:`, (e as Error).message);
    }
  }
}

async function tick(sock: WASocket): Promise<void> {
  try {
    await runMorningReminder(sock);
    await runDispatchPoller(sock);
  } catch (e) {
    console.error("[flashcards] tick:", (e as Error).message);
  }
}

async function restoreActiveSession(): Promise<void> {
  if (!cfg) return;
  try {
    const session = await getFlashcardsActiveSession(cfg);
    if (!session?.id) return;
    const settings = await getFlashcardsBotSettings(cfg);
    const jid = resolveTargetJid(settings);
    if (jid) {
      pendingConfirmSessionByJid.set(jid, session.id);
      console.log(`[flashcards] sessao ativa restaurada: ${session.id}`);
    }
  } catch (e) {
    console.warn("[flashcards] restore session:", (e as Error).message);
  }
}

/**
 * Trata mensagens no privado para o fluxo Flashcards (separado do quiz).
 * @returns true se consumiu a mensagem
 */
export async function handleFlashcardsPrivateMessage(
  sock: WASocket,
  remoteJid: string,
  actorJid: string,
  text: string
): Promise<boolean> {
  if (!cfg || !isPrivateJid(remoteJid)) return false;

  const jid = actorJid.trim() || remoteJid;

  const rating = parseRating(text);
  if (rating != null && awaitingRatingByJid.has(jid)) {
    const state = awaitingRatingByJid.get(jid)!;
    try {
      await submitFlashcardsDispatchAnswer(cfg, state.dispatchId, rating);
      awaitingRatingByJid.delete(jid);
      await sock.sendMessage(remoteJid, { text: `Avaliacao registrada (${rating}).` });
    } catch (e) {
      await sock.sendMessage(remoteJid, {
        text: `Erro ao salvar avaliacao: ${(e as Error).message}`
      });
    }
    return true;
  }

  const sessionId = pendingConfirmSessionByJid.get(jid);
  if (sessionId) {
    if (isYes(text)) {
      try {
        await confirmFlashcardsSession(cfg, sessionId);
        pendingConfirmSessionByJid.delete(jid);
        await sock.sendMessage(remoteJid, {
          text: "Ok! Vou enviar os cards nos horarios agendados."
        });
      } catch (e) {
        await sock.sendMessage(remoteJid, {
          text: `Erro ao confirmar sessao: ${(e as Error).message}`
        });
      }
      return true;
    }
    if (isNo(text)) {
      try {
        await cancelFlashcardsSession(cfg, sessionId);
        pendingConfirmSessionByJid.delete(jid);
        await sock.sendMessage(remoteJid, { text: "Sessao cancelada. Ate amanha." });
      } catch (e) {
        await sock.sendMessage(remoteJid, {
          text: `Erro ao cancelar: ${(e as Error).message}`
        });
      }
      return true;
    }
  }

  if (awaitingRatingByJid.has(jid)) {
    await sock.sendMessage(remoteJid, {
      text: `Envie apenas um numero de 1 a 4.\n\n${RATING_LINE}`
    });
    return true;
  }

  const reveal = awaitingRevealByJid.get(jid);
  if (reveal) {
    awaitingRevealByJid.delete(jid);
    awaitingRatingByJid.set(jid, reveal);
    try {
      await sendRevealAndRatingPrompt(sock, remoteJid, reveal.card);
    } catch (e) {
      awaitingRatingByJid.delete(jid);
      await sock.sendMessage(remoteJid, {
        text: `Erro ao enviar verso: ${(e as Error).message}`
      });
    }
    return true;
  }

  return false;
}

export function startFlashcardsBot(sock: WASocket): void {
  cfg = getFlashcardsConfig();
  if (!cfg) {
    console.log(
      "[flashcards] desligado (defina FLASHCARDS_API_URL e FLASHCARDS_API_KEY no .env)."
    );
    return;
  }

  console.log(
    `[flashcards] ativo — API ${cfg.apiUrl}, poll a cada ${cfg.pollIntervalMs / 1000}s`
  );

  void restoreActiveSession();

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    void tick(sock);
  }, cfg.pollIntervalMs);

  void tick(sock);
}

export function stopFlashcardsBot(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  cfg = null;
}
