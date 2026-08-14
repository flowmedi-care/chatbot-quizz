import type { WASocket } from "@whiskeysockets/baileys";
import {
  CadernoPrivateRecipientRow,
  CadernoQuestionRow,
  CadernoRow,
  countUnpublishedCadernoQuestions,
  countUnreleasedQueueItems,
  countUnsentPrivateQuestionsForRecipient,
  createQuestionFromCaderno,
  findOrphanCadernoQuestionRow,
  getPrivateSendPublishedQuestionId,
  getPublishedQuestionIdForCadernoQuestion,
  getQuestionShortIdByDbId,
  effectivePrivateRecipientSchedule,
  getEngagedDisplayNameForUser,
  getCadernoById,
  getCadernoProgress,
  getCadernoQuestionById,
  getCadernoSendQueueItem,
  isCadernoDayCompleteForEngaged,
  isPrivateRecipientDayComplete,
  listActiveGroupCadernos,
  listCadernoQuestionsPublishedOnDate,
  listCadernosDueForRun,
  listNextCadernoQuestionsToSend,
  listNextPrivateCadernoQuestionsToSend,
  listPrivateRecipientsDueForRun,
  listPrivateRecipientsByCaderno,
  markCadernoQuestionPublished,
  markCadernoSendQueueReleased,
  maybePausePrivateCadernoWhenExhausted,
  recordGroupDailyDigest,
  recordPrivateSend,
  setCadernoStatus,
  updateCadernoDayState,
  updatePrivateRecipientDayState,
  wasGroupDailyDigestSent
} from "./supabase";
import {
  addDaysIso,
  DailyScheduleSlots,
  dateIsoInTimezone,
  formatNextRunPretty,
  isBeforeOmissasCutoff,
  resolveDailySlotUtc
} from "./schedule";
import { config } from "./config";
import { ECONOMY_TZ, OMISSAS_SCHEDULE } from "./economy/constants";
import { notifyGroupOmissasEntered } from "./economy/omissas";

const TICK_INTERVAL_MS = 60 * 1000;
const WAIT_RETRY_MS = 15 * 60 * 1000;
const DIGEST_FALLBACK_HOUR = 7;
const DIGEST_FALLBACK_MINUTE = 0;
const DEFAULT_TZ = "America/Sao_Paulo";

let timer: NodeJS.Timeout | null = null;
let running = false;

function jidComparableKey(jid: string): string {
  const at = jid.indexOf("@");
  if (at < 0) return jid.toLowerCase().trim();
  const userPart = jid.slice(0, at);
  const userNoDevice = userPart.includes(":") ? userPart.split(":")[0]! : userPart;
  const domain = jid.slice(at + 1).toLowerCase();
  return `${userNoDevice}@${domain}`;
}

/** Monta um CadernoRow “só agenda” para reutilizar decideAction no modo privado. */
function syntheticCadernoForPrivateSchedule(
  caderno: CadernoRow,
  eff: ReturnType<typeof effectivePrivateRecipientSchedule>,
  recipient: CadernoPrivateRecipientRow
): CadernoRow {
  return {
    ...caderno,
    questionsPerDay: eff.questionsPerDay,
    sendTimes: eff.sendTimes,
    startHour: eff.startHour,
    startMinute: eff.startMinute,
    endHour: eff.endHour,
    endMinute: eff.endMinute,
    waitForAnswers: eff.waitForAnswers,
    randomOrder: eff.randomOrder,
    timezone: eff.timezone,
    currentDayDate: recipient.currentDayDate,
    currentDaySent: recipient.currentDaySent,
    nextRunAt: recipient.nextRunAt
  };
}

async function publishCadernoQuestionToChat(
  sock: WASocket,
  destJid: string,
  shortId: string,
  cadernoName: string,
  question: CadernoQuestionRow,
  mode: "group" | "private",
  engagedLine?: string | null
): Promise<void> {
  const intro =
    mode === "private"
      ? `Sua questão #${shortId} (Caderno privado: ${cadernoName})`
      : `Nova questão #${shortId} (Caderno: ${cadernoName})`;
  const options =
    question.questionType === "true_false"
      ? `Responda no privado do bot:\nc ${shortId}\ne ${shortId}`
      : `Responda no privado do bot:\na ${shortId}\nb ${shortId}\nc ${shortId}\nd ${shortId}\ne ${shortId}\n\nConfiança (opcional): inseguro ou chute — ex.: a ${shortId} inseguro`;
  const parts = [intro];
  if (engagedLine && engagedLine.trim()) {
    parts.push(engagedLine.trim());
  }
  parts.push("", question.statementText, "", options);
  const fullText = parts.join("\n");
  await sock.sendMessage(destJid, { text: fullText });
}

