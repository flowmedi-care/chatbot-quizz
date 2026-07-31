import { ACHIEVEMENTS, REWARDS, cadernoCompleteReward, PENALTIES } from "./constants";
import { getAuraLevel } from "./aura-levels";
import {
  applyLedger,
  ensureEconomy,
  ensureStreak,
  economyDb,
  insertDiarioEvent,
  setDayFlag,
  getDayFlag,
  todayIso,
  tryGroupAnnounceOnce,
  type UserEconomyRow
} from "./db";

export type GroupAnnounce = { text: string; groupJid: string };

export type RewardSideEffects = {
  announces: GroupAnnounce[];
  privateMessages: { jid: string; text: string }[];
  economy: UserEconomyRow;
};

function emptyEffects(economy: UserEconomyRow): RewardSideEffects {
  return { announces: [], privateMessages: [], economy };
}

async function checkAchievements(
  userJid: string,
  displayName: string | null | undefined,
  groupJid: string | null | undefined,
  effects: RewardSideEffects
): Promise<void> {
  const eco = await ensureEconomy(userJid);
  const db = economyDb();
  const { data: owned } = await db.from("user_achievements").select("achievement_key").eq("user_jid", userJid);
  const have = new Set((owned || []).map((r) => r.achievement_key));
  let topTitle = eco.active_title;

  for (const a of ACHIEVEMENTS) {
    if (eco.lifetime_answers < a.minAnswers) continue;
    if (have.has(a.key)) {
      topTitle = a.title;
      continue;
    }
    await db.from("user_achievements").insert({ user_jid: userJid, achievement_key: a.key });
    const r = await applyLedger({
      userJid,
      deltaAura: a.aura,
      deltaCredits: a.credits,
      reason: "achievement",
      refType: "achievement",
      refId: a.key,
      displayName: displayName || undefined,
      activeTitle: a.title,
      meta: { title: a.title, actorLabel: displayName || userJid }
    });
    effects.economy = r.economy;
    topTitle = a.title;
    await insertDiarioEvent({
      groupJid,
      eventType: "achievement",
      actorJid: userJid,
      actorLabel: displayName,
      payload: { title: a.title }
    });
    if (groupJid) {
      effects.announces.push({
        groupJid,
        text: [
          "🏆 Conquista desbloqueada",
          "",
          `${displayName || "Alguém"} é agora *${a.title}*`,
          `+${a.aura} Aura · +${a.credits} Créditos`
        ].join("\n")
      });
    }
  }

  if (topTitle && topTitle !== eco.active_title) {
    await economyDb()
      .from("user_economy")
      .update({ active_title: topTitle, updated_at: new Date().toISOString() })
      .eq("user_jid", userJid);
  }
}

async function maybeAnnounceBoardLead(
  userJid: string,
  displayName: string | null | undefined,
  groupJid: string | null | undefined,
  effects: RewardSideEffects,
  board: "aura" | "producao" | "disciplina" | "duelo",
  value: number,
  label: string
): Promise<void> {
  if (!groupJid) return;
  const db = economyDb();
  let isTop = false;
  if (board === "disciplina") {
    const { data: top } = await db
      .from("user_streak")
      .select("user_jid, current_streak")
      .order("current_streak", { ascending: false })
      .limit(1)
      .maybeSingle();
    isTop = !!top && top.user_jid === userJid;
  } else {
    const col = board === "aura" ? "aura" : board === "producao" ? "lifetime_answers" : "mandados_won";
    const { data: top } = await db
      .from("user_economy")
      .select(`user_jid, ${col}`)
      .order(col, { ascending: false })
      .limit(1)
      .maybeSingle();
    isTop = !!top && top.user_jid === userJid;
  }
  if (!isTop) return;
  const ok = await tryGroupAnnounceOnce({
    groupJid,
    dayIso: todayIso(),
    announceKey: `${board}_lead`,
    actorJid: userJid
  });
  if (!ok) return;
  effects.announces.push({
    groupJid,
    text: [
      label,
      "",
      `${displayName || "Alguém"} assumiu o 1º lugar com *${Number(value).toLocaleString("pt-BR")}*.`
    ].join("\n")
  });
}

async function maybeAnnounceAuraLead(
  userJid: string,
  displayName: string | null | undefined,
  groupJid: string | null | undefined,
  effects: RewardSideEffects
): Promise<void> {
  const eco = await ensureEconomy(userJid);
  await maybeAnnounceBoardLead(
    userJid,
    displayName,
    groupJid,
    effects,
    "aura",
    eco.aura,
    "🏛️ Topo da Aura"
  );
  await maybeAnnounceBoardLead(
    userJid,
    displayName,
    groupJid,
    effects,
    "producao",
    eco.lifetime_answers,
    "📚 Topo da Produção"
  );
}

