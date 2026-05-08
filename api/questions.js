const { getClient, applyCors } = require("./_lib.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from("questions")
      .select(
        "short_id, creator_name, statement_text, question_type, created_at, statement_media_url, statement_media_mime_type"
      )
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;

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
