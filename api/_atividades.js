/**
 * Atividades: calendário dia/semana/mês + adiantar + sessão omissas web.
 * Montado em omissas-web.js (limite Hobby de serverless functions).
 */
const crypto = require("crypto");
const { getClient, pickTargetGroupJid } = require("./_lib.js");
const {
  dateIsoInTimezone,
  addDaysIso,
  weekDayIsos,
  monthDayIsos,
  startOfMonthIso,
  formatDayLabelPt
} = require("./_schedule.js");

const TZ = "America/Sao_Paulo";
const WEEKDAY_LABELS = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];

function jidKey(jid) {
  const raw = String(jid || "").trim().toLowerCase();
  const at = raw.indexOf("@");
  if (at < 0) return raw;
  return `${raw.slice(0, at).split(":")[0]}@${raw.slice(at + 1)}`;
}

function weekdayLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const utcDay = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  const idx = utcDay === 0 ? 6 : utcDay - 1;
  return WEEKDAY_LABELS[idx];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) {
        reject(new Error("Body grande demais"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

async function listEngagedCadernos(supabase, userJid, groupJid) {
  const { data: cadernos, error } = await supabase
    .from("cadernos")
    .select(
      "id, name, timezone, questions_per_day, random_order, target_group_jid, status, delivery_mode"
    )
    .eq("status", "active")
    .eq("target_group_jid", groupJid)
    .neq("delivery_mode", "private");

  if (error) throw error;
  const ids = (cadernos || []).map((c) => Number(c.id)).filter(Boolean);
  if (!ids.length) return [];

  const { data: eng, error: eErr } = await supabase
    .from("caderno_engagement")
    .select("caderno_id, user_jid, engaged")
    .in("caderno_id", ids)
    .eq("engaged", true);

  if (eErr) {
    const msg = String(eErr.message || "").toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw eErr;
  }

  const userK = jidKey(userJid);
  const engagedIds = new Set();
  for (const row of eng || []) {
    if (jidKey(row.user_jid) === userK) engagedIds.add(Number(row.caderno_id));
  }

  return (cadernos || [])
    .filter((c) => engagedIds.has(Number(c.id)))
    .map((c) => ({
      id: Number(c.id),
      name: String(c.name || ""),
      timezone: c.timezone || TZ,
      questionsPerDay: Math.max(1, Number(c.questions_per_day) || 1),
      randomOrder: Boolean(c.random_order),
      targetGroupJid: String(c.target_group_jid)
    }));
}

async function listQueueForDay(supabase, cadernoId, dayIso) {
  const { data, error } = await supabase
    .from("caderno_send_queue")
    .select("id, published_question_id, slot_index, planned_day_iso")
    .eq("caderno_id", cadernoId)
    .eq("planned_day_iso", dayIso)
    .order("slot_index", { ascending: true });
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw error;
  }
  return data || [];
}

async function listPublishedOnDay(supabase, cadernoId, dayIso, tz) {
  const { data, error } = await supabase
    .from("caderno_questions")
    .select("published_question_id, published_at")
    .eq("caderno_id", cadernoId)
    .not("published_question_id", "is", null);
  if (error) throw error;
  const out = [];
  for (const row of data || []) {
    if (!row.published_at || row.published_question_id == null) continue;
    const iso = dateIsoInTimezone(new Date(row.published_at), tz);
    if (iso === dayIso) out.push(Number(row.published_question_id));
  }
  return out;
}

async function shortIdsForQuestionIds(supabase, questionIds) {
  if (!questionIds.length) return [];
  const { data, error } = await supabase
    .from("questions")
    .select("id, short_id")
    .in("id", questionIds);
  if (error) throw error;
  const map = new Map((data || []).map((r) => [Number(r.id), String(r.short_id || "").toUpperCase()]));
  return questionIds.map((id) => map.get(id)).filter(Boolean);
}

async function answersByUser(supabase, questionIds, userJid) {
  const out = new Map();
  if (!questionIds.length) return out;
  const userK = jidKey(userJid);
  const CHUNK = 80;
  for (let i = 0; i < questionIds.length; i += CHUNK) {
    const chunk = questionIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("answers")
      .select("question_id, user_jid")
      .in("question_id", chunk);
    if (error) throw error;
    for (const row of data || []) {
      if (jidKey(row.user_jid) !== userK) continue;
      out.set(Number(row.question_id), true);
    }
  }
  return out;
}

async function resolveDayQuestionIds(supabase, caderno, dayIso) {
  const queue = await listQueueForDay(supabase, caderno.id, dayIso);
  const fromQueue = queue
    .map((q) => (q.published_question_id != null ? Number(q.published_question_id) : null))
    .filter((id) => id != null && Number.isFinite(id));
  if (fromQueue.length) return [...new Set(fromQueue)];
  return listPublishedOnDay(supabase, caderno.id, dayIso, caderno.timezone || TZ);
}

async function dayStatusForCaderno(supabase, caderno, userJid, dayIso, todayIso) {
  const questionIds = await resolveDayQuestionIds(supabase, caderno, dayIso);
  const shortIds = await shortIdsForQuestionIds(supabase, questionIds);
  const answered = await answersByUser(supabase, questionIds, userJid);
  let answeredCount = 0;
  for (const qid of questionIds) {
    if (answered.get(qid)) answeredCount += 1;
  }
  const totalCount = questionIds.length;
  const allDone = totalCount > 0 && answeredCount >= totalCount;

  let status;
  if (dayIso === todayIso) status = allDone ? "feito" : "hoje";
  else if (dayIso < todayIso) {
    if (totalCount === 0) status = "passou";
    else if (allDone) status = "feito";
    else status = "atrasado";
  } else if (totalCount === 0) status = "pendente";
  else if (allDone) status = "feito";
  else status = "pendente";

  return {
    dayIso,
    status,
    shortIds,
    answeredCount,
    totalCount,
    label: `${weekdayLabel(dayIso)} ${formatDayLabelPt(dayIso)}`,
    selectable: dayIso > todayIso && status !== "feito"
  };
}

function mergeStatus(statuses) {
  if (!statuses.length) return "passou";
  if (statuses.some((s) => s.status === "atrasado")) return "atrasado";
  if (statuses.some((s) => s.status === "hoje")) return "hoje";
  const withQ = statuses.filter((s) => s.totalCount > 0);
  if (withQ.length && withQ.every((s) => s.status === "feito")) return "feito";
  if (statuses.some((s) => s.status === "pendente")) return "pendente";
  if (statuses.every((s) => s.status === "feito")) return "feito";
  if (statuses.every((s) => s.status === "passou")) return "passou";
  return "pendente";
}

async function listQueuedCadernoQuestionIds(supabase, cadernoId) {
  const { data, error } = await supabase
    .from("caderno_send_queue")
    .select("caderno_question_id")
    .eq("caderno_id", cadernoId)
    .is("released_at", null);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return new Set();
    throw error;
  }
  return new Set((data || []).map((r) => Number(r.caderno_question_id)).filter(Boolean));
}

async function listNextPending(supabase, caderno, limit) {
  const exclude = await listQueuedCadernoQuestionIds(supabase, caderno.id);
  const { data, error } = await supabase
    .from("caderno_questions")
    .select(
      "id, caderno_id, position, tec_question_id, tec_url, banca, subject, question_type, statement_text, answer_key"
    )
    .eq("caderno_id", caderno.id)
    .is("published_question_id", null)
    .order("position", { ascending: true })
    .limit(Math.max(limit + exclude.size, limit));
  if (error) throw error;
  let rows = (data || []).filter((r) => !exclude.has(Number(r.id)));
  if (caderno.randomOrder) {
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
  }
  return rows.slice(0, limit);
}

async function nextGroupShortId(supabase, groupJid) {
  const { data, error } = await supabase
    .from("questions")
    .select("short_id")
    .eq("target_group_jid", groupJid);
  if (error) throw error;
  let max = 0;
  for (const row of data || []) {
    const s = String(row.short_id || "").trim();
    if (/^\d+$/.test(s)) max = Math.max(max, parseInt(s, 10));
  }
  return String(max + 1);
}

async function createQuestionFromCaderno(supabase, caderno, question) {
  const creatorJid = `caderno:${caderno.id}@bot`;
  const explanation = [
    "Resolução completa no Tec Concursos:",
    question.tec_url || "",
    question.banca ? `\nBanca: ${question.banca}` : "",
    question.subject ? `\nMatéria: ${question.subject}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const { data, error } = await supabase
    .from("questions")
    .insert({
      creator_jid: creatorJid,
      creator_name: `Caderno: ${caderno.name}`,
      target_group_jid: caderno.targetGroupJid,
      question_type: question.question_type,
      statement_text: question.statement_text,
      statement_media_url: null,
      statement_media_mime_type: null,
      answer_key: String(question.answer_key || "").toUpperCase(),
      explanation_text: explanation,
      explanation_media_url: null,
      explanation_media_mime_type: null,
      group_jid: caderno.targetGroupJid,
      sender_jid: creatorJid,
      message_type: "text",
      text_content: question.statement_text,
      media_mime_type: null,
      wa_message_id: `caderno-${caderno.id}-${question.id}-${Date.now()}`,
      sent_at: new Date().toISOString()
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(error?.message || "Falha ao criar questão");
  const dbId = Number(data.id);
  const shortId = (await nextGroupShortId(supabase, caderno.targetGroupJid)).toUpperCase();
  const { error: uErr } = await supabase.from("questions").update({ short_id: shortId }).eq("id", dbId);
  if (uErr) throw uErr;
  return { shortId, dbId };
}

async function adiantarCadernoDays(supabase, caderno, dayIsos, userJid) {
  const todayIso = dateIsoInTimezone(new Date(), caderno.timezone || TZ);
  const unique = [...new Set(dayIsos.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  const N = caderno.questionsPerDay;
  const dayResults = [];
  const offerShortIds = [];
  const newlyPlannedDays = [];

  for (const dayIso of unique) {
    if (dayIso <= todayIso) {
      dayResults.push({
        dayIso,
        status: "skipped",
        shortIds: [],
        message: `${formatDayLabelPt(dayIso)}: use omissas de hoje (ou dia já passou).`
      });
      continue;
    }

    const queue = await listQueueForDay(supabase, caderno.id, dayIso);
    if (queue.length) {
      const qids = queue
        .map((q) => (q.published_question_id != null ? Number(q.published_question_id) : null))
        .filter((id) => id != null);
      const shortIds = await shortIdsForQuestionIds(supabase, qids);
      const answered = await answersByUser(supabase, qids, userJid);
      const allDone = qids.length > 0 && qids.every((id) => answered.get(id));
      if (allDone) {
        dayResults.push({
          dayIso,
          status: "feito",
          shortIds: [],
          message: `${formatDayLabelPt(dayIso)}: já feito.`
        });
      } else {
        dayResults.push({
          dayIso,
          status: "pendente",
          shortIds,
          message: `${formatDayLabelPt(dayIso)}: pendente (${shortIds.length}).`
        });
        offerShortIds.push(...shortIds);
      }
      continue;
    }

    const pending = await listNextPending(supabase, caderno, N);
    if (!pending.length) {
      dayResults.push({
        dayIso,
        status: "error",
        shortIds: [],
        message: `${formatDayLabelPt(dayIso)}: sem questões no caderno.`
      });
      continue;
    }

    const shortIds = [];
    for (let slot = 0; slot < N && slot < pending.length; slot++) {
      const q = pending[slot];
      const { shortId, dbId } = await createQuestionFromCaderno(supabase, caderno, q);
      const { error } = await supabase.from("caderno_send_queue").insert({
        caderno_id: caderno.id,
        caderno_question_id: q.id,
        planned_day_iso: dayIso,
        slot_index: slot,
        published_question_id: dbId
      });
      if (error) throw error;
      shortIds.push(shortId);
    }
    newlyPlannedDays.push(dayIso);
    offerShortIds.push(...shortIds);
    dayResults.push({
      dayIso,
      status: "novo",
      shortIds,
      message: `${formatDayLabelPt(dayIso)}: ${shortIds.length} reservada(s).`
    });
  }

  return {
    shortIds: [...new Set(offerShortIds)],
    newlyPlannedDays,
    dayResults,
    message: [`Caderno #${caderno.id} "${caderno.name}":`, ...dayResults.map((r) => r.message)].join(
      "\n"
    )
  };
}

