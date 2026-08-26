/**
 * Rotas Flashcards num unico serverless function (limite Hobby: 12 funcoes/deploy).
 * URLs publicas inalteradas via rewrites em vercel.json:
 *   GET  /api/flashcards-whatsapp-users
 *   POST /api/flashcards-link-request
 *   POST /api/flashcards-unlink-request
 *   POST /api/quiz-sync-ingest
 *   POST /api/quiz-sync-assist
 *   GET  /api/quiz-sync-omissas
 *   GET  /api/quiz-sync-inventory
 *   GET  /api/quiz-sync-answers
 *   POST /api/quiz-sync-replay-gabarito
 */

const {
  applyCors,
  checkFlashcardsInboundAuth,
  handleWhatsappUsers,
  handleLinkRequest,
  handleUnlinkRequest,
  handleIngestAnswer,
  handleAppAssist,
  handleOmissasForApp,
  handleInventoryQty,
  handleUserAnswers,
  handleCadernoStatus,
  handleReplayGabarito
} = require("./_flashcards-handlers.js");

function resolveRoute(req) {
  const url = new URL(req.url || "/", "http://localhost");
  const fromQuery = url.searchParams.get("fc");
  if (
    fromQuery === "users" ||
    fromQuery === "link" ||
    fromQuery === "unlink" ||
    fromQuery === "ingest" ||
    fromQuery === "assist" ||
    fromQuery === "omissas" ||
    fromQuery === "inventory" ||
    fromQuery === "answers" ||
    fromQuery === "status" ||
    fromQuery === "replay-gabarito"
  ) {
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
  if (path.includes("quiz-sync-ingest")) return "ingest";
  if (path.includes("quiz-sync-assist")) return "assist";
  if (path.includes("quiz-sync-omissas")) return "omissas";
  if (path.includes("quiz-sync-inventory")) return "inventory";
  if (path.includes("quiz-sync-answers")) return "answers";
  if (path.includes("quiz-sync-status")) return "status";
  if (path.includes("quiz-sync-replay-gabarito")) return "replay-gabarito";
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
  if (route === "ingest") return handleIngestAnswer(req, res);
  if (route === "assist") return handleAppAssist(req, res);
  if (route === "omissas") return handleOmissasForApp(req, res);
  if (route === "inventory") return handleInventoryQty(req, res);
  if (route === "answers") return handleUserAnswers(req, res);
  if (route === "status") return handleCadernoStatus(req, res);
  if (route === "replay-gabarito") return handleReplayGabarito(req, res);

  return res.status(404).json({ error: "Rota flashcards desconhecida" });
};
