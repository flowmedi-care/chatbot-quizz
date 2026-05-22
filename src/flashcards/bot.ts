import type { WASocket } from "@whiskeysockets/baileys";
import { dateIsoInTimezone } from "../schedule";
import type { FlashcardsBaseConfig, FlashcardsConfig } from "./config";
import { getFlashcardsBaseConfig, userFlashcardsConfig } from "./config";
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
import {
  FlashcardsWhatsappLink,
  getFlashcardsLinkByUserJid,
  listActiveFlashcardsLinks,
  listFlashcardsLinksPendingConfirmationSend,
  markFlashcardsLinkConfirmationSent,
  setFlashcardsLinkStatus
} from "./links";
import type { FlashcardCard } from "./types";

const RATING_LINE =
  "Avalie (FSRS):\n1 = Again\n2 = Hard\n3 = Good\n4 = Easy";

/** Sessão de estudo (lembrete matinal SIM/NÃO). */
const pendingConfirmSessionByJid = new Map<string, string>();

const awaitingRevealByJid = new Map<
  string,
  { dispatchId: string; card: FlashcardCard; userCfg: FlashcardsConfig }
>();

const awaitingRatingByJid = new Map<
  string,
  { dispatchId: string; card: FlashcardCard; userCfg: FlashcardsConfig }
>();

let pollTimer: NodeJS.Timeout | null = null;
let baseCfg: FlashcardsBaseConfig | null = null;
const lastMorningIsoDateByJid = new Map<string, string>();