async function resolveCadernoQuestionForPublish(
  caderno: CadernoRow,
  question: CadernoQuestionRow,
  recipientJid?: string | null
): Promise<{ shortId: string; dbId: number }> {
  const targetJid = (recipientJid && recipientJid.trim()) || caderno.targetGroupJid;

  let alreadyPublishedId: number | null = null;
  if (recipientJid?.trim()) {
    alreadyPublishedId = await getPrivateSendPublishedQuestionId(
      caderno.id,
      recipientJid.trim(),
      question.id
    );
  } else {
    alreadyPublishedId = await getPublishedQuestionIdForCadernoQuestion(question.id);
  }
  if (alreadyPublishedId != null) {
    const shortId = await getQuestionShortIdByDbId(alreadyPublishedId);
    if (shortId) return { shortId, dbId: alreadyPublishedId };
  }

  const orphan = await findOrphanCadernoQuestionRow(
    caderno.id,
    question.id,
    targetJid,
    recipientJid
  );
  if (orphan) return orphan;

  return createQuestionFromCaderno({ caderno, question, recipientJid });
}

async function publishGroupCadernoQuestion(
  sock: WASocket,
  caderno: CadernoRow,
  question: CadernoQuestionRow,
  preResolved?: { shortId: string; dbId: number } | null
): Promise<{ shortId: string; dbId: number } | null> {
  try {
    const { shortId, dbId } =
      preResolved ?? (await resolveCadernoQuestionForPublish(caderno, question));
    // Enunciado de caderno não vai mais ao grupo — só materializa no DB.
    // Engajados/passivos usam /omissas; digest diário avisa o grupo.
    void sock;
    await markCadernoQuestionPublished(question.id, dbId);
    try {
      const tec = question.tecQuestionId != null ? Number(question.tecQuestionId) : null;
      const { notifyStudyAppPublished } = await import("./study-sync");
      await notifyStudyAppPublished({
        tecId: Number.isFinite(tec as number) ? (tec as number) : null,
        cadernoId: caderno.id,
        shortId,
        publishedQuestionId: dbId
      });
    } catch (syncErr) {
      console.warn("[study-sync] flush", (syncErr as Error).message);
    }
    console.log(
      `[caderno-scheduler] publicada (silencioso) #${shortId} (caderno ${caderno.id}, pos ${question.position})`
    );
    return { shortId, dbId };
  } catch (e) {
    console.error(
      `[caderno-scheduler] erro publicando caderno ${caderno.id} pos ${question.position}:`,
      (e as Error).message
    );
    return null;
  }
}

async function publishPrivateCadernoQuestion(
  sock: WASocket,
  caderno: CadernoRow,
  recipient: CadernoPrivateRecipientRow,
  question: CadernoQuestionRow
): Promise<{ shortId: string; dbId: number } | null> {
  try {
    const { shortId, dbId } = await resolveCadernoQuestionForPublish(
      caderno,
      question,
      recipient.userJid
    );
    let engagedLine: string | null = null;
    const displayName = await getEngagedDisplayNameForUser(caderno.id, recipient.userJid);
    if (displayName) {
      engagedLine = `Engajado: ${displayName}`;
    } else {
      const at = recipient.userJid.indexOf("@");
      const fallback = at > 0 ? recipient.userJid.slice(0, at) : recipient.userJid;
      engagedLine = `Engajado: ${fallback}`;
    }
    await publishCadernoQuestionToChat(
      sock,
      recipient.userJid,
      shortId,
      caderno.name,
      question,
      "private",
      engagedLine
    );
    await recordPrivateSend(caderno.id, recipient.userJid, question.id, dbId);
    try {
      const tec = question.tecQuestionId != null ? Number(question.tecQuestionId) : null;
      const { notifyStudyAppPublished } = await import("./study-sync");
      await notifyStudyAppPublished({
        tecId: Number.isFinite(tec as number) ? (tec as number) : null,
        cadernoId: caderno.id,
        shortId,
        publishedQuestionId: dbId
      });
    } catch (syncErr) {
      console.warn("[study-sync] flush private", (syncErr as Error).message);
    }
    console.log(
      `[caderno-scheduler] privado #${shortId} -> ${recipient.userJid} (caderno ${caderno.id}, pos ${question.position})`
    );
    return { shortId, dbId };
  } catch (e) {
    console.error(
      `[caderno-scheduler] erro publicacao privada ${caderno.id} -> ${recipient.userJid}:`,
      (e as Error).message
    );
    return null;
  }
}

async function notifyOwnerEndOfCaderno(sock: WASocket, caderno: CadernoRow): Promise<void> {
  if (!caderno.createdByJid) return;
  const lines = [
    `Caderno "${caderno.name}" (#${caderno.id}) chegou ao fim das questões.`,
    "",
    "O envio automático está pausado. O que deseja fazer?",
    "",
    `Reciclar do início:  reciclar caderno ${caderno.id}`,
    `Encerrar de vez:     desativar caderno ${caderno.id}`
  ];
  try {
    await sock.sendMessage(caderno.createdByJid, { text: lines.join("\n") });
  } catch (e) {
    console.warn(
      `[caderno-scheduler] falha avisando dono do caderno ${caderno.id}:`,
      (e as Error).message
    );
  }
}

