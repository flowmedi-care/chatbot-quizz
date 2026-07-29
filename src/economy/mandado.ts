import { MANDADO, REWARDS, mandadoFee } from "./constants";
import {
  applyLedger,
  availableCredits,
  economyDb,
  insertDiarioEvent,
  todayIso
} from "./db";

export type IntimacaoRow = {
  id: number;
  challenger_jid: string;
  challenger_label: string | null;
  defender_jid: string;
  defender_label: string | null;
  group_jid: string | null;
  question_short_id: string;
  question_label: string | null;
  materia: string | null;
  stake: number;
  fee_burned: number;
  status: string;
  expires_at: string;
};

export function formatMandadoCard(row: {
  challengerLabel: string;
  defenderLabel: string;
  materia?: string | null;
  questionShortId: string;
  questionLabel?: string | null;
  stake: number;
}): string {
  return [
    "⚖️ MANDADO DE INTIMAÇÃO",
    "",
    `O concurseiro ${row.challengerLabel} intimou ${row.defenderLabel}.`,
    "",
    "Matéria:",
    row.materia || "—",
    "",
    "Questão:",
    `#${row.questionShortId}${row.questionLabel ? ` — ${row.questionLabel}` : ""}`,
    "",
    "Valor:",
    `${row.stake} Créditos Orçamentários`,
    "",
    "Prazo:",
    "24 horas",
    "",
    "Aguardando cumprimento..."
  ].join("\n");
}