async function maybeAnnounceAuraLevelUp(
  userJid: string,
  beforeAura: number,
  afterAura: number,
  displayName: string | null | undefined,
  groupJid: string | null | undefined,
  effects: RewardSideEffects
): Promise<void> {
  const before = getAuraLevel(beforeAura);
  const after = getAuraLevel(afterAura);
  if (before.level.key === after.level.key) return;
  effects.privateMessages.push({
    jid: userJid,
    text: `🌌 Novo nível de Aura!\n${after.label}`
  });
  await insertDiarioEvent({
    groupJid,
    eventType: "aura_level",
    actorJid: userJid,
    actorLabel: displayName,
    payload: { level: after.level.title, aura: afterAura }
  });
}

export async function onAnswerSaved(input: {
  userJid: string;
  userName?: string | null;
  questionShortId: string;
  questionId: number | string;
  answerLetter: string;
  answerKey: string | null | undefined;
  groupJid?: string | null;
  wasUpdate?: boolean;
  previousLetter?: string | null;
}): Promise<RewardSideEffects> {
  const correct =
    input.answerKey != null &&
    String(input.answerKey).trim().toLowerCase() === String(input.answerLetter).trim().toLowerCase();
  const reward = correct ? REWARDS.answerCorrect : REWARDS.answerWrong;
  const reason = correct ? "answer_correct" : "answer_wrong";
  const refId = `${input.questionId}`;

  const before = await ensureEconomy(input.userJid, input.userName);
  const effects = emptyEffects(before);

  if (input.wasUpdate) {
    // Estorna reward anterior desta questão (se houver) via razão de reversal + novo apply
    const prevCorrect =
      input.previousLetter != null &&
      input.answerKey != null &&
      String(input.answerKey).trim().toLowerCase() === String(input.previousLetter).trim().toLowerCase();
    const prevReward = prevCorrect ? REWARDS.answerCorrect : REWARDS.answerWrong;
    await applyLedger({
      userJid: input.userJid,
      deltaAura: -prevReward.aura,
      deltaCredits: -prevReward.credits,
      reason: prevCorrect ? "answer_correct_reversal" : "answer_wrong_reversal",
      refType: "answer",
      refId: `${refId}:rev:${Date.now()}`,
      allowNegativeCredits: true,
      displayName: input.userName || undefined,
      meta: { questionShortId: input.questionShortId, actorLabel: input.userName }
    });
    // Remove unique constraint conflict by deleting old reward row then re-inserting
    await economyDb()
      .from("economy_ledger")
      .delete()
      .eq("user_jid", input.userJid)
      .eq("reason", "answer_correct")
      .eq("ref_id", refId);
    await economyDb()
      .from("economy_ledger")
      .delete()
      .eq("user_jid", input.userJid)
      .eq("reason", "answer_wrong")
      .eq("ref_id", refId);
  }

  const r = await applyLedger({
    userJid: input.userJid,
    deltaAura: reward.aura,
    deltaCredits: reward.credits,
    reason,
    refType: "answer",
    refId,
    bumpLifetimeAnswers: input.wasUpdate ? 0 : 1,
    displayName: input.userName || undefined,
    meta: { questionShortId: input.questionShortId, actorLabel: input.userName, correct }
  });
  effects.economy = r.economy;

  await maybeAnnounceAuraLevelUp(input.userJid, before.aura, r.economy.aura, input.userName, input.groupJid, effects);
  await checkAchievements(input.userJid, input.userName, input.groupJid, effects);
  await maybeAnnounceAuraLead(input.userJid, input.userName, input.groupJid, effects);

  if (input.groupJid) {
    await maybeFirstOmissasClear(input.userJid, input.userName, input.groupJid, effects);
  }

  return effects;
}

