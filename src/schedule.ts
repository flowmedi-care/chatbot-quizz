/**
 * Cálculo de `next_run_at` para um caderno. Equivalente TS ao `api/_schedule.js`.
 *
 *  - Pega `now` no fuso configurado (via Intl.DateTimeFormat).
 *  - Monta o "alvo de hoje" naquele fuso com hh:mm; se intervalDays>0 soma
 *    `intervalDays` dias; senão se já passou hoje, joga para amanhã.
 */

export function getZonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    map[part.type] = part.value;
  }
  const hourStr = map.hour === "24" ? "00" : map.hour;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(hourStr),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function zonedDateToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const zoned = getZonedParts(new Date(guess), timeZone);
  const reconstructed = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second
  );
  const offsetMs = guess - reconstructed;
  return new Date(guess + offsetMs);
}

export function computeNextRunAt(
  from: Date,
  sendHour: number,
  sendMinute: number,
  timeZone: string,
  intervalDays: number
): Date {
  const zonedNow = getZonedParts(from, timeZone);
  let candidate = zonedDateToUtc(
    zonedNow.year,
    zonedNow.month,
    zonedNow.day,
    sendHour,
    sendMinute,
    timeZone
  );

  if (intervalDays > 0) {
    candidate = new Date(candidate.getTime() + intervalDays * 24 * 60 * 60 * 1000);
  } else if (candidate.getTime() <= from.getTime()) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }

  return candidate;
}

/** Data ISO (YYYY-MM-DD) de `date` interpretada no fuso `timeZone`. */
export function dateIsoInTimezone(date: Date, timeZone: string): string {
  const z = getZonedParts(date, timeZone);
  const mm = z.month < 10 ? `0${z.month}` : String(z.month);
  const dd = z.day < 10 ? `0${z.day}` : String(z.day);
  return `${z.year}-${mm}-${dd}`;
}

/** Minutos desde 00:00 no fuso (0–1439). */
export function minutesInTimezone(date: Date, timeZone: string): number {
  const z = getZonedParts(date, timeZone);
  return z.hour * 60 + z.minute;
}

/** True se o horário local no fuso já passou de hour:minute (inclusive). */
export function isAtOrAfterLocalTime(
  date: Date,
  timeZone: string,
  hour: number,
  minute: number
): boolean {
  return minutesInTimezone(date, timeZone) >= hour * 60 + minute;
}

/**
 * Dia ISO em que uma nova omissa deve contar, dado o instante e o corte diário.
 * Antes do corte → dia civil; a partir do corte → dia seguinte.
 */
export function omissaDayIsoForInstant(
  date: Date,
  timeZone: string,
  cutoffHour: number,
  cutoffMinute: number
): string {
  const civil = dateIsoInTimezone(date, timeZone);
  if (isAtOrAfterLocalTime(date, timeZone, cutoffHour, cutoffMinute)) {
    return addDaysIso(civil, 1);
  }
  return civil;
}

/** True se ainda estamos antes do corte de omissas (exclusivo do horário de corte). */
export function isBeforeOmissasCutoff(
  date: Date,
  timeZone: string,
  cutoffHour: number,
  cutoffMinute: number
): boolean {
  return !isAtOrAfterLocalTime(date, timeZone, cutoffHour, cutoffMinute);
}

/** Soma `n` dias a uma data ISO (YYYY-MM-DD). Não envolve fuso porque a data é puro calendário. */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map((s) => Number(s));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = dt.getUTCMonth() + 1;
  const dd = dt.getUTCDate();
  return `${yy}-${mm < 10 ? `0${mm}` : mm}-${dd < 10 ? `0${dd}` : dd}`;
}

export type SendTimeSlot = { hour: number; minute: number };

export type DailyScheduleSlots = {
  sendTimes: SendTimeSlot[] | null;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  questionsPerDay: number;
};

/** Parseia `send_times` do Supabase (jsonb ou string). */
export function parseSendTimesJson(raw: unknown): SendTimeSlot[] | null {
  if (raw == null) return null;
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;
  const out: SendTimeSlot[] = [];
  for (const item of arr) {
    if (item == null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const hour = Number(rec.hour);
    const minute = Number(rec.minute ?? 0);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) continue;
    out.push({ hour, minute });
  }
  return out.length ? out : null;
}

/** Valida array com exatamente `questionsPerDay` horários em ordem não decrescente. */
export function normalizeSendTimesForDay(
  raw: unknown,
  questionsPerDay: number
): SendTimeSlot[] | null {
  const parsed = parseSendTimesJson(raw);
  const n = Math.max(1, Math.min(24, questionsPerDay));
  if (!parsed || parsed.length !== n) return null;
  let prev = -1;
  for (const slot of parsed) {
    const mins = slot.hour * 60 + slot.minute;
    if (mins < prev) return null;
    prev = mins;
  }
  return parsed;
}

/**
 * Instante UTC do slot `index` (0..N-1) no dia `dayIso` (YYYY-MM-DD no fuso `timeZone`).
 * Modo lote do dia: todas as questões liberam no horário de início (`startHour`/`startMinute`).
 * `sendTimes` / `endHour` são ignorados para o ritmo (mantidos no banco só por compat).
 */
