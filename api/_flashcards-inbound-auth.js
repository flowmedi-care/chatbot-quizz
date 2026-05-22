/** Auth compartilhada: rotas /api/flashcards-* chamadas pelo app Flashcards. */

function checkFlashcardsInboundAuth(req) {
  const secret = String(process.env.FLASHCARDS_BOT_INBOUND_SECRET || "").trim();
  if (!secret) {
    return { ok: false, status: 503, error: "FLASHCARDS_BOT_INBOUND_SECRET nao configurado no Vercel." };
  }
  const auth = String(req.headers.authorization || "").trim();
  if (auth !== `Bearer ${secret}`) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

function isPrivateJid(jid) {
  const t = String(jid || "").toLowerCase();
  return t.endsWith("@s.whatsapp.net") || t.endsWith("@lid");
}

module.exports = { checkFlashcardsInboundAuth, isPrivateJid };
