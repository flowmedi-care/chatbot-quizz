const { createClient } = require("@supabase/supabase-js");

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variaveis de ambiente do Vercel.");
  }
  return createClient(url, key);
}

function pickTargetGroupJid() {
  const raw = process.env.TARGET_GROUP_JIDS || "";
  const first = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return first || null;
}

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/**
 * Questões do grupo (deduplica por id): target_group_jid + legado group_jid.
 * @param {{ extended?: boolean }} options — extended inclui campos de comentário/resolução
 */
async function fetchQuestionsForGroup(supabase, groupJid, options = {}) {
  const extended = options.extended === true;
  const sel = extended
    ? "id, short_id, creator_name, question_type, statement_text, statement_media_url, statement_media_mime_type, answer_key, explanation_text, explanation_media_url, explanation_media_mime_type, created_at, target_group_jid"
    : "id, short_id, creator_name, question_type, statement_text, statement_media_url, statement_media_mime_type, answer_key, created_at, target_group_jid";

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

  return Array.from(map.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

module.exports = { getClient, pickTargetGroupJid, applyCors, fetchQuestionsForGroup };
