import { APLICACAO, aplicacaoReturn } from "./constants";
import { addDaysToIso, applyLedger, availableCredits, economyDb, todayIso } from "./db";

export async function createAplicacao(userJid: string, principal: number): Promise<string> {
  const p = Math.floor(principal);
  if (p < APLICACAO.minPrincipal) throw new Error(`Aplicação mínima: ${APLICACAO.minPrincipal} Créditos.`);
  const avail = await availableCredits(userJid);
  if (p > avail) throw new Error("Saldo disponível insuficiente.");

  const { data: existing } = await economyDb()
    .from("aplicacoes_orcamentarias")
    .select("id")
    .eq("user_jid", userJid)
    .eq("status", "active")
    .maybeSingle();
  if (existing) throw new Error("Você já tem uma Aplicação Orçamentária ativa.");

  const started = todayIso();
  const matures = addDaysToIso(started, APLICACAO.streakDays);
  const ret = aplicacaoReturn(p);

  await applyLedger({
    userJid,
    deltaCredits: -p,
    deltaEscrow: 0,
    reason: "aplicacao_lock",
    refType: "aplicacao",
    refId: `${userJid}:${started}`,
    meta: { principal: p, returnAmount: ret }
  });

  const { error } = await economyDb().from("aplicacoes_orcamentarias").insert({
    user_jid: userJid,
    principal: p,
    return_amount: ret,
    started_day: started,
    matures_day: matures,
    status: "active"
  });
  if (error) throw new Error(error.message);

  return [
    "🏦 Aplicação Orçamentária",
    `Aplicação: ${p} Créditos`,
    `Prazo: ${APLICACAO.streakDays} dias de streak`,
    `Retorno: ${ret} Créditos`,
    "",
    "Se a sequência quebrar, a verba é perdida. Seguro de Streak não cobre aplicação."
  ].join("\n");
}

export async function getActiveAplicacao(userJid: string): Promise<{
  principal: number;
  return_amount: number;
  started_day: string;
  matures_day: string;
} | null> {
  const { data, error } = await economyDb()
    .from("aplicacoes_orcamentarias")
    .select("principal, return_amount, started_day, matures_day")
    .eq("user_jid", userJid)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

export async function loseActiveAplicacao(userJid: string): Promise<void> {
  const { data } = await economyDb()
    .from("aplicacoes_orcamentarias")
    .select("id, principal")
    .eq("user_jid", userJid)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return;
  await economyDb()
    .from("aplicacoes_orcamentarias")
    .update({ status: "lost", resolved_at: new Date().toISOString() })
    .eq("id", data.id);
  await applyLedger({
    userJid,
    reason: "aplicacao_lost",
    refType: "aplicacao",
    refId: `lost:${data.id}`,
    meta: { principal: data.principal }
  });
}

export async function tryMatureAplicacoes(userJid: string, currentStreak: number): Promise<string | null> {
  const { data } = await economyDb()
    .from("aplicacoes_orcamentarias")
    .select("*")
    .eq("user_jid", userJid)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;
  const today = todayIso();
  if (today < data.matures_day) return null;
  if (currentStreak < APLICACAO.streakDays) return null;

  await applyLedger({
    userJid,
    deltaCredits: data.return_amount,
    reason: "aplicacao_payout",
    refType: "aplicacao",
    refId: `pay:${data.id}`,
    meta: { principal: data.principal, returnAmount: data.return_amount }
  });
  await economyDb()
    .from("aplicacoes_orcamentarias")
    .update({ status: "paid", resolved_at: new Date().toISOString() })
    .eq("id", data.id);
  return `🏦 Aplicação liquidada: +${data.return_amount} Créditos (principal ${data.principal}).`;
}