async function createWebSession(supabase, input) {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const shortIds = [...new Set((input.shortIds || []).map((s) => String(s).toUpperCase()).filter(Boolean))];
  const { data, error } = await supabase
    .from("omissas_web_sessions")
    .insert({
      token,
      user_jid: input.userJid,
      user_name: input.userName || null,
      group_jid: input.groupJid,
      mode: input.mode || "adiantar",
      short_ids: shortIds,
      expires_at: expiresAt
    })
    .select("token")
    .single();
  if (error) throw error;
  return { token: String(data.token), shortIds };
}

async function addPrepaidDays(supabase, userJid, days) {
  if (!days.length) return;
  const { data, error } = await supabase
    .from("user_streak")
    .select("user_jid, prepaid_days")
    .eq("user_jid", userJid)
    .maybeSingle();
  if (error) {
    console.warn("[atividades] prepaid:", error.message);
    return;
  }
  const set = new Set([...(data?.prepaid_days || []), ...days]);
  if (data) {
    await supabase
      .from("user_streak")
      .update({ prepaid_days: [...set], updated_at: new Date().toISOString() })
      .eq("user_jid", userJid);
  }
}

async function listUnansweredToday(supabase, userJid, groupJid, dayIso) {
  const cadernos = await listEngagedCadernos(supabase, userJid, groupJid);
  const shortIds = [];
  const byCaderno = [];
  for (const c of cadernos) {
    const st = await dayStatusForCaderno(supabase, c, userJid, dayIso, dayIso);
    const pending = [];
    if (st.totalCount > 0 && st.answeredCount < st.totalCount) {
      const answered = await answersByUser(
        supabase,
        await resolveDayQuestionIds(supabase, c, dayIso),
        userJid
      );
      const qids = await resolveDayQuestionIds(supabase, c, dayIso);
      const sids = await shortIdsForQuestionIds(supabase, qids);
      for (let i = 0; i < qids.length; i++) {
        if (!answered.get(qids[i]) && sids[i]) {
          pending.push(sids[i]);
          shortIds.push(sids[i]);
        }
      }
    }
    byCaderno.push({
      cadernoId: c.id,
      name: c.name,
      status: st.status,
      answeredCount: st.answeredCount,
      totalCount: st.totalCount,
      pendingShortIds: pending
    });
  }
  return { shortIds: [...new Set(shortIds)], byCaderno };
}

