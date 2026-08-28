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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

/** Normaliza JID (ignora sufixo de device: `123:64@s.whatsapp.net` → `123@s.whatsapp.net`). */
function jidComparableKey(jid) {
  const raw = String(jid || "")
    .trim()
    .toLowerCase();
  const at = raw.indexOf("@");
  if (at < 0) return raw;
  const user = raw.slice(0, at).split(":")[0];
  const domain = raw.slice(at + 1);
  return `${user}@${domain}`;
}

function chunkList(items, size = 80) {
  const list = Array.isArray(items) ? items : [];
  const n = Math.max(1, Number(size) || 80);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * `.in()` + paginação. Sem isso o PostgREST corta em 1000 linhas
 * e `.in()` grande estoura URL.
 */
async function fetchAllIn(supabase, table, select, column, ids, options = {}) {
  const pageSize = Math.min(1000, Math.max(1, Number(options.pageSize) || 1000));
  const chunkSize = Math.max(1, Number(options.chunkSize) || 80);
  const orderColumn = options.orderColumn || "id";
  const uniq = [...new Set((ids || []).filter((x) => x != null && x !== ""))];
  const all = [];
  for (const part of chunkList(uniq, chunkSize)) {
    let from = 0;
    let orderOk = Boolean(orderColumn);
    for (;;) {
      let q = supabase.from(table).select(select).in(column, part);
      if (orderOk) q = q.order(orderColumn, { ascending: true });
      const { data, error } = await q.range(from, from + pageSize - 1);
      if (error) {
        const msg = String(error.message || "");
        if (orderOk && /column|does not exist/i.test(msg)) {
          orderOk = false;
          continue;
        }
        throw error;
      }
      const rows = data || [];
      all.push(...rows);
      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }
  return all;
}

/**
 * Maior short_id numérico (UNIQUE global). Sem paginação o max fica preso
 * nas primeiras 1000 linhas e o próximo número colide.
 */
async function maxNumericShortId(supabase) {
  const pageSize = 1000;
  let max = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("questions")
      .select("short_id")
      .not("short_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      const s = String(row.short_id || "").trim();
      if (/^\d+$/.test(s)) max = Math.max(max, parseInt(s, 10));
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return max;
}

function isShortIdUniqueViolation(error) {
  const msg = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return msg.includes("questions_short_id_key") || (msg.includes("duplicate") && msg.includes("short_id"));
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

  const rows = await fetchAllIn(
    supabase,
    "caderno_questions",
    "published_question_id",
    "caderno_id",
    cadernoIds
  );

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
  jidComparableKey,
  chunkList,
  fetchAllIn,
  maxNumericShortId,
  isShortIdUniqueViolation,
  fetchQuestionsForGroup,
  fetchPublishedCadernoQuestionIdsForGroup,
  isGroupQuizQuestion,
  isPrivateQuizTargetJid,
  isPrivateCadernoShortId,
  isBotCreatorJid,
  isOrphanCadernoGroupQuestion
};
