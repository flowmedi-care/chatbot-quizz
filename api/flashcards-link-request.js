/**
 * App Flashcards chama ao vincular WhatsApp: grava pedido e o bot manda SIM/NÃO no privado.
 *
 * POST /api/flashcards-link-request
 * Authorization: Bearer <FLASHCARDS_BOT_INBOUND_SECRET>
 * Body: { "userJid": "...", "apiKey": "fc_...", "displayLabel": "Daniel Ranna" }
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
  const displayLabel =
    body.displayLabel != null ? String(body.displayLabel).trim() || null : null;

  if (!userJid || !isPrivateJid(userJid)) {
    return res.status(400).json({ error: "Informe userJid valido (@lid ou @s.whatsapp.net)." });
  }
  if (!apiKey.startsWith("fc_")) {
    return res.status(400).json({ error: "Informe apiKey do Flashcards (fc_...)." });
  }

  try {
    const supabase = getClient();
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("flashcards_whatsapp_links")
      .upsert(
        {
          user_jid: userJid,
          api_key: apiKey,
          display_label: displayLabel,
          status: "pending_confirm",
          confirmation_sent_at: null,
          confirmed_at: null,
          updated_at: now
        },
        { onConflict: "user_jid" }
      )
      .select("id, user_jid, display_label, status")
      .single();

    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("relation") && msg.includes("does not exist")) {
        return res.status(503).json({
          error: "Rode supabase-migration-flashcards-whatsapp-links.sql no Supabase do quiz."
        });
      }
      throw error;
    }

    return res.status(200).json({
      ok: true,
      link: {
        id: data.id,
        userJid: data.user_jid,
        displayLabel: data.display_label,
        status: data.status
      },
      message:
        "Pedido registrado. O bot enviara uma mensagem no WhatsApp pedindo SIM ou NAO para autorizar."
    });
  } catch (e) {
    console.error("[flashcards-link-request]", e);
    return res.status(500).json({ error: e.message || "Erro ao registrar vinculo" });
  }
};
