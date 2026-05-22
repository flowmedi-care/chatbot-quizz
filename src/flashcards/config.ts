export type FlashcardsConfig = {
  apiUrl: string;
  apiKey: string;
  pollIntervalMs: number;
};

export function getFlashcardsConfig(): FlashcardsConfig | null {
  const apiUrl = String(process.env.FLASHCARDS_API_URL || "").trim().replace(/\/$/, "");
  const apiKey = String(process.env.FLASHCARDS_API_KEY || "").trim();
  if (!apiUrl || !apiKey) return null;
  const pollRaw = Number(process.env.FLASHCARDS_POLL_MS || 90_000);
  const pollIntervalMs = Number.isFinite(pollRaw) && pollRaw >= 30_000 ? pollRaw : 90_000;
  return { apiUrl, apiKey, pollIntervalMs };
}
