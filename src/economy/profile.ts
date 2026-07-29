import { formatAuraBlock, getAuraLevel } from "./aura-levels";
import { ensureEconomy, ensureStreak, economyDb, availableCredits } from "./db";
import { listInventory } from "./shop";
import { getActiveAplicacao } from "./aplicacao";
import { listOpenMandadosForUser } from "./mandado";
import { ACHIEVEMENTS } from "./constants";

export async function buildProfileText(userJid: string): Promise<string> {
  const eco = await ensureEconomy(userJid);
  const streak = await ensureStreak(userJid);
  const avail = await availableCredits(userJid);
  const inv = await listInventory(userJid);
  const app = await getActiveAplicacao(userJid);
  const mandados = await listOpenMandadosForUser(userJid);
  const equipped = inv.filter((i) => i.equipped);

  const lines = [
    `👤 ${eco.display_name || userJid}`,
    eco.active_title ? `Título: *${eco.active_title}*` : "Título: —",
    "",
    formatAuraBlock(eco.aura),
    "",
    `💰 ${eco.credits} Créditos (${avail} disponíveis)`,
    eco.credits_escrowed > 0 ? `Verbas empenhadas: ${eco.credits_escrowed}` : null,
    `🔥 Sequência: ${streak.current_streak} (recorde ${streak.best_streak})`,
    streak.streak_insurance_charges > 0 ? `🛡️ Seguros: ${streak.streak_insurance_charges}` : null,
    `📚 Questões respondidas: ${eco.lifetime_answers}`,
    `⚔️ Mandados vencidos: ${eco.mandados_won}`,
    ""
  ].filter((x) => x != null) as string[];

  if (app) {
    lines.push("🏦 Aplicação Orçamentária ativa:");
    lines.push(`Aplicação: ${app.principal} → ${app.return_amount} até ${app.matures_day}`);
    lines.push("");
  }
  if (mandados.length) {
    lines.push(`Mandados abertos: ${mandados.length}`);
    lines.push("");
  }
  if (equipped.length) {
    lines.push("Equipado:");
    for (const e of equipped) lines.push(`• ${e.name || e.item_key}`);
  }

  const { data: unlocked } = await economyDb()
    .from("user_achievements")
    .select("achievement_key")
    .eq("user_jid", userJid);
  const have = new Set((unlocked || []).map((r) => r.achievement_key));
  lines.push("", "Conquistas:");
  for (const a of ACHIEVEMENTS) {
    lines.push(`${have.has(a.key) ? "✅" : "⬜"} ${a.title} (${a.minAnswers} Q)`);
  }

  return lines.join("\n");
}

export async function getProfilePayload(userJid: string) {
  const eco = await ensureEconomy(userJid);
  const streak = await ensureStreak(userJid);
  const avail = await availableCredits(userJid);
  const inv = await listInventory(userJid);
  const app = await getActiveAplicacao(userJid);
  const mandados = await listOpenMandadosForUser(userJid);
  const aura = getAuraLevel(eco.aura);
  const { data: unlocked } = await economyDb()
    .from("user_achievements")
    .select("achievement_key, unlocked_at")
    .eq("user_jid", userJid);
  return {
    economy: eco,
    streak,
    availableCredits: avail,
    inventory: inv,
    aplicacao: app,
    mandados,
    aura,
    achievements: ACHIEVEMENTS.map((a) => ({
      ...a,
      unlocked: (unlocked || []).some((u) => u.achievement_key === a.key)
    }))
  };
}

export type RankingKind = "aura" | "producao" | "disciplina" | "duelo";

export async function getRanking(kind: RankingKind, limit = 20): Promise<
  { userJid: string; label: string; value: number; title?: string | null }[]
