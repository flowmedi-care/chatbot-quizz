const { getClient, applyCors, pickTargetGroupJid } = require("./_lib.js");
const { firstSlotFromSchedule } = require("./_schedule.js");
const { parseSendTimes } = require("./_send-times.js");

/** Hora máxima de liberação do lote do dia (alinhada ao corte de omissas). */
const MAX_RELEASE_HOUR = 15;

const SELECT_COLUMNS =
  "id, name, target_group_jid, created_by_jid, delivery_mode, status, questions_per_day, send_times, start_hour, start_minute, end_hour, end_minute, wait_for_answers, current_day_date, current_day_sent, questions_per_run, interval_days, send_hour, send_minute, timezone, cursor, random_order, last_run_at, next_run_at, created_at";

const SELECT_COLUMNS_NO_DM =
  "id, name, target_group_jid, created_by_jid, status, questions_per_day, send_times, start_hour, start_minute, end_hour, end_minute, wait_for_answers, current_day_date, current_day_sent, questions_per_run, interval_days, send_hour, send_minute, timezone, cursor, random_order, last_run_at, next_run_at, created_at";

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function clampReleaseHour(value, fallback = 7) {
  return clampInt(value, 0, MAX_RELEASE_HOUR, fallback);
}

function clampReleaseMinute(hour, minute, fallback = 0) {
  const m = clampInt(minute, 0, 59, fallback);
  return hour >= MAX_RELEASE_HOUR ? 0 : m;
}

