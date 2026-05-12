const { getClient, applyCors, pickTargetGroupJid } = require("./_lib.js");
const { computeNextRunAt } = require("./_schedule.js");

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

async function handleGet(req, res, supabase) {
  try {
    const groupJid =
      (req.query && req.query.groupJid && String(req.query.groupJid)) || pickTargetGroupJid();
    if (!groupJid) {
      return res.status(200).json({ cadernos: [], warning: "Sem grupo configurado." });
    }

    const { data: cadernos, error } = await supabase
      .from("cadernos")
      .select(
        "id, name, target_group_jid, created_by_jid, status, questions_per_run, interval_days, send_hour, send_minute, timezone, cursor, random_order, last_run_at, next_run_at, created_at"
      )
      .eq("target_group_jid", groupJid)
      .order("created_at", { ascending: false });

    if (error) throw error;

    if (!cadernos || cadernos.length === 0) {
      return res.status(200).json({ cadernos: [] });
    }

    const ids = cadernos.map((c) => c.id);
    const { data: counts, error: countErr } = await supabase
      .from("caderno_questions")
      .select("caderno_id, published_question_id")
      .in("caderno_id", ids);

    if (countErr) throw countErr;

    const totalByCaderno = new Map();
    const publishedByCaderno = new Map();
    for (const row of counts || []) {
      const id = row.caderno_id;
      totalByCaderno.set(id, (totalByCaderno.get(id) || 0) + 1);
      if (row.published_question_id != null) {
        publishedByCaderno.set(id, (publishedByCaderno.get(id) || 0) + 1);
      }
    }

    const out = cadernos.map((c) => ({
      id: c.id,
      name: c.name,
      targetGroupJid: c.target_group_jid,
      createdByJid: c.created_by_jid,
      status: c.status,
      questionsPerRun: c.questions_per_run,
      intervalDays: c.interval_days,
      sendHour: c.send_hour,
      sendMinute: c.send_minute,
      timezone: c.timezone,
      cursor: c.cursor,
      randomOrder: Boolean(c.random_order),
      totalQuestions: totalByCaderno.get(c.id) || 0,
      publishedCount: publishedByCaderno.get(c.id) || 0,
      lastRunAt: c.last_run_at,
      nextRunAt: c.next_run_at,
      createdAt: c.created_at
    }));

    return res.status(200).json({ cadernos: out });
  } catch (e) {
    console.error("[cadernos GET]", e);
    return res.status(500).json({ error: e.message || "Erro ao listar cadernos" });
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

  const { data: existing, error: readErr } = await supabase
    .from("cadernos")
    .select(
      "id, name, status, questions_per_run, interval_days, send_hour, send_minute, timezone, cursor, random_order"
    )
    .eq("id", id)
    .maybeSingle();

  if (readErr) {
    return res.status(500).json({ error: `Erro ao buscar caderno: ${readErr.message}` });
  }
  if (!existing) {
    return res.status(404).json({ error: "Caderno nao encontrado" });
  }

  const update = {};
  if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
  if (body.questionsPerRun !== undefined)
    update.questions_per_run = clampInt(body.questionsPerRun, 1, 20, existing.questions_per_run);
  if (body.intervalDays !== undefined)
    update.interval_days = clampInt(body.intervalDays, 1, 30, existing.interval_days);
  if (body.sendHour !== undefined)
    update.send_hour = clampInt(body.sendHour, 0, 23, existing.send_hour);
  if (body.sendMinute !== undefined)
    update.send_minute = clampInt(body.sendMinute, 0, 59, existing.send_minute);
  if (typeof body.timezone === "string" && body.timezone.trim())
    update.timezone = body.timezone.trim();
  if (Number.isFinite(Number(body.cursor))) update.cursor = Math.max(0, Math.round(Number(body.cursor)));
  if (typeof body.randomOrder === "boolean") update.random_order = body.randomOrder;

  if (typeof body.status === "string") {
    const allowed = ["inactive", "active", "paused_waiting_decision", "finished"];
    if (!allowed.includes(body.status)) {
      return res.status(400).json({ error: "Status invalido" });
    }
    update.status = body.status;
  }

  const newSendHour = update.send_hour ?? existing.send_hour;
  const newSendMinute = update.send_minute ?? existing.send_minute;
  const newTimezone = update.timezone ?? existing.timezone;
  const newStatus = update.status ?? existing.status;
  const previousStatus = existing.status;

  const scheduleChanged =
    update.send_hour !== undefined ||
    update.send_minute !== undefined ||
    update.timezone !== undefined ||
    update.interval_days !== undefined;

  if (newStatus === "active") {
    if (
      previousStatus !== "active" ||
      body.recomputeNextRun === true ||
      scheduleChanged
    ) {
      update.next_run_at = computeNextRunAt(
        new Date(),
        newSendHour,
        newSendMinute,
        newTimezone,
        0
      ).toISOString();
    }
  } else if (newStatus === "inactive" || newStatus === "finished") {
    update.next_run_at = null;
  }

  if (body.triggerNow === true && newStatus === "active") {
    update.next_run_at = new Date().toISOString();
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
  }

  const { error: upErr } = await supabase.from("cadernos").update(update).eq("id", id);
  if (upErr) {
    return res.status(500).json({ error: `Erro ao atualizar caderno: ${upErr.message}` });
  }

  return res.status(200).json({ ok: true, id, applied: update });
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
