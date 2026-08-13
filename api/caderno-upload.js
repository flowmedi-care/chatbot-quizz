const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const { getClient, applyCors, pickTargetGroupJid } = require("./_lib.js");
const { parseTecConcursosPdf } = require("./_pdf-parser.js");
const { checkFlashcardsInboundAuth } = require("./_flashcards-inbound-auth.js");
const {
  parseSchedule,
  normalizeIncomingQuestions,
  insertCadernoBundle,
  buildSummary
} = require("./_caderno-create.js");
const { normalizeOptions } = require("./_statement-options.js");

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

  const fromJson = Array.isArray(body.questions) && body.questions.length > 0;
  const path = String(
    req.headers["x-vercel-original-path"] ||
      req.headers["x-invoke-path"] ||
      (req.url ? new URL(req.url, "http://localhost").pathname : "") ||
      ""
  ).toLowerCase();
  const forceJson = fromJson || path.includes("caderno-from-json") || String(req.query?.mode || "") === "json";

  if (forceJson) {
    const auth = checkFlashcardsInboundAuth(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }
  }

  const name = String(body.name || "").trim();
  const pdfBase64 = String(body.pdfBase64 || "").trim();
  const targetGroupJidRaw = body.targetGroupJid ? String(body.targetGroupJid).trim() : "";
  const targetGroupJid = targetGroupJidRaw || pickTargetGroupJid();
  const createdByJid = body.createdByJid ? String(body.createdByJid).trim() : null;
  const privateRecipientsRaw = Array.isArray(body.privateRecipients) ? body.privateRecipients : [];
  const byRecipientJid = new Map();
  for (const item of privateRecipientsRaw) {
    const userJid = item.userJid != null ? String(item.userJid).trim() : "";
    if (!userJid) continue;
    byRecipientJid.set(userJid, item);
  }
  const privateRecipientsNorm = [...byRecipientJid.values()];
  const firstActiveJid = privateRecipientsNorm.find((i) => i.active !== false)?.userJid;
  const effectiveCreatedBy =
    (createdByJid && createdByJid.trim()) || (firstActiveJid ? String(firstActiveJid).trim() : null);

  const previewOnly = Boolean(body.previewOnly);
  const activate = Boolean(body.activate);
  const deliveryMode = body.deliveryMode === "private" ? "private" : "group";
  const originNotebookId = body.originNotebookId ? String(body.originNotebookId).trim() : null;
  const schedule = parseSchedule(body.schedule || {});

  if (!previewOnly && !name) {
    return res.status(400).json({ error: "Informe um nome para o caderno." });
  }
  if (!previewOnly && !targetGroupJid) {
    return res.status(400).json({ error: "Sem grupo de destino configurado." });
  }
  if (!previewOnly && deliveryMode === "private") {
    if (!effectiveCreatedBy) {
      return res.status(400).json({
        error:
          "Caderno privado: selecione ao menos um participante do engajamento ou envie createdByJid."
      });
    }
    if (privateRecipientsNorm.length > 0 && !firstActiveJid) {
      return res.status(400).json({ error: "Marque ao menos um destinatário ativo no modo privado." });
    }
  }

  let questions = [];
  let warnings = [];
  let totalGabaritoEntries = 0;

  if (forceJson) {
    const parsed = normalizeIncomingQuestions(body.questions);
    questions = parsed.questions;
    warnings = parsed.warnings;
    totalGabaritoEntries = questions.length;
    if (questions.length === 0) {
      return res.status(400).json({ error: "Nenhuma questao valida no JSON.", warnings });
    }
  } else {
    if (!pdfBase64) {
      return res.status(400).json({ error: "Envie pdfBase64 (PDF em base64) ou questions (JSON)." });
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
    const parsed = parseTecConcursosPdf(pdfText);
    questions = (parsed.questions || []).map((q) => ({
      ...q,
      options: normalizeOptions(
        (q.alternatives || []).map((a) => ({ label: a.letter, text: a.text }))
      )
    }));
    warnings = parsed.warnings || [];
    totalGabaritoEntries = parsed.totalGabaritoEntries || 0;
  }

  if (questions.length === 0) {
    return res.status(400).json({
      error: "Nenhuma questao encontrada.",
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

  try {
    const created = await insertCadernoBundle(supabase, {
      name,
      targetGroupJid,
      effectiveCreatedBy,
      deliveryMode,
      activate,
      originNotebookId,
      schedule,
      questions: validForInsert,
      privateRecipientsNorm
    });
    return res.status(200).json({
      cadernoId: created.cadernoId,
      name,
      targetGroupJid,
      deliveryMode,
      originNotebookId,
      totalQuestions: validForInsert.length,
      totalGabaritoEntries,
      status: created.status,
      nextRunAt: created.nextRunAt,
      summary,
      warnings,
      preview: previewSlice
    });
  } catch (e) {
    console.error("[caderno-upload]", e);
    return res.status(500).json({ error: e.message || "Erro ao criar caderno" });
  }
};

function toPreviewQuestion(q) {
  return {
    position: q.position,
    tecUrl: q.tecUrl,
    banca: q.banca,
    subject: q.subject,
    questionType: q.questionType,
    statementText: q.statementText,
    answerKey: q.answerKey,
    options: q.options || []
  };
}

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: "12mb" }
  }
};
