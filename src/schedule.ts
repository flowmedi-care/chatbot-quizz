/**
 * Cálculo de `next_run_at` para um caderno. Equivalente TS ao `api/_schedule.js`.
 *
 *  - Pega `now` no fuso configurado (via Intl.DateTimeFormat).
 *  - Monta o "alvo de hoje" naquele fuso com hh:mm; se intervalDays>0 soma
 *    `intervalDays` dias; senão se já passou hoje, joga para amanhã.
 */

function getZonedParts(date: Date, timeZone: string): {
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
 * Usa `sendTimes` quando definido com N itens; senão distribui uniformemente entre início e fim.
 */
export function resolveDailySlotUtc(
  dayIso: string,
  index: number,
  timeZone: string,
  schedule: DailyScheduleSlots
): Date {
  const N = Math.max(1, schedule.questionsPerDay);
  const safeIndex = Math.min(Math.max(0, index), N - 1);
  const times = schedule.sendTimes;
  if (times && times.length >= N && times[safeIndex]) {
    const [y, m, d] = dayIso.split("-").map((s) => Number(s));
    const slot = times[safeIndex];
    return zonedDateToUtc(y, m, d, slot.hour, slot.minute, timeZone);
  }
  return dailySlotUtc(
    dayIso,
    schedule.startHour,
    schedule.startMinute,
    schedule.endHour,
    schedule.endMinute,
    N,
    safeIndex,
    timeZone
  );
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
 * Instante UTC do slot `index` (0..N-1) no dia `dayIso` (YYYY-MM-DD no fuso `timeZone`).
 * Distribui as N questões **uniformemente entre início e fim** (inclusive), no mesmo dia local.
 * Se fim <= início, cai no comportamento antigo: espaçamento 24h/N a partir do início.
 *
 * Ex.: N=2, 07:00–22:00 ⇒ 07:00 e 22:00. N=5 ⇒ 5 pontos ao longo de 15h.
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
  const [y, m, d] = dayIso.split("-").map((s) => Number(s));
  const safeN = Math.max(1, questionsPerDay);
  const safeIndex = Math.min(Math.max(0, index), safeN - 1);
  const start = zonedDateToUtc(y, m, d, startHour, startMinute, timeZone);
  const end = zonedDateToUtc(y, m, d, endHour, endMinute, timeZone);
  let windowMs = end.getTime() - start.getTime();

  if (windowMs <= 0) {
    const gapMs = Math.round((24 * 60 * 60 * 1000) / safeN);
    return new Date(start.getTime() + safeIndex * gapMs);
  }

  if (safeN <= 1) return start;
  const offsetMs = (windowMs * safeIndex) / (safeN - 1);
  return new Date(start.getTime() + offsetMs);
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
