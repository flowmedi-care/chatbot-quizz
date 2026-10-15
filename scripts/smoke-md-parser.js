/**
 * Uso: node scripts/smoke-md-parser.js
 */
const { parseCadernoMarkdown } = require("../api/_md-parser.js");
const { normalizeIncomingQuestions } = require("../api/_caderno-create.js");

const sample = `# Políticas Públicas — bloco 1

## Q1
tipo: certo_errado
gabarito: C
banca: INÉDITA
materia: Políticas públicas
tec_id:

A política pública X caracteriza-se por ser inédita neste caderno.

Certo
Errado

## Q2
tipo: multiple_choice
gabarito: B
banca: INÉDITA
materia: Políticas públicas

Segundo o ciclo de políticas públicas, a etapa que precede a formulação é:

a) formulação ocorre após a avaliação
b) agenda precede a formulação
c) implementação independe de atores
d) avaliação encerra o ciclo sem feedback
e) o ciclo tem etapas rígidas e sem retorno
`;

const parsed = parseCadernoMarkdown(sample);
const normalized = normalizeIncomingQuestions(parsed.questions);
if (parsed.questions.length !== 2) {
  throw new Error(`esperava 2 questões, veio ${parsed.questions.length}`);
}
if (normalized.questions.length !== 2) {
  throw new Error(`normalização perdeu questões: ${normalized.warnings.join("; ")}`);
}
if (normalized.questions[0].questionType !== "true_false") {
  throw new Error(`Q1 tipo ${normalized.questions[0].questionType}`);
}
if (normalized.questions[0].answerKey !== "C") {
  throw new Error(`Q1 gabarito ${normalized.questions[0].answerKey}`);
}
if (normalized.questions[1].answerKey !== "B") {
  throw new Error(`Q2 gabarito ${normalized.questions[1].answerKey}`);
}
if (!/agenda precede/i.test(normalized.questions[1].statementText)) {
  throw new Error("Q2 enunciado sem alternativas");
}
console.log("smoke-md-parser: ok", normalized.questions.map((q) => q.answerKey).join(", "));
