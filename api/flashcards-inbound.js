/**
 * Rotas Flashcards num unico serverless function (limite Hobby: 12 funcoes/deploy).
 * URLs publicas inalteradas via rewrites em vercel.json:
 *   GET  /api/flashcards-whatsapp-users
 *   POST /api/flashcards-link-request
 *   POST /api/flashcards-unlink-request
 */

const {
  applyCors,
  checkFlashcardsInboundAuth,
  handleWhatsappUsers,
  handleLinkRequest,
  handleUnlinkRequest
} = require("./_flashcards-handlers.js");

function resolveRoute(req) {
  const url = new URL(req.url || "/", "http://localhost");
  const fromQuery = url.searchParams.get("fc");
  if (fromQuery === "users" || fromQuery === "link" || fromQuery === "unlink") {
    return fromQuery;
  }

  const path = String(
    req.headers["x-vercel-original-path"] ||
      req.headers["x-invoke-path"] ||
      url.pathname ||
      ""
  ).toLowerCase();

  if (path.includes("flashcards-whatsapp-users")) return "users";
  if (path.includes("flashcards-link-request")) return "link";
  if (path.includes("flashcards-unlink-request")) return "unlink";
  return null;
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const auth = checkFlashcardsInboundAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const route = resolveRoute(req);
  if (route === "users") return handleWhatsappUsers(req, res);
  if (route === "link") return handleLinkRequest(req, res);
  if (route === "unlink") return handleUnlinkRequest(req, res);

  return res.status(404).json({ error: "Rota flashcards desconhecida" });
};
