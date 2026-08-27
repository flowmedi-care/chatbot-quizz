/**
 * Discussões do feed (via /api/questions?view=discussions*).
 * GET  /api/discussions
 * GET  /api/discussions?postId=
 * GET  /api/discussions?shortId=   → detalhe (cria early se precisar? só lê)
 * POST /api/discussions            → { postId? | shortId?, userJid, body, parentId? }
 * POST /api/discussions/share-whatsapp → { commentId, userJid }
 */
const { pickTargetGroupJid, fetchAllIn } = require("./_lib.js");
const {
  getMembersForGroup,
  getNameHintsForGroup,
  pickDisplayLabel
} = require("./_group-members.js");

const FEED_TZ = "America/Sao_Paulo";
const POST_SELECT = "id, question_id, short_id, group_jid, source, created_at, feed_at";

function discussionsMissing(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("relation") && msg.includes("does not exist");
}

function jidKey(jid) {
  const raw = String(jid || "")
    .trim()
    .toLowerCase();
  const at = raw.indexOf("@");
  if (at < 0) return raw;
  const user = raw.slice(0, at).split(":")[0];
  const domain = raw.slice(at + 1);
  return `${user}@${domain}`;
}

function dayInTz(iso, timeZone = FEED_TZ) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(d);
  } catch {
    return String(iso).slice(0, 10);
  }
}

function todayInTz(timeZone = FEED_TZ) {
  return dayInTz(new Date().toISOString(), timeZone);
}

function mapComment(row) {
  return {
    id: Number(row.id),
    postId: Number(row.post_id),
    parentId: row.parent_id != null ? Number(row.parent_id) : null,
    authorJid: String(row.author_jid || ""),
    authorName: row.author_name != null ? String(row.author_name) : null,
    body: String(row.body || ""),
    source: String(row.source || "web"),
    waMessageId: row.wa_message_id != null ? String(row.wa_message_id) : null,
    sharedToWaAt: row.shared_to_wa_at != null ? String(row.shared_to_wa_at) : null,
    createdAt: String(row.created_at)
  };
}

function mapPost(row) {
  const feedAt = row.feed_at != null ? String(row.feed_at) : null;
  return {
    id: Number(row.id),
    questionId: Number(row.question_id),
    shortId: String(row.short_id || "").toUpperCase(),
    groupJid: String(row.group_jid || ""),
    source: String(row.source || ""),
    createdAt: String(row.created_at),
    feedAt,
    feedDay: dayInTz(feedAt || row.created_at)
  };
}

function isFeedSource(source) {
  return source === "auto_gabarito" || source === "gabarito";
}

async function listPosts(supabase, limit = 120) {
  const { data, error } = await supabase
    .from("discussion_posts")
    .select(POST_SELECT)
    .in("source", ["auto_gabarito", "gabarito"])
    .order("feed_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    if (discussionsMissing(error)) {
      return {
        posts: [],
        availableDays: [],
        today: todayInTz(),
        cadernos: [],
        engagementByCaderno: {},
        warning: "Rode supabase-migration-discussions.sql no Supabase."
      };
    }
    // fallback se feed_at ainda não existe
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("feed_at")) {
      const legacy = await supabase
        .from("discussion_posts")
        .select("id, question_id, short_id, group_jid, source, created_at")
        .in("source", ["auto_gabarito", "gabarito"])
        .order("created_at", { ascending: false })
        .limit(limit);
      if (legacy.error) throw legacy.error;
      return enrichPostsList(supabase, (legacy.data || []).map((r) => ({ ...r, feed_at: r.created_at })));
    }
    throw error;
  }
  return enrichPostsList(supabase, data || []);
}

