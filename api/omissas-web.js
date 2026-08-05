/**
 * Rotas de omissas web + atividades num único serverless (limite Hobby: 12).
 * URLs públicas via rewrites em vercel.json:
 *   GET  /api/omissas-session
 *   POST /api/omissas-answer
 *   GET  /api/omissas-results
 *   GET|POST /api/atividades
 */
const { applyCors } = require("./_lib.js");
const {
  handleOmissasSession,
  handleOmissasAnswer,
  handleOmissasResults
} = require("./_omissas-web.js");
const { handleAtividades } = require("./_atividades.js");

function resolveRoute(req) {
  const url = new URL(req.url || "/", "http://localhost");
  const fromQuery = url.searchParams.get("om");
  if (
    fromQuery === "session" ||
    fromQuery === "answer" ||
    fromQuery === "results" ||
    fromQuery === "atividades"
  ) {
    return fromQuery;
  }

  const path = String(
    req.headers["x-vercel-original-path"] ||
      req.headers["x-invoke-path"] ||
      url.pathname ||
      ""
  ).toLowerCase();

  if (path.includes("atividades")) return "atividades";
  if (path.includes("omissas-session")) return "session";
  if (path.includes("omissas-answer")) return "answer";
  if (path.includes("omissas-results")) return "results";
  return null;
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const route = resolveRoute(req);
  if (route === "session") return handleOmissasSession(req, res);
  if (route === "answer") return handleOmissasAnswer(req, res);
  if (route === "results") return handleOmissasResults(req, res);
  if (route === "atividades") return handleAtividades(req, res);

  return res.status(404).json({ error: "Rota omissas/atividades desconhecida" });
};