async function handleAtividadesGet(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const view = url.searchParams.get("view") || "week";
  const userJid = String(url.searchParams.get("userJid") || "").trim();
  if (!userJid) return res.status(400).json({ error: "Informe userJid" });

  const groupJid = pickTargetGroupJid();
  if (!groupJid) return res.status(503).json({ error: "TARGET_GROUP_JIDS não configurado" });

  const supabase = getClient();
  const cadernos = await listEngagedCadernos(supabase, userJid, groupJid);
  const todayIso = dateIsoInTimezone(new Date(), TZ);

  if (view === "day") {
    const day = url.searchParams.get("day") || todayIso;
    const omissas = await listUnansweredToday(supabase, userJid, groupJid, day);
    return res.status(200).json({
      view: "day",
      todayIso,
      dayIso: day,
      engaged: cadernos.map((c) => ({ id: c.id, name: c.name })),
      ...omissas
    });
  }

  if (view === "month") {
    const month = url.searchParams.get("month") || todayIso.slice(0, 7);
    const daysList = monthDayIsos(month);
    const days = [];
    for (const dayIso of daysList) {
      const perCaderno = [];
      for (const c of cadernos) {
        perCaderno.push(await dayStatusForCaderno(supabase, c, userJid, dayIso, todayIso));
      }
      const status = mergeStatus(perCaderno);
      days.push({
        dayIso,
        status,
        selectable: dayIso > todayIso && status !== "feito",
        label: formatDayLabelPt(dayIso),
        cadernos: perCaderno.map((s, i) => ({
          cadernoId: cadernos[i].id,
          name: cadernos[i].name,
          status: s.status,
          answeredCount: s.answeredCount,
          totalCount: s.totalCount
        }))
      });
    }
    const counts = {
      feito: days.filter((d) => d.status === "feito").length,
      atrasado: days.filter((d) => d.status === "atrasado").length,
      pendente: days.filter((d) => d.status === "pendente" || d.status === "hoje").length
    };
    return res.status(200).json({
      view: "month",
      todayIso,
      month: startOfMonthIso(month).slice(0, 7),
      counts,
      engaged: cadernos.map((c) => ({ id: c.id, name: c.name })),
      days
    });
  }

  // week (default)
  const weekStartParam = url.searchParams.get("weekStart");
  const anchor = weekStartParam || todayIso;
  const daysList = weekDayIsos(anchor);
  const days = [];
  for (const dayIso of daysList) {
    const perCaderno = [];
    for (const c of cadernos) {
      perCaderno.push(await dayStatusForCaderno(supabase, c, userJid, dayIso, todayIso));
    }
    const status = mergeStatus(perCaderno);
    days.push({
      dayIso,
      status,
      selectable: dayIso > todayIso && status !== "feito",
      label: `${weekdayLabel(dayIso)} ${formatDayLabelPt(dayIso)}`,
      weekday: weekdayLabel(dayIso),
      cadernos: perCaderno.map((s, i) => ({
        cadernoId: cadernos[i].id,
        name: cadernos[i].name,
        status: s.status,
        answeredCount: s.answeredCount,
        totalCount: s.totalCount,
        shortIds: s.shortIds
      }))
    });
  }

  return res.status(200).json({
    view: "week",
    todayIso,
    weekStart: daysList[0],
    weekEnd: daysList[6],
    engaged: cadernos.map((c) => ({ id: c.id, name: c.name })),
    days
  });
}

