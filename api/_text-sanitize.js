/**
 * PostgreSQL (via PostgREST/JSON) rejeita strings com U+0000 e pares surrogate inválidos.
 * PDFs do Tec Concursos às vezes incluem bytes nulos no texto extraído por pdf-parse.
 */
function sanitizePostgresText(value) {
  if (value == null || value === "") return value;
  const s = String(value);
  if (!s.includes("\u0000") && !/[\uD800-\uDFFF]/.test(s)) return s;
  return s
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

module.exports = { sanitizePostgresText };