async function enrichPostsList(supabase, rows) {
  const posts = rows.map(mapPost);
  const today = todayInTz();
  if (!posts.length) {
    return { posts: [], availableDays: [], today, cadernos: [] };
  }

  const questionIds = posts.map((p) => p.questionId);
  const { data: qRows } = await supabase
    .from("questions")
    .select("id, statement_text, creator_jid")
    .in("id", questionIds);
  const previewById = new Map();
  const creatorByQ = new Map();
  for (const row of qRows || []) {
    const raw = row.statement_text != null ? String(row.statement_text).trim() : "";
    previewById.set(Number(row.id), raw ? raw.slice(0, 220) : null);
    creatorByQ.set(Number(row.id), String(row.creator_jid || ""));
  }

  const cadernoByQuestionId = new Map();
  const { data: cqRows } = await supabase
    .from("caderno_questions")
    .select("published_question_id, caderno_id")
    .in("published_question_id", questionIds);
  for (const row of cqRows || []) {
    const qid = Number(row.published_question_id);
    const cid = Number(row.caderno_id);
    if (Number.isFinite(qid) && Number.isFinite(cid)) cadernoByQuestionId.set(qid, cid);
  }
  for (const [qid, creator] of creatorByQ) {
    if (cadernoByQuestionId.has(qid)) continue;
    const m = String(creator || "").match(/^caderno:(\d+)@bot$/i);
    if (m) cadernoByQuestionId.set(qid, Number(m[1]));
  }

  const cadernoIds = [...new Set([...cadernoByQuestionId.values()])];
  const cadernoNames = new Map();
  if (cadernoIds.length) {
    const { data: cRows } = await supabase.from("cadernos").select("id, name").in("id", cadernoIds);
    for (const c of cRows || []) {
      cadernoNames.set(Number(c.id), String(c.name || `Caderno #${c.id}`));
    }
  }

  const postIds = posts.map((p) => p.id);
  const { data: cRows } = await supabase
    .from("discussion_comments")
    .select("post_id, author_jid, author_name")
    .in("post_id", postIds);

  const countByPost = new Map();
  /** @type {Map<number, Map<string, { jidKey: string, local: string, name: string }>>} */
  const discussantsByPost = new Map();
  for (const row of cRows || []) {
    const pid = Number(row.post_id);
    countByPost.set(pid, (countByPost.get(pid) || 0) + 1);
    if (!discussantsByPost.has(pid)) discussantsByPost.set(pid, new Map());
    const jk = jidKey(row.author_jid);
    const local = String(row.author_jid || "")
      .split("@")[0]
      .split(":")[0]
      .toLowerCase();
    const nm = String(row.author_name || "").trim();
    const map = discussantsByPost.get(pid);
    const prev = map.get(jk) || { jidKey: jk, local, name: "" };
    if (nm && (!prev.name || nm.length > prev.name.length)) prev.name = nm;
    prev.local = local || prev.local;
    map.set(jk, prev);
  }

  // Mapa de engajamento por caderno (todos os membros) — o front filtra pelo user selecionado
  let engagementByCaderno = {};
  if (cadernoIds.length) {
    const { data: engRows, error: engErr } = await supabase
      .from("caderno_engagement")
      .select("caderno_id, user_jid, engaged, passive")
      .in("caderno_id", cadernoIds);
    if (!engErr) {
      for (const row of engRows || []) {
        const cid = Number(row.caderno_id);
        if (!Number.isFinite(cid)) continue;
        if (!engagementByCaderno[cid]) engagementByCaderno[cid] = [];
        engagementByCaderno[cid].push({
          userJid: String(row.user_jid || ""),
          userJidKey: jidKey(row.user_jid),
          engaged: Boolean(row.engaged),
          passive: Boolean(row.passive)
        });
      }
    }
  }

  const daySet = new Set();
  const cadernoSet = new Map();
  const enriched = posts.map((p) => {
    if (p.feedDay) daySet.add(p.feedDay);
    const cadernoId = cadernoByQuestionId.get(p.questionId) ?? null;
    const cadernoName =
      cadernoId != null ? cadernoNames.get(cadernoId) || `Caderno #${cadernoId}` : null;
    if (cadernoId != null) {
      cadernoSet.set(cadernoId, cadernoName);
    }
    const discussants = [...(discussantsByPost.get(p.id)?.values() || [])];
    return {
      ...p,
      cadernoId,
      cadernoName,
      statementPreview: previewById.get(p.questionId) ?? null,
      commentCount: countByPost.get(p.id) || 0,
      // quem escreveu na thread (raiz ou reply) — NÃO usa answers.answer_comment
      discussants,
      authorJidKeys: discussants.map((d) => d.jidKey),
      authorNames: discussants.map((d) => d.name).filter(Boolean)
    };
  });

  const availableDays = [...daySet].sort((a, b) => b.localeCompare(a));
  const cadernos = [...cadernoSet.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-BR"));

  return {
    posts: enriched,
    availableDays,
    today,
    cadernos,
    engagementByCaderno
  };
}

async function loadAnswersContext(supabase, questionId, answerKey) {
  const { splitAnswerComments } = require("./_answer-comments.js");
  let answers;
  const first = await supabase
    .from("answers")
    .select("user_jid, user_name, answer_letter, answer_comment, ai_comment")
    .eq("question_id", questionId);
  if (first.error && /column/i.test(first.error.message || "")) {
    const retry = await supabase
      .from("answers")
      .select("user_jid, user_name, answer_letter, answer_comment")
      .eq("question_id", questionId);
    if (retry.error) throw retry.error;
    answers = retry.data;
  } else if (first.error) throw first.error;
  else answers = first.data;
  const key = String(answerKey || "")
    .toUpperCase()
    .slice(0, 1);
  return (answers || []).map((row) => {
    const letter = String(row.answer_letter || "")
      .toUpperCase()
      .slice(0, 1);
    const name = (row.user_name && String(row.user_name).trim()) || "Participante";
    const split = splitAnswerComments(row);
    return {
      userJid: String(row.user_jid || ""),
      userName: name,
      letter,
      comment: split.comment,
      aiComment: split.aiComment,
      correct: key ? letter === key : null
    };
  });
}

async function getPostDetail(supabase, postId) {
  const { data: post, error } = await supabase
    .from("discussion_posts")
    .select(POST_SELECT)
    .eq("id", postId)
    .maybeSingle();
  if (error) {
    if (discussionsMissing(error)) {
      return { error: "Rode supabase-migration-discussions.sql no Supabase.", status: 503 };
    }
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("feed_at")) {
      const legacy = await supabase
        .from("discussion_posts")
        .select("id, question_id, short_id, group_jid, source, created_at")
        .eq("id", postId)
        .maybeSingle();
      if (legacy.error) throw legacy.error;
      if (!legacy.data) return { error: "Discussão não encontrada.", status: 404 };
      return getPostDetailFromRow(supabase, { ...legacy.data, feed_at: legacy.data.created_at });
    }
    throw error;
  }
  if (!post) return { error: "Discussão não encontrada.", status: 404 };
  return getPostDetailFromRow(supabase, post);
}

