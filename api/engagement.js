const { getClient, pickTargetGroupJid, applyCors } = require("./_lib.js");

/** WhatsApp às vezes grava só LID/número em user_label — não é um “nome” legível. */
function looksLikeRawId(s) {
  const t = String(s || "").trim();
  if (!t) return true;
  if (/^\d{8,}$/.test(t)) return true;
  return false;
}

function formatPhoneJid(userJid) {
  const m = String(userJid).match(/^(\d{8,20})@s\.whatsapp\.net$/i);
  if (!m) return String(userJid);
  return `+${m[1]}`;
}

function pickDisplayLabel({ userJid, userLabel, quizDisplayName, nameFromQuiz }) {
  const fromTable = quizDisplayName != null ? String(quizDisplayName).trim() : "";
  const stored = userLabel != null ? String(userLabel).trim() : "";
  const fromAnswers = nameFromQuiz != null ? String(nameFromQuiz).trim() : "";

  if (fromTable && !looksLikeRawId(fromTable)) return fromTable;
  if (fromAnswers && !looksLikeRawId(fromAnswers)) return fromAnswers;
  if (stored && !looksLikeRawId(stored)) return stored;
  if (fromAnswers) return fromAnswers;

  if (String(userJid).includes("@s.whatsapp.net")) return formatPhoneJid(userJid);
  return stored || String(userJid);
}

async function fetchQuestionIdsForGroup(supabase, groupJid) {
  const ids = new Set();

  const { data: byTarget, error: errTarget } = await supabase
    .from("questions")
    .select("id")
    .eq("target_group_jid", groupJid);
  if (errTarget) throw errTarget;
  for (const q of byTarget || []) ids.add(q.id);

  const legacyRes = await supabase.from("questions").select("id").eq("group_jid", groupJid);
  if (!legacyRes.error && legacyRes.data) {
    for (const q of legacyRes.data) ids.add(q.id);
  }

  return [...ids];
}

/** Melhor user_name por JID (respostas no grupo). */
async function fetchNamesFromAnswers(supabase, groupJid) {
  const questionIds = await fetchQuestionIdsForGroup(supabase, groupJid);
  if (questionIds.length === 0) return new Map();

  const { data: answers, error } = await supabase
    .from("answers")
    .select("user_jid, user_name")
    .in("question_id", questionIds);

  if (error) throw error;

  const best = new Map();
  for (const row of answers || []) {
    const jid = row.user_jid != null ? String(row.user_jid) : "";
    if (!jid) continue;
    const raw = row.user_name != null ? String(row.user_name).trim() : "";
    if (!raw) continue;
    const prev = best.get(jid);
    if (!prev || raw.length > prev.length) best.set(jid, raw);
  }
  return best;
}

/** Nomes de quem já criou questão no grupo. */
async function fetchNamesFromCreators(supabase, groupJid) {
  const best = new Map();

  async function ingest(rows) {
    for (const q of rows || []) {
      const jid = q.creator_jid != null ? String(q.creator_jid) : "";
      const name = q.creator_name != null ? String(q.creator_name).trim() : "";
      if (!jid || !name) continue;
      const prev = best.get(jid);
      if (!prev || name.length > prev.length) best.set(jid, name);
    }
  }

  const r1 = await supabase
    .from("questions")
    .select("creator_jid, creator_name")
    .eq("target_group_jid", groupJid);
  if (!r1.error) await ingest(r1.data);

  const r2 = await supabase.from("questions").select("creator_jid, creator_name").eq("group_jid", groupJid);
  if (!r2.error) await ingest(r2.data);

  return best;
}

function mergeNameHints(fromAnswers, fromCreators) {
  const out = new Map(fromAnswers);
  for (const [jid, name] of fromCreators) {
    const prev = out.get(jid);
    if (!prev || String(name).length > String(prev).length) out.set(jid, name);
  }
  return out;
}

async function getNameHintsForGroup(supabase, groupJid) {
  const [namesAnswers, namesCreators] = await Promise.all([
    fetchNamesFromAnswers(supabase, groupJid),
    fetchNamesFromCreators(supabase, groupJid)
  ]);
  return mergeNameHints(namesAnswers, namesCreators);
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const groupJid = pickTargetGroupJid();
  if (!groupJid) {
    return res.status(200).json({
      members: [],
      groupJid: null,
      warning: "TARGET_GROUP_JIDS nao configurado no Vercel."
    });
  }

  try {
    const supabase = getClient();

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("group_member_engagement")
        .select("user_jid, user_label, quiz_display_name, engaged, updated_at")
        .eq("group_jid", groupJid)
        .order("user_label", { ascending: true, nullsFirst: false });

      if (error) {
        const msg = String(error.message || "").toLowerCase();
        if (msg.includes("relation") && msg.includes("does not exist")) {
          return res.status(200).json({
            members: [],
            groupJid,
            warning:
              "Tabela group_member_engagement inexistente. Rode a migracao SQL no Supabase e use /sync-membros no grupo."
          });
        }
        throw error;
      }

      const nameHints = await getNameHintsForGroup(supabase, groupJid);

      const members = (data || []).map((r) => {
        const userJid = String(r.user_jid);
        const userLabel = r.user_label ? String(r.user_label) : null;
        const quizDisplayName = r.quiz_display_name != null ? String(r.quiz_display_name) : null;
        const nameFromQuiz = nameHints.get(userJid) || null;
        const displayLabel = pickDisplayLabel({ userJid, userLabel, quizDisplayName, nameFromQuiz });
        return {
          userJid,
          userLabel,
          quizDisplayName,
          displayLabel,
          engaged: Boolean(r.engaged),
          updatedAt: r.updated_at ? String(r.updated_at) : null
        };
      });

      return res.status(200).json({ members, groupJid });
    }

    if (req.method === "PATCH") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const userJid = body.userJid != null ? String(body.userJid).trim() : "";
      if (!userJid) {
        return res.status(400).json({ error: "Campo userJid e obrigatorio." });
      }
      const engaged = Boolean(body.engaged);

      const { data: updated, error: uErr } = await supabase
        .from("group_member_engagement")
        .update({ engaged, updated_at: new Date().toISOString() })
        .eq("group_jid", groupJid)
        .eq("user_jid", userJid)
        .select("user_jid, user_label, quiz_display_name, engaged, updated_at");

      if (uErr) throw uErr;
      if (!updated || updated.length === 0) {
        return res.status(404).json({
          error:
            "Membro nao encontrado para este grupo. Rode /sync-membros no WhatsApp para popular a lista."
        });
      }

      const r = updated[0];
      const memberJid = String(r.user_jid);
      const userLabel = r.user_label ? String(r.user_label) : null;
      const quizDisplayName = r.quiz_display_name != null ? String(r.quiz_display_name) : null;
      const hints = await getNameHintsForGroup(supabase, groupJid);
      const displayLabel = pickDisplayLabel({
        userJid: memberJid,
        userLabel,
        quizDisplayName,
        nameFromQuiz: hints.get(memberJid) || null
      });

      return res.status(200).json({
        member: {
          userJid: memberJid,
          userLabel,
          quizDisplayName,
          displayLabel,
          engaged: Boolean(r.engaged),
          updatedAt: r.updated_at ? String(r.updated_at) : null
        }
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro no engajamento" });
  }
};
