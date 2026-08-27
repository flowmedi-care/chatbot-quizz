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
  useDayOff,
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
  friendlyEconomyLabel,
  type RewardSideEffects
} from "./index";
import {
  listUnansweredShortIdsForUser,
  listUnprocessedBotPendingEvents,
  markBotPendingEventProcessed,
  getCadernoIdForQuestion,
  getDiscussionCommentById,
  getDiscussionPostById,
  getResultWaMessageIdForQuestion,
  markDiscussionCommentSharedToWa,
  listDiscussionCommentsForPost,
  getQuestionResult
} from "../supabase";
import { tryAdvanceCadernoAfterAnswer } from "../caderno-scheduler";
import { formatAiGroupMessage } from "../answer-comments";
import { todayIso, addDaysToIso, economyDb } from "./db";

async function handleDiscussionSharePending(
  sock: WASocket,
  payload: Record<string, unknown>
): Promise<void> {
  const commentId = Number(payload.commentId);
  if (!Number.isFinite(commentId) || commentId <= 0) return;

  const comment = await getDiscussionCommentById(commentId);
  if (!comment) return;

  const post = await getDiscussionPostById(comment.postId);
  if (!post) return;

  const author =
    (comment.authorName && comment.authorName.trim()) ||
    String(payload.authorLabel || "").trim() ||
    "Alguém";

  const allComments = await listDiscussionCommentsForPost(post.id);
  const byId = new Map(allComments.map((c) => [c.id, c]));
  const chain: typeof allComments = [];
  let cur: (typeof allComments)[number] | undefined = comment;
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
  }

  let resultHint = "";
  try {
    const result = await getQuestionResult(post.shortId);
    const me = result.correctRespondents
      .concat(result.wrongRespondents)
      .find((r) => r.name === author);
    const letterLine = me
      ? `Marcou: ${me.letter}${me.comment ? ` — "${me.comment}"` : ""}`
      : null;
    resultHint = [
      `Gabarito: ${result.answerKey}`,
      letterLine,
      `Acertaram: ${result.correctUsers.length} · Erraram: ${result.wrongUsers.length}`
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    /* ignore */
  }

  const chainLines = chain.map((c, i) => {
    const who = (c.authorName && c.authorName.trim()) || "Participante";
    const prefix = i === 0 ? "└" : `${"  ".repeat(i)}└`;
    return `${prefix} ${who}: ${c.body}`;
  });

  const text = [
    `[Discussão site] #${post.shortId}`,
    resultHint,
    resultHint ? "" : null,
    `${author} comentou${comment.parentId ? " (em resposta)" : ""}:`,
    `"${comment.body}"`,
    chain.length > 1 ? "" : null,
    chain.length > 1 ? "Contexto da thread:" : null,
    chain.length > 1 ? chainLines.join("\n") : null
  ]
    .filter((x) => x != null)
    .join("\n");

  const resultWaId = await getResultWaMessageIdForQuestion(post.questionId, post.groupJid);
  if (resultWaId) {
    await sock.sendMessage(
      post.groupJid,
      { text },
      {
        quoted: {
          key: {
            remoteJid: post.groupJid,
            id: resultWaId,
            fromMe: true
          },
          message: { conversation: `Resultado da Questao #${post.shortId}` }
        }
      }
    );
  } else {
    await sock.sendMessage(post.groupJid, { text });
  }

  await markDiscussionCommentSharedToWa(comment.id);
}

async function handleAiCommentPending(
  sock: WASocket,
  payload: Record<string, unknown>
): Promise<void> {
  const shortId = String(payload.questionShortId || "").toUpperCase();
  const aiComment = String(payload.aiComment || "").trim();
  if (!shortId || !aiComment) return;
  const groupJid =
    String(payload.groupJid || "").trim() || quizGroupJid();
  if (!groupJid) return;
  const questionId = Number(payload.questionId);
  if (Number.isFinite(questionId) && questionId > 0) {
    const posted = await getResultWaMessageIdForQuestion(questionId, groupJid);
    if (!posted) return;
  } else {
    try {
      const result = await getQuestionResult(shortId);
      const posted = await getResultWaMessageIdForQuestion(result.questionId, groupJid);
      if (!posted) return;
    } catch {
      return;
    }
  }
  const text = formatAiGroupMessage({
    shortId,
    userName: payload.userName != null ? String(payload.userName) : null,
    studentComment:
      payload.studentComment != null ? String(payload.studentComment) : null,
    aiComment
  });
  await sock.sendMessage(groupJid, { text });
}

function looksLikeRawId(s: string | null | undefined): boolean {
  const t = String(s || "").trim();
  if (!t) return true;
  if (t.includes("@")) return true;
  if (/^\+?\d{8,}$/.test(t)) return true;
  if (/^\d{10,}/.test(t)) return true;
  if (/^Caderno:/i.test(t)) return true;
  return false;
}