async function getPostDetailByShortId(supabase, shortId) {
  const id = String(shortId || "")
    .trim()
    .toUpperCase();
  if (!id) return { error: "shortId inválido.", status: 400 };
  const { data: post, error } = await supabase
    .from("discussion_posts")
    .select(POST_SELECT)
    .eq("short_id", id)
    .maybeSingle();
  if (error) {
    if (discussionsMissing(error)) {
      return { error: "Rode supabase-migration-discussions.sql no Supabase.", status: 503 };
    }
    throw error;
  }
  if (!post) {
    // ainda sem post: devolve contexto da questão para discussão antecipada
    const { data: q, error: qErr } = await supabase
      .from("questions")
      .select(
        "id, short_id, statement_text, answer_key, target_group_jid, explanation_text"
      )
      .eq("short_id", id)
      .maybeSingle();
    if (qErr) throw qErr;
    if (!q) return { error: "Questão não encontrada.", status: 404 };
    const answers = await loadAnswersContext(supabase, Number(q.id), q.answer_key);
    return {
      post: null,
      early: true,
      shortId: id,
      questionId: Number(q.id),
      groupJid: String(q.target_group_jid || pickTargetGroupJid() || ""),
      statementText: q.statement_text ? String(q.statement_text).trim() : null,
      answerKey: String(q.answer_key || "")
        .toUpperCase()
        .slice(0, 1),
      explanationText: q.explanation_text ? String(q.explanation_text).trim() : null,
      answers,
      comments: []
    };
  }
  return getPostDetailFromRow(supabase, post);
}

