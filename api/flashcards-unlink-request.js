/**
 * App Flashcards avisa desvinculo (opcional).
 *
 * POST /api/flashcards-unlink-request
 * Authorization: Bearer <FLASHCARDS_BOT_INBOUND_SECRET>
 * Body: { "userJid": "...", "apiKey": "fc_..." }
 */

const { getClient, applyCors } = require("./_lib.js");
const { checkFlashcardsInboundAuth, isPrivateJid } = require("./_flashcards-inbound-auth.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const auth = checkFlashcardsInboundAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "JSON invalido" });
  }

  const userJid = body.userJid != null ? String(body.userJid).trim() : "";
  const apiKey = body.apiKey != null ? String(body.apiKey).trim() : "";

  if (!userJid || !isPrivateJid(userJid)) {
    return res.status(400).json({ error: "Informe userJid valido." });
  }

  try {
    const supabase = getClient();
    let q = supabase.from("flashcards_whatsapp_links").delete().eq("user_jid", userJid);
    if (apiKey.startsWith("fc_")) {
      q = q.eq("api_key", apiKey);
    }
    const { error } = await q;

    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("relation") && msg.includes("does not exist")) {
        return res.status(503).json({
          error: "Rode supabase-migration-flashcards-whatsapp-links.sql no Supabase do quiz."
        });
      }
      throw error;
    }

    return res.status(200).json({ ok: true, unlinked: true });
  } catch (e) {
    console.error("[flashcards-unlink-request]", e);
    return res.status(500).json({ error: e.message || "Erro ao desvincular" });
  }
};
