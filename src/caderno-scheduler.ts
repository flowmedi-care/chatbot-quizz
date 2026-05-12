import type { WASocket } from "@whiskeysockets/baileys";
import {
  CadernoQuestionRow,
  CadernoRow,
  countCadernoQuestions,
  createQuestionFromCaderno,
  listCadernoQuestionsAfterCursor,
  listCadernosDueForRun,
  markCadernoQuestionPublished,
  setCadernoStatus,
  updateCadernoAfterRun
} from "./supabase";
import { computeNextRunAt, formatNextRunPretty } from "./schedule";

const TICK_INTERVAL_MS = 60 * 1000;
const DELAY_BETWEEN_QUESTIONS_MS = 3500;

let timer: NodeJS.Timeout | null = null;
let running = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runCaderno(sock: WASocket, caderno: CadernoRow): Promise<void> {
  const batchSize = Math.max(1, caderno.questionsPerRun);
  const pending = await listCadernoQuestionsAfterCursor(caderno.id, caderno.cursor, batchSize);

  if (pending.length === 0) {
    const total = await countCadernoQuestions(caderno.id);
    if (total > 0 && caderno.cursor >= total) {
      await setCadernoStatus(caderno.id, "paused_waiting_decision", { nextRunAt: null });
      await notifyOwnerEndOfCaderno(sock, caderno);
      console.log(
        `[caderno-scheduler] caderno ${caderno.id} chegou ao fim, aguardando decisao do dono.`
      );
    } else {
      console.warn(
        `[caderno-scheduler] caderno ${caderno.id} sem questoes para enviar mas cursor (${caderno.cursor}) < total (${total}).`
      );
      const nextIso = computeNextRunAt(
        new Date(),
        caderno.sendHour,
        caderno.sendMinute,
        caderno.timezone,
        caderno.intervalDays
      ).toISOString();
      await updateCadernoAfterRun(caderno.id, caderno.cursor, nextIso);
    }
    return;
  }

  let published = 0;
  for (const question of pending) {
    const result = await publishCadernoQuestion(sock, caderno, question);
    if (result) {
      published += 1;
      if (published < pending.length) {
        await delay(DELAY_BETWEEN_QUESTIONS_MS);
      }
    }
  }

  const newCursor = pending[pending.length - 1].position;
  const totalAfter = await countCadernoQuestions(caderno.id);
  const reachedEnd = newCursor >= totalAfter;

  if (reachedEnd) {
    await updateCadernoAfterRun(caderno.id, newCursor, null);
    await setCadernoStatus(caderno.id, "paused_waiting_decision", { nextRunAt: null });
    await notifyOwnerEndOfCaderno(sock, { ...caderno, cursor: newCursor });
    console.log(`[caderno-scheduler] caderno ${caderno.id} terminou após este envio.`);
    return;
  }

  const nextIso = computeNextRunAt(
    new Date(),
    caderno.sendHour,
    caderno.sendMinute,
    caderno.timezone,
    caderno.intervalDays
  ).toISOString();
  await updateCadernoAfterRun(caderno.id, newCursor, nextIso);
  console.log(
    `[caderno-scheduler] caderno ${caderno.id}: cursor=${newCursor}, próximo envio em ${formatNextRunPretty(nextIso, caderno.timezone)}`
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
 * Força um envio imediato para um caderno específico, ignorando next_run_at.
 * Usado pelo comando `/caderno next <id>` no privado.
 */
export async function forceRunCaderno(sock: WASocket, caderno: CadernoRow): Promise<void> {
  await runCaderno(sock, caderno);
}
