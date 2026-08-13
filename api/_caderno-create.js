const { firstSlotFromSchedule } = require("./_schedule.js");
const { sanitizePostgresText } = require("./_text-sanitize.js");
const {
  normalizeOptions,
  formatStatementWithOptions,
  mapQuestionType,
  mapAnswerKey
} = require("./_statement-options.js");

const MAX_RELEASE_HOUR = 15;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function parseSchedule(sched) {
  const questionsPerDay = clampInt(
    sched.questionsPerDay != null ? sched.questionsPerDay : sched.questionsPerRun,
    1,
    24,
    3
  );
  let startHour = clampInt(
    sched.startHour != null ? sched.startHour : sched.sendHour,
    0,
    MAX_RELEASE_HOUR,
    7
  );
  let startMinute = clampInt(
    sched.startMinute != null ? sched.startMinute : sched.sendMinute,
    0,
    59,
    0
  );
  if (startHour >= MAX_RELEASE_HOUR) startMinute = 0;
  const waitForAnswers = Boolean(sched.waitForAnswers);
  const timezone = String(sched.timezone || "America/Sao_Paulo");
  const randomOrder = Boolean(sched.randomOrder);
  const sendTimes = Array.from({ length: questionsPerDay }, () => ({
    hour: startHour,
    minute: startMinute
  }));
  return {
    questionsPerDay,
    startHour,
    startMinute,
    endHour: startHour,
    endMinute: startMinute,
    waitForAnswers,
    timezone,
    randomOrder,
    sendTimes,
    questionsPerRun: Math.min(20, questionsPerDay),
    sendHour: startHour,
    sendMinute: startMinute,
    intervalDays: 1
  };
}

function normalizeIncomingQuestions(rawList) {
  const warnings = [];
  const questions = [];
  (Array.isArray(rawList) ? rawList : []).forEach((item, idx) => {
    const parsedPos = Number(item.position);
    const position =
      Number.isFinite(parsedPos) && parsedPos >= 0 ? parsedPos : idx + 1;
    const questionType = mapQuestionType(item.questionType || item.type);
    const options = normalizeOptions(item.options || item.alternatives);
    const statement = String(item.statement || item.statementText || "").trim();
    const answerKey = mapAnswerKey(item.answerKey || item.correct_answer || item.correctAnswer, questionType);
    const statementText = formatStatementWithOptions(statement, options, questionType);
    if (!statementText || !answerKey) {
      warnings.push(`Questão #${position}: sem enunciado ou gabarito.`);
      return;
    }
    questions.push({
      position,
      tecQuestionId: item.tecQuestionId != null ? String(item.tecQuestionId) : item.tec_id != null ? String(item.tec_id) : null,
      tecUrl: String(item.tecUrl || item.tec_url || "").trim() || "https://www.tecconcursos.com.br",
      banca: item.banca != null ? String(item.banca) : null,
      subject: item.subject != null ? String(item.subject) : item.tec_subject != null ? String(item.tec_subject) : null,
      questionType,
      statementText,
      options,
      answerKey
    });
  });
  questions.forEach((q, i) => {
    q.position = i + 1;
  });
  return { questions, warnings };
}

