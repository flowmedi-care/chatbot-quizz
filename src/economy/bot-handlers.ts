import { WASocket } from "@whiskeysockets/baileys";
import type { EconomyCommand } from "../message-utils";
import { config } from "../config";
import {
  buildProfileText,
  buildAurasBoardText,
  buildDiarioOficialDigest,
  listShopCatalog,
  formatShopList,
  purchaseDirectWhatsapp,
  equipItem,
  useEliminateAssist,
  createAplicacao,
  createMandado,
  getRanking,
  formatRankingMessage,
  confirmPurchase,
  getPendingPurchaseForUser,
  listPendingPurchaseNotifications,
  markPurchaseNotified,
  getShopItem,
  ensureEconomy,
  availableCredits,
  expireMandados,
  findPendingMandadoForAnswer,
  resolveMandadoOnAnswer,
  onAnswerSaved,
  onQuestionCreated,
  markStreakDayComplete,
  tryMatureAplicacoes,
  ensureStreak,
  type RewardSideEffects
} from "./index";
import {
  listUnansweredShortIdsForUser,
  listUnprocessedBotPendingEvents,
  markBotPendingEventProcessed,
  getCadernoIdForQuestion
} from "../supabase";
import { tryAdvanceCadernoAfterAnswer } from "../caderno-scheduler";
import { todayIso } from "./db";

function quizGroupJid(): string | null {
  if (config.targetGroupJids.length === 0) return null;
  if (config.targetGroupJids.length >= 2) return config.targetGroupJids[1];
  return config.targetGroupJids[0];
}

/** Hook opcional (auto-gabarito no grupo) — registrado em index.ts para evitar ciclo. */
let webAnswerExtraSideEffect:
  | ((sock: WASocket, questionShortId: string) => Promise<void>)
  | null = null;

export function registerWebAnswerSideEffect(
  fn: (sock: WASocket, questionShortId: string) => Promise<void>
): void {
  webAnswerExtraSideEffect = fn;
}

function getBotJidComparable(sock: WASocket): string | null {
  const id = sock.user?.id;
  if (!id) return null;
  const bare = id.includes(":") ? id.split(":")[0] : id.split("@")[0];
  return `${bare}@s.whatsapp.net`.toLowerCase();
}

export async function dispatchRewardEffects(sock: WASocket, effects: RewardSideEffects | null | undefined): Promise<void> {
  if (!effects) return;
  for (const a of effects.announces) {
    try {
      await sock.sendMessage(a.groupJid, { text: a.text });
    } catch (e) {
      console.warn("[economy] announce:", (e as Error).message);
    }
  }
  for (const pm of effects.privateMessages) {
    try {
      await sock.sendMessage(pm.jid, { text: pm.text });
    } catch (e) {
      console.warn("[economy] dm:", (e as Error).message);
    }
  }
}

export async function processEconomyAfterAnswer(
  sock: WASocket,
  input: {
    userJid: string;
    userName: string;
    questionShortId: string;
    questionId: number | string;
    answerLetter: string;
    answerKey: string | null | undefined;
    groupJid?: string | null;
    wasUpdate?: boolean;
    previousLetter?: string | null;
  }
): Promise<void> {
  try {
    const effects = await onAnswerSaved(input);
    await dispatchRewardEffects(sock, effects);

    const mandado = await findPendingMandadoForAnswer(input.userJid, input.questionShortId);
    if (mandado) {
      const correct =
        input.answerKey != null &&
        String(input.answerKey).trim().toLowerCase() === String(input.answerLetter).trim().toLowerCase();
      const resolved = await resolveMandadoOnAnswer({ mandado, correct });
      if (mandado.group_jid) {
        await sock.sendMessage(mandado.group_jid, { text: resolved.groupText });
      }
    }

    // Streak: se zerou omissas de hoje, marca dia
    const gj = input.groupJid || quizGroupJid();
    if (gj) {
      const open = await listUnansweredShortIdsForUser(input.userJid, gj, 50);
      if (open.length === 0) {
        const streakFx = await markStreakDayComplete({
          userJid: input.userJid,
          userName: input.userName,
          dayIso: todayIso(),
          groupJid: gj
        });
        await dispatchRewardEffects(sock, {
          announces: streakFx.announces,
          privateMessages: streakFx.privateMessages,
          economy: effects.economy
        });
        const streak = await ensureStreak(input.userJid);
        const matured = await tryMatureAplicacoes(input.userJid, streak.current_streak);
        if (matured) {
          await sock.sendMessage(input.userJid, { text: matured });
        }
      }
      try {
        const { maybeRewardCadernoComplete } = await import("./daily");
        await maybeRewardCadernoComplete(input.userJid, input.userName, gj);
      } catch (e) {
        console.warn("[economy] caderno complete hook:", (e as Error).message);
      }
    }
  } catch (e) {
    console.warn("[economy] after answer:", (e as Error).message);
  }
}

