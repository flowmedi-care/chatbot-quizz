import { REWARDS, PENALTIES } from "./constants";
import {
  applyLedger,
  ensureStreak,
  economyDb,
  insertDiarioEvent,
  todayIso,
  tryGroupAnnounceOnce,
  type UserStreakRow
} from "./db";
import type { GroupAnnounce } from "./rewards";

const MILESTONES = [3, 7, 15, 30];

export type StreakEvalResult = {
  announces: GroupAnnounce[];
  privateMessages: { jid: string; text: string }[];
};

function prevDay(dayIso: string): string {
  const [y, m, d] = dayIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export async function markStreakDayComplete(input: {
  userJid: string;
  userName?: string | null;
  dayIso: string;
  groupJid?: string | null;
}): Promise<StreakEvalResult> {
  const out: StreakEvalResult = { announces: [], privateMessages: [] };
  const streak = await ensureStreak(input.userJid);
  if (streak.last_completed_day === input.dayIso) return out;

  const expectedPrev = prevDay(input.dayIso);
  let nextCurrent = 1;
  if (streak.last_completed_day === expectedPrev || streak.prepaid_days?.includes(input.dayIso)) {
    nextCurrent = (streak.current_streak || 0) + 1;
  } else if (streak.last_completed_day && streak.last_completed_day > expectedPrev) {
    // already ahead
    nextCurrent = Math.max(1, streak.current_streak || 1);
  }

  const bestBefore = streak.best_streak || 0;
  const best = Math.max(bestBefore, nextCurrent);
  const milestones = new Set((streak.milestones_claimed || []).map(Number));
  const prepaid = (streak.prepaid_days || []).filter((d) => d !== input.dayIso);

  await economyDb()
    .from("user_streak")
    .update({
      current_streak: nextCurrent,
      best_streak: best,
      last_completed_day: input.dayIso,
      miss_streak: 0,
      abandon_penalty_applied: false,
      prepaid_days: prepaid,
      updated_at: new Date().toISOString()
    })
    .eq("user_jid", input.userJid);

  await applyLedger({
    userJid: input.userJid,
    deltaAura: REWARDS.dailyStreakMaintain.aura,
    deltaCredits: REWARDS.dailyStreakMaintain.credits,
    reason: "streak_daily",
    refType: "streak_day",
    refId: input.dayIso,
    displayName: input.userName || undefined,
    meta: { actorLabel: input.userName, days: nextCurrent }
  });

  for (const m of MILESTONES) {
    if (nextCurrent < m || milestones.has(m)) continue;
    const bonus = REWARDS.streakMilestone[m];
    if (!bonus) continue;
    milestones.add(m);
    await applyLedger({
      userJid: input.userJid,
      deltaAura: bonus.aura,
      deltaCredits: bonus.credits,
      reason: "streak_milestone",
      refType: "streak_milestone",
      refId: String(m),
      meta: { days: m, actorLabel: input.userName }
    });
  }

  if (nextCurrent > 30) {
    await applyLedger({
      userJid: input.userJid,
      deltaAura: REWARDS.streakBeyond30DailyAura,
      reason: "streak_beyond_30",
      refType: "streak_day_bonus",
      refId: input.dayIso,
      meta: { days: nextCurrent, actorLabel: input.userName }
    });
  }

  await economyDb()
    .from("user_streak")
    .update({ milestones_claimed: [...milestones], updated_at: new Date().toISOString() })
    .eq("user_jid", input.userJid);

  const isMilestone = MILESTONES.includes(nextCurrent) || (nextCurrent > 30 && nextCurrent > bestBefore);
  if (isMilestone && nextCurrent >= bestBefore && input.groupJid) {
    const ok = await tryGroupAnnounceOnce({
      groupJid: input.groupJid,
      dayIso: input.dayIso,
      announceKey: `streak_record_${nextCurrent}`,
      actorJid: input.userJid
    });
    if (ok && nextCurrent >= best) {
      out.announces.push({
        groupJid: input.groupJid,
        text: [
          "🔥 Recorde pessoal",
          "",
          `${input.userName || "Alguém"} atingiu sua maior sequência:`,
          `*${nextCurrent} dias* consecutivos cumprindo as omissas.`
        ].join("\n")
      });
      await insertDiarioEvent({
        groupJid: input.groupJid,
        eventType: "streak_record",
        actorJid: input.userJid,
        actorLabel: input.userName,
        payload: { days: nextCurrent }
      });
    }
  }

  return out;
}

export async function addPrepaidStreakDays(userJid: string, days: string[]): Promise<void> {
  const streak = await ensureStreak(userJid);
  const set = new Set([...(streak.prepaid_days || []), ...days]);
  await economyDb()
    .from("user_streak")
    .update({ prepaid_days: [...set], updated_at: new Date().toISOString() })
    .eq("user_jid", userJid);
}

/** Avalia misses do dia anterior para engajados. */
export async function evaluateMissesForUsers(input: {
  users: { userJid: string; userName?: string | null; completedYesterday: boolean; hadDueYesterday: boolean; answeredAnythingYesterday: boolean }[];
  yesterdayIso: string;
  groupJid?: string | null;
}): Promise<StreakEvalResult> {
  const out: StreakEvalResult = { announces: [], privateMessages: [] };
  for (const u of input.users) {
    if (u.completedYesterday) continue;
    const streak = await ensureStreak(u.userJid);

    if (streak.prepaid_days?.includes(input.yesterdayIso)) {
      await markStreakDayComplete({
        userJid: u.userJid,
        userName: u.userName,
        dayIso: input.yesterdayIso,
        groupJid: input.groupJid
      });
      continue;
    }

    if (!u.hadDueYesterday) continue;

    // Quebra / miss
    let insurance = streak.streak_insurance_charges || 0;
    if (insurance > 0) {
      insurance -= 1;
      await economyDb()
        .from("user_streak")
        .update({
          streak_insurance_charges: insurance,
          miss_streak: 0,
          updated_at: new Date().toISOString()
        })
        .eq("user_jid", u.userJid);
      await applyLedger({
        userJid: u.userJid,
        reason: "streak_insurance",
        refType: "streak_day",
        refId: `ins:${input.yesterdayIso}`,
        meta: { actorLabel: u.userName }
      });
      out.privateMessages.push({
        jid: u.userJid,
        text: "🛡️ Seguro de Streak usado — sua sequência foi preservada."
      });
      continue;
    }

    const miss = (streak.miss_streak || 0) + 1;
    await economyDb()
      .from("user_streak")
      .update({
        current_streak: 0,
        miss_streak: miss,
        updated_at: new Date().toISOString()
      })
      .eq("user_jid", u.userJid);

    // Aplicação orçamentária loss
    try {
      const { loseActiveAplicacao } = await import("./aplicacao");
      await loseActiveAplicacao(u.userJid);
    } catch (e) {
      console.warn("[economy] aplicacao lose:", (e as Error).message);
    }

    if (miss >= 3 && !streak.abandon_penalty_applied) {
      await applyLedger({
        userJid: u.userJid,
        deltaAura: PENALTIES.abandonStreak.aura,
        reason: "penalty_abandon",
        refType: "abandon",
        refId: input.yesterdayIso,
        meta: { actorLabel: u.userName }
      });
      await economyDb()
        .from("user_streak")
        .update({ abandon_penalty_applied: true, updated_at: new Date().toISOString() })
        .eq("user_jid", u.userJid);
    } else if (u.hadDueYesterday && !u.answeredAnythingYesterday) {
      await applyLedger({
        userJid: u.userJid,
        deltaAura: PENALTIES.zeroAnswersDay.aura,
        reason: "penalty_zero_day",
        refType: "zero_day",
        refId: input.yesterdayIso,
        meta: { actorLabel: u.userName }
      });
    }
  }
  return out;
}

export async function getStreakPublic(userJid: string): Promise<UserStreakRow> {
  return ensureStreak(userJid);
}
