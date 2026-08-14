/**
 * Handlers Flashcards (app externo). Um unico serverless function no Vercel — ver api/flashcards-inbound.js.
 */

const { getClient, pickTargetGroupJid, applyCors } = require("./_lib.js");
const { getMembersForGroup } = require("./_group-members.js");
const { checkFlashcardsInboundAuth, isPrivateJid } = require("./_flashcards-inbound-auth.js");

async function handleWhatsappUsers(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const groupJid = pickTargetGroupJid();
  if (!groupJid) {
    return res.status(200).json({
      users: [],
      groupJid: null,
      warning: "TARGET_GROUP_JIDS nao configurado no servidor do bot."
    });
  }

  try {
    const supabase = getClient();
    const { members, warning } = await getMembersForGroup(supabase, groupJid);
    const users = members.map((m) => ({
      userJid: m.userJid,
      displayLabel: m.displayLabel,
      userLabel: m.userLabel,
      engaged: m.engaged
    }));
    return res.status(200).json({
      users,
      groupJid,
      warning: warning || undefined,
      hint: "Rode /sync-membros no grupo do WhatsApp se a lista estiver vazia."
    });
  } catch (e) {
    console.error("[flashcards-whatsapp-users]", e);
    return res.status(500).json({ error: e.message || "Erro ao listar usuarios" });
  }
}

async function handleLinkRequest(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "JSON invalido" });
  }

  const userJid = body.userJid != null ? String(body.userJid).trim() : "";
  const apiKey = body.apiKey != null ? String(body.apiKey).trim() : "";
  const displayLabel =
    body.displayLabel != null ? String(body.displayLabel).trim() || null : null;

  if (!userJid || !isPrivateJid(userJid)) {
    return res.status(400).json({ error: "Informe userJid valido (@lid ou @s.whatsapp.net)." });
  }
  if (!apiKey.startsWith("fc_")) {
    return res.status(400).json({ error: "Informe apiKey do Flashcards (fc_...)." });
  }

  try {
    const supabase = getClient();
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("flashcards_whatsapp_links")
      .upsert(
        {
          user_jid: userJid,
          api_key: apiKey,
          display_label: displayLabel,
          status: "pending_confirm",
          confirmation_sent_at: null,
          confirmed_at: null,
          updated_at: now
        },
        { onConflict: "user_jid" }
      )
      .select("id, user_jid, display_label, status")
      .single();

    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("relation") && msg.includes("does not exist")) {
        return res.status(503).json({
          error: "Rode supabase-migration-flashcards-whatsapp-links.sql no Supabase do quiz."
        });
      }
      throw error;
    }

    return res.status(200).json({
      ok: true,
      link: {
        id: data.id,
        userJid: data.user_jid,
        displayLabel: data.display_label,
        status: data.status
      },
      message:
        "Pedido registrado. O bot enviara uma mensagem no WhatsApp pedindo SIM ou NAO para autorizar."
    });
  } catch (e) {
    console.error("[flashcards-link-request]", e);
    return res.status(500).json({ error: e.message || "Erro ao registrar vinculo" });
  }
}

async function handleUnlinkRequest(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "JSON invalido" });
  }

  const userJid = body.userJid != null ? String(body.userJid).trim() : "";
  const apiKey = body.apiKey != null ? String(body.apiKey).trim() : "";

  if (!userJid || !isPrivateJid(userJid)) {
    return res.status(400).json({ error: "Informe userJid valido." });
  }

  try {
    const supabase = getClient();
    let q = supabase.from("flashcards_whatsapp_links").delete().eq("user_jid", userJid);
    if (apiKey.startsWith("fc_")) {
      q = q.eq("api_key", apiKey);
    }
    const { error } = await q;

    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("relation") && msg.includes("does not exist")) {
        return res.status(503).json({
          error: "Rode supabase-migration-flashcards-whatsapp-links.sql no Supabase do quiz."
        });
      }
      throw error;
    }

    return res.status(200).json({ ok: true, unlinked: true });
  } catch (e) {
    console.error("[flashcards-unlink-request]", e);
    return res.status(500).json({ error: e.message || "Erro ao desvincular" });
  }
}

function parseBody(req) {
  try {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return null;
  }
}

