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
  getEngagedUserJidsForCaderno,
  isCadernoDayCompleteForEngaged,
  getCadernoProgress
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
          row.hadDueYesterday = open.length > 0 || true;
          row.completedYesterday = open.length === 0;
          const { data: ans } = await economyDb()
            .from("economy_ledger")
            .select("id")
            .eq("user_jid", jid)
            .eq("day_iso", yIso)
            .in("reason", ["answer_correct", "answer_wrong"])
            .limit(1);
          row.answeredAnythingYesterday = (ans || []).length > 0;
          // Se tinha omissas ontem: se ainda tem open, não completou; se open=0, completou
          row.hadDueYesterday = true;
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

      const complete = await isCadernoDayCompleteForEngaged(
        c.id,
        c.currentDayDate,
        c.timezone || ECONOMY_TZ,
        new Set()
      );
      if (complete) continue;

      const engaged = await getEngagedUserJidsForCaderno(c.id);
      for (const jid of engaged) {
        const open = await listUnansweredShortIdsForUser(jid, groupJid, 30);
        if (open.length === 0) continue;
        try {
          await applyPenaltyLocking(jid, c.id, c.currentDayDate);
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
