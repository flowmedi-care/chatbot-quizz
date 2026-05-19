/**
 * Validação e normalização de send_times (horário por questão do dia).
 */

function parseSendTimes(raw) {
  if (raw == null) return null;
  let arr = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const item of arr) {
    if (item == null || typeof item !== "object") continue;
    const hour = Number(item.hour);
    const minute = Number(item.minute ?? 0);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) continue;
    out.push({ hour, minute });
  }
  return out.length ? out : null;
}

/** Exige exatamente `questionsPerDay` horários em ordem não decrescente. */
function normalizeSendTimesForDay(raw, questionsPerDay) {
  const parsed = parseSendTimes(raw);
  const n = Math.max(1, Math.min(24, Number(questionsPerDay) || 1));
  if (!parsed || parsed.length !== n) return null;
  let prev = -1;
  for (const slot of parsed) {
    const mins = slot.hour * 60 + slot.minute;
    if (mins < prev) return null;
    prev = mins;
  }
  return parsed;
}

function formatSendTimesList(times) {
  if (!times || !times.length) return "";
  return times
    .map((t) => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`)
    .join(", ");
}

module.exports = { parseSendTimes, normalizeSendTimesForDay, formatSendTimesList };
