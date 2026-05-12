/**
 * Parser dos PDFs do Tec Concursos (formato uniforme nos dois exemplos
 * fornecidos: SEFAZ PI / TCU).
 *
 * Entrada: texto já extraído do PDF (via pdf-parse).
 * Saída:
 *   {
 *     questions: ParsedQuestion[],
 *     warnings: string[]
 *   }
 *
 * Padrão observado:
 *   - Cada questão começa com uma linha `www.tecconcursos.com.br/questoes/<ID>`.
 *   - Logo abaixo, 1 linha "banca/concurso" e 1 linha "matéria - assunto".
 *   - Enunciado em múltiplas linhas até a primeira alternativa.
 *   - Alternativas: linhas `a) ... b) ... c) ... d) ... e) ...` (múltipla
 *     escolha) OU duas linhas literais `Certo` e `Errado` (CEBRASPE).
 *   - Após a última questão, linha `Gabarito` seguida de entradas
 *     `N) Letra` ou `N) Certo/Errado`.
 *   - Ruído: linhas isoladas `\d+\)`, rodapés `-- N of N --`, headers do
 *     PDF (`apagar`, `Ordenação:...`, URL do caderno em `/s/...`).
 */

const QUESTION_URL_RE = /^www\.tecconcursos\.com\.br\/questoes\/(\d+)\s*$/i;
const BARE_NUMBER_MARKER_RE = /^\d+\)\s*$/;
const PAGE_FOOTER_RE = /^--\s+\d+\s+of\s+\d+\s+--$/i;
const ORDENACAO_RE = /^Ordenação:/i;
const CADERNO_URL_RE = /^https:\/\/www\.tecconcursos\.com\.br\/s\//i;
const APAGAR_LINE_RE = /^apagar$/i;
const GABARITO_HEADER_RE = /^Gabarito\s*$/i;
const ALT_MC_RE = /^([a-e])\)\s*(.*)$/i;
const ALT_CERTO_RE = /^Certo\s*$/i;
const ALT_ERRADO_RE = /^Errado\s*$/i;
const GABARITO_ENTRY_RE = /(\d+)\)\s*(Certo|Errado|[A-E])\b/gi;

function isNoise(line) {
  if (!line) return true;
  if (BARE_NUMBER_MARKER_RE.test(line)) return true;
  if (PAGE_FOOTER_RE.test(line)) return true;
  if (ORDENACAO_RE.test(line)) return true;
  if (CADERNO_URL_RE.test(line)) return true;
  if (APAGAR_LINE_RE.test(line)) return true;
  return false;
}

function normalizeLines(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim());
}

/**
 * Acha o índice da primeira linha de alternativa (a) ou `Certo`).
 * Retorna -1 se não achar.
 */
function findFirstAlternativeIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (ALT_MC_RE.test(l) || ALT_CERTO_RE.test(l)) return i;
  }
  return -1;
}

function buildMultipleChoiceAlternatives(altLines) {
  const result = [];
  let current = null;
  for (const line of altLines) {
    const m = line.match(ALT_MC_RE);
    if (m) {
      if (current) result.push(current);
      current = { letter: m[1].toLowerCase(), text: (m[2] || "").trim() };
    } else if (current) {
      const extra = line.trim();
      if (extra) current.text = `${current.text} ${extra}`.trim();
    }
  }
  if (current) result.push(current);
  return result;
}

/**
 * Junta enunciado em uma string só, preservando quebra entre parágrafos
 * mas reaglutinando linhas que parecem só wrap do PDF.
 */
function joinStatementLines(statementLines) {
  const text = statementLines
    .filter((l) => l && l.length > 0)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text;
}

/**
 * Monta o `statement_text` final que vai ao grupo: enunciado + alternativas
 * inline (MC). Para true_false, só o enunciado (o bot publica as opções
 * c/e no rodapé da mensagem).
 */
function buildPublishableStatement(statement, type, alternatives) {
  if (type === "true_false") {
    return statement;
  }
  const altText = alternatives.map((a) => `${a.letter}) ${a.text}`).join("\n");
  return altText ? `${statement}\n\n${altText}` : statement;
}