async function notifyRecipientPrivateExhausted(
  sock: WASocket,
  caderno: CadernoRow,
  recipientJid: string
): Promise<void> {
  const lines = [
    `Você terminou todas as questões do caderno privado "${caderno.name}" (#${caderno.id}).`,
    "",
    "Peça ao dono do caderno para reciclar se quiserem recomeçar."
  ];
  try {
    await sock.sendMessage(recipientJid, { text: lines.join("\n") });
  } catch (e) {
    console.warn(`[caderno-scheduler] falha avisando destinatario privado:`, (e as Error).message);
  }
}

async function isDayAnsweredByEngaged(
  caderno: CadernoRow,
  dayIso: string,
  excludeComparableKeys?: Set<string>
): Promise<boolean> {
  return isCadernoDayCompleteForEngaged(
    caderno.id,
    dayIso,
    caderno.timezone,
    excludeComparableKeys
  );
}

function botComparableFromSock(sock: WASocket): string | null {
  const ext = sock as WASocket & {
    user?: { id?: string };
    authState?: { creds?: { me?: { id?: string } } };
  };
  const rawId = ext.user?.id ?? ext.authState?.creds?.me?.id ?? "";
  return rawId ? jidComparableKey(String(rawId)) : null;
}

type DayDecision =
  | { kind: "send"; dayIso: string; sentBefore: number }
  | { kind: "wait_same_day"; nextRunIso: string }
  | { kind: "wait_for_answers"; previousDayIso: string };

function scheduleSlotsFromCaderno(caderno: CadernoRow): DailyScheduleSlots {
  return {
    sendTimes: caderno.sendTimes,
    startHour: caderno.startHour,
    startMinute: caderno.startMinute,
    endHour: caderno.endHour,
    endMinute: caderno.endMinute,
    questionsPerDay: Math.max(1, caderno.questionsPerDay)
  };
}

function decideAction(caderno: CadernoRow, now: Date): DayDecision {
  const tzNow = dateIsoInTimezone(now, caderno.timezone);
  const N = Math.max(1, caderno.questionsPerDay);
  const slots = scheduleSlotsFromCaderno(caderno);

  if (caderno.currentDayDate && caderno.currentDaySent < N) {
    const sent = caderno.currentDaySent;
    const slot = resolveDailySlotUtc(caderno.currentDayDate, sent, caderno.timezone, slots);
    if (slot.getTime() <= now.getTime()) {
      return { kind: "send", dayIso: caderno.currentDayDate, sentBefore: sent };
    }
    if (caderno.nextRunAt && new Date(caderno.nextRunAt).getTime() <= now.getTime()) {
      return { kind: "send", dayIso: caderno.currentDayDate, sentBefore: sent };
    }
    return { kind: "wait_same_day", nextRunIso: slot.toISOString() };
  }

  let nextDayIso: string;
  if (!caderno.currentDayDate) {
    nextDayIso = tzNow;
  } else {
    const previousDayDoneIso = addDaysIso(caderno.currentDayDate, 1);
    nextDayIso = previousDayDoneIso > tzNow ? previousDayDoneIso : tzNow;
  }

  if (caderno.waitForAnswers && caderno.currentDayDate) {
    return { kind: "wait_for_answers", previousDayIso: caderno.currentDayDate };
  }

  const firstSlot = resolveDailySlotUtc(nextDayIso, 0, caderno.timezone, slots);

  if (firstSlot.getTime() > now.getTime()) {
    return { kind: "wait_same_day", nextRunIso: firstSlot.toISOString() };
  }
  return { kind: "send", dayIso: nextDayIso, sentBefore: 0 };
}

function computeNextRunForDay(caderno: CadernoRow, dayIso: string, sentNow: number): Date {
  const slots = scheduleSlotsFromCaderno(caderno);
  const N = slots.questionsPerDay;
  if (sentNow < N) {
    // Lote: horários restantes do mesmo dia = startHour (já vencido se o lote começou).
    return resolveDailySlotUtc(dayIso, sentNow, caderno.timezone, slots);
  }
  const nextDay = addDaysIso(dayIso, 1);
  return resolveDailySlotUtc(nextDay, 0, caderno.timezone, slots);
}

