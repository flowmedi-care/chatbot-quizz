/**
 * Cálculo de `next_run_at` para um caderno.
 *
 * Recebe hora/minuto e timezone (ex.: 'America/Sao_Paulo'); retorna a próxima
 * data UTC em que o envio deve acontecer.
 *
 * Estratégia simples (sem libs):
 *  1. Pega `now` no fuso configurado (via Intl.DateTimeFormat).
 *  2. Monta o "alvo de hoje" naquele fuso com hh:mm; se já passou, avança 1 dia.
 *  3. Converte o alvo para UTC iterativamente (corrige offset uma vez).
 *
 * É suficiente para cadernos do dia-a-dia. Pode dar um deslize de 1h em
 * dias de virada de horário de verão; é aceitável para essa feature.
 */

function getZonedParts(date, timeZone) {
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
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "00" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

/** Converte uma data "vivendo no fuso X" para o instante UTC equivalente. */
function zonedDateToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const guessDate = new Date(guess);
  const zoned = getZonedParts(guessDate, timeZone);
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

/**
 * Próximo envio a partir de `from`.
 * @param {Date} from
 * @param {number} sendHour
 * @param {number} sendMinute
 * @param {string} timeZone
 * @param {number} intervalDays minimum days to wait. Se >=1, força avançar pelo menos 1 dia.
 *   Quando chamado para "agendar pela primeira vez" passe 0 — se hora ainda não passou hoje, dispara hoje.
 *   Quando chamado após um envio, passe `interval_days` (≥1).
 */
function computeNextRunAt(from, sendHour, sendMinute, timeZone, intervalDays) {
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

/**
 * Primeiro envio do "modelo diário" a partir de `from`.
 * Se `start_hour:start_minute` no fuso ainda não passou hoje, devolve hoje;
 * caso contrário, agenda para amanhã.
 *
 * Usado quando o caderno é criado/ativado: queremos que o ciclo do dia
 * comece no próximo `start_time` (não disparar imediato fora do horário).
 */
function firstDailySlotUtc(from, startHour, startMinute, timeZone) {
  const zonedNow = getZonedParts(from, timeZone);
  let candidate = zonedDateToUtc(
    zonedNow.year,
    zonedNow.month,
    zonedNow.day,
    startHour,
    startMinute,
    timeZone
  );
  if (candidate.getTime() <= from.getTime()) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

function dateIsoInTimezone(date, timeZone) {
  const z = getZonedParts(date, timeZone);
  const mm = z.month < 10 ? `0${z.month}` : String(z.month);
  const dd = z.day < 10 ? `0${z.day}` : String(z.day);
  return `${z.year}-${mm}-${dd}`;
}

function addDaysIso(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map((s) => Number(s));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = dt.getUTCMonth() + 1;
  const dd = dt.getUTCDate();
  return `${yy}-${mm < 10 ? `0${mm}` : mm}-${dd < 10 ? `0${dd}` : dd}`;
}

function dailySlotUtc(dayIso, startHour, startMinute, endHour, endMinute, questionsPerDay, index, timeZone) {
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

function resolveDailySlotUtc(dayIso, index, timeZone, schedule) {
  const N = Math.max(1, schedule.questionsPerDay || 1);
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

function firstSlotFromSchedule(from, timeZone, schedule) {
  const dayIso = dateIsoInTimezone(from, timeZone);
  let slot = resolveDailySlotUtc(dayIso, 0, timeZone, schedule);
  if (slot.getTime() <= from.getTime()) {
    const nextDay = addDaysIso(dayIso, 1);
    slot = resolveDailySlotUtc(nextDay, 0, timeZone, schedule);
  }
  return slot;
}

module.exports = {
  computeNextRunAt,
  firstDailySlotUtc,
  firstSlotFromSchedule,
  resolveDailySlotUtc,
  dailySlotUtc,
  dateIsoInTimezone,
  getZonedParts,
  zonedDateToUtc
};