async function handleIngestAnswer(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: "JSON invalido" });

  const userJid = String(body.userJid || "").trim();
  const letter = String(body.answerLetter || body.letter || "")
    .trim()
    .toLowerCase()
    .slice(0, 1);
  const tecId = body.tecId != null ? String(body.tecId).trim() : "";
  const shortIdRaw = body.shortId != null ? String(body.shortId).trim().toUpperCase() : "";
  const comment = body.comment != null ? String(body.comment).trim() : "";
  const confidence = String(body.confidenceLevel || "seguro").toLowerCase();
  const durationMs =
    body.durationMs != null && Number.isFinite(Number(body.durationMs))
      ? Math.round(Number(body.durationMs))
      : null;
  const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean) : [];

  if (!userJid || !/^[abcde]$/.test(letter)) {
    return res.status(400).json({ error: "Informe userJid e answerLetter (a–e)." });
  }

  try {
    const supabase = getClient();
    let question = null;
    if (shortIdRaw) {
      const { data } = await supabase
        .from("questions")
        .select("id, short_id, answer_key, creator_jid")
        .eq("short_id", shortIdRaw)
        .maybeSingle();
      question = data;
    }
    if (!question && tecId) {
      const cadernoId =
        body.cadernoId != null && Number.isFinite(Number(body.cadernoId))
          ? Number(body.cadernoId)
          : null;
      let cqQuery = supabase
        .from("caderno_questions")
        .select("published_question_id")
        .eq("tec_question_id", tecId)
        .not("published_question_id", "is", null)
        .order("published_at", { ascending: false });
      if (cadernoId) cqQuery = cqQuery.eq("caderno_id", cadernoId);
      const { data: cq } = await cqQuery.limit(1).maybeSingle();
      if (cq?.published_question_id) {
        const { data } = await supabase
          .from("questions")
          .select("id, short_id, answer_key, creator_jid")
          .eq("id", cq.published_question_id)
          .maybeSingle();
        question = data;
      }
    }
    if (!question) {
      return res.status(202).json({ pending: true, reason: "Questao ainda nao publicada no WhatsApp." });
    }

    const row = {
      question_id: question.id,
      question_short_id: String(question.short_id || "").toUpperCase(),
      user_jid: userJid,
      user_name: body.userName != null ? String(body.userName) : null,
      answer_letter: letter,
      answer_comment: comment || null,
      source_message_id: `app:${Date.now()}`,
      sent_at: new Date().toISOString(),
      confidence_level: confidence === "inseguro" || confidence === "chute" ? confidence : "seguro",
      duration_ms: durationMs,
      sync_source: "app"
    };

    const { data: existing } = await supabase
      .from("answers")
      .select("id")
      .eq("question_id", question.id)
      .eq("user_jid", userJid)
      .maybeSingle();

    let answerId;
    if (existing) {
      const { error } = await supabase.from("answers").update(row).eq("id", existing.id);
      if (error && /column/i.test(error.message || "")) {
        const slim = { ...row };
        delete slim.confidence_level;
        delete slim.duration_ms;
        delete slim.sync_source;
        const retry = await supabase.from("answers").update(slim).eq("id", existing.id);
        if (retry.error) throw retry.error;
      } else if (error) throw error;
      answerId = Number(existing.id);
    } else {
      const { data: inserted, error } = await supabase.from("answers").insert(row).select("id").maybeSingle();
      if (error && /column/i.test(error.message || "")) {
        const slim = { ...row };
        delete slim.confidence_level;
        delete slim.duration_ms;
        delete slim.sync_source;
        const retry = await supabase.from("answers").insert(slim).select("id").maybeSingle();
        if (retry.error) throw retry.error;
        answerId = Number(retry.data?.id);
      } else if (error) throw error;
      else answerId = Number(inserted?.id);
    }

    if (tags.length && answerId) {
      try {
        const { listUserCategories, createUserCategory, setAnswerCategories } = require("./_categories.js");
        const existingCats = await listUserCategories(supabase, userJid);
        const ids = [];
        for (const tag of tags) {
          const found = existingCats.find(
            (c) => c.nameNormalized === tag.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase()
          );
          if (found) ids.push(found.id);
          else {
            const created = await createUserCategory(supabase, userJid, tag);
            ids.push(created.id);
            existingCats.push(created);
          }
        }
        await setAnswerCategories(supabase, answerId, ids);
      } catch (catErr) {
        console.warn("[ingest] categories:", catErr.message || catErr);
      }
    }

    return res.status(200).json({
      ok: true,
      answerId,
      shortId: String(question.short_id || "").toUpperCase(),
      pending: false
    });
  } catch (e) {
    console.error("[quiz-sync-ingest]", e);
    return res.status(500).json({ error: e.message || "Erro ao gravar resposta" });
  }
}

