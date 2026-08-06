import { PURCHASE } from "./constants";
import { applyLedger, availableCredits, economyDb, ensureEconomy, insertDiarioEvent, todayIso } from "./db";

function randomToken(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export type ShopItem = {
  item_key: string;
  name: string;
  category: string;
  price_credits: number;
  min_aura: number;
  consumable: boolean;
  metadata: Record<string, unknown>;
  sort_order: number;
};

export async function listShopCatalog(): Promise<ShopItem[]> {
  const { data, error } = await economyDb()
    .from("shop_catalog")
    .select("*")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []) as ShopItem[];
}

export async function getShopItem(itemKey: string): Promise<ShopItem | null> {
  const { data, error } = await economyDb()
    .from("shop_catalog")
    .select("*")
    .eq("item_key", itemKey)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ShopItem) || null;
}

export async function createPurchaseIntent(input: {
  userJid: string;
  itemKey: string;
  source?: "site" | "whatsapp";
}): Promise<{ token: string; expiresAt: string; item: ShopItem; price: number; balance: number }> {
  const item = await getShopItem(input.itemKey);
  if (!item) throw new Error("Item não encontrado no Portal de compras.");
  const eco = await ensureEconomy(input.userJid);
  if (eco.aura < item.min_aura) {
    throw new Error(`Aura insuficiente (precisa ${item.min_aura}).`);
  }
  const avail = await availableCredits(input.userJid);
  if (avail < item.price_credits) {
    throw new Error("Saldo disponível insuficiente.");
  }

  // cancel previous pending
  await economyDb()
    .from("purchase_confirmations")
    .update({ status: "cancelled" })
    .eq("user_jid", input.userJid)
    .eq("status", "pending");

  const token = randomToken();
  const expiresAt = new Date(Date.now() + PURCHASE.expiresMinutes * 60_000).toISOString();
  const { error } = await economyDb().from("purchase_confirmations").insert({
    token,
    user_jid: input.userJid,
    item_key: item.item_key,
    qty: 1,
    price_credits: item.price_credits,
    status: "pending",
    source: input.source || "site",
    expires_at: expiresAt
  });
  if (error) throw new Error(error.message);
  return { token, expiresAt, item, price: item.price_credits, balance: avail };
}

export async function listPendingPurchaseNotifications(limit = 20): Promise<
  {
    id: number;
    token: string;
    user_jid: string;
    item_key: string;
    price_credits: number;
    expires_at: string;
  }[]
