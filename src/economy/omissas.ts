/**
 * Omissas do dia vs atrasadas, status de travamento e textos de aviso.
 */
import type { WASocket } from "@whiskeysockets/baileys";
import {
  listActiveGroupCadernos,
  listEngagedJidsMissingCadernoDayAnswers,
  listUnansweredOmissasForUser,
  isSameQuizParticipant,
  type UnansweredOmissasBuckets
} from "../supabase";
import { ECONOMY_TZ, OMISSAS_SCHEDULE } from "./constants";
import { todayIso, userHasDayOffOn } from "./db";

export type LockingStatus = {
  cadernoId: number;
  cadernoName: string;
  dayIso: string;
};

/** Cadernos com wait_for_answers em que o usuário ainda falta responder o dia corrente (já enviado). */
export async function listLockingCadernosForUser(
  userJid: string,
  groupJid: string
): Promise<LockingStatus[]> {
  const cadernos = await listActiveGroupCadernos(groupJid);
  const today = todayIso();
  const out: LockingStatus[] = [];

  for (const c of cadernos) {
    if (!c.waitForAnswers || !c.currentDayDate) continue;
    const nPerDay = Math.max(1, c.questionsPerDay);
    if (c.currentDaySent < nPerDay) continue;
    // Ainda no dia civil do caderno (avisos) OU preso em dia passado (pré soft-unlock)
    if (c.currentDayDate > today) continue;

    const tz = c.timezone || ECONOMY_TZ;
    const missing = await listEngagedJidsMissingCadernoDayAnswers(
      c.id,
      c.currentDayDate,
      tz,
      new Set()
    );
    const isMissing = missing.some((jid) => isSameQuizParticipant(jid, userJid));
    if (!isMissing) continue;
    if (await userHasDayOffOn(userJid, c.currentDayDate)) continue;
    out.push({
      cadernoId: c.id,
      cadernoName: c.name,
      dayIso: c.currentDayDate
    });
  }
  return out;
}

export function formatOmissasIds(ids: string[], max = 20): string {
  if (ids.length === 0) return "(nenhuma)";
  const shown = ids.slice(0, max).map((id) => `#${id}`);
  const extra = ids.length > max ? ` … +${ids.length - max}` : "";
  return shown.join(" ") + extra;
}

export function buildOmissasPrivateMessage(input: {
  buckets: UnansweredOmissasBuckets;
  locking: LockingStatus[];
  mode: "hoje" | "atrasadas";
  /** Link pessoal /omissas?t=… (só deste usuário). */
  webLink?: string | null;
  /** Link no app de estudo para a mesma sessão. */
  studyAppLink?: string | null;
}): string {
  const lines: string[] = [];
  if (input.mode === "hoje") {
    lines.push("📋 Omissas de *hoje* (valem p/ streak e bônus):", "");
    if (input.buckets.today.length === 0) {
      lines.push("Nenhuma omissa de hoje. Bom trabalho!");
    } else {
      lines.push(...input.buckets.today.map((id, i) => `${i + 1}. #${id}`));
    }
    if (input.buckets.atrasadas.length > 0) {
      lines.push(
        "",
        `Também há *${input.buckets.atrasadas.length}* atrasada(s) (não contam no streak).`,
        "Veja com /atrasadas."
      );
    }
  } else {
    lines.push("📂 Omissas *atrasadas* (não contam no streak nem no −50):", "");
    if (input.buckets.atrasadas.length === 0) {
      lines.push("Nenhuma atrasada.");
    } else {
      lines.push(...input.buckets.atrasadas.map((id, i) => `${i + 1}. #${id}`));
    }
    if (input.buckets.today.length > 0) {
      lines.push(
        "",
        `Hoje ainda faltam ${input.buckets.today.length}: ${formatOmissasIds(input.buckets.today, 8)}`,
        "Use /omissas para as do dia."
      );
    }
  }

  if (input.locking.length > 0) {
    lines.push("", "⚠️ Você está *travando* o ritmo:");
    for (const L of input.locking) {
      lines.push(`• Caderno #${L.cadernoId} (${L.cadernoName}) · dia ${L.dayIso}`);
    }
    lines.push(
      `Responda até 23:59 ou leva −50 Aura. Soft-unlock à meia-noite (o caderno avança mesmo assim).`,
      `Corte ${OMISSAS_SCHEDULE.cutoffHour}h: nova questão avulsa ou destravar depois disso vai para amanhã.`
    );
  } else if (input.mode === "hoje" && input.buckets.today.length > 0) {
    lines.push(
      "",
      "Você *não* está na lista de quem trava nenhum caderno agora — mas as omissas de hoje ainda contam pro streak."
    );
  }

  const offerIds =
    input.mode === "hoje" ? input.buckets.today : input.buckets.atrasadas;
  if (offerIds.length > 0) {
    if (input.webLink) {
      lines.push(
        "",
        "🌐 Resolver no site (seu link pessoal — só as suas omissas):",
        input.webLink
      );
    }
    if (input.studyAppLink) {
      lines.push(
        "",
        "📚 Resolver no app de estudo (alternativas, confiança, anotações):",
        input.studyAppLink
      );
    }
    lines.push("", "Deseja receber os enunciados aqui? Responda *sim* ou *nao*.");
  }
  return lines.join("\n");
}