export async function processEconomyAfterCreateQuestion(
  sock: WASocket,
  input: {
    userJid: string;
    userName: string;
    questionId: number | string;
    creatorIsBot?: boolean;
    groupJid?: string | null;
  }
): Promise<void> {
  try {
    const effects = await onQuestionCreated(input);
    await dispatchRewardEffects(sock, effects);
  } catch (e) {
    console.warn("[economy] after create:", (e as Error).message);
  }
}

/** Prioridade: confirmação de compra pendente no sim/nao. */
export async function tryHandlePurchaseConfirm(
  sock: WASocket,
  userJid: string,
  text: string
): Promise<boolean> {
  const pending = await getPendingPurchaseForUser(userJid);
  if (!pending) return false;
  const t = text.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (t === "sim" || t === "s") {
    const r = await confirmPurchase(userJid, true);
    await sock.sendMessage(userJid, { text: r.message });
    return true;
  }
  if (t === "nao" || t === "n") {
    const r = await confirmPurchase(userJid, false);
    await sock.sendMessage(userJid, { text: r.message });
    return true;
  }
  return false;
}

export async function handleEconomyCommand(
  sock: WASocket,
  remoteJid: string,
  sender: string,
  displayName: string,
  cmd: EconomyCommand
): Promise<boolean> {
  const groupJid = quizGroupJid();

  if (cmd.kind === "perfil") {
    await sock.sendMessage(remoteJid, { text: await buildProfileText(sender, displayName) });
    return true;
  }
  if (cmd.kind === "auras") {
    await sock.sendMessage(remoteJid, { text: await buildAurasBoardText() });
    return true;
  }
  if (cmd.kind === "loja") {
    const items = await listShopCatalog();
    await sock.sendMessage(remoteJid, { text: formatShopList(items) });
    return true;
  }
  if (cmd.kind === "comprar") {
    const r = await purchaseDirectWhatsapp({ userJid: sender, itemKey: cmd.itemKey });
    await sock.sendMessage(remoteJid, { text: r.message });
    return true;
  }
  if (cmd.kind === "equipar") {
    const msg = await equipItem(sender, cmd.itemKey);
    await sock.sendMessage(remoteJid, { text: msg });
    return true;
  }
  if (cmd.kind === "eliminar") {
    const msg = await useEliminateAssist(sender, cmd.questionShortId);
    await sock.sendMessage(remoteJid, { text: msg });
    return true;
  }
  if (cmd.kind === "aplicar") {
    const msg = await createAplicacao(sender, cmd.amount);
    await sock.sendMessage(remoteJid, { text: msg });
    return true;
  }
  if (cmd.kind === "diario") {
    const text = await buildDiarioOficialDigest({
      dayIso: todayIso(),
      cadernoLines: ["(Use o digest do grupo pela manhã para cadernos do dia.)"],
      groupJid: groupJid || ""
    });
    await sock.sendMessage(remoteJid, { text });
    return true;
  }
  if (cmd.kind === "ranking_eco") {
    const rows = await getRanking(cmd.board);
    await sock.sendMessage(remoteJid, { text: formatRankingMessage(cmd.board, rows) });
    return true;
  }
  if (cmd.kind === "intimar") {
    if (!groupJid) {
      await sock.sendMessage(remoteJid, { text: "Grupo do quiz não configurado." });
      return true;
    }
    // Resolve defender by display name substring or jid fragment
    const { data: ecos } = await (
      await import("./db")
    ).economyDb()
      .from("user_economy")
      .select("user_jid, display_name")
      .limit(200);
    const q = cmd.defenderQuery.toLowerCase();
    const match =
      (ecos || []).find(
        (e) =>
          e.user_jid === cmd.defenderQuery ||
          (e.display_name && e.display_name.toLowerCase().includes(q)) ||
          e.user_jid.toLowerCase().includes(q.replace(/\D/g, ""))
      ) || null;
    if (!match) {
      await sock.sendMessage(remoteJid, {
        text: "Não achei o intimado. Peça para a pessoa responder uma questão antes (cria o perfil) ou use parte do nome/JID.\nUso: /intimar Nome 50 123"
      });
      return true;
    }
    const { getQuestionResult } = await import("../supabase");
    let questionLabel: string | null = null;
    let materia: string | null = null;
    try {
      const qr = await getQuestionResult(cmd.questionShortId);
      questionLabel = (qr.statementText || "").slice(0, 80) || null;
    } catch {
      await sock.sendMessage(remoteJid, { text: "Questão não encontrada." });
      return true;
    }
    const created = await createMandado({
      challengerJid: sender,
      challengerLabel: displayName,
      defenderJid: match.user_jid,
      defenderLabel: match.display_name || match.user_jid,
      groupJid,
      questionShortId: cmd.questionShortId,
      questionLabel,
      materia,
      stake: cmd.stake
    });
    await sock.sendMessage(groupJid, { text: created.card });
    await sock.sendMessage(remoteJid, {
      text: `Mandado emitido. Taxa queimada: ${created.fee} Créditos. Stake empenhado: ${cmd.stake}.`
    });
    await sock.sendMessage(match.user_jid, {
      text: [
        "⚖️ Você foi intimado!",
        `Por: ${displayName}`,
        `Questão: #${cmd.questionShortId}`,
        `Valor: ${cmd.stake} Créditos`,
        "Prazo: 24h — responda no privado."
      ].join("\n")
    });
    return true;
  }
  return false;
}

