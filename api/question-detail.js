const { getClient, applyCors } = require("./_lib.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const shortId = (req.query.shortId || "").trim().toUpperCase();
  if (!shortId) return res.status(400).json({ error: "Informe shortId" });

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from("questions")
      .select(
        "short_id, creator_name, question_type, statement_text, statement_media_url, statement_media_mime_type, created_at"
      )
      .eq("short_id", shortId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Questao nao encontrada" });

    return res.status(200).json({
      shortId: String(data.short_id).toUpperCase(),
      creatorName: data.creator_name || "Autor",
      questionType: data.question_type,
      statementText: data.statement_text || "",
      statementMediaUrl: data.statement_media_url || null,
      statementMediaMimeType: data.statement_media_mime_type || null,
      createdAt: data.created_at
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao carregar questao" });
  }
};