export async function createMandado(input: {
  challengerJid: string;
  challengerLabel: string;
  defenderJid: string;
  defenderLabel: string;
  groupJid: string;
  questionShortId: string;
  questionLabel?: string | null;
  materia?: string | null;
  stake: number;
}): Promise<{ row: IntimacaoRow; card: string; fee: number }> {
  if (input.challengerJid === input.defenderJid) throw new Error("Não é possível intimar a si mesmo.");
  const stake = Math.floor(input.stake);
  if (stake < MANDADO.minStake || stake > MANDADO.maxStake) {
    throw new Error(`Stake entre ${MANDADO.minStake} e ${MANDADO.maxStake} Créditos.`);
  }
  const { count } = await economyDb()
    .from("intimacoes")
    .select("id", { count: "exact", head: true })
    .eq("challenger_jid", input.challengerJid)
    .eq("status", "pending");
  if ((count || 0) >= MANDADO.maxOpenPerChallenger) {
    throw new Error(`Máximo de ${MANDADO.maxOpenPerChallenger} mandados abertos.`);
  }

  const fee = mandadoFee(stake);
  const need = stake + fee;
  const avail = await availableCredits(input.challengerJid);
  if (avail < need) throw new Error(`Precisa de ${need} Créditos disponíveis (stake + taxa ${fee}).`);

  await applyLedger({
    userJid: input.challengerJid,
    deltaCredits: -fee,
    reason: "mandado_fee",
    refType: "mandado_fee",
    refId: `${input.challengerJid}:${Date.now()}:fee`,
    meta: { fee, stake }
  });
  // Empenha stake (continua no saldo, mas trava em escrow)
  await applyLedger({
    userJid: input.challengerJid,
    deltaEscrow: stake,
    reason: "mandado_escrow",
    refType: "mandado_escrow",
    refId: `${input.challengerJid}:${Date.now()}:escrow`,
    meta: { stake }
  });

  const expires = new Date(Date.now() + MANDADO.hoursToExpire * 3600_000).toISOString();
  const { data, error } = await economyDb()
    .from("intimacoes")
    .insert({
      challenger_jid: input.challengerJid,
      challenger_label: input.challengerLabel,
      defender_jid: input.defenderJid,
      defender_label: input.defenderLabel,
      group_jid: input.groupJid,
      question_short_id: input.questionShortId.toUpperCase(),
      question_label: input.questionLabel || null,
      materia: input.materia || null,
      stake,
      fee_burned: fee,
      status: "pending",
      expires_at: expires
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  // Fix escrow ref to mandado id
  await applyLedger({
    userJid: input.challengerJid,
    reason: "mandado_escrow_link",
    refType: "mandado",
    refId: String(data.id),
    meta: { note: "linked" }
  }).catch(() => undefined);

  const card = formatMandadoCard({
    challengerLabel: input.challengerLabel,
    defenderLabel: input.defenderLabel,
    materia: input.materia,
    questionShortId: input.questionShortId.toUpperCase(),
    questionLabel: input.questionLabel,
    stake
  });

  await insertDiarioEvent({
    groupJid: input.groupJid,
    eventType: "mandado_issued",
    actorJid: input.challengerJid,
    actorLabel: input.challengerLabel,
    payload: { defender: input.defenderLabel, stake, shortId: input.questionShortId }
  });

  return { row: data as IntimacaoRow, card, fee };
}

export async function findPendingMandadoForAnswer(
  defenderJid: string,
  questionShortId: string
): Promise<IntimacaoRow | null> {
  const now = new Date().toISOString();
  const { data, error } = await economyDb()
    .from("intimacoes")
    .select("*")
    .eq("defender_jid", defenderJid)
    .eq("question_short_id", questionShortId.toUpperCase())
    .eq("status", "pending")
    .gt("expires_at", now)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as IntimacaoRow) || null;
}

export async function resolveMandadoOnAnswer(input: {
  mandado: IntimacaoRow;
  correct: boolean;
}): Promise<{ groupText: string }> {
  const m = input.mandado;
  if (input.correct) {
    // Defender wins stake; challenger loses escrowed credits
    await applyLedger({
      userJid: m.challenger_jid,
      deltaCredits: -m.stake,
      deltaEscrow: -m.stake,
      reason: "mandado_escrow_release_loss",
      refType: "mandado",
      refId: `loss-escrow:${m.id}`,
      allowNegativeCredits: true
    });
    await applyLedger({
      userJid: m.defender_jid,
      deltaCredits: m.stake,
      deltaAura: REWARDS.mandadoWinDefender.aura,
      reason: "mandado_win_defender",
      refType: "mandado",
      refId: `win:${m.id}`,
      bumpMandadosWon: 1,
      meta: { stake: m.stake, actorLabel: m.defender_label }
    });
    await economyDb()
      .from("intimacoes")
      .update({ status: "won", resolved_at: new Date().toISOString() })
      .eq("id", m.id);
    await insertDiarioEvent({
      groupJid: m.group_jid,
      eventType: "mandado_won",
      actorJid: m.defender_jid,
      actorLabel: m.defender_label,
      payload: { challenger: m.challenger_label, stake: m.stake }
    });
    return {
      groupText: [
        "✅ Intimação cumprida.",
        "",
        `${m.defender_label || "Intimado"} recebe +${m.stake} Créditos · +${REWARDS.mandadoWinDefender.aura} Aura.`,
        `${m.challenger_label || "Intimante"} perde o valor apostado.`
      ].join("\n")
    };
  }

  // Challenger wins: libera escrow (créditos voltam a ficar disponíveis) + aura
  await applyLedger({
    userJid: m.challenger_jid,
    deltaEscrow: -m.stake,
    deltaAura: REWARDS.mandadoWinChallenger.aura,
    reason: "mandado_win_challenger",
    refType: "mandado",
    refId: `challenger-win:${m.id}`,
    meta: { stake: m.stake }
  });
  await applyLedger({
    userJid: m.defender_jid,
    deltaAura: REWARDS.mandadoLoseDefenderAura,
    reason: "mandado_defender_miss",
    refType: "mandado",
    refId: `def-miss:${m.id}`
  });
  await economyDb()
    .from("intimacoes")
    .update({ status: "lost", resolved_at: new Date().toISOString() })
    .eq("id", m.id);
  await insertDiarioEvent({
    groupJid: m.group_jid,
    eventType: "mandado_lost",
    actorJid: m.challenger_jid,
    actorLabel: m.challenger_label,
    payload: { defender: m.defender_label, stake: m.stake }
  });
  return {
    groupText: [
      "❌ Intimação rejeitada.",
      "",
      `${m.challenger_label || "Intimante"} recebe +${m.stake} Créditos · +${REWARDS.mandadoWinChallenger.aura} Aura.`,
      `${m.defender_label || "Intimado"}: ${REWARDS.mandadoLoseDefenderAura} Aura.`
    ].join("\n")
  };
}

export async function expireMandados(): Promise<{ groupJid: string; text: string }[]> {
  const now = new Date().toISOString();
  const { data, error } = await economyDb()
    .from("intimacoes")
    .select("*")
    .eq("status", "pending")
    .lt("expires_at", now)
    .limit(30);
  if (error) throw new Error(error.message);
  const out: { groupJid: string; text: string }[] = [];
  for (const m of data || []) {
    await applyLedger({
      userJid: m.challenger_jid,
      deltaEscrow: -m.stake,
      reason: "mandado_refund",
      refType: "mandado",
      refId: `exp:${m.id}`,
      meta: { stake: m.stake }
    });
    await economyDb()
      .from("intimacoes")
      .update({ status: "expired", resolved_at: new Date().toISOString() })
      .eq("id", m.id);
    if (m.group_jid) {
      out.push({
        groupJid: m.group_jid,
        text: `⌛ Mandado #${m.id} expirou. Stake devolvido a ${m.challenger_label || "intimante"} (taxa não retorna).`
      });
    }
  }
  return out;
}

export async function listOpenMandadosForUser(userJid: string): Promise<IntimacaoRow[]> {
  const { data, error } = await economyDb()
    .from("intimacoes")
    .select("*")
    .or(`challenger_jid.eq.${userJid},defender_jid.eq.${userJid}`)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as IntimacaoRow[];
}
