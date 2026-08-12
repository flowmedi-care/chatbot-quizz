const { getClient, applyCors, pickTargetGroupJid, fetchQuestionsForGroup } = require("./_lib.js");
const { handleDiscussionsRequest } = require("./_discussions.js");

function resolveDiscussionsView(req) {
  const url = new URL(req.url || "/", "http://localhost");
  const view = String(url.searchParams.get("view") || req.query?.view || "").toLowerCase();
  if (view === "discussions" || view === "discussions-share") return view;

  const path = String(
    req.headers["x-vercel-original-path"] ||
      req.headers["x-invoke-path"] ||
      url.pathname ||
      ""
  ).toLowerCase();
  if (path.includes("discussions/share-whatsapp") || path.includes("discussions-share")) {
    return "discussions-share";
  }
  if (path.includes("discussions")) return "discussions";
  return null;
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const discussionsView = resolveDiscussionsView(req);
  if (discussionsView) {
    try {
      const supabase = getClient();
      return await handleDiscussionsRequest(req, res, supabase, discussionsView);
    } catch (e) {
      console.error("[discussions]", e);
      return res.status(500).json({ error: e.message || "Erro nas discussões" });
    }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const groupJid = pickTargetGroupJid();
    if (!groupJid) {
      return res.status(200).json({
        questions: [],
        warning: "TARGET_GROUP_JIDS nao configurado no Vercel."
      });
    }

    const supabase = getClient();
    const data = (await fetchQuestionsForGroup(supabase, groupJid)).slice(0, 100);

    const questions = (data || []).map((row) => ({
      shortId: String(row.short_id || "").toUpperCase(),
      creatorName: row.creator_name || "Autor",
      questionType: row.question_type,
      createdAt: row.created_at,
      statementPreview: truncate(row.statement_text, 220),
      hasMedia: Boolean(row.statement_media_url),
      statementMediaMimeType: row.statement_media_mime_type || null
    }));

    return res.status(200).json({ questions });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao listar questoes" });
  }
};

function truncate(text, max) {
  if (!text || typeof text !== "string") return "";
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}