/** Publica todas as questões restantes do dia em um único tick. */
async function sendDayBatchGroup(
  sock: WASocket,
  caderno: CadernoRow,
  dayIso: string,
  sentBefore: number
): Promise<string[]> {
  const N = Math.max(1, caderno.questionsPerDay);
  const shortIds: string[] = [];
  let current = caderno;
  let sent = Math.max(0, sentBefore);

  while (sent < N) {
    const result = await sendOneGroupAndAdvance(sock, current, dayIso, sent);
    if (!result) break;
    shortIds.push(result.shortId);
    const refreshed = await getCadernoById(current.id);
    if (!refreshed) break;
    current = refreshed;
    sent = refreshed.currentDaySent ?? sent + 1;
    if (refreshed.currentDayDate !== dayIso) break;
    if (refreshed.status === "paused_waiting_decision") break;
  }

  if (shortIds.length > 1) {
    console.log(
      `[caderno-scheduler] caderno ${caderno.id}: lote do dia ${dayIso} — ${shortIds.length} questão(ões) (${shortIds.map((id) => "#" + id).join(", ")})`
    );
  }
  return shortIds;
}

async function sendDayBatchPrivate(
  sock: WASocket,
  caderno: CadernoRow,
  recipient: CadernoPrivateRecipientRow,
  eff: ReturnType<typeof effectivePrivateRecipientSchedule>,
  dayIso: string,
  sentBefore: number
): Promise<void> {
  const N = Math.max(1, eff.questionsPerDay);
  let currentRecipient = recipient;
  let sent = Math.max(0, sentBefore);

  while (sent < N) {
    await sendOnePrivateAndAdvance(sock, caderno, currentRecipient, eff, dayIso, sent);
    const list = await listPrivateRecipientsByCaderno(caderno.id);
    const refreshed = list.find((r) => r.id === recipient.id) || null;
    if (!refreshed || !refreshed.active) break;
    currentRecipient = refreshed;
    sent = refreshed.currentDaySent ?? sent + 1;
    if (refreshed.currentDayDate !== dayIso) break;
  }
}

async function runCaderno(
  sock: WASocket,
  caderno: CadernoRow,
  opts?: { force?: boolean }
): Promise<void> {
  const now = new Date();
  const decision = decideAction(caderno, now);
  const tzToday = dateIsoInTimezone(now, caderno.timezone || ECONOMY_TZ);
  const beforeCutoff = isBeforeOmissasCutoff(
    now,
    ECONOMY_TZ,
    OMISSAS_SCHEDULE.cutoffHour,
    OMISSAS_SCHEDULE.cutoffMinute
  );

  if (decision.kind === "wait_same_day") {
    if (caderno.nextRunAt !== decision.nextRunIso) {
      await updateCadernoDayState(caderno.id, { nextRunAtIso: decision.nextRunIso });
    }
    return;
  }

  if (decision.kind === "wait_for_answers") {
    const exclude = new Set<string>();
    const botComp = botComparableFromSock(sock);
    if (botComp) exclude.add(botComp);
    const ok = await isDayAnsweredByEngaged(caderno, decision.previousDayIso, exclude);
    // Soft-unlock: se o dia civil já passou, avança mesmo com faltosos (penalidade roda antes no tick).
    const softUnlock = !ok && decision.previousDayIso < tzToday;
    if (!ok && !softUnlock) {
      const retryIso = new Date(Date.now() + WAIT_RETRY_MS).toISOString();
      await updateCadernoDayState(caderno.id, { nextRunAtIso: retryIso });
      console.log(
        `[caderno-scheduler] caderno ${caderno.id}: aguardando engajados responderem o dia ${decision.previousDayIso}. Retry em ~${Math.round(
          WAIT_RETRY_MS / 60000
        )}min.`
      );
      return;
    }
    if (softUnlock) {
      console.log(
        `[caderno-scheduler] caderno ${caderno.id}: soft-unlock do dia ${decision.previousDayIso} (faltosos não bloqueiam mais).`
      );
    }

    const earlyUnlock = ok && !softUnlock;
    let newDayIso = addDaysIso(decision.previousDayIso, 1);
    if (tzToday > newDayIso) newDayIso = tzToday;

    // Corte 15h: destravar antecipado (todos responderam) após o corte não
    // joga omissas no dia civil corrente — agenda amanhã.
    if (earlyUnlock && !beforeCutoff && newDayIso === tzToday) {
      newDayIso = addDaysIso(tzToday, 1);
      console.log(
        `[caderno-scheduler] caderno ${caderno.id}: destravar após corte ${OMISSAS_SCHEDULE.cutoffHour}h — dia ${newDayIso}.`
      );
    }

    const firstSlot = resolveDailySlotUtc(
      newDayIso,
      0,
      caderno.timezone,
      scheduleSlotsFromCaderno(caderno)
    );
    if (firstSlot.getTime() > now.getTime()) {
      await updateCadernoDayState(caderno.id, {
        currentDayDate: newDayIso,
        currentDaySent: 0,
        nextRunAtIso: firstSlot.toISOString()
      });
      return;
    }
    const shortIds = await sendDayBatchGroup(sock, caderno, newDayIso, 0);
    if (earlyUnlock && beforeCutoff && shortIds.length > 0 && caderno.targetGroupJid) {
      await notifyGroupOmissasEntered(sock, caderno.targetGroupJid, {
        shortIds,
        source: "caderno",
        cadernoName: caderno.name
      });
    }
    return;
  }

  // /caderno next forçando início de dia novo após o corte → fila de amanhã.
  if (
    opts?.force &&
    decision.kind === "send" &&
    decision.sentBefore === 0 &&
    !beforeCutoff &&
    decision.dayIso === tzToday
  ) {
    const tomorrow = addDaysIso(tzToday, 1);
    const firstSlot = resolveDailySlotUtc(
      tomorrow,
      0,
      caderno.timezone,
      scheduleSlotsFromCaderno(caderno)
    );
    await updateCadernoDayState(caderno.id, {
      currentDayDate: tomorrow,
      currentDaySent: 0,
      nextRunAtIso: firstSlot.toISOString()
    });
    console.log(
      `[caderno-scheduler] caderno ${caderno.id}: force após corte ${OMISSAS_SCHEDULE.cutoffHour}h — agendado ${tomorrow}.`
    );
    return;
  }

  const shortIds = await sendDayBatchGroup(sock, caderno, decision.dayIso, decision.sentBefore);
  if (
    opts?.force &&
    beforeCutoff &&
    decision.sentBefore === 0 &&
    shortIds.length > 0 &&
    caderno.targetGroupJid
  ) {
    await notifyGroupOmissasEntered(sock, caderno.targetGroupJid, {
      shortIds,
      source: "caderno",
      cadernoName: caderno.name
    });
  }
}

