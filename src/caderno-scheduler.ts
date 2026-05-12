import type { WASocket } from "@whiskeysockets/baileys";
import {
  CadernoQuestionRow,
  CadernoRow,
  countUnpublishedCadernoQuestions,
  createQuestionFromCaderno,
  getEngagedEligibleUserJidsAt,
  listAnswersForQuestionIds,
  listCadernoQuestionsPublishedOnDate,
  listNextCadernoQuestionsToSend,
  listCadernosDueForRun,
  markCadernoQuestionPublished,
  setCadernoStatus,
  updateCadernoDayState
} from "./supabase";
import {
  addDaysIso,
  dailySlotUtc,
  dateIsoInTimezone,
  formatNextRunPretty
} from "./schedule";

const TICK_INTERVAL_MS = 60 * 1000;
const WAIT_RETRY_MS = 15 * 60 * 1000;

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

async function publishCadernoQuestion(
  sock: WASocket,
  caderno: CadernoRow,
  question: CadernoQuestionRow
): Promise<{ shortId: string; dbId: number } | null> {
  try {
    const { shortId, dbId } = await createQuestionFromCaderno({ caderno, question });

    const intro = `Nova questão #${shortId} (Caderno: ${caderno.name})`;
    const options =
      question.questionType === "true_false"
        ? `Responda no privado do bot:\nc ${shortId}\ne ${shortId}`
        : `Responda no privado do bot:\na ${shortId}\nb ${shortId}\nc ${shortId}\nd ${shortId}\ne ${shortId}`;

    const fullText = [intro, "", question.statementText, "", options].join("\n");

    await sock.sendMessage(caderno.targetGroupJid, { text: fullText });
    await markCadernoQuestionPublished(question.id, dbId);

    console.log(
      `[caderno-scheduler] publicada questao #${shortId} (caderno ${caderno.id}, pos ${question.position})`
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

async function notifyOwnerEndOfCaderno(
  sock: WASocket,
  caderno: CadernoRow
): Promise<void> {
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

/**
 * Verifica se o dia `dayIso` foi "concluído" pelos engajados: todas as
 * questões publicadas nesse dia tiveram resposta de todos os engajados
 * elegíveis (cujo `engaged_since <= published_at`).
 *
 * Se não há engajados ou se não houve questões publicadas no dia,
 * retorna `true` (não trava).
 */
async function isDayAnsweredByEngaged(
  caderno: CadernoRow,
  dayIso: string
): Promise<boolean> {
  const publishedToday = await listCadernoQuestionsPublishedOnDate(
    caderno.id,
    dayIso,
    caderno.timezone
  );
  if (publishedToday.length === 0) return true;

  const questionIds = publishedToday.map((p) => p.publishedQuestionId);
  const answersByQ = await listAnswersForQuestionIds(questionIds);

  for (const pub of publishedToday) {
    const eligible = await getEngagedEligibleUserJidsAt(
      caderno.targetGroupJid,
      pub.publishedAt
    );
    if (eligible.length === 0) continue;
    const eligibleSet = new Set(eligible.map((j) => jidComparableKey(j)));
    const answeredSet = answersByQ.get(pub.publishedQuestionId) ?? new Set<string>();
    for (const jc of eligibleSet) {
      if (!answeredSet.has(jc)) {
        return false;
      }
    }
  }
  return true;
}

type DayDecision =
  | { kind: "send"; dayIso: string; sentBefore: number }
  | { kind: "wait_same_day"; nextRunIso: string }
  | { kind: "wait_for_answers"; previousDayIso: string };

function decideAction(caderno: CadernoRow, now: Date): DayDecision {
  const tzNow = dateIsoInTimezone(now, caderno.timezone);
  const N = Math.max(1, caderno.questionsPerDay);

  if (caderno.currentDayDate && caderno.currentDaySent < N) {
    const sent = caderno.currentDaySent;
    const slot = dailySlotUtc(
      caderno.currentDayDate,
      caderno.startHour,
      caderno.startMinute,
      N,
      sent,
      caderno.timezone
    );
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

  const firstSlot = dailySlotUtc(
    nextDayIso,
    caderno.startHour,
    caderno.startMinute,
    N,
    0,
    caderno.timezone
  );

  if (firstSlot.getTime() > now.getTime()) {
    return { kind: "wait_same_day", nextRunIso: firstSlot.toISOString() };
  }
  return { kind: "send", dayIso: nextDayIso, sentBefore: 0 };
}

function computeNextRunForDay(caderno: CadernoRow, dayIso: string, sentNow: number): Date {
  const N = Math.max(1, caderno.questionsPerDay);
  if (sentNow < N) {
    return dailySlotUtc(
      dayIso,
      caderno.startHour,
      caderno.startMinute,
      N,
      sentNow,
      caderno.timezone
    );
  }
  const nextDay = addDaysIso(dayIso, 1);
  return dailySlotUtc(
    nextDay,
    caderno.startHour,
    caderno.startMinute,
    N,
    0,
    caderno.timezone
  );
}

async function runCaderno(sock: WASocket, caderno: CadernoRow): Promise<void> {
  const now = new Date();
  const decision = decideAction(caderno, now);

  if (decision.kind === "wait_same_day") {
    if (caderno.nextRunAt !== decision.nextRunIso) {
      await updateCadernoDayState(caderno.id, { nextRunAtIso: decision.nextRunIso });
    }
    return;
  }

  if (decision.kind === "wait_for_answers") {
    const ok = await isDayAnsweredByEngaged(caderno, decision.previousDayIso);
    if (!ok) {
      const retryIso = new Date(Date.now() + WAIT_RETRY_MS).toISOString();
      await updateCadernoDayState(caderno.id, { nextRunAtIso: retryIso });
      console.log(
        `[caderno-scheduler] caderno ${caderno.id}: aguardando engajados responderem o dia ${decision.previousDayIso}. Retry em ~${Math.round(
          WAIT_RETRY_MS / 60000
        )}min.`
      );
      return;
    }

    let newDayIso = addDaysIso(decision.previousDayIso, 1);
    const tzToday = dateIsoInTimezone(now, caderno.timezone);
    if (tzToday > newDayIso) newDayIso = tzToday;
    const firstSlot = dailySlotUtc(
      newDayIso,
      caderno.startHour,
      caderno.startMinute,
      Math.max(1, caderno.questionsPerDay),
      0,
      caderno.timezone
    );
    if (firstSlot.getTime() > now.getTime()) {
      await updateCadernoDayState(caderno.id, {
        currentDayDate: newDayIso,
        currentDaySent: 0,
        nextRunAtIso: firstSlot.toISOString()
      });
      return;
    }
    await sendOneAndAdvance(sock, caderno, newDayIso, 0);
    return;
  }

  await sendOneAndAdvance(sock, caderno, decision.dayIso, decision.sentBefore);
}

async function sendOneAndAdvance(
  sock: WASocket,
  caderno: CadernoRow,
  dayIso: string,
  sentBefore: number
): Promise<void> {
  const pending = await listNextCadernoQuestionsToSend(caderno.id, 1, caderno.randomOrder);
  if (pending.length === 0) {
    await updateCadernoDayState(caderno.id, { nextRunAtIso: null, updateLastRun: true });
    await setCadernoStatus(caderno.id, "paused_waiting_decision", { nextRunAt: null });
    await notifyOwnerEndOfCaderno(sock, caderno);
    console.log(
      `[caderno-scheduler] caderno ${caderno.id} sem pendentes — aguardando decisao do dono.`
    );
    return;
  }

  const question = pending[0];
  const result = await publishCadernoQuestion(sock, caderno, question);
  const sentAfter = result ? sentBefore + 1 : sentBefore;

  const remaining = await countUnpublishedCadernoQuestions(caderno.id);
  if (remaining <= 0) {
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
    return;
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
}

async function tick(sock: WASocket): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = await listCadernosDueForRun();
    if (due.length === 0) return;
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
  } catch (e) {
    console.error("[caderno-scheduler] tick:", (e as Error).message);
  } finally {
    running = false;
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
 * Força disparo imediato (botão "Enviar questão" ou comando `/caderno next`):
 * apenas chama `runCaderno`, que pode mandar ou apenas reagendar dependendo
 * do estado do dia.
 */
export async function forceRunCaderno(sock: WASocket, caderno: CadernoRow): Promise<void> {
  await runCaderno(sock, caderno);
}
