import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";
import { dateIsoInTimezone } from "../schedule";
import { ECONOMY_TZ } from "./constants";

let client: SupabaseClient | null = null;

export function economyDb(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  }
  return client;
}

export function todayIso(tz = ECONOMY_TZ): string {
  return dateIsoInTimezone(new Date(), tz);
}

export function addDaysToIso(dayIso: string, days: number): string {
  const [y, m, d] = dayIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export type UserEconomyRow = {
  user_jid: string;
  aura: number;
  credits: number;
  credits_escrowed: number;
  lifetime_answers: number;
  mandados_won: number;
  active_title: string | null;
  display_name: string | null;
};

export type UserStreakRow = {
  user_jid: string;
  current_streak: number;
  best_streak: number;
  last_completed_day: string | null;
  miss_streak: number;
  abandon_penalty_applied: boolean;
  streak_insurance_charges: number;
  prepaid_days: string[];
  milestones_claimed: number[];
};

export async function ensureEconomy(userJid: string, displayName?: string | null): Promise<UserEconomyRow> {
  const db = economyDb();
  const { data, error } = await db.from("user_economy").select("*").eq("user_jid", userJid).maybeSingle();
  if (error) throw new Error(`economy ensure: ${error.message}`);
  if (data) {
    if (displayName && displayName.trim() && displayName !== data.display_name) {
      await db.from("user_economy").update({ display_name: displayName.trim(), updated_at: new Date().toISOString() }).eq("user_jid", userJid);
      return { ...data, display_name: displayName.trim() } as UserEconomyRow;
    }
    return data as UserEconomyRow;
  }
  const insert = {
    user_jid: userJid,
    aura: 0,
    credits: 0,
    credits_escrowed: 0,
    lifetime_answers: 0,
    mandados_won: 0,
    active_title: null as string | null,
    display_name: displayName?.trim() || null
  };
  const { data: created, error: insErr } = await db.from("user_economy").insert(insert).select("*").single();
  if (insErr) throw new Error(`economy insert: ${insErr.message}`);
  return created as UserEconomyRow;
}

export async function ensureStreak(userJid: string): Promise<UserStreakRow> {
  const db = economyDb();
  const { data, error } = await db.from("user_streak").select("*").eq("user_jid", userJid).maybeSingle();
  if (error) throw new Error(`streak ensure: ${error.message}`);
  if (data) {
    return {
      ...(data as UserStreakRow),
      prepaid_days: Array.isArray(data.prepaid_days) ? data.prepaid_days : [],
      milestones_claimed: Array.isArray(data.milestones_claimed) ? data.milestones_claimed.map(Number) : []
    };
  }
  const insert = {
    user_jid: userJid,
    current_streak: 0,
    best_streak: 0,
    last_completed_day: null,
    miss_streak: 0,
    abandon_penalty_applied: false,
    streak_insurance_charges: 0,
    prepaid_days: [] as string[],
    milestones_claimed: [] as number[]
  };
  const { data: created, error: insErr } = await db.from("user_streak").insert(insert).select("*").single();
  if (insErr) throw new Error(`streak insert: ${insErr.message}`);
  return created as UserStreakRow;
}

export type LedgerInput = {
  userJid: string;
  deltaAura?: number;
  deltaCredits?: number;
  reason: string;
  refType?: string;
  refId?: string | null;
  dayIso?: string;
  meta?: Record<string, unknown>;
  /** Se true, permite saldo de créditos negativo? default false — rejeita. */
  allowNegativeCredits?: boolean;
  /** Ajusta escrow (positivo = trava mais créditos). */
  deltaEscrow?: number;
  /** Incrementa lifetime_answers */
  bumpLifetimeAnswers?: number;
  /** Incrementa mandados_won */
  bumpMandadosWon?: number;
  activeTitle?: string | null;
  displayName?: string | null;
};

export type LedgerResult = {
  applied: boolean;
  skippedDuplicate?: boolean;
  economy: UserEconomyRow;
  deltaAura: number;
  deltaCredits: number;
};

export async function applyLedger(input: LedgerInput): Promise<LedgerResult> {
  const db = economyDb();
  const deltaAura = Math.trunc(input.deltaAura || 0);
  const deltaCredits = Math.trunc(input.deltaCredits || 0);
  const deltaEscrow = Math.trunc(input.deltaEscrow || 0);
  const dayIso = input.dayIso || todayIso();

  await ensureEconomy(input.userJid, input.displayName);

  if (input.refId) {
    const { data: existing } = await db
      .from("economy_ledger")
      .select("id")
      .eq("user_jid", input.userJid)
      .eq("reason", input.reason)
      .eq("ref_id", input.refId)
      .maybeSingle();
    if (existing) {
      const eco = await ensureEconomy(input.userJid);
      return { applied: false, skippedDuplicate: true, economy: eco, deltaAura: 0, deltaCredits: 0 };
    }
  }

  const eco = await ensureEconomy(input.userJid, input.displayName);
  const nextCredits = eco.credits + deltaCredits;
  const nextEscrow = Math.max(0, (eco.credits_escrowed || 0) + deltaEscrow);
  const available = eco.credits - (eco.credits_escrowed || 0);
  if (!input.allowNegativeCredits && nextCredits < 0) {
    throw new Error("Saldo de Créditos Orçamentários insuficiente.");
  }
  if (!input.allowNegativeCredits && deltaCredits < 0 && Math.abs(deltaCredits) > available) {
    throw new Error("Saldo disponível insuficiente (há verbas empenhadas).");
  }
  if (deltaEscrow > 0 && deltaEscrow > available - Math.max(0, -deltaCredits)) {
    throw new Error("Saldo disponível insuficiente para empenho.");
  }

  const patch: Record<string, unknown> = {
    aura: Math.max(0, eco.aura + deltaAura),
    credits: Math.max(0, nextCredits),
    credits_escrowed: nextEscrow,
    updated_at: new Date().toISOString()
  };
  if (input.bumpLifetimeAnswers) {
    patch.lifetime_answers = (eco.lifetime_answers || 0) + input.bumpLifetimeAnswers;
  }
  if (input.bumpMandadosWon) {
    patch.mandados_won = (eco.mandados_won || 0) + input.bumpMandadosWon;
  }
  if (input.activeTitle !== undefined) {
    patch.active_title = input.activeTitle;
  }
  if (input.displayName) {
    patch.display_name = input.displayName.trim();
  }

  const { data: updated, error: upErr } = await db
    .from("user_economy")
    .update(patch)
    .eq("user_jid", input.userJid)
    .select("*")
    .single();
  if (upErr) throw new Error(`economy update: ${upErr.message}`);

  const { error: ledErr } = await db.from("economy_ledger").insert({
    user_jid: input.userJid,
    delta_aura: deltaAura,
    delta_credits: deltaCredits,
    reason: input.reason,
    ref_type: input.refType || null,
    ref_id: input.refId || null,
    day_iso: dayIso,
    meta: input.meta || null
  });
  if (ledErr) {
    if (ledErr.code === "23505") {
      return { applied: false, skippedDuplicate: true, economy: updated as UserEconomyRow, deltaAura: 0, deltaCredits: 0 };
    }
    throw new Error(`ledger insert: ${ledErr.message}`);
  }

  return {
    applied: true,
    economy: updated as UserEconomyRow,
    deltaAura,
    deltaCredits
  };
}

/** Folga gravada no ledger (sobrevive à remoção de prepaid_days no miss-eval). */
export async function userHasDayOffOn(userJid: string, dayIso: string): Promise<boolean> {
  const day = String(dayIso || "").trim();
  if (!userJid || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const { data, error } = await economyDb()
    .from("economy_ledger")
    .select("id")
    .eq("user_jid", userJid)
    .eq("reason", "day_off_use")
    .eq("ref_id", `folga:${day}`)
    .maybeSingle();
  if (error) {
    console.warn("[economy] day-off lookup:", error.message);
    return false;
  }
  return Boolean(data);
}

export async function availableCredits(userJid: string): Promise<number> {
  const eco = await ensureEconomy(userJid);
  return Math.max(0, eco.credits - (eco.credits_escrowed || 0));
}

export async function insertDiarioEvent(input: {
  groupJid?: string | null;
  dayIso?: string;
  eventType: string;
  actorJid?: string | null;
  actorLabel?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const db = economyDb();
  await db.from("diario_oficial_events").insert({
    group_jid: input.groupJid || null,
    day_iso: input.dayIso || todayIso(),
    event_type: input.eventType,
    actor_jid: input.actorJid || null,
    actor_label: input.actorLabel || null,
    payload: input.payload || {}
  });
}

export async function tryGroupAnnounceOnce(input: {
  groupJid: string;
  dayIso: string;
  announceKey: string;
  actorJid: string;
}): Promise<boolean> {
  const db = economyDb();
  const { error } = await db.from("economy_group_announces").insert({
    group_jid: input.groupJid,
    day_iso: input.dayIso,
    announce_key: input.announceKey,
    actor_jid: input.actorJid
  });
  if (error) {
    if (error.code === "23505") return false;
    console.warn("[economy] announce flag:", error.message);
    return false;
  }
  return true;
}

export async function getDayFlag(
  groupJid: string,
  dayIso: string,
  flagKey: string
): Promise<{ user_jid: string | null; meta: unknown } | null> {
  const db = economyDb();
  const { data, error } = await db
    .from("economy_day_flags")
    .select("user_jid, meta")
    .eq("group_jid", groupJid)
    .eq("day_iso", dayIso)
    .eq("flag_key", flagKey)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

export async function setDayFlag(input: {
  groupJid: string;
  dayIso: string;
  flagKey: string;
  userJid?: string | null;
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  const db = economyDb();
  const { error } = await db.from("economy_day_flags").insert({
    group_jid: input.groupJid,
    day_iso: input.dayIso,
    flag_key: input.flagKey,
    user_jid: input.userJid || null,
    meta: input.meta || null
  });
  if (error) {
    if (error.code === "23505") return false;
    throw new Error(error.message);
  }
  return true;
}