/** Lote: N horários iguais ao horário de liberação (compat com coluna send_times). */
function batchSendTimes(n, hour, minute) {
  const N = Math.max(1, Math.min(24, n || 1));
  return Array.from({ length: N }, () => ({ hour, minute }));
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  let supabase;
  try {
    supabase = getClient();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (req.method === "GET") return handleGet(req, res, supabase);
  if (req.method === "PATCH") return handlePatch(req, res, supabase);
  return res.status(405).json({ error: "Method not allowed" });
};

async function fetchCadernosList(supabase, groupJid) {
  let { data: cadernos, error } = await supabase
    .from("cadernos")
    .select(SELECT_COLUMNS)
    .eq("target_group_jid", groupJid)
    .order("created_at", { ascending: false });

  if (error && String(error.message || "").toLowerCase().includes("delivery_mode")) {
    const r = await supabase
      .from("cadernos")
      .select(SELECT_COLUMNS_NO_DM)
      .eq("target_group_jid", groupJid)
      .order("created_at", { ascending: false });
    if (r.error) throw r.error;
    cadernos = (r.data || []).map((c) => ({ ...c, delivery_mode: "group" }));
    error = null;
  }
  if (error) throw error;
  return cadernos || [];
}

async function handleGet(req, res, supabase) {
  try {
    const groupJid =
      (req.query && req.query.groupJid && String(req.query.groupJid)) || pickTargetGroupJid();
    if (!groupJid) {
      return res.status(200).json({ cadernos: [], warning: "Sem grupo configurado." });
    }

    const cadernos = await fetchCadernosList(supabase, groupJid);
    if (cadernos.length === 0) {
      return res.status(200).json({ cadernos: [] });
    }

    const ids = cadernos.map((c) => c.id);
    const { data: counts, error: countErr } = await supabase
      .from("caderno_questions")
      .select("caderno_id, published_question_id")
      .in("caderno_id", ids);

    if (countErr) throw countErr;

    const totalByCaderno = new Map();
    const publishedGroupByCaderno = new Map();
    const publishedIdsByCaderno = new Map();
    const allPublishedIds = [];
    for (const row of counts || []) {
      const id = row.caderno_id;
      totalByCaderno.set(id, (totalByCaderno.get(id) || 0) + 1);
      if (row.published_question_id != null) {
        publishedGroupByCaderno.set(id, (publishedGroupByCaderno.get(id) || 0) + 1);
        if (!publishedIdsByCaderno.has(id)) publishedIdsByCaderno.set(id, []);
        publishedIdsByCaderno.get(id).push(row.published_question_id);
        allPublishedIds.push(row.published_question_id);
      }
    }

    const answeredQuestionIds = new Set();
    if (allPublishedIds.length > 0) {
      const uniquePublished = [...new Set(allPublishedIds)];
      const { data: ansRows, error: ansErr } = await supabase
        .from("answers")
        .select("question_id")
        .in("question_id", uniquePublished);
      if (!ansErr && ansRows) {
        for (const a of ansRows) {
          if (a.question_id != null) answeredQuestionIds.add(a.question_id);
        }
      }
    }

    const answeredByCaderno = new Map();
    for (const [cid, ids] of publishedIdsByCaderno.entries()) {
      answeredByCaderno.set(
        cid,
        ids.filter((qid) => answeredQuestionIds.has(qid)).length
      );
    }

    const privateIds = cadernos.filter((c) => c.delivery_mode === "private").map((c) => c.id);
    const privateSendCount = new Map();
    const privateRecipientsByCaderno = new Map();
    const engagedCountByCaderno = new Map();

    const groupIds = cadernos.filter((c) => c.delivery_mode !== "private").map((c) => c.id);
    if (groupIds.length > 0) {
      const { data: engRows, error: engErr } = await supabase
        .from("caderno_engagement")
        .select("caderno_id")
        .in("caderno_id", groupIds)
        .eq("engaged", true);
      if (!engErr && engRows) {
        for (const row of engRows) {
          const cid = row.caderno_id;
          engagedCountByCaderno.set(cid, (engagedCountByCaderno.get(cid) || 0) + 1);
        }
      }
    }

    if (privateIds.length > 0) {
      const { data: sends, error: sErr } = await supabase
        .from("caderno_private_send")
        .select("caderno_id")
        .in("caderno_id", privateIds);
      if (!sErr && sends) {
        for (const s of sends) {
          const cid = s.caderno_id;
          privateSendCount.set(cid, (privateSendCount.get(cid) || 0) + 1);
        }
      }

      const { data: recs, error: rErr } = await supabase
        .from("caderno_private_recipients")
        .select(
          "id, caderno_id, user_jid, active, questions_per_day, send_times, start_hour, start_minute, end_hour, end_minute, wait_for_answers, random_order, timezone, current_day_date, current_day_sent, next_run_at"
        )
        .in("caderno_id", privateIds);
      if (!rErr && recs) {
        for (const r of recs) {
          const cid = r.caderno_id;
          if (!privateRecipientsByCaderno.has(cid)) privateRecipientsByCaderno.set(cid, []);
          privateRecipientsByCaderno.get(cid).push({
            id: r.id,
            userJid: r.user_jid,
            active: Boolean(r.active),
            questionsPerDay: r.questions_per_day,
            sendTimes: parseSendTimes(r.send_times),
            startHour: r.start_hour,
            startMinute: r.start_minute,
            endHour: r.end_hour,
            endMinute: r.end_minute,
            waitForAnswers: r.wait_for_answers,
            randomOrder: r.random_order,
            timezone: r.timezone,
            currentDayDate: r.current_day_date,
            currentDaySent: r.current_day_sent || 0,
            nextRunAt: r.next_run_at
          });
        }
      }
    }

    const out = cadernos.map((c) => {
      const dm = c.delivery_mode === "private" ? "private" : "group";
      const publishedCount =
        dm === "private"
          ? privateSendCount.get(c.id) || 0
          : publishedGroupByCaderno.get(c.id) || 0;

      return {
        id: c.id,
        name: c.name,
        targetGroupJid: c.target_group_jid,
        createdByJid: c.created_by_jid,
        deliveryMode: dm,
        status: c.status,
        questionsPerDay: c.questions_per_day ?? c.questions_per_run,
        sendTimes: parseSendTimes(c.send_times),
        startHour: c.start_hour ?? c.send_hour,
        startMinute: c.start_minute ?? c.send_minute,
        endHour: c.end_hour != null ? Number(c.end_hour) : 15,
        endMinute: c.end_minute != null ? Number(c.end_minute) : 0,
        waitForAnswers: Boolean(c.wait_for_answers),
        currentDayDate: c.current_day_date,
        currentDaySent: c.current_day_sent || 0,
        questionsPerRun: c.questions_per_run,
        intervalDays: c.interval_days,
        sendHour: c.send_hour,
        sendMinute: c.send_minute,
        timezone: c.timezone,
        cursor: c.cursor,
        randomOrder: Boolean(c.random_order),
        totalQuestions: totalByCaderno.get(c.id) || 0,
        publishedCount,
        answeredPublishedCount: answeredByCaderno.get(c.id) || 0,
        engagedCount: engagedCountByCaderno.get(c.id) || 0,
        lastRunAt: c.last_run_at,
        nextRunAt: dm === "private" ? null : c.next_run_at,
        createdAt: c.created_at,
        privateRecipients: privateRecipientsByCaderno.get(c.id) || []
      };
    });

    return res.status(200).json({ cadernos: out });
  } catch (e) {
    console.error("[cadernos GET]", e);
    return res.status(500).json({ error: e.message || "Erro ao listar cadernos" });
  }
}

async function replacePrivateRecipients(supabase, cadernoId, list, template) {
  const { error: delErr } = await supabase
    .from("caderno_private_recipients")
    .delete()
    .eq("caderno_id", cadernoId);
  if (delErr && !String(delErr.message).toLowerCase().includes("does not exist")) {
    throw new Error(delErr.message);
  }
  if (!list || list.length === 0) return;

  const qd = template.questions_per_day ?? template.questions_per_run ?? 3;
  const sh = clampReleaseHour(template.start_hour ?? template.send_hour ?? 7, 7);
  const sm = clampReleaseMinute(sh, template.start_minute ?? template.send_minute ?? 0, 0);
  const tz = template.timezone || "America/Sao_Paulo";
  void tz;

  const rows = [];
  for (const item of list) {
    const userJid = item.userJid != null ? String(item.userJid).trim() : "";
    if (!userJid) continue;
    const qpdItem =
      item.questionsPerDay != null ? clampInt(item.questionsPerDay, 1, 24, qd) : null;
    const nForTimes = qpdItem != null ? qpdItem : qd;
    const shItem = item.startHour != null ? clampReleaseHour(item.startHour, sh) : null;
    const smItem =
      item.startMinute != null
        ? clampReleaseMinute(shItem != null ? shItem : sh, item.startMinute, sm)
        : null;
    const releaseH = shItem != null ? shItem : sh;
    const releaseM = smItem != null ? smItem : sm;
    rows.push({
      caderno_id: cadernoId,
      user_jid: userJid,
      active: item.active !== false,
      questions_per_day: qpdItem,
      send_times: batchSendTimes(nForTimes, releaseH, releaseM),
      start_hour: shItem,
      start_minute: smItem,
      end_hour: shItem,
      end_minute: smItem,
      wait_for_answers: item.waitForAnswers != null ? Boolean(item.waitForAnswers) : null,
      random_order: item.randomOrder != null ? Boolean(item.randomOrder) : null,
      timezone: item.timezone != null ? String(item.timezone).trim() || null : null,
      current_day_date: null,
      current_day_sent: 0,
      next_run_at: item.nextRunAt != null ? item.nextRunAt : null
    });
  }
  if (rows.length === 0) return;
  const { error: insErr } = await supabase.from("caderno_private_recipients").insert(rows);
  if (insErr) throw new Error(insErr.message);
}

async function reschedulePrivateRecipients(supabase, cadernoId, template) {
  const { data: recs, error } = await supabase
    .from("caderno_private_recipients")
    .select(
      "id, questions_per_day, send_times, start_hour, start_minute, end_hour, end_minute, wait_for_answers, random_order, timezone"
    )
    .eq("caderno_id", cadernoId);
  if (error) return;

  const qd0 = template.questions_per_day ?? template.questions_per_run ?? 3;
  const sh0 = clampReleaseHour(template.start_hour ?? template.send_hour ?? 7, 7);
  const sm0 = clampReleaseMinute(sh0, template.start_minute ?? template.send_minute ?? 0, 0);
  const tz0 = template.timezone || "America/Sao_Paulo";

  const now = new Date();
  for (const r of recs || []) {
    const qpd = r.questions_per_day ?? qd0;
    const sh = clampReleaseHour(r.start_hour ?? sh0, sh0);
    const sm = clampReleaseMinute(sh, r.start_minute ?? sm0, sm0);
    const tz = r.timezone || tz0;
    const next = firstSlotFromSchedule(now, tz, {
      sendTimes: batchSendTimes(qpd, sh, sm),
      startHour: sh,
      startMinute: sm,
      endHour: sh,
      endMinute: sm,
      questionsPerDay: qpd
    }).toISOString();
    await supabase
      .from("caderno_private_recipients")
      .update({
        next_run_at: next,
        current_day_date: null,
        current_day_sent: 0
      })
      .eq("id", r.id);
  }
}

async function handlePatch(req, res, supabase) {
  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "JSON invalido" });
  }

  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "Informe id do caderno." });
  }

  let existing;
  let readErr;
  {
    const r = await supabase.from("cadernos").select(SELECT_COLUMNS).eq("id", id).maybeSingle();
    existing = r.data;
    readErr = r.error;
    if (readErr && String(readErr.message || "").toLowerCase().includes("delivery_mode")) {
      const r2 = await supabase.from("cadernos").select(SELECT_COLUMNS_NO_DM).eq("id", id).maybeSingle();
      existing = r2.data ? { ...r2.data, delivery_mode: "group" } : null;
      readErr = r2.error;
    }
  }

  if (readErr) {
    return res.status(500).json({ error: `Erro ao buscar caderno: ${readErr.message}` });
  }
  if (!existing) {
    return res.status(404).json({ error: "Caderno nao encontrado" });
  }

  const existingDm = existing.delivery_mode === "private" ? "private" : "group";

  const existingQuestionsPerDay = existing.questions_per_day ?? existing.questions_per_run ?? 3;
  const existingStartHour = clampReleaseHour(existing.start_hour ?? existing.send_hour ?? 7, 7);
  const existingStartMinute = clampReleaseMinute(
    existingStartHour,
    existing.start_minute ?? existing.send_minute ?? 0,
    0
  );

  const update = {};
  if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();

  if (body.deliveryMode === "private" || body.deliveryMode === "group") {
    update.delivery_mode = body.deliveryMode;
  }

  if (body.questionsPerDay !== undefined) {
    const q = clampInt(body.questionsPerDay, 1, 24, existingQuestionsPerDay);
    update.questions_per_day = q;
    update.questions_per_run = Math.min(20, q);
  } else if (body.questionsPerRun !== undefined) {
    const q = clampInt(body.questionsPerRun, 1, 20, existing.questions_per_run);
    update.questions_per_run = q;
    update.questions_per_day = Math.min(24, q);
  }

  if (body.startHour !== undefined) {
    const h = clampReleaseHour(body.startHour, existingStartHour);
    update.start_hour = h;
    update.send_hour = h;
  } else if (body.sendHour !== undefined) {
    const h = clampReleaseHour(body.sendHour, existingStartHour);
    update.send_hour = h;
    update.start_hour = h;
  }

  if (body.startMinute !== undefined) {
    const h = update.start_hour !== undefined ? update.start_hour : existingStartHour;
    const m = clampReleaseMinute(h, body.startMinute, existingStartMinute);
    update.start_minute = m;
    update.send_minute = m;
  } else if (body.sendMinute !== undefined) {
    const h = update.start_hour !== undefined ? update.start_hour : existingStartHour;
    const m = clampReleaseMinute(h, body.sendMinute, existingStartMinute);
    update.send_minute = m;
    update.start_minute = m;
  }

  const releaseHourForBatch =
    update.start_hour !== undefined ? update.start_hour : existingStartHour;
  const releaseMinuteForBatch =
    update.start_minute !== undefined ? update.start_minute : existingStartMinute;
  const mergedQpdForTimes =
    update.questions_per_day !== undefined ? update.questions_per_day : existingQuestionsPerDay;

  if (
    body.startHour !== undefined ||
    body.sendHour !== undefined ||
    body.startMinute !== undefined ||
    body.sendMinute !== undefined ||
    body.endHour !== undefined ||
    body.endMinute !== undefined ||
    body.sendTimes !== undefined ||
    body.questionsPerDay !== undefined ||
    body.questionsPerRun !== undefined
  ) {
    update.end_hour = releaseHourForBatch;
    update.end_minute = releaseMinuteForBatch;
    update.send_times = batchSendTimes(
      mergedQpdForTimes,
      releaseHourForBatch,
      releaseMinuteForBatch
    );
  }

  if (typeof body.waitForAnswers === "boolean") {
    update.wait_for_answers = body.waitForAnswers;
  }

  if (body.intervalDays !== undefined) {
    update.interval_days = clampInt(body.intervalDays, 1, 30, existing.interval_days);
  }
  if (typeof body.timezone === "string" && body.timezone.trim())
    update.timezone = body.timezone.trim();
  if (Number.isFinite(Number(body.cursor)))
    update.cursor = Math.max(0, Math.round(Number(body.cursor)));
  if (typeof body.randomOrder === "boolean") update.random_order = body.randomOrder;

  if (typeof body.status === "string") {
    const allowed = ["inactive", "active", "paused_waiting_decision", "finished"];
    if (!allowed.includes(body.status)) {
      return res.status(400).json({ error: "Status invalido" });
    }
    update.status = body.status;
  }

  const merged = { ...existing, ...update };
  const newDm = merged.delivery_mode === "private" ? "private" : "group";
  const newStartHour = clampReleaseHour(merged.start_hour ?? merged.send_hour ?? 7, 7);
  const newStartMinute = clampReleaseMinute(
    newStartHour,
    merged.start_minute ?? merged.send_minute ?? 0,
    0
  );
  const newTimezone = merged.timezone || "America/Sao_Paulo";
  const newStatus = merged.status;
  const previousStatus = existing.status;

  const scheduleChanged =
    update.start_hour !== undefined ||
    update.start_minute !== undefined ||
    update.end_hour !== undefined ||
    update.end_minute !== undefined ||
    update.timezone !== undefined ||
    update.questions_per_day !== undefined ||
    update.send_times !== undefined;

  if (newDm === "private" && (update.delivery_mode === "private" || existingDm !== "private")) {
    update.next_run_at = null;
    update.current_day_date = null;
    update.current_day_sent = 0;
  } else if (newDm === "group" && newStatus === "active") {
    if (previousStatus !== "active" || body.recomputeNextRun === true || scheduleChanged) {
      update.current_day_date = null;
      update.current_day_sent = 0;
      const newQpd = merged.questions_per_day ?? merged.questions_per_run ?? 3;
      update.next_run_at = firstSlotFromSchedule(new Date(), newTimezone, {
        sendTimes: batchSendTimes(newQpd, newStartHour, newStartMinute),
        startHour: newStartHour,
        startMinute: newStartMinute,
        endHour: newStartHour,
        endMinute: newStartMinute,
        questionsPerDay: newQpd
      }).toISOString();
    }
  } else if (newStatus === "inactive" || newStatus === "finished") {
    update.next_run_at = null;
  }

  if (body.triggerNow === true && newStatus === "active") {
    if (newDm === "private") {
      update.next_run_at = null;
    } else {
      update.next_run_at = new Date().toISOString();
    }
  }

  if (body.recyclePublished === true) {
    const { error: resetErr } = await supabase
      .from("caderno_questions")
      .update({ published_question_id: null, published_at: null })
      .eq("caderno_id", id);
    if (resetErr) {
      return res
        .status(500)
        .json({ error: `Erro ao reciclar questoes do caderno: ${resetErr.message}` });
    }
    try {
      await supabase.from("caderno_private_send").delete().eq("caderno_id", id);
      await supabase
        .from("caderno_private_recipients")
        .update({ current_day_date: null, current_day_sent: 0, last_run_at: null })
        .eq("caderno_id", id);
    } catch (_) {
      /* tabelas opcionais */
    }
    update.current_day_date = null;
    update.current_day_sent = 0;
    update.cursor = 0;
  }

  if (Array.isArray(body.privateRecipients) && newDm === "private") {
    try {
      await replacePrivateRecipients(supabase, id, body.privateRecipients, merged);
    } catch (e) {
      return res.status(500).json({ error: e.message || "Erro destinatarios privados" });
    }
  }

  const { error: upErr } = await supabase.from("cadernos").update(update).eq("id", id);
  if (upErr) {
    return res.status(500).json({ error: `Erro ao atualizar caderno: ${upErr.message}` });
  }

  if (body.recyclePublished === true && newDm === "private" && newStatus === "active") {
    try {
      const { data: fresh } = await supabase.from("cadernos").select(SELECT_COLUMNS).eq("id", id).single();
      if (fresh) await reschedulePrivateRecipients(supabase, id, fresh);
    } catch (e) {
      console.warn("[cadernos PATCH] reschedule apos recycle:", e);
    }
  }

  if (newDm === "private" && newStatus === "active") {
    if (
      body.triggerNow === true ||
      previousStatus !== "active" ||
      body.recomputeNextRun === true ||
      scheduleChanged ||
      update.delivery_mode !== undefined ||
      Array.isArray(body.privateRecipients)
    ) {
      try {
        if (body.triggerNow === true) {
          const nowIso = new Date().toISOString();
          await supabase
            .from("caderno_private_recipients")
            .update({ next_run_at: nowIso })
            .eq("caderno_id", id)
            .eq("active", true);
        } else {
          const { data: check } = await supabase
            .from("caderno_private_recipients")
            .select("id")
            .eq("caderno_id", id)
            .limit(1);
          if (!check || check.length === 0) {
            if (merged.created_by_jid) {
              await replacePrivateRecipients(
                supabase,
                id,
                [{ userJid: merged.created_by_jid, active: true }],
                merged
              );
            }
          }
          await reschedulePrivateRecipients(supabase, id, merged);
        }
      } catch (e) {
        console.warn("[cadernos PATCH] reschedule private:", e);
      }
    }
  }

  if (newDm === "group" && newStatus === "active" && (update.delivery_mode !== undefined || scheduleChanged)) {
    try {
      await supabase
        .from("caderno_private_recipients")
        .update({ next_run_at: null })
        .eq("caderno_id", id);
    } catch (_) {}
  }

  return res.status(200).json({ ok: true, id, applied: update });
}
