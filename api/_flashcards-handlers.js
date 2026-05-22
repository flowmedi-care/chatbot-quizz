/**
 * Handlers Flashcards (app externo). Um unico serverless function no Vercel — ver api/flashcards-inbound.js.
 */

const { getClient, pickTargetGroupJid, applyCors } = require("./_lib.js");
const { getMembersForGroup } = require("./_group-members.js");
const { checkFlashcardsInboundAuth, isPrivateJid } = require("./_flashcards-inbound-auth.js");

async function handleWhatsappUsers(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const groupJid = pickTargetGroupJid();
  if (!groupJid) {
    return res.status(200).json({
      users: [],
      groupJid: null,
      warning: "TARGET_GROUP_JIDS nao configurado no servidor do bot."
    });
  }

  try {
    const supabase = getClient();
    const { members, warning } = await getMembersForGroup(supabase, groupJid);
    const users = members.map((m) => ({
      userJid: m.userJid,
      displayLabel: m.displayLabel,
      userLabel: m.userLabel,
      engaged: m.engaged
    }));
    return res.status(200).json({
      users,
      groupJid,
      warning: warning || undefined,
      hint: "Rode /sync-membros no grupo do WhatsApp se a lista estiver vazia."
    });
  } catch (e) {
    console.error("[flashcards-whatsapp-users]", e);
    return res.status(500).json({ error: e.message || "Erro ao listar usuarios" });
  }
}

async function handleLinkRequest(req, res) {
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
}

async function handleUnlinkRequest(req, res) {
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
}

module.exports = {
  handleWhatsappUsers,
  handleLinkRequest,
  handleUnlinkRequest,
  applyCors,
  checkFlashcardsInboundAuth
};
