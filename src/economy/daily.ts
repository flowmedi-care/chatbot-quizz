/**
 * Manutenção diária: misses de streak, avisos de omissas, penalidade de travamento.
 * Chamado pelo caderno-scheduler (tick) — preferencialmente ANTES dos envios,
 * para aplicar −50 antes do soft-unlock avançar o dia.
 */
import { WASocket } from "@whiskeysockets/baileys";
import { dateIsoInTimezone, addDaysIso, isAtOrAfterLocalTime } from "../schedule";
import { config } from "../config";
import {
  listActiveGroupCadernos,
  listUnansweredOmissasForUser,
  isCadernoDayCompleteForEngaged,
  listEngagedJidsMissingCadernoDayAnswers,
  getCadernoProgress,
  getEngagedUserJidsForCaderno
} from "../supabase";
import { ECONOMY_TZ, OMISSAS_SCHEDULE } from "./constants";
import { evaluateMissesForUsers } from "./streak";
import { applyPenaltyLocking, onCadernoCompleted } from "./rewards";
import { economyDb, todayIso, getDayFlag, setDayFlag, userHasDayOffOn } from "./db";
import {
  buildOmissasWarnMessage,
  listLockingCadernosForUser
} from "./omissas";

function quizGroupJid(): string | null {
  if (config.targetGroupJids.length === 0) return null;
  if (config.targetGroupJids.length >= 2) return config.targetGroupJids[1];
  return config.targetGroupJids[0];
}

function yesterdayIso(tz = ECONOMY_TZ): string {
  const today = dateIsoInTimezone(new Date(), tz);
  return addDaysIso(today, -1);
}

async function sendQuiet(sock: WASocket, jid: string, text: string): Promise<void> {
  try {
    await sock.sendMessage(jid, { text });
  } catch {
    /* ignore */
  }
}

/** Avalia streak do dia anterior com base nas omissas publicadas NAQUELE dia (não as de hoje). */
async function runMissEval(sock: WASocket, groupJid: string): Promise<void> {
  const yIso = yesterdayIso();
  const dayKey = `miss_eval`;
  const already = await getDayFlag(groupJid, yIso, dayKey);
  if (already) return;

  try {
    const cadernos = await listActiveGroupCadernos(groupJid);
    const userMap = new Map<
      string,
      {
        userJid: string;
        userName?: string | null;
        completedYesterday: boolean;
        hadDueYesterday: boolean;
        answeredAnythingYesterday: boolean;
      }
    >();

    for (const c of cadernos) {
      const engaged = await getEngagedUserJidsForCaderno(c.id);
      for (const jid of engaged) {
        if (!userMap.has(jid)) {
          userMap.set(jid, {
            userJid: jid,
            completedYesterday: true,
            hadDueYesterday: false,
            answeredAnythingYesterday: false
          });
        }
      }
    }

    for (const [jid, row] of userMap) {
      try {
        const buckets = await listUnansweredOmissasForUser(jid, groupJid, {
          dayIso: yIso,
          todayLimit: 80,
          atrasadasLimit: 0,
          includeAtrasadas: false
        });
        row.hadDueYesterday = buckets.dueOnDayCount > 0;
        row.completedYesterday = buckets.openOnDayCount === 0;
        const { data: ans } = await economyDb()
          .from("economy_ledger")
          .select("id")
          .eq("user_jid", jid)
          .eq("day_iso", yIso)
          .in("reason", ["answer_correct", "answer_wrong"])
          .limit(1);
        row.answeredAnythingYesterday = (ans || []).length > 0;
        const { data: eco } = await economyDb()
          .from("user_economy")
          .select("display_name")
          .eq("user_jid", jid)
          .maybeSingle();
        row.userName = eco?.display_name || null;
      } catch (e) {
        console.warn("[economy-daily] user", jid, (e as Error).message);
      }
    }

    const result = await evaluateMissesForUsers({
      users: [...userMap.values()],
      yesterdayIso: yIso,
      groupJid
    });

    for (const a of result.announces) {
      await sendQuiet(sock, a.groupJid, a.text);
    }
    for (const pm of result.privateMessages) {
      await sendQuiet(sock, pm.jid, pm.text);
    }

    await setDayFlag({ groupJid, dayIso: yIso, flagKey: dayKey });
  } catch (e) {
    console.warn("[economy-daily] miss eval:", (e as Error).message);
  }
}

