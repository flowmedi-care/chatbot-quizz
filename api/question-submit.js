const { getClient, applyCors } = require("./_lib.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "JSON invalido" });
  }

  const shortId = String(body.shortId || "")
    .trim()
    .toUpperCase();
  const letterRaw = String(body.letter || "")
    .trim()
    .toLowerCase();

  if (!shortId || !letterRaw) {
    return res.status(400).json({ error: "Informe shortId e letter" });
  }

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from("questions")
      .select(
        "answer_key, question_type, explanation_text, explanation_media_url, explanation_media_mime_type"
      )
      .eq("short_id", shortId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Questao nao encontrada" });

    const expected = String(data.answer_key).toUpperCase();
    const qType = data.question_type;

    let userLetter = letterRaw === "certo" ? "C" : letterRaw === "errado" ? "E" : letterRaw.toUpperCase();

    if (qType === "true_false") {
      if (letterRaw === "c" || letterRaw === "certo") userLetter = "C";
      else if (letterRaw === "e" || letterRaw === "errado") userLetter = "E";
    } else {
      userLetter = letterRaw.toUpperCase().slice(0, 1);
    }

    const correct = userLetter === expected;

    return res.status(200).json({
      correct,
      answerKey: expected,
      yourAnswer: userLetter,
      explanationText: data.explanation_text || null,
      explanationMediaUrl: data.explanation_media_url || null,
      explanationMediaMimeType: data.explanation_media_mime_type || null
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erro ao validar resposta" });
  }
};