async function getPostDetailFromRow(supabase, post) {
  const mapped = mapPost(post);
  const { data: q } = await supabase
    .from("questions")
    .select("statement_text, answer_key, explanation_text")
    .eq("id", mapped.questionId)
    .maybeSingle();
  const statementRaw = q?.statement_text != null ? String(q.statement_text).trim() : "";
  const answerKey = q?.answer_key
    ? String(q.answer_key)
        .toUpperCase()
        .slice(0, 1)
    : null;
  const explanationText =
    q?.explanation_text != null && String(q.explanation_text).trim()
      ? String(q.explanation_text).trim()
      : null;

  const answers = await loadAnswersContext(supabase, mapped.questionId, answerKey);

  const { data: comments, error: cErr } = await supabase
    .from("discussion_comments")
    .select(
      "id, post_id, parent_id, author_jid, author_name, body, source, wa_message_id, shared_to_wa_at, created_at"
    )
    .eq("post_id", mapped.id)
    .order("created_at", { ascending: true });
  if (cErr) throw cErr;

  return {
    post: {
      ...mapped,
      statementPreview: statementRaw ? statementRaw.slice(0, 400) : null,
      statementText: statementRaw || null,
      answerKey,
      explanationText
    },
    answers,
    comments: (comments || []).map(mapComment),
    early: mapped.source === "early"
  };
}

async function resolveAuthorName(supabase, groupJid, userJid, fallbackName) {
  const given = String(fallbackName || "").trim();
  if (given && !given.includes("@") && !/^\+?\d{8,}$/.test(given)) return given;
  try {
    const { members } = await getMembersForGroup(supabase, groupJid);
    const hints = await getNameHintsForGroup(supabase, groupJid);
    const hit = (members || []).find(
      (m) => String(m.userJid || m.user_jid || "") === userJid
    );
    if (hit) {
      const label = pickDisplayLabel({
        userJid,
        userLabel: hit.userLabel || hit.user_label,
        quizDisplayName: hit.quizDisplayName || hit.quiz_display_name || hit.displayLabel,
        nameFromQuiz: hints.get(userJid) || null
      });
      if (label && label !== "Participante") return label;
    }
    const fromHint = hints.get(userJid);
    if (fromHint) return fromHint;
  } catch {
    /* ignore */
  }
  return given || "Participante";
}

