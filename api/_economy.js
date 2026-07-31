/**
 * Helpers de economia para APIs Vercel (espelha regras do bot).
 */

const AURA_LEVELS = [
  { min: 0, max: 99, title: "Aura Latente", emoji: "🌱" },
  { min: 100, max: 299, title: "Aura Desperta", emoji: "✨" },
  { min: 300, max: 599, title: "Aura Incandescente", emoji: "🔥" },
  { min: 600, max: 999, title: "Aura Elevada", emoji: "⚡" },
  { min: 1000, max: 1999, title: "Aura Institucional", emoji: "🏛️" },
  { min: 2000, max: 4999, title: "Aura Suprema", emoji: "👑" },
  { min: 5000, max: null, title: "Aura Lendária", emoji: "🌌" }
];

const ACHIEVEMENTS = [
  { key: "calouro", title: "Calouro", minAnswers: 10, aura: 5, credits: 10 },
  { key: "estudante", title: "Estudante", minAnswers: 30, aura: 15, credits: 15 },
  { key: "tecnico", title: "Técnico", minAnswers: 100, aura: 50, credits: 50 },
  { key: "analista", title: "Analista", minAnswers: 500, aura: 250, credits: 250 },
  { key: "auditor", title: "Auditor", minAnswers: 1000, aura: 500, credits: 500 },
  { key: "nazli", title: "Nazli Setton Filippini", minAnswers: 2000, aura: 1000, credits: 1000 }
];

function getAuraLevel(auraRaw) {
  const aura = Math.max(0, Math.floor(auraRaw || 0));
  let level = AURA_LEVELS[0];
  for (const l of AURA_LEVELS) {
    if (aura >= l.min) level = l;
  }
  const next = AURA_LEVELS.find((l) => l.min > level.min) || null;
  const spanStart = level.min;
  const spanEnd = level.max != null ? level.max + 1 : spanStart + 1000;
  const progressPct =
    level.max == null
      ? 100
      : Math.min(100, Math.max(0, Math.round(((aura - spanStart) / (spanEnd - spanStart)) * 100)));
  return {
    ...level,
    aura,
    progressPct,
    remainingToNext: next ? Math.max(0, next.min - aura) : null,
    label: `${level.emoji} ${level.title}`,
    shortLabel: level.title.replace(/^Aura\s+/i, "")
  };
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function randomToken() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function ensureEconomy(supabase, userJid, displayName) {
  const { data, error } = await supabase.from("user_economy").select("*").eq("user_jid", userJid).maybeSingle();
  if (error) throw error;
  if (data) return data;
  const row = {
    user_jid: userJid,
    aura: 0,
    credits: 0,
    credits_escrowed: 0,
    lifetime_answers: 0,
    mandados_won: 0,
    active_title: null,
    display_name: displayName || null
  };
  const { data: created, error: ins } = await supabase.from("user_economy").insert(row).select("*").single();
  if (ins) throw ins;
  return created;
}

async function ensureStreak(supabase, userJid) {
  const { data, error } = await supabase.from("user_streak").select("*").eq("user_jid", userJid).maybeSingle();
  if (error) throw error;
  if (data) return data;
  const { data: created, error: ins } = await supabase
    .from("user_streak")
    .insert({ user_jid: userJid })
    .select("*")
    .single();
  if (ins) throw ins;
  return created;
}

function ledgerReasonLabel(reason, meta) {
  const shortId = meta?.questionShortId ? `#${meta.questionShortId}` : "uma questão";
  const name = meta?.actorLabel || "Alguém";
  const item = meta?.itemName || meta?.name || "item";
  switch (reason) {
    case "answer_correct":
      return `${name} respondeu ${shortId} e farmou +2 Aura · +2 Créditos`;
    case "answer_wrong":
      return `${name} errou ${shortId} · +1 Aura · +1 Crédito`;
    case "shop_purchase":
      return `${name} empenhou despesa: ${item} (−${meta?.price ?? "?"})`;
    case "first_omissas":
      return `${name} zerou as omissas (janela 1h)`;
    case "achievement":
      return `${name} desbloqueou: ${meta?.title || "conquista"}`;
    case "streak_daily":
      return `${name} manteve sequência · +1 Aura · +1 Crédito`;
    case "mandado_win_defender":
      return `${name} cumpriu Mandado`;
    case "aplicacao_payout":
      return `${name} liquidou Aplicação Orçamentária`;
    default:
      return `${name}: ${reason} (${meta?.delta_aura ?? ""}/${meta?.delta_credits ?? ""})`.trim();
  }
}

module.exports = {
  AURA_LEVELS,
  ACHIEVEMENTS,
  getAuraLevel,
  todayIso,
  randomToken,
  ensureEconomy,
  ensureStreak,
  ledgerReasonLabel
};
