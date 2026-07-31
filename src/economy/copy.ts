/** Copy temática orçamentária. */

export function creditApproved(n: number): string {
  const sign = n >= 0 ? `+${n}` : String(n);
  return `🏛️ Crédito Orçamentário aprovado: ${sign}`;
}

export function expenseEmpenhada(n: number): string {
  const abs = Math.abs(n);
  return `📄 Despesa empenhada: -${abs} Créditos`;
}

export function saldoDisponivel(n: number): string {
  return `💰 Saldo disponível: ${n}`;
}

export function auraCreditada(n: number): string {
  const sign = n >= 0 ? `+${n}` : String(n);
  return `✨ Aura creditada: ${sign}`;
}

export function formatRewardToast(deltaAura: number, deltaCredits: number, balanceCredits?: number): string {
  const parts: string[] = [];
  if (deltaCredits > 0) parts.push(creditApproved(deltaCredits));
  if (deltaCredits < 0) parts.push(expenseEmpenhada(deltaCredits));
  if (deltaAura !== 0) parts.push(auraCreditada(deltaAura));
  if (balanceCredits != null) parts.push(saldoDisponivel(balanceCredits));
  return parts.join("\n");
}

export function ledgerReasonLabel(reason: string, meta?: Record<string, unknown> | null): string {
  const shortId = meta?.questionShortId != null ? String(meta.questionShortId) : "";
  const item = meta?.itemName != null ? String(meta.itemName) : "";
  const name = meta?.actorLabel != null ? String(meta.actorLabel) : "Alguém";
  switch (reason) {
    case "answer_correct":
      return `${name} respondeu ${shortId ? "#" + shortId : "uma questão"} e farmou +2 Aura · +2 Créditos`;
    case "answer_wrong":
      return `${name} errou ${shortId ? "#" + shortId : "uma questão"} · +1 Aura · +1 Crédito`;
    case "answer_correct_reversal":
    case "answer_wrong_reversal":
      return `${name} alterou resposta ${shortId ? "#" + shortId : ""} (ajuste de verba)`;
    case "create_question":
      return `${name} criou uma questão · +1 Aura · +1 Crédito`;
    case "first_omissas":
      return `${name} zerou as omissas (janela 1h) · +4 Aura · +4 Créditos`;
    case "streak_daily":
      return `${name} manteve sequência · Crédito aprovado +1 · +1 Aura`;
    case "streak_milestone":
      return `${name} atingiu marco de sequência ${meta?.days ?? ""}`;
    case "streak_beyond_30":
      return `${name} sequência 30+ · +5 Aura`;
    case "caderno_complete":
      return `${name} completou um caderno · bônus orçamentário`;
    case "achievement":
      return `${name} desbloqueou: ${meta?.title ?? "conquista"}`;
    case "shop_purchase":
      return `${name} empenhou despesa: ${item || "item"} (${meta?.price != null ? "−" + meta.price : ""})`;
    case "mandado_fee":
      return `${name} pagou taxa de Mandado`;
    case "mandado_escrow":
      return `${name} empenhou stake de Mandado`;
    case "mandado_win_defender":
      return `${name} cumpriu Mandado · recompensa`;
    case "mandado_win_challenger":
      return `${name} venceu Mandado (intimado errou)`;
    case "mandado_refund":
      return `${name} recebeu devolução de Mandado`;
    case "aplicacao_lock":
      return `${name} fez Aplicação Orçamentária`;
    case "aplicacao_payout":
      return `${name} liquidou Aplicação Orçamentária`;
    case "aplicacao_lost":
      return `${name} perdeu Aplicação Orçamentária (quebra de sequência)`;
    case "penalty_lock":
      return `${name} penalizado por travar caderno (−50 Aura)`;
    case "penalty_abandon":
      return `${name} abandonou sequência (−4 Aura)`;
    case "penalty_zero_day":
      return `${name} não respondeu no dia (−1 Aura)`;
    case "streak_insurance":
      return `${name} usou Seguro de Streak`;
    default:
      return `${name}: ${reason}`;
  }
}