async function handleAtividadesPost(req, res) {
  const body = await readBody(req);
  const action = String(body.action || "").trim();
  const userJid = String(body.userJid || "").trim();
  const userName = body.userName != null ? String(body.userName) : null;
  if (!userJid) return res.status(400).json({ error: "Informe userJid" });

  const groupJid = pickTargetGroupJid();
  if (!groupJid) return res.status(503).json({ error: "TARGET_GROUP_JIDS não configurado" });

  const supabase = getClient();
  const cadernos = await listEngagedCadernos(supabase, userJid, groupJid);
  if (!cadernos.length) {
    return res.status(400).json({ error: "Você não está engajado em nenhum caderno ativo." });
  }

  const todayIso = dateIsoInTimezone(new Date(), TZ);

  if (action === "session") {
    const mode = body.mode === "atrasadas" ? "atrasadas" : "hoje";
    const dayIso = String(body.dayIso || todayIso);
    if (mode === "hoje") {
      const omissas = await listUnansweredToday(supabase, userJid, groupJid, dayIso);
      if (!omissas.shortIds.length) {
        return res.status(200).json({ token: null, shortIds: [], message: "Nada pendente hoje." });
      }
      const session = await createWebSession(supabase, {
        userJid,
        userName,
        groupJid,
        mode: "hoje",
        shortIds: omissas.shortIds
      });
      return res.status(200).json({ ...session, message: "Sessão criada." });
    }
    // atrasadas: collect atrasado short ids from last 60 days lightly via week/month would be heavy;
    // reuse day statuses for past 30 days
    const shortIds = [];
    for (let i = 1; i <= 30; i++) {
      const dayIsoPast = addDaysIso(todayIso, -i);
      for (const c of cadernos) {
        const st = await dayStatusForCaderno(supabase, c, userJid, dayIsoPast, todayIso);
        if (st.status === "atrasado") {
          const qids = await resolveDayQuestionIds(supabase, c, dayIsoPast);
          const answered = await answersByUser(supabase, qids, userJid);
          const sids = await shortIdsForQuestionIds(supabase, qids);
          for (let j = 0; j < qids.length; j++) {
            if (!answered.get(qids[j]) && sids[j]) shortIds.push(sids[j]);
          }
        }
      }
    }
    const uniq = [...new Set(shortIds)];
    if (!uniq.length) {
      return res.status(200).json({ token: null, shortIds: [], message: "Sem atrasadas." });
    }
    const session = await createWebSession(supabase, {
      userJid,
      userName,
      groupJid,
      mode: "atrasadas",
      shortIds: uniq
    });
    return res.status(200).json({ ...session, message: "Sessão de atrasadas criada." });
  }

  if (action === "adiantar") {
    let dayIsos = Array.isArray(body.dayIsos)
      ? body.dayIsos.map((d) => String(d)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      : [];
    dayIsos = [...new Set(dayIsos)].filter((d) => d > todayIso).sort();
    if (!dayIsos.length) {
      return res.status(400).json({ error: "Selecione dias futuros para adiantar." });
    }
    if (dayIsos.length > 14) {
      return res.status(400).json({ error: "Máximo 14 dias por vez." });
    }

    const filterCadernoId =
      body.cadernoId != null && Number.isFinite(Number(body.cadernoId))
        ? Number(body.cadernoId)
        : null;
    const targets = filterCadernoId
      ? cadernos.filter((c) => c.id === filterCadernoId)
      : cadernos;
    if (!targets.length) return res.status(400).json({ error: "Caderno não encontrado." });

    const summaries = [];
    const allShortIds = [];
    const prepaid = [];
    for (const c of targets) {
      const result = await adiantarCadernoDays(supabase, c, dayIsos, userJid);
      summaries.push(result.message);
      allShortIds.push(...result.shortIds);
      prepaid.push(...result.newlyPlannedDays);
    }
    await addPrepaidDays(supabase, userJid, [...new Set(prepaid)]);

    const uniq = [...new Set(allShortIds)];
    if (!uniq.length) {
      return res.status(200).json({
        token: null,
        shortIds: [],
        summary: summaries.join("\n"),
        message: "Nada a adiantar (já feito ou sem questões)."
      });
    }

    const session = await createWebSession(supabase, {
      userJid,
      userName,
      groupJid,
      mode: "adiantar",
      shortIds: uniq
    });
    return res.status(200).json({
      ...session,
      summary: summaries.join("\n"),
      message: "Dias adiantados. Responda no quiz abaixo."
    });
  }

  return res.status(400).json({ error: "action inválida (adiantar|session)" });
}

async function handleAtividades(req, res) {
  try {
    if (req.method === "GET") return await handleAtividadesGet(req, res);
    if (req.method === "POST") return await handleAtividadesPost(req, res);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[atividades]", e);
    return res.status(500).json({ error: e.message || "Erro interno" });
  }
}

module.exports = { handleAtividades };