async function sendOneGroupAndAdvance(
  sock: WASocket,
  caderno: CadernoRow,
  dayIso: string,
  sentBefore: number
): Promise<{ shortId: string; dbId: number } | null> {
  let question: CadernoQuestionRow | null = null;
  let preResolved: { shortId: string; dbId: number } | null = null;
  let queueId: number | null = null;

  const queued = await getCadernoSendQueueItem(caderno.id, dayIso, sentBefore);
  if (queued) {
    queueId = queued.id;
    const cq = await getCadernoQuestionById(queued.cadernoQuestionId);
    if (cq) {
      question = cq;
      if (queued.publishedQuestionId != null) {
        const shortId = await getQuestionShortIdByDbId(queued.publishedQuestionId);
        if (shortId) {
          preResolved = { shortId, dbId: queued.publishedQuestionId };
        }
      }
    }
  }

  if (!question) {
    const pending = await listNextCadernoQuestionsToSend(caderno.id, 1, caderno.randomOrder);
    if (pending.length === 0) {
      const queuedLeft = await countUnreleasedQueueItems(caderno.id);
      if (queuedLeft > 0) {
        const retryIso = new Date(Date.now() + WAIT_RETRY_MS).toISOString();
        await updateCadernoDayState(caderno.id, { nextRunAtIso: retryIso });
        console.log(
          `[caderno-scheduler] caderno ${caderno.id}: sem pendentes livres, mas há ${queuedLeft} na fila — aguardando.`
        );
        return null;
      }
      await updateCadernoDayState(caderno.id, { nextRunAtIso: null, updateLastRun: true });
      await setCadernoStatus(caderno.id, "paused_waiting_decision", { nextRunAt: null });
      await notifyOwnerEndOfCaderno(sock, caderno);
      console.log(
        `[caderno-scheduler] caderno ${caderno.id} sem pendentes — aguardando decisao do dono.`
      );
      return null;
    }
    question = pending[0];
  }

  const result = await publishGroupCadernoQuestion(sock, caderno, question, preResolved);
  if (result && queueId != null) {
    await markCadernoSendQueueReleased(queueId, result.dbId);
  }
  const sentAfter = result ? sentBefore + 1 : sentBefore;

  const remaining = await countUnpublishedCadernoQuestions(caderno.id);
  const queuedLeft = await countUnreleasedQueueItems(caderno.id);
  if (remaining <= 0 && queuedLeft <= 0) {
    await updateCadernoDayState(caderno.id, {
      currentDayDate: dayIso,
      currentDaySent: sentAfter,
      cursor: (caderno.cursor || 0) + (result ? 1 : 0),
      nextRunAtIso: null,
      updateLastRun: true
    });
    await setCadernoStatus(caderno.id, "paused_waiting_decision", { nextRunAt: null });
    await notifyOwnerEndOfCaderno(sock, caderno);
    console.log(`[caderno-scheduler] caderno ${caderno.id} terminou após este envio.`);
    return result;
  }

  const nextRun = computeNextRunForDay(caderno, dayIso, sentAfter);
  const nextRunIso = nextRun.toISOString();
  await updateCadernoDayState(caderno.id, {
    currentDayDate: dayIso,
    currentDaySent: sentAfter,
    cursor: (caderno.cursor || 0) + (result ? 1 : 0),
    nextRunAtIso: nextRunIso,
    updateLastRun: true
  });
  console.log(
    `[caderno-scheduler] caderno ${caderno.id}: dia ${dayIso} ${sentAfter}/${caderno.questionsPerDay}, próximo envio ${formatNextRunPretty(nextRunIso, caderno.timezone)}`
  );
  return result;
}

