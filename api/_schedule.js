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

/** Modo lote: todas as questões do dia liberam no horário de início. */
function dailySlotUtc(dayIso, startHour, startMinute, endHour, endMinute, questionsPerDay, index, timeZone) {
  void endHour;
  void endMinute;
  void questionsPerDay;
  void index;
  const [y, m, d] = dayIso.split("-").map((s) => Number(s));
  return zonedDateToUtc(y, m, d, startHour, startMinute, timeZone);
}

function resolveDailySlotUtc(dayIso, index, timeZone, schedule) {
  void index;
  const [y, m, d] = dayIso.split("-").map((s) => Number(s));
  return zonedDateToUtc(y, m, d, schedule.startHour, schedule.startMinute, timeZone);
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
  addDaysIso,
  getZonedParts,
  zonedDateToUtc,
  weekdayIndexMondayFirst,
  startOfWeekMondayIso,
  weekDayIsos,
  monthDayIsos,
  startOfMonthIso,
  formatDayLabelPt
};

function weekdayIndexMondayFirst(isoDate) {
  const [y, m, d] = isoDate.split("-").map((s) => Number(s));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const utcDay = dt.getUTCDay();
  return utcDay === 0 ? 6 : utcDay - 1;
}

function startOfWeekMondayIso(isoDate) {
  return addDaysIso(isoDate, -weekdayIndexMondayFirst(isoDate));
}

function weekDayIsos(isoDate) {
  const monday = startOfWeekMondayIso(isoDate);
  return Array.from({ length: 7 }, (_, i) => addDaysIso(monday, i));
}

function startOfMonthIso(yearMonthOrDay) {
  const raw = String(yearMonthOrDay || "").trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw.slice(0, 7)}-01`;
  throw new Error(`Mês inválido: ${yearMonthOrDay}`);
}

function monthDayIsos(yearMonthOrDay) {
  const first = startOfMonthIso(yearMonthOrDay);
  const [y, m] = first.split("-").map((s) => Number(s));
  const daysInMonth = new Date(Date.UTC(y, m, 0, 12, 0, 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, i) => addDaysIso(first, i));
}

function formatDayLabelPt(isoDate) {
  const [, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}