function resolveFolgaDayIso(dayToken: string): string | null {
  const raw = dayToken
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const today = todayIso();
  if (raw === "hoje" || raw === "today") return today;
  if (raw === "amanha" || raw === "tomorrow") return addDaysToIso(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return null;
}

async function resolveDefenderForIntimar(query: string): Promise<{
  userJid: string;
  label: string;
} | null> {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const db = economyDb();

  type Cand = { userJid: string; names: string[] };
  const byJid = new Map<string, Cand>();

  const add = (userJid: string, ...names: (string | null | undefined)[]) => {
    if (!userJid) return;
    let c = byJid.get(userJid);
    if (!c) {
      c = { userJid, names: [] };
      byJid.set(userJid, c);
    }
    for (const n of names) {
      const t = n != null ? String(n).trim() : "";
      if (t && !looksLikeRawId(t) && !c.names.includes(t)) c.names.push(t);
    }
  };

  const { data: ecos } = await db.from("user_economy").select("user_jid, display_name").limit(500);
  for (const e of ecos || []) add(e.user_jid, e.display_name);

  try {
    const { data: eng } = await db
      .from("group_member_engagement")
      .select("user_jid, quiz_display_name, user_label")
      .limit(500);
    for (const e of eng || []) add(e.user_jid, e.quiz_display_name, e.user_label);
  } catch {
    /* tabela pode não existir */
  }

  const list = [...byJid.values()];
  const scored = list
    .map((c) => {
      let score = 0;
      if (c.userJid === query.trim() || c.userJid.toLowerCase() === q) score += 100;
      for (const n of c.names) {
        const ln = n.toLowerCase();
        if (ln === q) score += 80;
        else if (ln.includes(q) || q.includes(ln)) score += 40;
      }
      if (digits.length >= 6 && c.userJid.toLowerCase().includes(digits)) score += 20;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0]?.c;
  if (!best) return null;
  const label = friendlyEconomyLabel(best.names[0] || null, null, best.userJid);
  return { userJid: best.userJid, label };
}

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
    const msg = await useEliminateAssist(sender, cmd.questionShortId, cmd.letter);
    await sock.sendMessage(remoteJid, { text: msg });
    return true;
  }
  if (cmd.kind === "folga") {
    const dayIso = resolveFolgaDayIso(cmd.dayToken);
    if (!dayIso) {
      await sock.sendMessage(remoteJid, {
        text: "Uso: /folga hoje · /folga amanha · /folga AAAA-MM-DD"
      });
      return true;
    }
    const msg = await useDayOff(sender, dayIso);
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
    const match = await resolveDefenderForIntimar(cmd.defenderQuery);
    if (!match) {
      await sock.sendMessage(remoteJid, {
        text: "Não achei o intimado. Peça para a pessoa responder uma questão antes (cria o perfil) ou use parte do nome.\nUso: /intimar Nome 50 123"
      });
      return true;
    }
    const { getQuestionResult } = await import("../supabase");
    let questionLabel: string | null = null;
    let materia: string | null = null;
    try {
      const qr = await getQuestionResult(cmd.questionShortId);
      questionLabel = (qr.statementText || "").slice(0, 80) || null;
      const { data: qrow } = await economyDb()
        .from("questions")
        .select("materia_id")
        .eq("short_id", cmd.questionShortId.toUpperCase())
        .maybeSingle();
      const mid = qrow?.materia_id != null ? Number(qrow.materia_id) : null;
      if (mid && Number.isFinite(mid)) {
        const { data: mat } = await economyDb().from("materias").select("name").eq("id", mid).maybeSingle();
        if (mat?.name) materia = String(mat.name);
      }
    } catch {
      await sock.sendMessage(remoteJid, { text: "Questão não encontrada." });
      return true;
    }
    const challengerLabel = friendlyEconomyLabel(displayName, null, sender);
    const created = await createMandado({
      challengerJid: sender,
      challengerLabel,
      defenderJid: match.userJid,
      defenderLabel: match.label,
      groupJid,
      questionShortId: cmd.questionShortId,
      questionLabel,
      materia,
      stake: cmd.stake
    });
    await sock.sendMessage(groupJid, { text: created.card });
    await sock.sendMessage(remoteJid, {
      text: `Mandado emitido contra *${match.label}*. Taxa queimada: ${created.fee} Créditos. Stake empenhado: ${cmd.stake}.`
    });
    await sock.sendMessage(match.userJid, {
      text: [
        "⚖️ Você foi intimado!",
        `Por: ${challengerLabel}`,
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
          if (!p.skipEconomy) {
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
          }

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
        } else if (ev.kind === "ai_comment") {
          await handleAiCommentPending(sock, ev.payload);
        } else if (ev.kind === "discussion_share") {
          await handleDiscussionSharePending(sock, ev.payload);
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