export async function flushEconomyOutbox(sock: WASocket): Promise<void> {
  try {
    const pending = await listPendingPurchaseNotifications();
    for (const p of pending) {
      const item = await getShopItem(p.item_key);
      const bal = await availableCredits(p.user_jid);
      await ensureEconomy(p.user_jid);
      await sock.sendMessage(p.user_jid, {
        text: [
          "🏛️ Portal de compras",
          `Você está comprando: ${item?.name || p.item_key}`,
          `Valor: ${p.price_credits} Créditos Orçamentários`,
          `Saldo disponível: ${bal}`,
          "",
          "Confirma? Responda *sim* ou *nao*",
          `(expira em breve · pedido #${p.token})`
        ].join("\n")
      });
      await markPurchaseNotified(p.id);
    }
  } catch (e) {
    console.warn("[economy] outbox purchases:", (e as Error).message);
  }

  try {
    const expired = await expireMandados();
    for (const ex of expired) {
      await sock.sendMessage(ex.groupJid, { text: ex.text });
    }
  } catch (e) {
    console.warn("[economy] expire mandados:", (e as Error).message);
  }

  try {
    const events = await listUnprocessedBotPendingEvents(40);
    for (const ev of events) {
      try {
        if (ev.kind === "web_answer") {
          const p = ev.payload;
          const userJid = String(p.userJid || "");
          const shortId = String(p.questionShortId || "").toUpperCase();
          if (!userJid || !shortId) {
            await markBotPendingEventProcessed(ev.id);
            continue;
          }
          await processEconomyAfterAnswer(sock, {
            userJid,
            userName: p.userName != null ? String(p.userName) : "",
            questionShortId: shortId,
            questionId: (p.questionId as string | number) ?? shortId,
            answerLetter: String(p.answerLetter || ""),
            answerKey: p.answerKey != null ? String(p.answerKey) : null,
            groupJid: p.groupJid != null ? String(p.groupJid) : quizGroupJid(),
            wasUpdate: Boolean(p.wasUpdate),
            previousLetter: p.previousLetter != null ? String(p.previousLetter) : null
          });

          try {
            const cadernoId = await getCadernoIdForQuestion(shortId);
            if (cadernoId != null) {
              await tryAdvanceCadernoAfterAnswer(sock, cadernoId, getBotJidComparable(sock));
            }
          } catch (wakeErr) {
            console.warn("[economy] web_answer wake:", (wakeErr as Error).message);
          }

          if (webAnswerExtraSideEffect) {
            try {
              await webAnswerExtraSideEffect(sock, shortId);
            } catch (extraErr) {
              console.warn("[economy] web_answer extra:", (extraErr as Error).message);
            }
          }
        }
        await markBotPendingEventProcessed(ev.id);
      } catch (evErr) {
        console.warn(`[economy] pending event ${ev.id}:`, (evErr as Error).message);
      }
    }
  } catch (e) {
    console.warn("[economy] bot_pending_events:", (e as Error).message);
  }
}