async function ensurePostForComment(supabase, body) {
  const postId = Number(body.postId);
  if (Number.isFinite(postId) && postId > 0) {
    const { data: post, error } = await supabase
      .from("discussion_posts")
      .select(POST_SELECT)
      .eq("id", postId)
      .maybeSingle();
    if (error) {
      if (discussionsMissing(error)) {
        return { error: "Rode supabase-migration-discussions.sql no Supabase.", status: 503 };
      }
      throw error;
    }
    if (!post) return { error: "Discussão não encontrada.", status: 404 };
    return { post: mapPost(post) };
  }

  const shortId = String(body.shortId || "")
    .trim()
    .toUpperCase();
  if (!shortId) return { error: "Informe postId ou shortId.", status: 400 };

  const { data: existing } = await supabase
    .from("discussion_posts")
    .select(POST_SELECT)
    .eq("short_id", shortId)
    .maybeSingle();
  if (existing) return { post: mapPost(existing) };

  const { data: q, error: qErr } = await supabase
    .from("questions")
    .select("id, short_id, target_group_jid")
    .eq("short_id", shortId)
    .maybeSingle();
  if (qErr) throw qErr;
  if (!q) return { error: "Questão não encontrada.", status: 404 };

  const groupJid =
    String(q.target_group_jid || "").trim() || pickTargetGroupJid() || "";
  if (!groupJid || !groupJid.endsWith("@g.us")) {
    return {
      error: "Discussão antecipada só para questões do grupo.",
      status: 400
    };
  }

  const { data: created, error: cErr } = await supabase
    .from("discussion_posts")
    .insert({
      question_id: Number(q.id),
      short_id: shortId,
      group_jid: groupJid,
      source: "early",
      feed_at: null
    })
    .select(POST_SELECT)
    .single();

  if (cErr) {
    const msg = String(cErr.message || "").toLowerCase();
    if (msg.includes("early") || msg.includes("check")) {
      return {
        error:
          "Rode supabase-migration-discussions-early.sql no Supabase para discussões antecipadas.",
        status: 503
      };
    }
    if (msg.includes("duplicate")) {
      const { data: again } = await supabase
        .from("discussion_posts")
        .select(POST_SELECT)
        .eq("short_id", shortId)
        .maybeSingle();
      if (again) return { post: mapPost(again) };
    }
    throw cErr;
  }
  return { post: mapPost(created), createdEarly: true };
}

async function createComment(supabase, body) {
  const userJid = String(body.userJid || "").trim();
  const text = String(body.body || "").trim();
  const parentIdRaw = body.parentId;
  const parentId =
    parentIdRaw == null || parentIdRaw === "" ? null : Number(parentIdRaw);

  if (!userJid) return { error: "Informe userJid.", status: 400 };
  if (!text) return { error: "Comentário vazio.", status: 400 };
  if (text.length > 4000) return { error: "Comentário muito longo.", status: 400 };
  if (parentId != null && (!Number.isFinite(parentId) || parentId <= 0)) {
    return { error: "parentId inválido.", status: 400 };
  }

  const ensured = await ensurePostForComment(supabase, body);
  if (ensured.error) return ensured;
  const post = ensured.post;

  if (parentId != null) {
    const { data: parent, error: parErr } = await supabase
      .from("discussion_comments")
      .select("id, post_id")
      .eq("id", parentId)
      .maybeSingle();
    if (parErr) throw parErr;
    if (!parent || Number(parent.post_id) !== post.id) {
      return { error: "Comentário pai inválido.", status: 400 };
    }
  }

  const authorName = await resolveAuthorName(
    supabase,
    String(post.groupJid),
    userJid,
    body.userName
  );

  const { data, error } = await supabase
    .from("discussion_comments")
    .insert({
      post_id: post.id,
      parent_id: parentId,
      author_jid: userJid,
      author_name: authorName,
      body: text,
      source: "web"
    })
    .select(
      "id, post_id, parent_id, author_jid, author_name, body, source, wa_message_id, shared_to_wa_at, created_at"
    )
    .single();
  if (error) throw error;
  return { comment: mapComment(data), postId: post.id, early: post.source === "early" };
}