function parseGabarito(tailLines) {
  const map = new Map();
  const text = tailLines.join(" ");
  let match;
  GABARITO_ENTRY_RE.lastIndex = 0;
  while ((match = GABARITO_ENTRY_RE.exec(text)) !== null) {
    const position = parseInt(match[1], 10);
    const raw = match[2];
    let value;
    if (/^certo$/i.test(raw)) value = "C";
    else if (/^errado$/i.test(raw)) value = "E";
    else value = raw.toUpperCase();
    if (!Number.isFinite(position)) continue;
    if (!map.has(position)) map.set(position, value);
  }
  return map;
}

/**
 * @typedef {{
 *   position: number,
 *   tecQuestionId: string,
 *   tecUrl: string,
 *   banca: string | null,
 *   subject: string | null,
 *   questionType: "multiple_choice" | "true_false",
 *   statementText: string,
 *   alternatives: { letter: string, text: string }[],
 *   answerKey: string | null
 * }} ParsedQuestion
 */

/**
 * @param {string} rawText
 * @returns {{ questions: ParsedQuestion[], warnings: string[], totalGabaritoEntries: number }}
 */
function parseTecConcursosPdf(rawText) {
  const warnings = [];
  const all = normalizeLines(rawText);

  const gabIdx = all.findIndex((l) => GABARITO_HEADER_RE.test(l));
  const bodyLines = gabIdx >= 0 ? all.slice(0, gabIdx) : all;
  const tailLines = gabIdx >= 0 ? all.slice(gabIdx + 1) : [];

  if (gabIdx < 0) {
    warnings.push("Linha 'Gabarito' não encontrada — questões ficarão sem resposta.");
  }

  const cleanBody = bodyLines.filter((l) => !isNoise(l));

  const blocks = [];
  let current = null;
  for (const line of cleanBody) {
    const m = line.match(QUESTION_URL_RE);
    if (m) {
      if (current) blocks.push(current);
      current = {
        tecQuestionId: m[1],
        tecUrl: `https://${line}`,
        lines: []
      };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);

  if (blocks.length === 0) {
    warnings.push("Nenhuma questão encontrada (anchor www.tecconcursos.com.br/questoes/ ausente).");
    return { questions: [], warnings, totalGabaritoEntries: 0 };
  }

  const gabaritoMap = parseGabarito(tailLines);

  const questions = blocks.map((block, idx) => {
    const position = idx + 1;
    const banca = block.lines[0] || null;
    const subject = block.lines[1] || null;
    const remainder = block.lines.slice(2);

    const firstAlt = findFirstAlternativeIndex(remainder);
    const statementLines = firstAlt >= 0 ? remainder.slice(0, firstAlt) : remainder;
    const altLines = firstAlt >= 0 ? remainder.slice(firstAlt) : [];

    const isTrueFalse = altLines.some((l) => ALT_CERTO_RE.test(l));
    const questionType = isTrueFalse ? "true_false" : "multiple_choice";

    const alternatives = isTrueFalse ? [] : buildMultipleChoiceAlternatives(altLines);

    if (questionType === "multiple_choice" && alternatives.length !== 5) {
      warnings.push(
        `Questão #${position} (${block.tecQuestionId}): esperava 5 alternativas, achei ${alternatives.length}.`
      );
    }

    const statement = joinStatementLines(statementLines);
    if (!statement) {
      warnings.push(
        `Questão #${position} (${block.tecQuestionId}): enunciado vazio após extração.`
      );
    }

    const finalStatement = buildPublishableStatement(statement, questionType, alternatives);
    const answerKey = gabaritoMap.get(position) || null;
    if (!answerKey) {
      warnings.push(`Questão #${position} (${block.tecQuestionId}): sem entrada no gabarito.`);
    } else if (questionType === "multiple_choice" && !/^[A-E]$/.test(answerKey)) {
      warnings.push(
        `Questão #${position}: gabarito '${answerKey}' não combina com tipo múltipla escolha.`
      );
    } else if (questionType === "true_false" && !/^[CE]$/.test(answerKey)) {
      warnings.push(
        `Questão #${position}: gabarito '${answerKey}' não combina com tipo certo/errado.`
      );
    }

    return {
      position,
      tecQuestionId: block.tecQuestionId,
      tecUrl: block.tecUrl,
      banca,
      subject,
      questionType,
      statementText: finalStatement,
      alternatives,
      answerKey
    };
  });

  return {
    questions,
    warnings,
    totalGabaritoEntries: gabaritoMap.size
  };
}

module.exports = { parseTecConcursosPdf };