async function runPrivateRecipient(
  sock: WASocket,
  caderno: CadernoRow,
  recipient: CadernoPrivateRecipientRow
): Promise<void> {
  const eff = effectivePrivateRecipientSchedule(caderno, recipient);
  const sched = syntheticCadernoForPrivateSchedule(caderno, eff, recipient);
  const now = new Date();
  const decision = decideAction(sched, now);

  if (decision.kind === "wait_same_day") {
    if (recipient.nextRunAt !== decision.nextRunIso) {
      await updatePrivateRecipientDayState(recipient.id, { nextRunAtIso: decision.nextRunIso });
    }
    return;
  }

  if (decision.kind === "wait_for_answers") {
    const ok = await isPrivateRecipientDayComplete(
      caderno.id,
      recipient.userJid,
      decision.previousDayIso,
      eff.timezone
    );
    const tzToday = dateIsoInTimezone(now, eff.timezone);
    const softUnlock = !ok && decision.previousDayIso < tzToday;
    if (!ok && !softUnlock) {
      const retryIso = new Date(Date.now() + WAIT_RETRY_MS).toISOString();
      await updatePrivateRecipientDayState(recipient.id, { nextRunAtIso: retryIso });
      console.log(
        `[caderno-scheduler] privado caderno ${caderno.id} user ${recipient.userJid}: aguardando respostas do dia ${decision.previousDayIso}.`
      );
      return;
    }
    if (softUnlock) {
      console.log(
        `[caderno-scheduler] privado caderno ${caderno.id} user ${recipient.userJid}: soft-unlock dia ${decision.previousDayIso}.`
      );
    }

    let newDayIso = addDaysIso(decision.previousDayIso, 1);
    if (tzToday > newDayIso) newDayIso = tzToday;
    const firstSlot = resolveDailySlotUtc(newDayIso, 0, eff.timezone, {
      sendTimes: eff.sendTimes,
      startHour: eff.startHour,
      startMinute: eff.startMinute,
      endHour: eff.endHour,
      endMinute: eff.endMinute,
      questionsPerDay: Math.max(1, eff.questionsPerDay)
    });
    if (firstSlot.getTime() > now.getTime()) {
      await updatePrivateRecipientDayState(recipient.id, {
        currentDayDate: newDayIso,
        currentDaySent: 0,
        nextRunAtIso: firstSlot.toISOString()
      });
      return;
    }
    await sendDayBatchPrivate(sock, caderno, recipient, eff, newDayIso, 0);
    return;
  }

  await sendDayBatchPrivate(sock, caderno, recipient, eff, decision.dayIso, decision.sentBefore);
}

async function sendOnePrivateAndAdvance(
  sock: WASocket,
  caderno: CadernoRow,
  recipient: CadernoPrivateRecipientRow,
  eff: ReturnType<typeof effectivePrivateRecipientSchedule>,
  dayIso: string,
  sentBefore: number
): Promise<void> {
  const pending = await listNextPrivateCadernoQuestionsToSend(
    caderno.id,
    recipient.userJid,
    1,
    eff.randomOrder
  );
  if (pending.length === 0) {
    await updatePrivateRecipientDayState(recipient.id, {
      nextRunAtIso: null,
      updateLastRun: true,
      active: false
    });
    await notifyRecipientPrivateExhausted(sock, caderno, recipient.userJid);
    const paused = await maybePausePrivateCadernoWhenExhausted(caderno.id);
    if (paused) await notifyOwnerEndOfCaderno(sock, caderno);
    console.log(
      `[caderno-scheduler] destinatario ${recipient.userJid} esgotou questoes do caderno ${caderno.id}.`
    );
    return;
  }

  const question = pending[0];
  const result = await publishPrivateCadernoQuestion(sock, caderno, recipient, question);
  const sentAfter = result ? sentBefore + 1 : sentBefore;

  const sched = syntheticCadernoForPrivateSchedule(caderno, eff, {
    ...recipient,
    currentDayDate: dayIso,
    currentDaySent: sentAfter
  });

  const remaining = await countUnsentPrivateQuestionsForRecipient(caderno.id, recipient.userJid);
  if (remaining <= 0) {
    await updatePrivateRecipientDayState(recipient.id, {
      currentDayDate: dayIso,
      currentDaySent: sentAfter,
      nextRunAtIso: null,
      updateLastRun: true,
      active: false
    });
    await notifyRecipientPrivateExhausted(sock, caderno, recipient.userJid);
    const paused = await maybePausePrivateCadernoWhenExhausted(caderno.id);
    if (paused) await notifyOwnerEndOfCaderno(sock, caderno);
    console.log(`[caderno-scheduler] caderno ${caderno.id} privado terminou após este envio.`);
    return;
  }

  const nextRun = computeNextRunForDay(sched, dayIso, sentAfter);
  const nextRunIso = nextRun.toISOString();
  await updatePrivateRecipientDayState(recipient.id, {
    currentDayDate: dayIso,
    currentDaySent: sentAfter,
    nextRunAtIso: nextRunIso,
    updateLastRun: true
  });
  console.log(
    `[caderno-scheduler] privado ${caderno.id} -> ${recipient.userJid}: dia ${dayIso} ${sentAfter}/${eff.questionsPerDay}, próximo ${formatNextRunPretty(nextRunIso, eff.timezone)}`
  );
}

