/**
 * Parser de caderno em Markdown (questões de IA / convertidas do Estratégia).
 *
 * Formato:
 *   # Título opcional
 *
 *   ## Q1
 *   tipo: certo_errado | multiple_choice
 *   gabarito: C
 *   banca: INÉDITA
 *   materia: Políticas públicas
 *   tec_id:
 *
 *   Enunciado...
 *
 *   Certo
 *   Errado
 *
 *   ## Q2
 *   tipo: multiple_choice
 *   gabarito: B
 *
 *   Enunciado...
 *
 *   a) ...
 *   b) ...
 */

const { sanitizePostgresText } = require("./_text-sanitize.js");

const META_RE = /^(tipo|gabarito|banca|materia|matéria|subject|tec_id|tec_url|url)\s*:\s*(.*)$/i;
const ALT_MC_RE = /^([a-e])\)\s*(.*)$/i;
const SECTION_RE = /^##\s+Q(\d+)\s*$/im;

function parseMetaValue(key, raw) {
  const k = String(key || "").toLowerCase();
  const v = String(raw || "").trim();
  if (k === "matéria") return { subject: v };
  if (k === "url") return { tecUrl: v };
  if (k === "tipo") return { questionType: v };
  if (k === "gabarito") return { answerKey: v };
  if (k === "banca") return { banca: v };
  if (k === "materia" || k === "subject") return { subject: v };
  if (k === "tec_id") return { tecQuestionId: v };
  if (k === "tec_url") return { tecUrl: v };
  return {};
}

function splitStatementAndOptions(bodyLines) {
  const options = [];
  let altStart = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (ALT_MC_RE.test(line)) {
      altStart = i;
      break;
    }
    if (/^certo\s*$/i.test(line) && i + 1 < bodyLines.length && /^errado\s*$/i.test(bodyLines[i + 1])) {
      altStart = i;
      break;
    }
  }
  if (altStart < 0) {
    return { statement: bodyLines.join("\n").trim(), options };
  }
  const statement = bodyLines.slice(0, altStart).join("\n").trim();
  const rest = bodyLines.slice(altStart);
  if (rest.length >= 2 && /^certo\s*$/i.test(rest[0]) && /^errado\s*$/i.test(rest[1])) {
    options.push({ label: "C", text: "Certo" }, { label: "E", text: "Errado" });
    return { statement, options };
  }
  for (const line of rest) {
    const m = line.match(ALT_MC_RE);
    if (!m) continue;
    options.push({ label: m[1].toUpperCase(), text: String(m[2] || "").trim() });
  }
  return { statement, options };
}

function inferType(metaType, options) {
  const t = String(metaType || "").toLowerCase().trim();
  if (t === "true_false" || t === "certo_errado" || t === "ce") return "true_false";
  if (t === "multiple_choice" || t === "multipla" || t === "múltipla") return "multiple_choice";
  const labels = options.map((o) => o.label);
  if (labels.includes("C") && labels.includes("E") && options.length === 2) return "true_false";
  return "multiple_choice";
}

function parseCadernoMarkdown(raw) {
  const text = String(raw || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  const warnings = [];
  const questions = [];
  if (!text) {
    return { questions, warnings: ["Markdown vazio."] };
  }

  const parts = text.split(/^(?=##\s+Q\d+\s*$)/im);
  for (const part of parts) {
    const header = part.match(/^##\s+Q(\d+)\s*$/im);
    if (!header) continue;
    const position = Number(header[1]);
    const afterHeader = part.replace(/^##\s+Q\d+\s*$/im, "").trim();
    const lines = afterHeader.split("\n");
    const meta = {};
    let bodyStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        if (Object.keys(meta).length) {
          bodyStart = i + 1;
          break;
        }
        continue;
      }
      const mm = trimmed.match(META_RE);
      if (!mm) {
        bodyStart = i;
        break;
      }
      Object.assign(meta, parseMetaValue(mm[1], mm[2]));
      bodyStart = i + 1;
    }
    const bodyLines = lines.slice(bodyStart).map((l) => l.trimEnd());
    while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
    const { statement, options } = splitStatementAndOptions(bodyLines);
    if (!statement) {
      warnings.push(`Questão #${position}: sem enunciado.`);
      continue;
    }
    const questionType = inferType(meta.questionType, options);
    const tecId = meta.tecQuestionId ? sanitizePostgresText(String(meta.tecQuestionId)) : null;
    questions.push({
      position: Number.isFinite(position) ? position : questions.length + 1,
      questionType,
      answerKey: meta.answerKey || "",
      banca: meta.banca || null,
      subject: meta.subject || null,
      tecQuestionId: tecId || null,
      tecUrl: meta.tecUrl || "",
      statement,
      statementText: statement,
      options
    });
  }

  if (!questions.length) {
    warnings.push("Nenhuma seção ## Q1, ## Q2… encontrada. Use o formato do guia.");
  }

  questions.sort((a, b) => a.position - b.position);
  questions.forEach((q, i) => {
    q.position = i + 1;
  });
  return { questions, warnings };
}

module.exports = { parseCadernoMarkdown };
