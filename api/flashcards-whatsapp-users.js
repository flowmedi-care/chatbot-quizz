/**
 * Lista usuários WhatsApp do grupo do quiz (JID + nome legível).
 * Chamado pelo app Flashcards (Vercel) para vincular conta sem digitar telefone.
 *
 * GET /api/flashcards-whatsapp-users
 * Authorization: Bearer <FLASHCARDS_BOT_INBOUND_SECRET>
 */

const { getClient, pickTargetGroupJid, applyCors } = require("./_lib.js");
const { getMembersForGroup } = require("./_group-members.js");

function checkInboundAuth(req) {
  const secret = String(process.env.FLASHCARDS_BOT_INBOUND_SECRET || "").trim();
  if (!secret) return { ok: false, error: "FLASHCARDS_BOT_INBOUND_SECRET nao configurado no bot." };
  const auth = String(req.headers.authorization || "").trim();
  if (auth !== `Bearer ${secret}`) return { ok: false, error: "Unauthorized" };
  return { ok: true };
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const auth = checkInboundAuth(req);
  if (!auth.ok) {
    return res.status(auth.error === "Unauthorized" ? 401 : 503).json({ error: auth.error });
  }

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
};
