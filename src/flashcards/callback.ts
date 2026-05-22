import type { FlashcardsWhatsappLink } from "./links";

/** Avisa o app Flashcards que o usuario respondeu SIM no WhatsApp. */
export async function notifyFlashcardsAppAuthorized(
  link: FlashcardsWhatsappLink
): Promise<void> {
  const baseUrl = String(process.env.FLASHCARDS_API_URL || "")
    .trim()
    .replace(/\/$/, "");
  const secret = String(process.env.FLASHCARDS_BOT_INBOUND_SECRET || "").trim();
  if (!baseUrl || !secret) {
    console.warn(
      "[flashcards] callback omitido (defina FLASHCARDS_API_URL e FLASHCARDS_BOT_INBOUND_SECRET na VPS para avisar o app)."
    );
    return;
  }

  const url = `${baseUrl}/api/flashcards/bot/whatsapp-authorized`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userJid: link.userJid,
        apiKey: link.apiKey
      })
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[flashcards] callback ${res.status}: ${text.slice(0, 200)}`);
      return;
    }
    console.log(`[flashcards] app notificado: whatsapp-authorized ${link.userJid}`);
  } catch (e) {
    console.warn("[flashcards] callback authorized:", (e as Error).message);
  }
}