async function insertCadernoBundle(supabase, input) {
  const {
    name,
    targetGroupJid,
    effectiveCreatedBy,
    deliveryMode,
    activate,
    originNotebookId,
    schedule,
    questions,
    privateRecipientsNorm
  } = input;

  const nowDate = new Date();
  const status = activate ? "active" : "inactive";
  const groupSchedule = {
    sendTimes: schedule.sendTimes,
    startHour: schedule.startHour,
    startMinute: schedule.startMinute,
    endHour: schedule.endHour,
    endMinute: schedule.endMinute,
    questionsPerDay: schedule.questionsPerDay
  };
  const nextRunAt =
    activate && deliveryMode === "group"
      ? firstSlotFromSchedule(nowDate, timezoneSafe(schedule.timezone), groupSchedule).toISOString()
      : null;

  const cadernoPayload = {
    name,
    target_group_jid: targetGroupJid,
    created_by_jid: effectiveCreatedBy,
    delivery_mode: deliveryMode,
    questions_per_day: schedule.questionsPerDay,
    start_hour: schedule.startHour,
    start_minute: schedule.startMinute,
    end_hour: schedule.endHour,
    end_minute: schedule.endMinute,
    send_times: schedule.sendTimes,
    wait_for_answers: schedule.waitForAnswers,
    current_day_date: null,
    current_day_sent: 0,
    questions_per_run: schedule.questionsPerRun,
    interval_days: schedule.intervalDays,
    send_hour: schedule.sendHour,
    send_minute: schedule.sendMinute,
    timezone: schedule.timezone,
    status,
    cursor: 0,
    random_order: schedule.randomOrder,
    next_run_at: nextRunAt
  };
  if (originNotebookId) cadernoPayload.origin_notebook_id = originNotebookId;

  let { data: cadernoRow, error: cadernoErr } = await supabase
    .from("cadernos")
    .insert(cadernoPayload)
    .select("id")
    .single();

  if (cadernoErr && /origin_notebook_id/i.test(cadernoErr.message || "")) {
    delete cadernoPayload.origin_notebook_id;
    const retry = await supabase.from("cadernos").insert(cadernoPayload).select("id").single();
    cadernoRow = retry.data;
    cadernoErr = retry.error;
  }

  if (cadernoErr || !cadernoRow) {
    throw new Error(`Erro ao criar caderno: ${cadernoErr?.message || "sem dados"}`);
  }

  const cadernoId = cadernoRow.id;
  const rows = questions.map((q) => ({
    caderno_id: cadernoId,
    position: q.position,
    tec_question_id: sanitizePostgresText(q.tecQuestionId),
    tec_url: sanitizePostgresText(q.tecUrl),
    banca: sanitizePostgresText(q.banca),
    subject: sanitizePostgresText(q.subject),
    question_type: q.questionType,
    statement_text: sanitizePostgresText(q.statementText),
    answer_key: q.answerKey,
    options: q.options || []
  }));

  let { error: bulkErr } = await supabase.from("caderno_questions").insert(rows);
  if (bulkErr && /options/i.test(bulkErr.message || "")) {
    const withoutOpts = rows.map(({ options: _o, ...rest }) => rest);
    const retry = await supabase.from("caderno_questions").insert(withoutOpts);
    bulkErr = retry.error;
  }
  if (bulkErr) {
    await supabase.from("cadernos").delete().eq("id", cadernoId);
    throw new Error(`Erro ao salvar questoes: ${bulkErr.message}`);
  }

  if (deliveryMode === "private") {
    const insertItems =
      privateRecipientsNorm.length > 0
        ? privateRecipientsNorm
        : [{ userJid: effectiveCreatedBy, active: true }];
    const prRows = insertItems.map((item) => {
      const userJid = String(item.userJid).trim();
      const qpdUse =
        item.questionsPerDay != null
          ? clampInt(item.questionsPerDay, 1, 24, schedule.questionsPerDay)
          : schedule.questionsPerDay;
      let shUse =
        item.startHour != null ? clampInt(item.startHour, 0, MAX_RELEASE_HOUR, schedule.startHour) : schedule.startHour;
      let smUse =
        item.startMinute != null ? clampInt(item.startMinute, 0, 59, schedule.startMinute) : schedule.startMinute;
      if (shUse >= MAX_RELEASE_HOUR) smUse = 0;
      const recSendTimes = Array.from({ length: qpdUse }, () => ({ hour: shUse, minute: smUse }));
      const recSchedule = {
        sendTimes: recSendTimes,
        startHour: shUse,
        startMinute: smUse,
        endHour: shUse,
        endMinute: smUse,
        questionsPerDay: qpdUse
      };
      const recNext = activate
        ? firstSlotFromSchedule(nowDate, timezoneSafe(schedule.timezone), recSchedule).toISOString()
        : null;
      return {
        caderno_id: cadernoId,
        user_jid: userJid,
        active: item.active !== false,
        questions_per_day: item.questionsPerDay != null ? qpdUse : null,
        send_times: recSendTimes,
        start_hour: item.startHour != null ? shUse : null,
        start_minute: item.startMinute != null ? smUse : null,
        end_hour: item.startHour != null ? shUse : null,
        end_minute: item.startMinute != null ? smUse : null,
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
      throw new Error(`Erro ao criar destinatario privado: ${prErr.message}`);
    }
  }

  return { cadernoId, status, nextRunAt };
}

function timezoneSafe(tz) {
  return String(tz || "America/Sao_Paulo");
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

module.exports = {
  clampInt,
  parseSchedule,
  normalizeIncomingQuestions,
  insertCadernoBundle,
  buildSummary,
  MAX_RELEASE_HOUR
};