export function resolveDailySlotUtc(
  dayIso: string,
  index: number,
  timeZone: string,
  schedule: DailyScheduleSlots
): Date {
  void index;
  const [y, m, d] = dayIso.split("-").map((s) => Number(s));
  return zonedDateToUtc(y, m, d, schedule.startHour, schedule.startMinute, timeZone);
}

/** Próximo slot 0 do dia (ou amanhã) conforme agenda. */
export function firstSlotFromSchedule(from: Date, timeZone: string, schedule: DailyScheduleSlots): Date {
  const dayIso = dateIsoInTimezone(from, timeZone);
  let slot = resolveDailySlotUtc(dayIso, 0, timeZone, schedule);
  if (slot.getTime() <= from.getTime()) {
    const nextDay = addDaysIso(dayIso, 1);
    slot = resolveDailySlotUtc(nextDay, 0, timeZone, schedule);
  }
  return slot;
}

/**
 * Instante UTC do slot `index` — legado (drip). Preferir `resolveDailySlotUtc` (lote no startHour).
 * Mantido para API/UI que ainda calcula prévia de horários.
 */
export function dailySlotUtc(
  dayIso: string,
  startHour: number,
  startMinute: number,
  endHour: number,
  endMinute: number,
  questionsPerDay: number,
  index: number,
  timeZone: string
): Date {
  void endHour;
  void endMinute;
  void questionsPerDay;
  void index;
  const [y, m, d] = dayIso.split("-").map((s) => Number(s));
  return zonedDateToUtc(y, m, d, startHour, startMinute, timeZone);
}

export function formatNextRunPretty(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(d);
  } catch {
    return iso;
  }
}

/** 0=segunda … 6=domingo (calendário civil ISO YYYY-MM-DD). */
export function weekdayIndexMondayFirst(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map((s) => Number(s));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const utcDay = dt.getUTCDay(); // 0=dom … 6=sab
  return utcDay === 0 ? 6 : utcDay - 1;
}

/** Segunda-feira da semana civil que contém `isoDate`. */
export function startOfWeekMondayIso(isoDate: string): string {
  const idx = weekdayIndexMondayFirst(isoDate);
  return addDaysIso(isoDate, -idx);
}

/** Lista seg–dom da semana que contém `isoDate`. */
export function weekDayIsos(isoDate: string): string[] {
  const monday = startOfWeekMondayIso(isoDate);
  return Array.from({ length: 7 }, (_, i) => addDaysIso(monday, i));
}

/** Primeiro dia do mês (YYYY-MM ou YYYY-MM-DD). */
export function startOfMonthIso(yearMonthOrDay: string): string {
  const raw = String(yearMonthOrDay || "").trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw.slice(0, 7)}-01`;
  throw new Error(`Mês inválido: ${yearMonthOrDay}`);
}

/** Todos os dias YYYY-MM-DD do mês. */
export function monthDayIsos(yearMonthOrDay: string): string[] {
  const first = startOfMonthIso(yearMonthOrDay);
  const [y, m] = first.split("-").map((s) => Number(s));
  const daysInMonth = new Date(Date.UTC(y, m, 0, 12, 0, 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, i) => addDaysIso(first, i));
}

export const WEEKDAY_LABELS_PT = [
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
  "domingo"
] as const;

export const WEEKDAY_LABELS_SHORT_PT = [
  "seg",
  "ter",
  "qua",
  "qui",
  "sex",
  "sab",
  "dom"
] as const;

/** Nome normalizado (sem acento) → índice 0–6 (seg–dom). */
export function weekdayNameToIndex(name: string): number | null {
  const n = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  const map: Record<string, number> = {
    seg: 0,
    segunda: 0,
    "segunda-feira": 0,
    ter: 1,
    terca: 1,
    "terca-feira": 1,
    qua: 2,
    quarta: 2,
    "quarta-feira": 2,
    qui: 3,
    quinta: 3,
    "quinta-feira": 3,
    sex: 4,
    sexta: 4,
    "sexta-feira": 4,
    sab: 5,
    sabado: 5,
    dom: 6,
    domingo: 6
  };
  return map[n] ?? null;
}

/**
 * Resolve nomes de dias (seg, quinta…) para ISOs da semana civil de `anchorIso`
 * (default: semana que contém o anchor).
 */
export function resolveWeekdayNamesToIsos(
  names: string[],
  anchorIso: string
): { dayIsos: string[]; unknown: string[] } {
  const monday = startOfWeekMondayIso(anchorIso);
  const dayIsos: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const idx = weekdayNameToIndex(raw);
    if (idx == null) {
      unknown.push(raw);
      continue;
    }
    const iso = addDaysIso(monday, idx);
    if (seen.has(iso)) continue;
    seen.add(iso);
    dayIsos.push(iso);
  }
  dayIsos.sort();
  return { dayIsos, unknown };
}

/** Próximos `n` dias civis após `todayIso` (amanhã …). */
export function nextNDayIsosAfter(todayIso: string, n: number): string[] {
  const count = Math.max(0, Math.min(31, Math.floor(n)));
  return Array.from({ length: count }, (_, i) => addDaysIso(todayIso, i + 1));
}

/** Rótulo curto dd/mm. */
export function formatDayLabelPt(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}
