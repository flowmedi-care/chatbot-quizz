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

module.exports = { computeNextRunAt, firstDailySlotUtc, getZonedParts, zonedDateToUtc };
