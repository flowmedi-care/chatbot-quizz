const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const { getClient, applyCors, pickTargetGroupJid } = require("./_lib.js");
const { parseTecConcursosPdf } = require("./_pdf-parser.js");
const { computeNextRunAt } = require("./_schedule.js");

const MAX_PDF_BYTES = 8 * 1024 * 1024;

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "JSON invalido" });
  }

  const name = String(body.name || "").trim();
  const pdfBase64 = String(body.pdfBase64 || "").trim();
  const targetGroupJidRaw = body.targetGroupJid ? String(body.targetGroupJid).trim() : "";
  const targetGroupJid = targetGroupJidRaw || pickTargetGroupJid();
  const createdByJid = body.createdByJid ? String(body.createdByJid).trim() : null;
  const previewOnly = Boolean(body.previewOnly);
  const activate = Boolean(body.activate);

  const sched = body.schedule || {};
  const questionsPerRun = clampInt(sched.questionsPerRun, 1, 20, 3);
  const intervalDays = clampInt(sched.intervalDays, 1, 30, 2);
  const sendHour = clampInt(sched.sendHour, 0, 23, 9);
  const sendMinute = clampInt(sched.sendMinute, 0, 59, 0);
  const timezone = String(sched.timezone || "America/Sao_Paulo");

  if (!previewOnly && !name) {
    return res.status(400).json({ error: "Informe um nome para o caderno." });
  }
  if (!previewOnly && !targetGroupJid) {
    return res.status(400).json({ error: "Sem grupo de destino configurado." });
  }
  if (!pdfBase64) {
    return res.status(400).json({ error: "Envie pdfBase64 (PDF em base64)." });
  }

  let pdfBuffer;
  try {
    const cleaned = pdfBase64.includes(",") ? pdfBase64.split(",", 2)[1] : pdfBase64;
    pdfBuffer = Buffer.from(cleaned, "base64");
  } catch {
    return res.status(400).json({ error: "pdfBase64 invalido." });
  }

  if (!pdfBuffer.length) {
    return res.status(400).json({ error: "PDF vazio." });
  }
  if (pdfBuffer.length > MAX_PDF_BYTES) {
    return res.status(413).json({ error: "PDF acima do limite de 8MB." });
  }

  let pdfText;
  try {
    const parsed = await pdfParse(pdfBuffer);
    pdfText = parsed.text || "";
  } catch (e) {
    console.error("[caderno-upload] pdf-parse:", e);
    return res.status(400).json({ error: `Erro ao ler PDF: ${e.message || "falha"}` });
  }

  const { questions, warnings, totalGabaritoEntries } = parseTecConcursosPdf(pdfText);

  if (questions.length === 0) {
    return res.status(400).json({
      error: "Nenhuma questao encontrada. Verifique se e um PDF do Tec Concursos.",
      warnings
    });
  }

  const previewSlice = questions.slice(0, 5).map(toPreviewQuestion);
  const summary = buildSummary(questions);

  if (previewOnly) {
    return res.status(200).json({
      previewOnly: true,
      totalQuestions: questions.length,
      totalGabaritoEntries,
      summary,
      warnings,
      preview: previewSlice
    });
  }

  let supabase;
  try {
    supabase = getClient();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const validForInsert = questions.filter((q) => q.answerKey && q.statementText);
  const skipped = questions.length - validForInsert.length;
  if (skipped > 0) {
    warnings.push(
      `${skipped} questao(oes) ignorada(s) por nao ter enunciado ou gabarito mapeado.`
    );
  }

  if (validForInsert.length === 0) {
    return res.status(400).json({
      error: "Nenhuma questao com gabarito mapeado para salvar.",
      warnings
    });
  }

  const nowDate = new Date();
  const status = activate ? "active" : "inactive";
  const nextRunAt = activate
    ? computeNextRunAt(nowDate, sendHour, sendMinute, timezone, 0).toISOString()
    : null;

  const { data: cadernoRow, error: cadernoErr } = await supabase
    .from("cadernos")
    .insert({
      name,
      target_group_jid: targetGroupJid,
      created_by_jid: createdByJid,
      questions_per_run: questionsPerRun,
      interval_days: intervalDays,
      send_hour: sendHour,
      send_minute: sendMinute,
      timezone,
      status,
      cursor: 0,
      next_run_at: nextRunAt
    })
    .select("id")
    .single();

  if (cadernoErr || !cadernoRow) {
    console.error("[caderno-upload] insert caderno:", cadernoErr);
    return res
      .status(500)
      .json({ error: `Erro ao criar caderno: ${cadernoErr?.message || "sem dados"}` });
  }

  const cadernoId = cadernoRow.id;

  const rows = validForInsert.map((q) => ({
    caderno_id: cadernoId,
    position: q.position,
    tec_question_id: q.tecQuestionId,
    tec_url: q.tecUrl,
    banca: q.banca,
    subject: q.subject,
    question_type: q.questionType,
    statement_text: q.statementText,
    answer_key: q.answerKey
  }));

  const { error: bulkErr } = await supabase.from("caderno_questions").insert(rows);
  if (bulkErr) {
    await supabase.from("cadernos").delete().eq("id", cadernoId);
    console.error("[caderno-upload] insert questoes:", bulkErr);
    return res.status(500).json({ error: `Erro ao salvar questoes: ${bulkErr.message}` });
  }

  return res.status(200).json({
    cadernoId,
    name,
    targetGroupJid,
    totalQuestions: validForInsert.length,
    totalGabaritoEntries,
    status,
    nextRunAt,
    summary,
    warnings,
    preview: previewSlice
  });
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function toPreviewQuestion(q) {
  return {
    position: q.position,
    tecUrl: q.tecUrl,
    banca: q.banca,
    subject: q.subject,
    questionType: q.questionType,
    statementText: q.statementText,
    answerKey: q.answerKey
  };
}

function buildSummary(questions) {
  let mc = 0;
  let tf = 0;
  let withoutKey = 0;
  for (const q of questions) {
    if (q.questionType === "true_false") tf += 1;
    else mc += 1;
    if (!q.answerKey) withoutKey += 1;
  }
  return { multipleChoice: mc, trueFalse: tf, withoutAnswerKey: withoutKey };
}

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "12mb" }
  }
};