async function handleAppAssist(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: "JSON invalido" });
  const userJid = String(body.userJid || "").trim();
  const shortId = String(body.shortId || "").trim().toUpperCase();
  const letter = String(body.letter || "").trim().toLowerCase().slice(0, 1);
  if (!userJid || !shortId || !/^[abcde]$/.test(letter)) {
    return res.status(400).json({ error: "Informe userJid, shortId e letter." });
  }
  try {
    const supabase = getClient();
    const {
      fetchQuestionsByShortIds,
      fetchAssistUsedMap,
      consumeAssistEliminate,
      normalizeLetter
    } = require("./_omissas-web.js");
    const usedMap = await fetchAssistUsedMap(supabase, userJid, [shortId]);
    if (usedMap.has(shortId)) {
      return res.status(409).json({ error: "Você já usou assistência nesta questão.", assistReveal: usedMap.get(shortId) });
    }
    const questions = await fetchQuestionsByShortIds(supabase, [shortId]);
    const q = questions[0];
    if (!q) return res.status(404).json({ error: "Questão não encontrada" });
    const normalized = normalizeLetter(letter, q.question_type);
    if (!normalized) return res.status(400).json({ error: "Letra inválida." });
    const key = String(q.answer_key || "").trim().toLowerCase().slice(0, 1);
    const isCorrect = normalized === key;
    const letterUp = normalized.toUpperCase();
    const newQty = await consumeAssistEliminate(supabase, userJid);
    if (newQty < 0) {
      return res.status(400).json({
        error: "Você não tem 'Verificar alternativa' no inventário."
      });
    }
    const { todayIso } = require("./_economy.js");
    await supabase.from("economy_ledger").insert({
      user_jid: userJid,
      delta_aura: 0,
      delta_credits: 0,
      reason: "assist_eliminate_use",
      ref_type: "assist",
      ref_id: `elim:${shortId}`,
      day_iso: todayIso(),
      meta: { letter: letterUp, removed: isCorrect ? null : letterUp, isCorrect, mode: "check", questionShortId: shortId }
    });
    const { data: inv } = await supabase
      .from("user_inventory")
      .select("qty")
      .eq("user_jid", userJid)
      .eq("item_key", "assist_eliminate")
      .maybeSingle();
    return res.status(200).json({
      ok: true,
      shortId,
      letter: letterUp,
      isCorrect,
      assistEliminateQty: inv?.qty ?? newQty,
      assistReveal: { letter: letterUp, isCorrect, removed: isCorrect ? null : letterUp }
    });
  } catch (e) {
    console.error("[quiz-sync-assist]", e);
    return res.status(500).json({ error: e.message || "Erro na assistência" });
  }
}

async function handleOmissasForApp(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const token = String(req.query.t || req.query.token || "").trim();
  if (!token) return res.status(400).json({ error: "Informe t." });
  try {
    const supabase = getClient();
    const { loadSession, fetchQuestionsByShortIds } = require("./_omissas-web.js");
    const loaded = await loadSession(supabase, token);
    if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
    const { session } = loaded;
    const questions = await fetchQuestionsByShortIds(supabase, session.shortIds || []);
    const ids = questions.map((q) => q.id).filter(Boolean);
    let tecByPublished = new Map();
    if (ids.length) {
      const { data: cq } = await supabase
        .from("caderno_questions")
        .select("published_question_id, tec_question_id, caderno_id, options")
        .in("published_question_id", ids);
      for (const row of cq || []) {
        tecByPublished.set(Number(row.published_question_id), row);
      }
    }
    return res.status(200).json({
      token: session.token,
      mode: session.mode,
      userJid: session.userJid,
      userName: session.userName,
      groupJid: session.groupJid,
      questions: questions.map((q) => {
        const extra = tecByPublished.get(Number(q.id)) || {};
        const tecRaw = extra.tec_question_id;
        const tecId = tecRaw != null && tecRaw !== "" && Number.isFinite(Number(tecRaw)) ? Number(tecRaw) : null;
        return {
          shortId: String(q.short_id || "").toUpperCase(),
          tecId,
          cadernoId: extra.caderno_id != null ? Number(extra.caderno_id) : null,
          questionType: q.question_type,
          statementText: q.statement_text,
          options: extra.options || q.options || [],
          alreadyAnswered: false
        };
      })
    });
  } catch (e) {
    console.error("[quiz-sync-omissas]", e);
    return res.status(500).json({ error: e.message || "Erro ao carregar omissas" });
  }
}