export function buildOmissasWarnMessage(input: {
  warnHour: number;
  todayIds: string[];
  locking: LockingStatus[];
}): string {
  const lines = [
    `⏰ Lembrete ${input.warnHour}h`,
    "",
    input.todayIds.length > 0
      ? `Omissas de hoje: ${formatOmissasIds(input.todayIds)}`
      : "Sem omissas de hoje."
  ];
  if (input.locking.length > 0) {
    lines.push("", "⚠️ Você está travando:");
    for (const L of input.locking) {
      lines.push(`• #${L.cadernoId} ${L.cadernoName} (${L.dayIso})`);
    }
    lines.push(
      "",
      "Prazo: 23:59 · depois disso: −50 Aura e soft-unlock (o caderno libera à meia-noite)."
    );
  } else if (input.todayIds.length > 0) {
    lines.push("", "Zere as de hoje para manter o streak.");
  }
  lines.push(
    "",
    `Corte ${OMISSAS_SCHEDULE.cutoffHour}h: questão avulsa ou destravar caderno depois disso entram amanhã.`,
    "",
    "Use /omissas no privado."
  );
  return lines.join("\n");
}

/** Aviso no grupo quando algo entra como omissa do dia (antes do corte 15h). */
export async function notifyGroupOmissasEntered(
  sock: WASocket,
  groupJid: string,
  input: {
    shortIds: string[];
    source: "questao" | "caderno";
    cadernoName?: string;
  }
): Promise<void> {
  const ids = input.shortIds.map((id) => String(id).toUpperCase()).filter(Boolean);
  if (!ids.length || !groupJid) return;

  const idLine = formatOmissasIds(ids, 12);
  const lines =
    input.source === "caderno"
      ? [
          "📋 Nova omissa do dia",
          input.cadernoName
            ? `Caderno "${input.cadernoName}" destravou: ${idLine}`
            : `Caderno destravou: ${idLine}`,
          "",
          "Enunciados: /omissas no privado."
        ]
      : [
          "📋 Nova omissa do dia",
          `Questão avulsa: ${idLine}`,
          "",
          "Enunciados: /omissas no privado."
        ];

  try {
    await sock.sendMessage(groupJid, { text: lines.join("\n") });
  } catch (e) {
    console.warn("[omissas] falha aviso grupo:", (e as Error).message);
  }
}

export async function loadOmissasContext(
  userJid: string,
  groupJid: string,
  opts?: { includeAtrasadas?: boolean; todayLimit?: number; atrasadasLimit?: number }
): Promise<{ buckets: UnansweredOmissasBuckets; locking: LockingStatus[] }> {
  const buckets = await listUnansweredOmissasForUser(userJid, groupJid, {
    todayLimit: opts?.todayLimit ?? 30,
    atrasadasLimit: opts?.atrasadasLimit ?? 30,
    includeAtrasadas: opts?.includeAtrasadas !== false
  });
  const locking = await listLockingCadernosForUser(userJid, groupJid);
  return { buckets, locking };
}