> {
  const db = economyDb();
  if (kind === "disciplina") {
    const { data, error } = await db
      .from("user_streak")
      .select("user_jid, current_streak, best_streak")
      .order("current_streak", { ascending: false })
      .order("best_streak", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    const jids = (data || []).map((r) => r.user_jid);
    const { data: ecos } = await db.from("user_economy").select("user_jid, display_name, active_title").in("user_jid", jids);
    const map = new Map((ecos || []).map((e) => [e.user_jid, e]));
    return (data || []).map((r) => ({
      userJid: r.user_jid,
      label: map.get(r.user_jid)?.display_name || r.user_jid,
      value: r.current_streak,
      title: map.get(r.user_jid)?.active_title
    }));
  }

  let orderCol = "aura";
  if (kind === "producao") orderCol = "lifetime_answers";
  if (kind === "duelo") orderCol = "mandados_won";

  const { data, error } = await db
    .from("user_economy")
    .select("user_jid, display_name, active_title, aura, lifetime_answers, mandados_won")
    .order(orderCol, { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({
    userJid: r.user_jid,
    label: r.display_name || r.user_jid,
    value: Number(r[orderCol as keyof typeof r] || 0),
    title: r.active_title
  }));
}

export function formatRankingMessage(kind: RankingKind, rows: { label: string; value: number; title?: string | null }[]): string {
  const titles: Record<RankingKind, string> = {
    aura: "🏛️ Ranking Aura",
    producao: "📚 Ranking Produção",
    disciplina: "🔥 Ranking Disciplina",
    duelo: "⚔️ Ranking Duelo"
  };
  const lines = [titles[kind], ""];
  if (!rows.length) {
    lines.push("Sem dados ainda.");
    return lines.join("\n");
  }
  rows.forEach((r, i) => {
    const t = r.title ? ` · ${r.title}` : "";
    lines.push(`${i + 1}. ${r.label}${t} — ${r.value.toLocaleString("pt-BR")}`);
  });
  return lines.join("\n");
}

export async function buildDiarioOficialDigest(input: {
  dayIso: string;
  cadernoLines: string[];
  groupJid: string;
}): Promise<string> {
  const db = economyDb();
  const { data: ecos } = await db
    .from("user_economy")
    .select("user_jid, display_name, aura, active_title")
    .order("aura", { ascending: false })
    .limit(25);
  const jids = (ecos || []).map((e) => e.user_jid);
  const { data: streaks } = jids.length
    ? await db.from("user_streak").select("user_jid, current_streak").in("user_jid", jids)
    : { data: [] as { user_jid: string; current_streak: number }[] };
  const streakMap = new Map((streaks || []).map((s) => [s.user_jid, s.current_streak]));

  const lines = [
    "📰 Diário Oficial do Papa Vagas",
    input.dayIso.split("-").reverse().join("/"),
    "",
    ...(input.cadernoLines.length ? input.cadernoLines : ["Sem cadernos ativos."]),
    "",
    "🏛️ Quadro do dia"
  ];

  for (const e of ecos || []) {
    const auraInfo = getAuraLevel(e.aura);
    const st = streakMap.get(e.user_jid) || 0;
    lines.push(
      `✨ ${e.display_name || e.user_jid} — Aura ${e.aura} (${auraInfo.shortLabel}) · 🔥 ${st}`
    );
  }

  lines.push("", "/omissas · /perfil · /ranking");
  return lines.join("\n");
}

export async function listLedgerAudit(input: {
  dayIso?: string;
  userJid?: string;
  limit?: number;
}): Promise<{ created_at: string; user_jid: string; reason: string; delta_aura: number; delta_credits: number; meta: Record<string, unknown> | null }[]> {
  let q = economyDb()
    .from("economy_ledger")
    .select("created_at, user_jid, reason, delta_aura, delta_credits, meta")
    .order("created_at", { ascending: false })
    .limit(input.limit || 100);
  if (input.dayIso) q = q.eq("day_iso", input.dayIso);
  if (input.userJid) q = q.eq("user_jid", input.userJid);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []) as {
    created_at: string;
    user_jid: string;
    reason: string;
    delta_aura: number;
    delta_credits: number;
    meta: Record<string, unknown> | null;
  }[];
}