async function tick(sock: WASocket): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Penalidades / avisos ANTES dos envios, para −50 rodar com o dia ainda “preso”
    // e só depois o soft-unlock avançar o caderno.
    try {
      const { runDailyEconomyMaintenance } = await import("./economy/daily");
      await runDailyEconomyMaintenance(sock);
    } catch (e) {
      console.warn("[caderno-scheduler] economy daily:", (e as Error).message);
    }

    const due = await listCadernosDueForRun();
    for (const caderno of due) {
      try {
        await runCaderno(sock, caderno);
      } catch (e) {
        console.error(
          `[caderno-scheduler] erro processando caderno ${caderno.id}:`,
          (e as Error).message
        );
      }
    }

    let duePrivate: { caderno: CadernoRow; recipient: CadernoPrivateRecipientRow }[] = [];
    try {
      duePrivate = await listPrivateRecipientsDueForRun();
    } catch (e) {
      const msg = (e as Error).message.toLowerCase();
      if (!msg.includes("relation") && !msg.includes("does not exist")) {
        console.error("[caderno-scheduler] listPrivateRecipientsDueForRun:", (e as Error).message);
      }
    }
    for (const { caderno, recipient } of duePrivate) {
      try {
        await runPrivateRecipient(sock, caderno, recipient);
      } catch (e) {
        console.error(
          `[caderno-scheduler] erro privado caderno ${caderno.id}:`,
          (e as Error).message
        );
      }
    }

    // Depois dos envios do tick, para o Diário Oficial já listar IDs liberados nesta manhã.
    await maybeSendGroupDailyDigest(sock);
    try {
      const { flushEconomyOutbox } = await import("./economy/bot-handlers");
      await flushEconomyOutbox(sock);
    } catch (e) {
      console.warn("[caderno-scheduler] economy outbox:", (e as Error).message);
    }
  } catch (e) {
    console.error("[caderno-scheduler] tick:", (e as Error).message);
  } finally {
    running = false;
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function quizGroupJidForDigest(): string | null {
  if (config.targetGroupJids.length === 0) return null;
  if (config.targetGroupJids.length >= 2) return config.targetGroupJids[1];
  return config.targetGroupJids[0];
}

function earliestDigestGateUtc(cadernos: CadernoRow[], dayIso: string, tz: string): Date {
  let earliest: Date | null = null;
  for (const c of cadernos) {
    const slots: DailyScheduleSlots = {
      sendTimes: c.sendTimes,
      startHour: c.startHour,
      startMinute: c.startMinute,
      endHour: c.endHour,
      endMinute: c.endMinute,
      questionsPerDay: Math.max(1, c.questionsPerDay)
    };
    const slot = resolveDailySlotUtc(dayIso, 0, c.timezone || tz, slots);
    if (!earliest || slot.getTime() < earliest.getTime()) earliest = slot;
  }
  if (earliest) return earliest;
  const fallbackSlots: DailyScheduleSlots = {
    sendTimes: [{ hour: DIGEST_FALLBACK_HOUR, minute: DIGEST_FALLBACK_MINUTE }],
    startHour: DIGEST_FALLBACK_HOUR,
    startMinute: DIGEST_FALLBACK_MINUTE,
    endHour: DIGEST_FALLBACK_HOUR,
    endMinute: DIGEST_FALLBACK_MINUTE,
    questionsPerDay: 1
  };
  return resolveDailySlotUtc(dayIso, 0, tz, fallbackSlots);
}

async function buildGroupDailyDigestText(
  groupJid: string,
  dayIso: string,
  cadernos: CadernoRow[]
): Promise<string> {
  const cadernoLines: string[] = [];

  let totalToday = 0;
  let totalPlanned = 0;

  for (const c of cadernos) {
    const progress = await getCadernoProgress(c.id);
    const publishedToday = await listCadernoQuestionsPublishedOnDate(
      c.id,
      dayIso,
      c.timezone || DEFAULT_TZ
    );
    const shortIds: string[] = [];
    for (const p of publishedToday) {
      const sid = await getQuestionShortIdByDbId(p.publishedQuestionId);
      if (sid) shortIds.push(`#${sid}`);
    }
    totalToday += publishedToday.length;
    totalPlanned += Math.max(1, c.questionsPerDay);

    const bits = [`Cadernos: #${c.id} ${c.name}`];
    if (shortIds.length > 0) bits.push(`${shortIds.length} questões hoje (${shortIds.join(", ")})`);
    else bits.push(`até ${c.questionsPerDay}/dia`);
    cadernoLines.push(bits.join(" · "));
    void progress;
  }

  cadernoLines.push("Enunciados: /omissas");
  cadernoLines.push(
    `Corte ${OMISSAS_SCHEDULE.cutoffHour}h: questão avulsa / destravar depois disso → omissas de amanhã.`
  );
  if (totalToday || totalPlanned) {
    cadernoLines.push(`Total liberado hoje: ${totalToday} (planejado ~${totalPlanned}).`);
  }

  try {
    const { buildDiarioOficialDigest } = await import("./economy/profile");
    return await buildDiarioOficialDigest({ dayIso, cadernoLines, groupJid });
  } catch (e) {
    console.warn("[caderno-scheduler] diario oficial economy:", (e as Error).message);
    return ["📰 Diário Oficial do Papa Vagas", dayIso, "", ...cadernoLines].join("\n");
  }
}

async function maybeSendGroupDailyDigest(sock: WASocket): Promise<void> {
  const groupJid = quizGroupJidForDigest();
  if (!groupJid) return;

  let cadernos: CadernoRow[] = [];
  try {
    cadernos = await listActiveGroupCadernos(groupJid);
  } catch (e) {
    console.warn("[caderno-scheduler] digest listActiveGroupCadernos:", (e as Error).message);
    return;
  }
  if (cadernos.length === 0) return;

  const tz = cadernos[0]?.timezone || DEFAULT_TZ;
  const now = new Date();
  const dayIso = dateIsoInTimezone(now, tz);

  try {
    if (await wasGroupDailyDigestSent(groupJid, dayIso)) return;
  } catch (e) {
    console.warn("[caderno-scheduler] digest check:", (e as Error).message);
    return;
  }

  const gate = earliestDigestGateUtc(cadernos, dayIso, tz);
  if (now.getTime() < gate.getTime()) return;

  const recorded = await recordGroupDailyDigest(groupJid, dayIso);
  if (!recorded) return;

  try {
    const text = await buildGroupDailyDigestText(groupJid, dayIso, cadernos);
    await sock.sendMessage(groupJid, { text });
    console.log(`[caderno-scheduler] digest diario enviado para ${groupJid} (${dayIso})`);
  } catch (e) {
    console.error("[caderno-scheduler] falha enviando digest:", (e as Error).message);
  }
}

export function startCadernoScheduler(sock: WASocket): void {
  if (timer) return;
  console.log(`[caderno-scheduler] iniciado (tick a cada ${TICK_INTERVAL_MS / 1000}s).`);
  void tick(sock);
  timer = setInterval(() => {
    void tick(sock);
  }, TICK_INTERVAL_MS);
}

export function stopCadernoScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Quando o último engajado responde, tenta avançar o caderno sem esperar o retry de 15 min.
 */
export async function tryAdvanceCadernoAfterAnswer(
  sock: WASocket,
  cadernoId: number,
  botComparable: string | null
): Promise<void> {
  const caderno = await getCadernoById(cadernoId);
  if (!caderno || caderno.status !== "active" || caderno.deliveryMode === "private") return;
  if (!caderno.waitForAnswers || !caderno.currentDayDate) return;

  const nPerDay = Math.max(1, caderno.questionsPerDay);
  if (caderno.currentDaySent < nPerDay) return;

  const exclude = new Set<string>();
  if (botComparable) exclude.add(botComparable);

  const ok = await isDayAnsweredByEngaged(caderno, caderno.currentDayDate, exclude);
  if (!ok) return;

  await updateCadernoDayState(caderno.id, { nextRunAtIso: new Date().toISOString() });
  const fresh = await getCadernoById(cadernoId);
  if (fresh) {
    console.log(
      `[caderno-scheduler] caderno ${cadernoId}: engajados responderam — avançando agenda imediatamente.`
    );
    await runCaderno(sock, fresh);
  }
}

export async function forceRunCaderno(sock: WASocket, caderno: CadernoRow): Promise<void> {
  if (caderno.deliveryMode === "private") {
    const recs = await listPrivateRecipientsByCaderno(caderno.id);
    const nowIso = new Date().toISOString();
    for (const r of recs) {
      if (!r.active) continue;
      await updatePrivateRecipientDayState(r.id, { nextRunAtIso: nowIso });
    }
    return;
  }
  await runCaderno(sock, caderno, { force: true });
}
