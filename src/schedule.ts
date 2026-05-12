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