> {
  const now = new Date().toISOString();
  const { data, error } = await economyDb()
    .from("purchase_confirmations")
    .select("id, token, user_jid, item_key, price_credits, expires_at")
    .eq("status", "pending")
    .is("notified_at", null)
    .gt("expires_at", now)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function markPurchaseNotified(id: number): Promise<void> {
  await economyDb()
    .from("purchase_confirmations")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", id);
}

export async function getPendingPurchaseForUser(userJid: string): Promise<{
  id: number;
  token: string;
  item_key: string;
  price_credits: number;
  expires_at: string;
} | null> {
  const now = new Date().toISOString();
  const { data, error } = await economyDb()
    .from("purchase_confirmations")
    .select("id, token, item_key, price_credits, expires_at")
    .eq("user_jid", userJid)
    .eq("status", "pending")
    .gt("expires_at", now)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

export async function getPurchaseStatus(token: string): Promise<{ status: string; item_key?: string } | null> {
  const { data, error } = await economyDb()
    .from("purchase_confirmations")
    .select("status, item_key, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  if (data.status === "pending" && new Date(data.expires_at).getTime() < Date.now()) {
    await economyDb().from("purchase_confirmations").update({ status: "expired" }).eq("token", token);
    return { status: "expired", item_key: data.item_key };
  }
  return { status: data.status, item_key: data.item_key };
}

async function fulfillPurchase(userJid: string, itemKey: string, price: number, token: string): Promise<void> {
  const item = await getShopItem(itemKey);
  if (!item) throw new Error("Item inválido.");
  await applyLedger({
    userJid,
    deltaCredits: -price,
    reason: "shop_purchase",
    refType: "purchase",
    refId: token,
    meta: { itemName: item.name, itemKey, price, actorLabel: userJid }
  });

  if (item.consumable && item.item_key === "streak_insurance") {
    const { ensureStreak } = await import("./db");
    const streak = await ensureStreak(userJid);
    await economyDb()
      .from("user_streak")
      .update({
        streak_insurance_charges: (streak.streak_insurance_charges || 0) + 1,
        updated_at: new Date().toISOString()
      })
      .eq("user_jid", userJid);
  }

  const { data: inv } = await economyDb()
    .from("user_inventory")
    .select("qty")
    .eq("user_jid", userJid)
    .eq("item_key", itemKey)
    .maybeSingle();
  if (inv) {
    await economyDb()
      .from("user_inventory")
      .update({ qty: (inv.qty || 0) + 1, updated_at: new Date().toISOString() })
      .eq("user_jid", userJid)
      .eq("item_key", itemKey);
  } else {
    await economyDb().from("user_inventory").insert({
      user_jid: userJid,
      item_key: itemKey,
      qty: 1,
      equipped: false
    });
  }

  if (!item.consumable || item.category === "aura" || item.category === "cosmeticos") {
    await insertDiarioEvent({
      eventType: "shop_purchase",
      actorJid: userJid,
      dayIso: todayIso(),
      payload: { itemKey, name: item.name, price }
    });
  }
}

export async function confirmPurchase(userJid: string, accept: boolean): Promise<{ ok: boolean; message: string }> {
  const pending = await getPendingPurchaseForUser(userJid);
  if (!pending) return { ok: false, message: "Nenhuma compra pendente no Portal." };
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await economyDb().from("purchase_confirmations").update({ status: "expired" }).eq("id", pending.id);
    return { ok: false, message: "Pedido expirado." };
  }
  if (!accept) {
    await economyDb().from("purchase_confirmations").update({ status: "cancelled" }).eq("id", pending.id);
    return { ok: true, message: "Compra cancelada. Nenhuma despesa foi empenhada." };
  }
  const item = await getShopItem(pending.item_key);
  await fulfillPurchase(userJid, pending.item_key, pending.price_credits, pending.token);
  await economyDb().from("purchase_confirmations").update({ status: "confirmed" }).eq("id", pending.id);
  return {
    ok: true,
    message: [
      "📄 Despesa empenhada: -" + pending.price_credits + " Créditos",
      item ? `Item: ${item.name}` : "",
      "💰 " + (await availableCredits(userJid)) + " Créditos disponíveis"
    ]
      .filter(Boolean)
      .join("\n")
  };
}

/** Compra direta no WhatsApp (com confirmação inline se caro). */
export async function purchaseDirectWhatsapp(input: {
  userJid: string;
  itemKey: string;
  confirmed?: boolean;
}): Promise<{ needsConfirm?: boolean; message: string; token?: string }> {
  const item = await getShopItem(input.itemKey);
  if (!item) return { message: "Item não encontrado. Use /loja." };
  if (!input.confirmed && item.price_credits >= PURCHASE.confirmExtraIfPriceGte) {
    const intent = await createPurchaseIntent({ userJid: input.userJid, itemKey: input.itemKey, source: "whatsapp" });
    return {
      needsConfirm: true,
      token: intent.token,
      message: [
        "🏛️ Portal de compras",
        `Despesa a empenhar: ${item.name} — ${item.price_credits} Créditos`,
        `Saldo disponível: ${intent.balance}`,
        "",
        `Confirma? Responda *sim* ou *nao*`,
        `(expira em ${PURCHASE.expiresMinutes} min · pedido #${intent.token})`
      ].join("\n")
    };
  }
  if (!input.confirmed) {
    const intent = await createPurchaseIntent({ userJid: input.userJid, itemKey: input.itemKey, source: "whatsapp" });
    const result = await confirmPurchase(input.userJid, true);
    return { message: result.message || `Despesa empenhada: ${item.name}`, token: intent.token };
  }
  const result = await confirmPurchase(input.userJid, true);
  return { message: result.message };
}

export async function listInventory(userJid: string): Promise<
  { item_key: string; qty: number; equipped: boolean; name?: string; metadata?: Record<string, unknown> }[]
> {
  const { data, error } = await economyDb().from("user_inventory").select("*").eq("user_jid", userJid);
  if (error) throw new Error(error.message);
  const catalog = await listShopCatalog();
  const byKey = new Map(catalog.map((c) => [c.item_key, c]));
  return (data || []).map((row) => ({
    item_key: row.item_key,
    qty: row.qty,
    equipped: row.equipped,
    name: byKey.get(row.item_key)?.name,
    metadata: byKey.get(row.item_key)?.metadata
  }));
}

export async function equipItem(userJid: string, itemKey: string): Promise<string> {
  const item = await getShopItem(itemKey);
  if (!item) throw new Error("Item não encontrado.");
  if (item.consumable) throw new Error("Consumíveis não se equipam.");
  const { data: inv } = await economyDb()
    .from("user_inventory")
    .select("*")
    .eq("user_jid", userJid)
    .eq("item_key", itemKey)
    .maybeSingle();
  if (!inv) throw new Error("Você não possui este item.");

  const slot = String((item.metadata as { slot?: string })?.slot || "");
  if (slot) {
    const catalog = await listShopCatalog();
    const sameSlot = catalog.filter((c) => String((c.metadata as { slot?: string })?.slot || "") === slot).map((c) => c.item_key);
    if (sameSlot.length) {
      await economyDb()
        .from("user_inventory")
        .update({ equipped: false, updated_at: new Date().toISOString() })
        .eq("user_jid", userJid)
        .in("item_key", sameSlot);
    }
  }
  await economyDb()
    .from("user_inventory")
    .update({ equipped: true, updated_at: new Date().toISOString() })
    .eq("user_jid", userJid)
    .eq("item_key", itemKey);
  return `Equipado: ${item.name}`;
}

async function consumeInventoryItem(userJid: string, itemKey: string): Promise<number> {
  const { data: inv } = await economyDb()
    .from("user_inventory")
    .select("qty")
    .eq("user_jid", userJid)
    .eq("item_key", itemKey)
    .maybeSingle();
  if (!inv || (inv.qty || 0) < 1) return -1;
  const newQty = (inv.qty || 1) - 1;
  if (newQty <= 0) {
    await economyDb().from("user_inventory").delete().eq("user_jid", userJid).eq("item_key", itemKey);
  } else {
    await economyDb()
      .from("user_inventory")
      .update({ qty: newQty, updated_at: new Date().toISOString() })
      .eq("user_jid", userJid)
      .eq("item_key", itemKey);
  }
  return Math.max(0, newQty);
}

async function hasUsedEliminateOnQuestion(userJid: string, questionShortId: string): Promise<boolean> {
  const sid = questionShortId.toUpperCase();
  const { data } = await economyDb()
    .from("economy_ledger")
    .select("id")
    .eq("user_jid", userJid)
    .eq("reason", "assist_eliminate_use")
    .eq("ref_id", `elim:${sid}`)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Usa assistência: elimina 1 alternativa errada (aleatória) OU revela se a letra escolhida é o gabarito.
 * Máximo 1 uso por questão.
 */
export async function useEliminateAssist(
  userJid: string,
  questionShortId: string,
  chosenLetter?: string | null
): Promise<string> {
  const sid = questionShortId.toUpperCase();
  if (await hasUsedEliminateOnQuestion(userJid, sid)) {
    throw new Error(`Você já usou assistência nesta questão (#${sid}). Máximo 1 por questão.`);
  }

  const { data: inv } = await economyDb()
    .from("user_inventory")
    .select("qty")
    .eq("user_jid", userJid)
    .eq("item_key", "assist_eliminate")
    .maybeSingle();
  if (!inv || (inv.qty || 0) < 1) {
    throw new Error("Você não tem 'Eliminar uma alternativa'. Compre no /loja (50 Créditos).");
  }

  const { getQuestionResult } = await import("../supabase");
  const result = await getQuestionResult(sid);
  const key = String(result.answerKey || "").toUpperCase();
  const options =
    result.questionType === "true_false" ? ["C", "E"] : ["A", "B", "C", "D", "E"];

  const letterRaw = chosenLetter != null ? String(chosenLetter).trim().toUpperCase().slice(0, 1) : "";
  let removed: string | null = null;
  let isCorrect: boolean | null = null;
  let mode: "random" | "check" = "random";

  if (letterRaw) {
    if (!options.includes(letterRaw)) {
      throw new Error(
        result.questionType === "true_false"
          ? "Letra inválida. Use C ou E."
          : "Letra inválida. Use A, B, C, D ou E."
      );
    }
    mode = "check";
    isCorrect = letterRaw === key;
    if (!isCorrect) removed = letterRaw;
  } else {
    const wrong = options.filter((o) => o !== key);
    if (wrong.length === 0) throw new Error("Não há alternativa para eliminar.");
    removed = wrong[Math.floor(Math.random() * wrong.length)];
  }

  const newQty = await consumeInventoryItem(userJid, "assist_eliminate");
  if (newQty < 0) {
    throw new Error("Você não tem 'Eliminar uma alternativa'. Compre no /loja (50 Créditos).");
  }

  await applyLedger({
    userJid,
    reason: "assist_eliminate_use",
    refType: "assist",
    refId: `elim:${sid}`,
    meta: { removed, letter: letterRaw || removed, isCorrect, mode, questionShortId: sid }
  });

  if (mode === "check") {
    return [
      "🧩 Assistência usada: Eliminar uma alternativa",
      `Questão #${sid}`,
      `Alternativa *${letterRaw}* é *${isCorrect ? "VERDADEIRA (gabarito)" : "FALSA"}*.`,
      `Restantes: ${newQty}`
    ].join("\n");
  }

  return [
    "🧩 Assistência usada: Eliminar uma alternativa",
    `Questão #${sid}`,
    `Pode descartar a alternativa *${removed}* (não é o gabarito).`,
    `Restantes: ${newQty}`
  ].join("\n");
}

/** Consome Dia de folga e marca o dia em prepaid_days (sem omissas naquele dia). */
export async function useDayOff(userJid: string, dayIso: string): Promise<string> {
  const day = String(dayIso || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("Data inválida. Use /folga hoje, /folga amanha ou /folga AAAA-MM-DD.");
  }
  const today = todayIso();
  if (day < today) {
    throw new Error("Só é possível marcar folga para hoje ou um dia futuro.");
  }

  const { data: inv } = await economyDb()
    .from("user_inventory")
    .select("qty")
    .eq("user_jid", userJid)
    .eq("item_key", "day_off")
    .maybeSingle();
  if (!inv || (inv.qty || 0) < 1) {
    throw new Error("Você não tem 'Dia de folga'. Compre no /loja (450 Créditos).");
  }

  const { ensureStreak } = await import("./db");
  const streak = await ensureStreak(userJid);
  const prepaid = new Set([...(streak.prepaid_days || []), day]);
  if ((streak.prepaid_days || []).includes(day)) {
    throw new Error(`O dia ${day} já está marcado como folga/adiantado.`);
  }

  const newQty = await consumeInventoryItem(userJid, "day_off");
  if (newQty < 0) {
    throw new Error("Você não tem 'Dia de folga'. Compre no /loja (450 Créditos).");
  }

  await economyDb()
    .from("user_streak")
    .update({ prepaid_days: [...prepaid], updated_at: new Date().toISOString() })
    .eq("user_jid", userJid);

  await applyLedger({
    userJid,
    reason: "day_off_use",
    refType: "streak_day",
    refId: `folga:${day}`,
    meta: { dayIso: day }
  });

  const label = day === today ? "hoje" : day;
  return [
    "🌴 Dia de folga ativado",
    `Dia: *${label}* (${day})`,
    "Naquele dia você conta como sem omissas (igual a ter adiantado).",
    `Restantes: ${newQty}`
  ].join("\n");
}

export function formatShopList(items: ShopItem[]): string {
  const byCat: Record<string, ShopItem[]> = {};
  for (const it of items) {
    (byCat[it.category] ||= []).push(it);
  }
  const labels: Record<string, string> = {
    assistencias: "Assistências",
    cosmeticos: "Cosméticos",
    aura: "Efeitos de Aura",
    protecao: "Proteção"
  };
  const lines = ["🏛️ Portal de compras", ""];
  for (const [cat, list] of Object.entries(byCat)) {
    lines.push(`*${labels[cat] || cat}*`);
    for (const it of list) {
      const lock = it.min_aura > 0 ? ` · Aura≥${it.min_aura}` : "";
      lines.push(`• ${it.item_key} — ${it.name}: ${it.price_credits} Créditos${lock}`);
    }
    lines.push("");
  }
  lines.push("Comprar: /comprar <item_key>");
  lines.push("Equipar: /equipar <item_key>");
  lines.push("Assistência: /eliminar <id> [letra]");
  lines.push("Folga: /folga hoje|amanha|AAAA-MM-DD");
  return lines.join("\n");
}