function normalizeInboundText(text: string): string {
  return text.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function isPrivateJid(jid: string): boolean {
  const t = jid.toLowerCase();
  return t.endsWith("@s.whatsapp.net") || t.endsWith("@lid");
}

function resolveTargetJid(settings: {
  whatsapp_jid?: string | null;
  user_whatsapp_jid?: string | null;
}): string | null {
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

async function listLinkedAccounts(): Promise<
  { link: FlashcardsWhatsappLink | null; userCfg: FlashcardsConfig }[]
> {
  if (!baseCfg) return [];
  const out: { link: FlashcardsWhatsappLink | null; userCfg: FlashcardsConfig }[] = [];

  if (baseCfg.legacyApiKey) {
    out.push({
      link: null,
      userCfg: userFlashcardsConfig(baseCfg, baseCfg.legacyApiKey)
    });
  }

  try {
    const active = await listActiveFlashcardsLinks();
    for (const link of active) {
      out.push({ link, userCfg: userFlashcardsConfig(baseCfg, link.apiKey) });
    }
  } catch (e) {
    console.warn("[flashcards] listar vinculos ativos:", (e as Error).message);
  }

  return out;
}

async function sendLinkConfirmationRequests(sock: WASocket): Promise<void> {
  let pending;
  try {
    pending = await listFlashcardsLinksPendingConfirmationSend();
  } catch (e) {
    console.warn("[flashcards] vinculos pendentes:", (e as Error).message);
    return;
  }

  for (const link of pending) {
    if (!isPrivateJid(link.userJid)) continue;
    const who = link.displayLabel?.trim() || "sua conta Flashcards";
    const text = [
      `O app Flashcards quer enviar cards neste WhatsApp (${who}).`,
      "",
      "Responda SIM para autorizar ou NAO para recusar.",
      "",
      "(A API key fica só no servidor; voce nao precisa digitar nada aqui.)"
    ].join("\n");
    try {
      await sock.sendMessage(link.userJid, { text });
      await markFlashcardsLinkConfirmationSent(link.id);
      console.log(`[flashcards] pedido de vinculo enviado para ${link.userJid}`);
    } catch (e) {
      console.error(`[flashcards] falha pedido vinculo ${link.userJid}:`, (e as Error).message);
    }
  }
}

async function runMorningReminderForUser(
  sock: WASocket,
  userCfg: FlashcardsConfig,
  targetJid: string
): Promise<void> {
  let settings;
  try {
    settings = await getFlashcardsBotSettings(userCfg);
  } catch (e) {
    console.warn(`[flashcards] settings ${targetJid}:`, (e as Error).message);
    return;
  }

  if (settings.enabled === false) return;

  const tz = settings.timezone || "America/Sao_Paulo";
  const today = dateIsoInTimezone(new Date(), tz);
  const startHour = settings.start_hour != null ? Number(settings.start_hour) : 7;
  if (hourInTimezone(tz) !== startHour) return;
  if (lastMorningIsoDateByJid.get(targetJid) === today) return;

  const resolved = resolveTargetJid(settings);
  if (resolved && resolved !== targetJid) return;

  let pending;
  try {
    pending = await getFlashcardsPending(userCfg);
  } catch (e) {
    console.warn(`[flashcards] pending ${targetJid}:`, (e as Error).message);
    return;
  }

  if (!pending.should_remind) {
    lastMorningIsoDateByJid.set(targetJid, today);
    return;
  }

  const template =
    pending.message_template?.trim() ||
    "Voce tem flashcards para revisar hoje. Responda SIM para comecar ou NAO para adiar.";

  try {
    await sock.sendMessage(targetJid, { text: template });
    const cardIds = pending.card_ids ?? [];
    if (cardIds.length > 0) {
      const session = await createFlashcardsSession(userCfg, cardIds);
      if (session?.id) {
        pendingConfirmSessionByJid.set(targetJid, session.id);
      }
    }
    lastMorningIsoDateByJid.set(targetJid, today);
    console.log(`[flashcards] lembrete matinal -> ${targetJid}`);
  } catch (e) {
    console.error(`[flashcards] lembrete ${targetJid}:`, (e as Error).message);
  }
}

async function runDispatchPollerForUser(
  sock: WASocket,
  userCfg: FlashcardsConfig,
  targetJid: string
): Promise<void> {
  let settings;
  try {
    settings = await getFlashcardsBotSettings(userCfg);
  } catch {
    return;
  }

  if (settings.enabled === false) return;

  const tz = settings.timezone || "America/Sao_Paulo";
  if (!withinSendWindow(settings, tz)) return;

  const resolved = resolveTargetJid(settings);
  const jid = resolved && isPrivateJid(resolved) ? resolved : targetJid;
  if (!isPrivateJid(jid)) return;

  if (awaitingRevealByJid.has(jid) || awaitingRatingByJid.has(jid)) return;

  let items;
  try {
    items = await listFlashcardsDispatchDue(userCfg);
  } catch (e) {
    console.warn(`[flashcards] dispatch ${jid}:`, (e as Error).message);
    return;
  }

  for (const item of items) {
    if (!item.card) continue;
    try {
      await sendQuestion(sock, jid, item.card);
      await markFlashcardsDispatchSent(userCfg, item.dispatch_id);
      awaitingRevealByJid.set(jid, {
        dispatchId: item.dispatch_id,
        card: item.card,
        userCfg
      });
      console.log(`[flashcards] card -> ${jid} dispatch=${item.dispatch_id}`);
      return;
    } catch (e) {
      console.error(`[flashcards] dispatch ${item.dispatch_id}:`, (e as Error).message);
    }
  }
}

async function tick(sock: WASocket): Promise<void> {
  try {
    await sendLinkConfirmationRequests(sock);
    const accounts = await listLinkedAccounts();
    for (const { link, userCfg } of accounts) {
      const jid =
        link?.userJid ??
        (await getFlashcardsBotSettings(userCfg).then((s) => resolveTargetJid(s)).catch(() => null));
      if (!jid || !isPrivateJid(jid)) continue;
      await runMorningReminderForUser(sock, userCfg, jid);
      await runDispatchPollerForUser(sock, userCfg, jid);
    }
  } catch (e) {
    console.error("[flashcards] tick:", (e as Error).message);
  }
}

async function restoreActiveSessions(): Promise<void> {
  const accounts = await listLinkedAccounts();
  for (const { userCfg } of accounts) {
    try {
      const session = await getFlashcardsActiveSession(userCfg);
      if (!session?.id) continue;
      const settings = await getFlashcardsBotSettings(userCfg);
      const jid = resolveTargetJid(settings);
      if (jid) {
        pendingConfirmSessionByJid.set(jid, session.id);
        console.log(`[flashcards] sessao restaurada ${jid}: ${session.id}`);
      }
    } catch {
      /* ignore per user */
    }
  }
}

async function handleLinkConfirmationReply(
  sock: WASocket,
  remoteJid: string,
  jid: string,
  text: string
): Promise<boolean> {
  let link;
  try {
    link = await getFlashcardsLinkByUserJid(jid);
  } catch {
    return false;
  }

  if (!link || link.status !== "pending_confirm" || !link.confirmationSentAt) {
    return false;
  }

  if (isYes(text)) {
    await setFlashcardsLinkStatus(jid, "active");
    await sock.sendMessage(remoteJid, {
      text: [
        "Vinculo autorizado.",
        "Voce recebera os flashcards neste WhatsApp nos horarios do app.",
        "Quando chegar o lembrete do dia, responda SIM para comecar a revisao."
      ].join("\n")
    });
    return true;
  }

  if (isNo(text)) {
    await setFlashcardsLinkStatus(jid, "rejected");
    await sock.sendMessage(remoteJid, {
      text: "Vinculo recusado. No app Flashcards voce pode escolher outro contato ou tentar de novo."
    });
    return true;
  }

  await sock.sendMessage(remoteJid, {
    text: 'Responda SIM para autorizar o Flashcards neste numero ou NAO para recusar.'
  });
  return true;
}

/**
 * Trata mensagens no privado para o fluxo Flashcards (separado do quiz).
 */
export async function handleFlashcardsPrivateMessage(
  sock: WASocket,
  remoteJid: string,
  actorJid: string,
  text: string
): Promise<boolean> {
  if (!baseCfg || !isPrivateJid(remoteJid)) return false;

  const jid = actorJid.trim() || remoteJid;

  const ratingState = awaitingRatingByJid.get(jid);
  const rating = parseRating(text);
  if (rating != null && ratingState) {
    try {
      await submitFlashcardsDispatchAnswer(
        ratingState.userCfg,
        ratingState.dispatchId,
        rating
      );
      awaitingRatingByJid.delete(jid);
      await sock.sendMessage(remoteJid, {
        text: `Avaliacao registrada (${rating}).`
      });
    } catch (e) {
      await sock.sendMessage(remoteJid, {
        text: `Erro ao salvar avaliacao: ${(e as Error).message}`
      });
    }
    return true;
  }

  if (await handleLinkConfirmationReply(sock, remoteJid, jid, text)) {
    return true;
  }

  const sessionId = pendingConfirmSessionByJid.get(jid);
  if (sessionId) {
    let userCfg: FlashcardsConfig | null = null;
    const accounts = await listLinkedAccounts();
    for (const acc of accounts) {
      try {
        const settings = await getFlashcardsBotSettings(acc.userCfg);
        if (resolveTargetJid(settings) === jid) {
          userCfg = acc.userCfg;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!userCfg && baseCfg.legacyApiKey) {
      userCfg = userFlashcardsConfig(baseCfg, baseCfg.legacyApiKey);
    }
    if (!userCfg) return false;

    if (isYes(text)) {
      try {
        await confirmFlashcardsSession(userCfg, sessionId);
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
        await cancelFlashcardsSession(userCfg, sessionId);
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
  baseCfg = getFlashcardsBaseConfig();
  if (!baseCfg) {
    console.log("[flashcards] desligado (defina FLASHCARDS_API_URL no .env).");
    return;
  }

  const mode =
    baseCfg.legacyApiKey != null
      ? "URL + legado FLASHCARDS_API_KEY + vinculos SIM"
      : "URL + vinculos por usuario (fc_ no Supabase apos SIM)";
  console.log(
    `[flashcards] ativo — ${mode}, API ${baseCfg.apiUrl}, poll ${baseCfg.pollIntervalMs / 1000}s`
  );

  void restoreActiveSessions();

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    void tick(sock);
  }, baseCfg.pollIntervalMs);

  void tick(sock);
}

export function stopFlashcardsBot(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  baseCfg = null;
  lastMorningIsoDateByJid.clear();
}