async function shareCommentToWhatsApp(supabase, body) {
  const commentId = Number(body.commentId);
  const userJid = String(body.userJid || "").trim();
  if (!Number.isFinite(commentId) || commentId <= 0) {
    return { error: "commentId inválido.", status: 400 };
  }
  if (!userJid) return { error: "Informe userJid.", status: 400 };

  const { data: comment, error } = await supabase
    .from("discussion_comments")
    .select("id, post_id, author_jid, author_name, body, parent_id, shared_to_wa_at")
    .eq("id", commentId)
    .maybeSingle();
  if (error) {
    if (discussionsMissing(error)) {
      return { error: "Rode supabase-migration-discussions.sql no Supabase.", status: 503 };
    }
    throw error;
  }
  if (!comment) return { error: "Comentário não encontrado.", status: 404 };
  if (comment.shared_to_wa_at) {
    return { ok: true, alreadyShared: true, sharedToWaAt: comment.shared_to_wa_at };
  }

  const { data: post, error: pErr } = await supabase
    .from("discussion_posts")
    .select("id, short_id, group_jid, source")
    .eq("id", comment.post_id)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!post) return { error: "Discussão não encontrada.", status: 404 };
  if (String(post.source) === "early") {
    return {
      error:
        "Essa questão ainda não foi para o feed do grupo. O bot anuncia a discussão junto com o gabarito.",
      status: 400
    };
  }

  const { error: evErr } = await supabase.from("bot_pending_events").insert({
    kind: "discussion_share",
    payload: {
      commentId: Number(comment.id),
      shortId: String(post.short_id || "").toUpperCase(),
      groupJid: String(post.group_jid || ""),
      authorLabel: comment.author_name || null,
      body: comment.body,
      parentId: comment.parent_id,
      requestedByJid: userJid
    }
  });
  if (evErr) {
    const msg = String(evErr.message || "").toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      return {
        error: "Tabela bot_pending_events inexistente. Rode supabase-migration-omissas-web-sessions.sql",
        status: 503
      };
    }
    throw evErr;
  }

  const sharedAt = new Date().toISOString();
  await supabase
    .from("discussion_comments")
    .update({ shared_to_wa_at: sharedAt })
    .eq("id", comment.id)
    .is("shared_to_wa_at", null);

  return { ok: true, queued: true, sharedToWaAt: sharedAt };
}

async function listThreadsForShortIds(supabase, shortIds) {
  const ids = [
    ...new Set(
      (shortIds || []).map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)
    )
  ];
  const discussions = {};
  if (!ids.length) return discussions;

  let posts;
  try {
    posts = await fetchAllIn(supabase, "discussion_posts", "id, short_id", "short_id", ids);
  } catch (error) {
    if (discussionsMissing(error)) return discussions;
    throw error;
  }
  if (!posts?.length) return discussions;

  const postIdToShort = new Map();
  for (const p of posts) {
    postIdToShort.set(Number(p.id), String(p.short_id).toUpperCase());
  }
  let comments;
  try {
    comments = await fetchAllIn(
      supabase,
      "discussion_comments",
      "id, post_id, parent_id, author_jid, author_name, body, source, wa_message_id, shared_to_wa_at, created_at",
      "post_id",
      [...postIdToShort.keys()]
    );
  } catch (cErr) {
    if (discussionsMissing(cErr)) return discussions;
    throw cErr;
  }

  comments.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));

  for (const row of comments || []) {
    const shortId = postIdToShort.get(Number(row.post_id));
    if (!shortId) continue;
    if (!discussions[shortId]) discussions[shortId] = [];
    discussions[shortId].push(mapComment(row));
  }
  return discussions;
}

async function handleDiscussionsRequest(req, res, supabase, view) {
  const url = new URL(req.url || "/", "http://localhost");

  if (view === "discussions-share") {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const result = await shareCommentToWhatsApp(supabase, body);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.status(200).json(result);
  }

  if (req.method === "GET") {
    const postId = Number(url.searchParams.get("postId") || req.query?.postId);
    if (Number.isFinite(postId) && postId > 0) {
      const detail = await getPostDetail(supabase, postId);
      if (detail.error) return res.status(detail.status || 400).json({ error: detail.error });
      return res.status(200).json(detail);
    }
    const shortId = url.searchParams.get("shortId") || req.query?.shortId;
    if (shortId) {
      const detail = await getPostDetailByShortId(supabase, shortId);
      if (detail.error) return res.status(detail.status || 400).json({ error: detail.error });
      return res.status(200).json(detail);
    }
    const listed = await listPosts(supabase, 120);
    return res.status(200).json({
      groupJid: pickTargetGroupJid(),
      ...listed
    });
  }

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const result = await createComment(supabase, body);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.status(201).json(result);
  }

  return res.status(405).json({ error: "Method not allowed" });
}

module.exports = {
  handleDiscussionsRequest,
  listThreadsForShortIds
};