/** Avisos 19h / 21h: omissas de hoje + se está travando. */
async function runOmissasWarnings(sock: WASocket, groupJid: string): Promise<void> {
  const now = new Date();
  const day = todayIso();
  const cadernos = await listActiveGroupCadernos(groupJid);
  const engagedSet = new Set<string>();
  for (const c of cadernos) {
    for (const jid of await getEngagedUserJidsForCaderno(c.id)) {
      engagedSet.add(jid);
    }
  }

  for (const warnHour of OMISSAS_SCHEDULE.warnHours) {
    if (!isAtOrAfterLocalTime(now, ECONOMY_TZ, warnHour, 0)) continue;

    for (const jid of engagedSet) {
      const flagKey = `omissas_warn_${warnHour}:${jid}`;
      try {
        const already = await getDayFlag(groupJid, day, flagKey);
        if (already) continue;

        const buckets = await listUnansweredOmissasForUser(jid, groupJid, {
          todayLimit: 40,
          atrasadasLimit: 0,
          includeAtrasadas: false
        });
        const locking = await listLockingCadernosForUser(jid, groupJid);
        if (buckets.today.length === 0 && locking.length === 0) {
          await setDayFlag({ groupJid, dayIso: day, flagKey });
          continue;
        }

        const claimed = await setDayFlag({
          groupJid,
          dayIso: day,
          flagKey,
          userJid: jid
        });
        if (!claimed) continue;

        await sendQuiet(
          sock,
          jid,
          buildOmissasWarnMessage({
            warnHour,
            todayIds: buckets.today,
            locking
          })
        );
      } catch (e) {
        console.warn("[economy-daily] warn", warnHour, jid, (e as Error).message);
      }
    }
  }
}

/**
 * Penalidade −50 por travar caderno: aplica quando o dia do caderno já passou
 * (currentDayDate < hoje) e ainda faltam respostas — antes do soft-unlock no scheduler.
 */
async function runLockPenalties(sock: WASocket, groupJid: string): Promise<void> {
  try {
    const cadernos = await listActiveGroupCadernos(groupJid);
    const today = todayIso();

    for (const c of cadernos) {
      if (!c.waitForAnswers || !c.currentDayDate) continue;
      if (c.currentDayDate >= today) continue;
      const nPerDay = Math.max(1, c.questionsPerDay);
      if (c.currentDaySent < nPerDay) continue;

      const tz = c.timezone || ECONOMY_TZ;
      const complete = await isCadernoDayCompleteForEngaged(c.id, c.currentDayDate, tz, new Set());
      if (complete) continue;

      const missing = await listEngagedJidsMissingCadernoDayAnswers(
        c.id,
        c.currentDayDate,
        tz,
        new Set()
      );
      for (const jid of missing) {
        try {
          if (await userHasDayOffOn(jid, c.currentDayDate)) continue;
          const { applied } = await applyPenaltyLocking(jid, c.id, c.currentDayDate);
          if (!applied) continue;
          await sendQuiet(
            sock,
            jid,
            `⚠️ Penalidade: −50 Aura por travar o caderno #${c.id} (${c.name}) no dia ${c.currentDayDate}. O caderno vai avançar (soft-unlock). Responda as atrasadas com /atrasadas quando puder.`
          );
        } catch (e) {
          console.warn("[economy-daily] lock penalty:", (e as Error).message);
        }
      }
    }
  } catch (e) {
    console.warn("[economy-daily] lock scan:", (e as Error).message);
  }
}

export async function runDailyEconomyMaintenance(sock: WASocket): Promise<void> {
  const groupJid = quizGroupJid();
  if (!groupJid) return;

  await runMissEval(sock, groupJid);
  await runOmissasWarnings(sock, groupJid);
  await runLockPenalties(sock, groupJid);
}

/** Após resposta: bônus one-shot se o caderno já está 100% publicado (ref única no ledger). */
export async function maybeRewardCadernoComplete(
  userJid: string,
  userName: string | null | undefined,
  groupJid: string | null | undefined
): Promise<void> {
  if (!groupJid) return;
  try {
    const cadernos = await listActiveGroupCadernos(groupJid);
    for (const c of cadernos) {
      const progress = await getCadernoProgress(c.id);
      if (!progress || progress.publishedCount < progress.totalQuestions || progress.totalQuestions === 0) {
        continue;
      }
      await onCadernoCompleted({
        userJid,
        userName,
        cadernoId: c.id,
        questionCount: progress.totalQuestions,
        groupJid
      });
    }
  } catch (e) {
    console.warn("[economy] caderno complete:", (e as Error).message);
  }
}
