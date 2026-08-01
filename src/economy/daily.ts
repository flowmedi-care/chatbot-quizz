/**
 * Manutenção diária: misses de streak, penalidade de travamento.
 * Chamado pelo caderno-scheduler (tick).
 */
import { WASocket } from "@whiskeysockets/baileys";
import { dateIsoInTimezone, addDaysIso } from "../schedule";
import { config } from "../config";
import {
  listActiveGroupCadernos,
  listUnansweredShortIdsForUser,
  isCadernoDayCompleteForEngaged,
  listEngagedJidsMissingCadernoDayAnswers,
  getCadernoProgress,
  getEngagedUserJidsForCaderno
} from "../supabase";
import { ECONOMY_TZ } from "./constants";
import { evaluateMissesForUsers } from "./streak";
import { applyPenaltyLocking, onCadernoCompleted } from "./rewards";
import { economyDb, todayIso, getDayFlag, setDayFlag } from "./db";

function quizGroupJid(): string | null {
  if (config.targetGroupJids.length === 0) return null;
  if (config.targetGroupJids.length >= 2) return config.targetGroupJids[1];
  return config.targetGroupJids[0];
}

function yesterdayIso(tz = ECONOMY_TZ): string {
  const today = dateIsoInTimezone(new Date(), tz);
  return addDaysIso(today, -1);
}

export async function runDailyEconomyMaintenance(sock: WASocket): Promise<void> {
  const groupJid = quizGroupJid();
  if (!groupJid) return;

  const yIso = yesterdayIso();
  const dayKey = `miss_eval`;
  const already = await getDayFlag(groupJid, yIso, dayKey);
  if (!already) {
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
          const open = await listUnansweredShortIdsForUser(jid, groupJid, 80);
          row.hadDueYesterday = open.length > 0;
          row.completedYesterday = open.length === 0;
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
        try {
          await sock.sendMessage(a.groupJid, { text: a.text });
        } catch {
          /* ignore */
        }
      }
      for (const pm of result.privateMessages) {
        try {
          await sock.sendMessage(pm.jid, { text: pm.text });
        } catch {
          /* ignore */
        }
      }

      await setDayFlag({ groupJid, dayIso: yIso, flagKey: dayKey });
    } catch (e) {
      console.warn("[economy-daily] miss eval:", (e as Error).message);
    }
  }

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

      // Só quem faltou questões DESTE caderno/dia — não omissas globais
      // (ao virar o dia outros cadernos criam pendências novas em todo mundo).
      const missing = await listEngagedJidsMissingCadernoDayAnswers(
        c.id,
        c.currentDayDate,
        tz,
        new Set()
      );
      for (const jid of missing) {
        try {
          const { applied } = await applyPenaltyLocking(jid, c.id, c.currentDayDate);
          if (!applied) continue;
          await sock.sendMessage(jid, {
            text: `⚠️ Penalidade: −50 Aura por travar o caderno #${c.id} (${c.name}). Responda suas omissas.`
          });
        } catch (e) {
          console.warn("[economy-daily] lock penalty:", (e as Error).message);
        }
      }
    }
  } catch (e) {
    console.warn("[economy-daily] lock scan:", (e as Error).message);
  }
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
