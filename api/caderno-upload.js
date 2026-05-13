const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const { getClient, applyCors, pickTargetGroupJid } = require("./_lib.js");
const { parseTecConcursosPdf } = require("./_pdf-parser.js");
const { firstDailySlotUtc } = require("./_schedule.js");

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

  const sched = body.schedule || {};
  // Modelo novo: questionsPerDay + startHour/startMinute + waitForAnswers.
  // Mantemos compat com chamadas antigas (questionsPerRun, sendHour, sendMinute).
  const questionsPerDay = clampInt(
    sched.questionsPerDay != null ? sched.questionsPerDay : sched.questionsPerRun,
    1,
    24,
    3
  );
  const startHour = clampInt(
    sched.startHour != null ? sched.startHour : sched.sendHour,
    0,
    23,
    7
  );
  const startMinute = clampInt(
    sched.startMinute != null ? sched.startMinute : sched.sendMinute,
    0,
    59,
    0
  );
  const endHour = clampInt(sched.endHour != null ? sched.endHour : 22, 0, 23, 22);
  const endMinute = clampInt(sched.endMinute != null ? sched.endMinute : 0, 0, 59, 0);
  const waitForAnswers = Boolean(sched.waitForAnswers);
  const timezone = String(sched.timezone || "America/Sao_Paulo");
  const randomOrder = Boolean(sched.randomOrder);

  // Legados: persistimos espelhando os campos novos para não violar NOT NULL.
  const questionsPerRun = Math.min(20, questionsPerDay);
  const sendHour = startHour;
  const sendMinute = startMinute;
  const intervalDays = 1;

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
  const nextRunAt =
    activate && deliveryMode === "group"
      ? firstDailySlotUtc(nowDate, startHour, startMinute, timezone).toISOString()
      : null;

  const { data: cadernoRow, error: cadernoErr } = await supabase
    .from("cadernos")
    .insert({
      name,
      target_group_jid: targetGroupJid,
      created_by_jid: effectiveCreatedBy,
      delivery_mode: deliveryMode,
      // Novos campos:
      questions_per_day: questionsPerDay,
      start_hour: startHour,
      start_minute: startMinute,
      end_hour: endHour,
      end_minute: endMinute,
      wait_for_answers: waitForAnswers,
      current_day_date: null,
      current_day_sent: 0,
      // Legados (espelhados para compat):
      questions_per_run: questionsPerRun,
      interval_days: intervalDays,
      send_hour: sendHour,
      send_minute: sendMinute,
      timezone,
      status,
      cursor: 0,
      random_order: randomOrder,
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

  if (deliveryMode === "private") {
    const insertItems =
      privateRecipientsNorm.length > 0
        ? privateRecipientsNorm
        : [{ userJid: effectiveCreatedBy, active: true }];
    const prRows = insertItems.map((item) => {
      const userJid = String(item.userJid).trim();
      const shUse = item.startHour != null ? clampInt(item.startHour, 0, 23, startHour) : startHour;
      const smUse = item.startMinute != null ? clampInt(item.startMinute, 0, 59, startMinute) : startMinute;
      const recNext = activate
        ? firstDailySlotUtc(nowDate, shUse, smUse, timezone).toISOString()
        : null;
      return {
        caderno_id: cadernoId,
        user_jid: userJid,
        active: item.active !== false,
        questions_per_day:
          item.questionsPerDay != null ? clampInt(item.questionsPerDay, 1, 24, questionsPerDay) : null,
        start_hour: item.startHour != null ? clampInt(item.startHour, 0, 23, startHour) : null,
        start_minute: item.startMinute != null ? clampInt(item.startMinute, 0, 59, startMinute) : null,
        end_hour: item.endHour != null ? clampInt(item.endHour, 0, 23, endHour) : null,
        end_minute: item.endMinute != null ? clampInt(item.endMinute, 0, 59, endMinute) : null,
        wait_for_answers: null,
        random_order: null,
        timezone: null,
        current_day_date: null,
        current_day_sent: 0,
        next_run_at: recNext
      };
    });
    const { error: prErr } = await supabase.from("caderno_private_recipients").insert(prRows);
    if (prErr) {
      await supabase.from("cadernos").delete().eq("id", cadernoId);
      await supabase.from("caderno_questions").delete().eq("caderno_id", cadernoId);
      console.error("[caderno-upload] insert destinatario privado:", prErr);
      return res.status(500).json({ error: `Erro ao criar destinatario privado: ${prErr.message}` });
    }
  }

  return res.status(200).json({
    cadernoId,
    name,
    targetGroupJid,
    deliveryMode,
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
