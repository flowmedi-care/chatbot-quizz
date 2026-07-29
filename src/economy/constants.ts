/** Constantes e tabelas da economia Papa Vagas. */

export const ECONOMY_TZ = "America/Sao_Paulo";

export const REWARDS = {
  answerCorrect: { aura: 2, credits: 2 },
  answerWrong: { aura: 1, credits: 1 },
  firstOmissasClear: { aura: 4, credits: 4 },
  dailyStreakMaintain: { aura: 1, credits: 1 },
  createQuestion: { aura: 1, credits: 1 },
  streakMilestone: {
    3: { aura: 2, credits: 5 },
    7: { aura: 10, credits: 15 },
    15: { aura: 15, credits: 25 },
    30: { aura: 30, credits: 50 }
  } as Record<number, { aura: number; credits: number }>,
  streakBeyond30DailyAura: 5,
  mandadoWinDefender: { aura: 10 },
  mandadoWinChallenger: { aura: 5 },
  mandadoLoseDefenderAura: -2
} as const;

export const PENALTIES = {
  lockingCaderno: { aura: -50 },
  abandonStreak: { aura: -4 },
  zeroAnswersDay: { aura: -1 }
} as const;

export const CADERNO_COMPLETE = {
  factor: 0.25,
  min: 5,
  max: 40
} as const;

export const APLICACAO = {
  minPrincipal: 100,
  returnFactor: 1.12,
  streakDays: 10
} as const;

export const MANDADO = {
  minStake: 20,
  maxStake: 200,
  feeRate: 0.1,
  minFee: 5,
  maxOpenPerChallenger: 2,
  hoursToExpire: 24
} as const;

export const PURCHASE = {
  expiresMinutes: 5,
  confirmExtraIfPriceGte: 200
} as const;

export type AchievementDef = {
  key: string;
  title: string;
  minAnswers: number;
  aura: number;
  credits: number;
};

export const ACHIEVEMENTS: AchievementDef[] = [
  { key: "calouro", title: "Calouro", minAnswers: 10, aura: 5, credits: 10 },
  { key: "estudante", title: "Estudante", minAnswers: 30, aura: 15, credits: 15 },
  { key: "tecnico", title: "Técnico", minAnswers: 100, aura: 50, credits: 50 },
  { key: "analista", title: "Analista", minAnswers: 500, aura: 250, credits: 250 },
  { key: "auditor", title: "Auditor", minAnswers: 1000, aura: 500, credits: 500 },
  { key: "nazli", title: "Nazli Setton Filippini", minAnswers: 2000, aura: 1000, credits: 1000 }
];

export type AuraLevelDef = {
  min: number;
  max: number | null;
  key: string;
  title: string;
  emoji: string;
};

export const AURA_LEVELS: AuraLevelDef[] = [
  { min: 0, max: 99, key: "latente", title: "Aura Latente", emoji: "🌱" },
  { min: 100, max: 299, key: "desperta", title: "Aura Desperta", emoji: "✨" },
  { min: 300, max: 599, key: "incandescente", title: "Aura Incandescente", emoji: "🔥" },
  { min: 600, max: 999, key: "elevada", title: "Aura Elevada", emoji: "⚡" },
  { min: 1000, max: 1999, key: "institucional", title: "Aura Institucional", emoji: "🏛️" },
  { min: 2000, max: 4999, key: "suprema", title: "Aura Suprema", emoji: "👑" },
  { min: 5000, max: null, key: "lendaria", title: "Aura Lendária", emoji: "🌌" }
];

export function cadernoCompleteReward(questionCount: number): number {
  const n = Math.max(0, Math.floor(questionCount));
  return Math.min(CADERNO_COMPLETE.max, Math.max(CADERNO_COMPLETE.min, Math.floor(CADERNO_COMPLETE.factor * n)));
}

export function mandadoFee(stake: number): number {
  return Math.max(MANDADO.minFee, Math.ceil(stake * MANDADO.feeRate));
}

export function aplicacaoReturn(principal: number): number {
  return Math.floor(principal * APLICACAO.returnFactor);
}