async function maybeFirstOmissasClear(
  userJid: string,
  userName: string | null | undefined,
  groupJid: string,
  effects: RewardSideEffects
): Promise<void> {
  // First to zero open omissas opens a 1h window; anyone who clears within it also gets the bonus.
  try {
    const { listUnansweredShortIdsForUser } = await import("../supabase");
    const open = await listUnansweredShortIdsForUser(userJid, groupJid, 50);
    if (open.length > 0) return;

    const day = todayIso();
    const aura = REWARDS.firstOmissasClear.aura;
    const credits = REWARDS.firstOmissasClear.credits;
    const refId = `${groupJid}:${day}:${userJid}`;
    const WINDOW_MS = 60 * 60 * 1000;
    const now = Date.now();

    let flag = await getDayFlag(groupJid, day, "first_omissas");
    let isOpener = false;

    if (!flag) {
      const startedAt = new Date(now).toISOString();
      const claimed = await setDayFlag({
        groupJid,
        dayIso: day,
        flagKey: "first_omissas",
        userJid,
        meta: { label: userName, startedAt }
      });
      if (claimed) {
        isOpener = true;
        flag = { user_jid: userJid, meta: { label: userName, startedAt } };
      } else {
        flag = await getDayFlag(groupJid, day, "first_omissas");
      }
    }

    if (!flag) return;

    if (!isOpener) {
      const meta = (flag.meta || {}) as { startedAt?: string };
      const startedMs = meta.startedAt ? Date.parse(meta.startedAt) : NaN;
      if (!Number.isFinite(startedMs) || now - startedMs > WINDOW_MS) return;
    }

    const r = await applyLedger({
      userJid,
      deltaAura: aura,
      deltaCredits: credits,
      reason: "first_omissas",
      refType: "day",
      refId,
      displayName: userName || undefined,
      meta: { actorLabel: userName, windowOpener: isOpener }
    });
    if (!r.applied) return;
    effects.economy = r.economy;

    if (isOpener) {
      effects.announces.push({
        groupJid,
        text: [
          "⚡ Omissas",
          "",
          `${userName || "Alguém"} completou suas omissas · *+${aura} Aura* e *+${credits} Créditos*!`,
          `Complete em até *1h* para ganhar o bônus também!!`
        ].join("\n")
      });
    } else {
      effects.announces.push({
        groupJid,
        text: [
          "⚡ Omissas",
          "",
          `${userName || "Alguém"} completou as omissas na janela de 1h · *+${aura} Aura* e *+${credits} Créditos*!`
        ].join("\n")
      });
    }

    await insertDiarioEvent({
      groupJid,
      eventType: "first_omissas",
      actorJid: userJid,
      actorLabel: userName,
      payload: { windowOpener: isOpener }
    });
  } catch (e) {
    console.warn("[economy] first omissas:", (e as Error).message);
  }
}

export async function onQuestionCreated(input: {
  userJid: string;
  userName?: string | null;
  questionId: number | string;
  creatorIsBot?: boolean;
  groupJid?: string | null;
}): Promise<RewardSideEffects | null> {
  if (input.creatorIsBot) return null;
  const before = await ensureEconomy(input.userJid, input.userName);
  const effects = emptyEffects(before);
  const r = await applyLedger({
    userJid: input.userJid,
    deltaAura: REWARDS.createQuestion.aura,
    deltaCredits: REWARDS.createQuestion.credits,
    reason: "create_question",
    refType: "question",
    refId: String(input.questionId),
    displayName: input.userName || undefined,
    meta: { actorLabel: input.userName }
  });
  effects.economy = r.economy;
  await maybeAnnounceAuraLevelUp(input.userJid, before.aura, r.economy.aura, input.userName, input.groupJid, effects);
  return effects;
}

export async function onCadernoCompleted(input: {
  userJid: string;
  userName?: string | null;
  cadernoId: number;
  questionCount: number;
  groupJid?: string | null;
}): Promise<RewardSideEffects> {
  const amount = cadernoCompleteReward(input.questionCount);
  const before = await ensureEconomy(input.userJid, input.userName);
  const effects = emptyEffects(before);
  const r = await applyLedger({
    userJid: input.userJid,
    deltaAura: amount,
    deltaCredits: amount,
    reason: "caderno_complete",
    refType: "caderno",
    refId: String(input.cadernoId),
    displayName: input.userName || undefined,
    meta: { actorLabel: input.userName, questionCount: input.questionCount, amount }
  });
  effects.economy = r.economy;
  return effects;
}

export async function applyPenaltyLocking(userJid: string, cadernoId: number, dayIso: string): Promise<void> {
  await applyLedger({
    userJid,
    deltaAura: PENALTIES.lockingCaderno.aura,
    reason: "penalty_lock",
    refType: "caderno_day",
    refId: `${cadernoId}:${dayIso}`,
    meta: { cadernoId }
  });
}

export { getDayFlag, ensureEconomy, ensureStreak };
