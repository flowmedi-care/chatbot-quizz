export type FlashcardsConfig = {
  apiUrl: string;
  apiKey: string;
  pollIntervalMs: number;
};

/** Config global da VPS: URL do app + intervalo. API key por usuário vem do Supabase após SIM. */
export type FlashcardsBaseConfig = {
  apiUrl: string;
  pollIntervalMs: number;
  /** Opcional: um usuário fixo no .env (legado). */
  legacyApiKey: string | null;
};

export function getFlashcardsBaseConfig(): FlashcardsBaseConfig | null {
  const apiUrl = String(process.env.FLASHCARDS_API_URL || "").trim().replace(/\/$/, "");
  if (!apiUrl) return null;
  const legacyApiKey = String(process.env.FLASHCARDS_API_KEY || "").trim() || null;
  const pollRaw = Number(process.env.FLASHCARDS_POLL_MS || 90_000);
  const pollIntervalMs = Number.isFinite(pollRaw) && pollRaw >= 30_000 ? pollRaw : 90_000;
  return { apiUrl, pollIntervalMs, legacyApiKey };
}

export function userFlashcardsConfig(
  base: FlashcardsBaseConfig,
  apiKey: string
): FlashcardsConfig {
  return {
    apiUrl: base.apiUrl,
    apiKey,
    pollIntervalMs: base.pollIntervalMs
  };
}

/** @deprecated use getFlashcardsBaseConfig + userFlashcardsConfig */
export function getFlashcardsConfig(): FlashcardsConfig | null {
  const base = getFlashcardsBaseConfig();
  if (!base?.legacyApiKey) return null;
  return userFlashcardsConfig(base, base.legacyApiKey);
}
