/** Alternativas estruturadas + enunciado publicável (A) texto…). */

function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const label = String(item.label || item.letter || "")
      .trim()
      .toUpperCase()
      .slice(0, 8);
    const text = String(item.text || "").trim();
    if (!label) continue;
    out.push({ label, text });
  }
  return out;
}

function formatStatementWithOptions(statement, options, questionType) {
  const base = String(statement || "").trim();
  if (questionType === "true_false" || questionType === "certo_errado") {
    return base;
  }
  const opts = normalizeOptions(options);
  if (!opts.length) return base;
  if (/^[A-E]\)/m.test(base)) return base;
  const altText = opts
    .map((o) => (o.text ? `${o.label}) ${o.text}` : `${o.label})`))
    .join("\n");
  return altText ? `${base}\n\n${altText}` : base;
}

function mapQuestionType(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (t === "true_false" || t === "certo_errado" || t === "ce") return "true_false";
  return "multiple_choice";
}

function mapAnswerKey(raw, questionType) {
  const v = String(raw || "").trim();
  if (!v) return null;
  if (questionType === "true_false") {
    if (/^certo$/i.test(v) || v.toUpperCase() === "C") return "C";
    if (/^errado$/i.test(v) || v.toUpperCase() === "E") return "E";
  }
  const letter = v.toUpperCase().slice(0, 1);
  return /^[A-E]$/.test(letter) ? letter : null;
}

module.exports = {
  normalizeOptions,
  formatStatementWithOptions,
  mapQuestionType,
  mapAnswerKey
};
