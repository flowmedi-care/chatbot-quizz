const { createClient } = require("@supabase/supabase-js");

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variaveis de ambiente do Vercel.");
  }
  return createClient(url, key);
}

/** Lista de JIDs (mesma convenção do bot). */
function parseTargetGroupJids() {
  const raw = process.env.TARGET_GROUP_JIDS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Alvo do quiz no site/API: segundo JID se houver dois ou mais (primeiro pode ser slot reservado). */
function pickTargetGroupJid() {
  const list = parseTargetGroupJids();
  if (!list.length) return null;
  if (list.length >= 2) return list[1];
  return list[0];
}

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** Destino privado (caderno no PV), não o grupo do quiz. */
function isPrivateQuizTargetJid(jid) {
  const t = String(jid || "").toLowerCase();
  return t.endsWith("@s.whatsapp.net") || t.endsWith("@lid");
}

/** short_id de caderno privado (ex.: 2-16 ou 3-5-ABC). */
function isPrivateCadernoShortId(shortId) {
  return /^\d+-\d+(-[A-Z0-9]+)?$/i.test(String(shortId || "").trim());
}

/** Questão do quiz em grupo (exclui PV / caderno privado). */
function isGroupQuizQuestion(row) {
  const target = String(row.target_group_jid || row.group_jid || "");
  if (isPrivateQuizTargetJid(target)) return false;
  if (isPrivateCadernoShortId(row.short_id)) return false;
  if (!target) return false;
  return target.toLowerCase().endsWith("@g.us");
}

function isBotCreatorJid(creatorJid) {
  return String(creatorJid || "").toLowerCase().startsWith("caderno:");
}

/** IDs em questions marcados como enviados pelo agendador (cadernos do grupo). */
async function fetchPublishedCadernoQuestionIdsForGroup(supabase, groupJid) {
  const { data: cadernos, error: cErr } = await supabase
    .from("cadernos")
    .select("id")
    .eq("target_group_jid", groupJid)
    .eq("delivery_mode", "group");

  if (cErr) throw cErr;

  const cadernoIds = (cadernos || []).map((c) => c.id).filter((id) => Number.isFinite(Number(id)));
  if (!cadernoIds.length) return new Set();

  const { data: rows, error: qErr } = await supabase
    .from("caderno_questions")
    .select("published_question_id")
    .in("caderno_id", cadernoIds)
    .not("published_question_id", "is", null);

  if (qErr) throw qErr;

  const out = new Set();
  for (const row of rows || []) {
    const id = Number(row.published_question_id);
    if (Number.isFinite(id)) out.add(id);
  }
  return out;
}

function isOrphanCadernoGroupQuestion(questionId, creatorJid, publishedCadernoIds) {
  if (!isBotCreatorJid(creatorJid)) return false;
  return !publishedCadernoIds.has(questionId);
}

/**
 * Questões do grupo (deduplica por id): target_group_jid + legado group_jid.
 * @param {{ extended?: boolean }} options — extended inclui campos de comentário/resolução
 */
async function fetchQuestionsForGroup(supabase, groupJid, options = {}) {
  const extended = options.extended === true;
  const sel = extended
    ? "id, short_id, creator_name, creator_jid, question_type, statement_text, statement_media_url, statement_media_mime_type, answer_key, explanation_text, explanation_media_url, explanation_media_mime_type, created_at, target_group_jid"
    : "id, short_id, creator_name, creator_jid, question_type, statement_text, statement_media_url, statement_media_mime_type, answer_key, created_at, target_group_jid";

  const { data: byTarget, error: errTarget } = await supabase
    .from("questions")
    .select(sel)
    .eq("target_group_jid", groupJid);

  if (errTarget) throw errTarget;

  let byLegacy = [];
  const legacyRes = await supabase.from("questions").select(sel).eq("group_jid", groupJid);
  if (!legacyRes.error && legacyRes.data) byLegacy = legacyRes.data;

  const map = new Map();
  for (const q of [...(byTarget || []), ...byLegacy]) {
    map.set(q.id, q);
  }

  const publishedCadernoIds = await fetchPublishedCadernoQuestionIdsForGroup(supabase, groupJid);

  return Array.from(map.values())
    .filter(isGroupQuizQuestion)
    .filter((q) => !isOrphanCadernoGroupQuestion(q.id, q.creator_jid, publishedCadernoIds))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

module.exports = {
  getClient,
  pickTargetGroupJid,
  applyCors,
  fetchQuestionsForGroup,
  fetchPublishedCadernoQuestionIdsForGroup,
  isGroupQuizQuestion,
  isPrivateQuizTargetJid,
  isPrivateCadernoShortId,
  isBotCreatorJid,
  isOrphanCadernoGroupQuestion
};
