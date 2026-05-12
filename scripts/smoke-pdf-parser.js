/**
 * Smoke test do parser: roda o pdf-parse + parseTecConcursosPdf nos dois
 * PDFs de exemplo e imprime totais + sample. Não faz nenhuma I/O em Supabase.
 *
 * Uso:  node scripts/smoke-pdf-parser.js
 */

const fs = require("node:fs");
const path = require("node:path");
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const { parseTecConcursosPdf } = require("../api/_pdf-parser.js");

const FILES = [
  { label: "SEFAZ PI", path: "C:/Users/Daniel Ranna/Desktop/sefaz PI.pdf" },
  { label: "TCU", path: "C:/Users/Daniel Ranna/Desktop/TCU.pdf" }
];

async function main() {
  for (const f of FILES) {
    if (!fs.existsSync(f.path)) {
      console.log(`[skip] ${f.label}: arquivo nao encontrado em ${f.path}`);
      continue;
    }
    const buf = fs.readFileSync(f.path);
    const parsedPdf = await pdfParse(buf);
    const { questions, warnings, totalGabaritoEntries } = parseTecConcursosPdf(parsedPdf.text);

    const types = questions.reduce(
      (acc, q) => {
        acc[q.questionType] = (acc[q.questionType] || 0) + 1;
        return acc;
      },
      {}
    );

    console.log("=".repeat(60));
    console.log(`${f.label} — ${path.basename(f.path)}`);
    console.log(`Total questões: ${questions.length}`);
    console.log(`Tipos: ${JSON.stringify(types)}`);
    console.log(`Gabaritos no rodapé: ${totalGabaritoEntries}`);
    console.log(`Sem gabarito mapeado: ${questions.filter((q) => !q.answerKey).length}`);
    console.log(`Avisos: ${warnings.length}`);
    if (warnings.length) {
      console.log(warnings.slice(0, 6).map((w) => `  - ${w}`).join("\n"));
      if (warnings.length > 6) console.log(`  … (${warnings.length - 6} avisos a mais)`);
    }

    const first = questions[0];
    if (first) {
      console.log("--- Primeira questão ---");
      console.log("URL:", first.tecUrl);
      console.log("Banca:", first.banca);
      console.log("Matéria:", first.subject);
      console.log("Tipo:", first.questionType, "| Gabarito:", first.answerKey);
      console.log("Enunciado:", first.statementText.slice(0, 240) + (first.statementText.length > 240 ? "…" : ""));
    }
    const last = questions[questions.length - 1];
    if (last && last !== first) {
      console.log("--- Última questão ---");
      console.log("URL:", last.tecUrl);
      console.log("Tipo:", last.questionType, "| Gabarito:", last.answerKey);
      console.log("Enunciado:", last.statementText.slice(0, 240) + (last.statementText.length > 240 ? "…" : ""));
    }
  }
}

main().catch((e) => {
  console.error("Falha no smoke:", e);
  process.exit(1);
});
