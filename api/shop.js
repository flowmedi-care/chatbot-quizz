const { applyCors, getClient } = require("./_lib");
const { ensureEconomy, randomToken } = require("./_economy");

module.exports = async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const supabase = getClient();
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET") {
      const token = url.searchParams.get("token");
      if (token) {
        const { data, error } = await supabase
          .from("purchase_confirmations")
          .select("status, item_key, expires_at, price_credits")
          .eq("token", token)
          .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: "Pedido não encontrado" });
        let status = data.status;
        if (status === "pending" && new Date(data.expires_at).getTime() < Date.now()) {
          await supabase.from("purchase_confirmations").update({ status: "expired" }).eq("token", token);
          status = "expired";
        }
        return res.status(200).json({ status, item_key: data.item_key, price_credits: data.price_credits });
      }

      const { data, error } = await supabase
        .from("shop_catalog")
        .select("*")
        .eq("active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return res.status(200).json({ items: data || [] });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const action = body.action || "purchase-intent";

      if (action === "equip") {
        const { userJid, itemKey } = body;
        if (!userJid || !itemKey) return res.status(400).json({ error: "userJid e itemKey obrigatórios" });
        const { data: item } = await supabase.from("shop_catalog").select("*").eq("item_key", itemKey).maybeSingle();
        if (!item || item.consumable) return res.status(400).json({ error: "Item inválido para equipar" });
        const { data: inv } = await supabase
          .from("user_inventory")
          .select("*")
          .eq("user_jid", userJid)
          .eq("item_key", itemKey)
          .maybeSingle();
        if (!inv) return res.status(400).json({ error: "Você não possui este item" });
        const slot = item.metadata?.slot;
        if (slot) {
          const { data: catalog } = await supabase.from("shop_catalog").select("item_key, metadata");
          const same = (catalog || [])
            .filter((c) => c.metadata?.slot === slot)
            .map((c) => c.item_key);
          if (same.length) {
            await supabase
              .from("user_inventory")
              .update({ equipped: false })
              .eq("user_jid", userJid)
              .in("item_key", same);
          }
        }
        await supabase
          .from("user_inventory")
          .update({ equipped: true, updated_at: new Date().toISOString() })
          .eq("user_jid", userJid)
          .eq("item_key", itemKey);
        return res.status(200).json({ ok: true, message: `Equipado: ${item.name}` });
      }

      const { userJid, itemKey } = body;
      if (!userJid || !itemKey) return res.status(400).json({ error: "userJid e itemKey obrigatórios" });

      const { data: item, error: itemErr } = await supabase
        .from("shop_catalog")
        .select("*")
        .eq("item_key", itemKey)
        .eq("active", true)
        .maybeSingle();
      if (itemErr) throw itemErr;
      if (!item) return res.status(404).json({ error: "Item não encontrado" });

      const eco = await ensureEconomy(supabase, userJid);
      if ((eco.aura || 0) < (item.min_aura || 0)) {
        return res.status(400).json({ error: `Aura insuficiente (precisa ${item.min_aura})` });
      }
      const available = Math.max(0, (eco.credits || 0) - (eco.credits_escrowed || 0));
      if (available < item.price_credits) {
        return res.status(400).json({ error: "Saldo disponível insuficiente" });
      }

      await supabase
        .from("purchase_confirmations")
        .update({ status: "cancelled" })
        .eq("user_jid", userJid)
        .eq("status", "pending");

      const token = randomToken();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const { error: insErr } = await supabase.from("purchase_confirmations").insert({
        token,
        user_jid: userJid,
        item_key: item.item_key,
        qty: 1,
        price_credits: item.price_credits,
        status: "pending",
        source: "site",
        expires_at: expiresAt
      });
      if (insErr) throw insErr;

      return res.status(200).json({
        token,
        expiresAt,
        item,
        price: item.price_credits,
        balance: available,
        message:
          "Aguardando confirmação no WhatsApp. Responda *sim* no privado com o bot (pedido enviado a esta pessoa)."
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};
