/**
 * Practice quiz: detail + submit num unico serverless (Hobby: max 12 functions).
 * URLs via rewrites:
 *   GET  /api/question-detail?shortId=
 *   POST /api/question-submit
 */
const { getClient, applyCors } = require("./_lib.js");

function resolveRoute(req) {
  const url = new URL(req.url || "/", "http://localhost");
  const fromQuery = url.searchParams.get("qz");
  if (fromQuery === "detail" || fromQuery === "submit") return fromQuery;

  const path = String(
    req.headers["x-vercel-original-path"] ||
      req.headers["x-invoke-path"] ||
      url.pathname ||
      ""
  ).toLowerCase();

  if (path.includes("question-detail")) return "detail";
  if (path.includes("question-submit")) return "submit";
  // Direct hit on this file: method decides
  if (req.method === "GET") return "detail";
  if (req.method === "POST") return "submit";
  return null;
}

async function handleDetail(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const shortId = String(req.query.shortId || "")
    .trim()
    .toUpperCase();
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
}

async function handleSubmit(req, res) {
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

    let userLetter =
      letterRaw === "certo" ? "C" : letterRaw === "errado" ? "E" : letterRaw.toUpperCase();

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
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const route = resolveRoute(req);
  if (route === "detail") return handleDetail(req, res);
  if (route === "submit") return handleSubmit(req, res);

  return res.status(404).json({ error: "Rota quiz desconhecida" });
};