async function handleInventoryQty(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const userJid = String(req.query.userJid || "").trim();
  if (!userJid) return res.status(400).json({ error: "Informe userJid." });
  try {
    const supabase = getClient();
    const { data: inv } = await supabase
      .from("user_inventory")
      .select("qty")
      .eq("user_jid", userJid)
      .eq("item_key", "assist_eliminate")
      .maybeSingle();
    const { listUserCategories } = require("./_categories.js");
    const categories = await listUserCategories(supabase, userJid).catch(() => []);
    return res.status(200).json({
      assistEliminateQty: inv?.qty || 0,
      categories
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Erro" });
  }
}

async function handleUserAnswers(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const userJid = String(req.query.userJid || "").trim();
  if (!userJid) return res.status(400).json({ error: "Informe userJid." });
  const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 200));
  try {
    const supabase = getClient();
    const { data: answers, error } = await supabase
      .from("answers")
      .select(
        "id, question_id, question_short_id, answer_letter, answer_comment, confidence_level, duration_ms, sent_at"
      )
      .eq("user_jid", userJid)
      .order("sent_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    const rows = answers || [];
    const qids = rows.map((a) => a.question_id).filter(Boolean);
    const tecByPublished = new Map();
    if (qids.length) {
      const { data: cq } = await supabase
        .from("caderno_questions")
        .select("published_question_id, tec_question_id")
        .in("published_question_id", qids);
      for (const row of cq || []) {
        const tecRaw = row.tec_question_id;
        const tecId =
          tecRaw != null && tecRaw !== "" && Number.isFinite(Number(tecRaw)) ? Number(tecRaw) : null;
        tecByPublished.set(Number(row.published_question_id), tecId);
      }
    }
    const tagsByAnswer = new Map();
    const answerIds = rows.map((a) => a.id).filter(Boolean);
    if (answerIds.length) {
      const { data: cats } = await supabase
        .from("answer_categories")
        .select("answer_id, user_categories(name)")
        .in("answer_id", answerIds);
      for (const row of cats || []) {
        const name =
          row.user_categories && typeof row.user_categories === "object"
            ? String(row.user_categories.name || "")
            : "";
        if (!name) continue;
        const list = tagsByAnswer.get(Number(row.answer_id)) || [];
        list.push(name);
        tagsByAnswer.set(Number(row.answer_id), list);
      }
    }
    return res.status(200).json({
      answers: rows.map((a) => ({
        shortId: String(a.question_short_id || "").toUpperCase(),
        tecId: tecByPublished.get(Number(a.question_id)) || null,
        answerLetter: String(a.answer_letter || "").toLowerCase().slice(0, 1),
        comment: a.answer_comment || null,
        confidenceLevel: a.confidence_level || "seguro",
        durationMs: a.duration_ms != null ? Number(a.duration_ms) : null,
        tags: tagsByAnswer.get(Number(a.id)) || [],
        sentAt: a.sent_at
      }))
    });
  } catch (e) {
    console.error("[quiz-sync-answers]", e);
    return res.status(500).json({ error: e.message || "Erro ao listar respostas" });
  }
}

module.exports = {
  handleWhatsappUsers,
  handleLinkRequest,
  handleUnlinkRequest,
  handleIngestAnswer,
  handleAppAssist,
  handleOmissasForApp,
  handleInventoryQty,
  handleUserAnswers,
  applyCors,
  checkFlashcardsInboundAuth
};
