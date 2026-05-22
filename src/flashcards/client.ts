import type {
  FlashcardBotSettings,
  FlashcardDispatchDueItem,
  FlashcardPendingResponse,
  FlashcardSession
} from "./types";
import type { FlashcardsConfig } from "./config";

export class FlashcardsApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string
  ) {
    super(message);
    this.name = "FlashcardsApiError";
  }
}

async function flashcardsFetch<T>(
  cfg: FlashcardsConfig,
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = `${cfg.apiUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/json",
      ...(init?.headers || {})
    }
  });
  const text = await res.text();
  if (!res.ok) {
    throw new FlashcardsApiError(
      `Flashcards API ${path}: ${res.status} ${text.slice(0, 200)}`,
      res.status,
      text
    );
  }
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export async function getFlashcardsBotSettings(
  cfg: FlashcardsConfig
): Promise<FlashcardBotSettings> {
  return flashcardsFetch<FlashcardBotSettings>(cfg, "/api/flashcards/bot/settings");
}

export async function getFlashcardsPending(
  cfg: FlashcardsConfig
): Promise<FlashcardPendingResponse> {
  return flashcardsFetch<FlashcardPendingResponse>(cfg, "/api/flashcards/bot/pending");
}

export async function createFlashcardsSession(
  cfg: FlashcardsConfig,
  cardIds: string[]
): Promise<FlashcardSession> {
  return flashcardsFetch<FlashcardSession>(cfg, "/api/flashcards/bot/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ card_ids: cardIds })
  });
}

export async function getFlashcardsActiveSession(
  cfg: FlashcardsConfig
): Promise<FlashcardSession | null> {
  const data = await flashcardsFetch<{ session?: FlashcardSession | null }>(
    cfg,
    "/api/flashcards/bot/sessions/active"
  );
  return data.session ?? null;
}

export async function confirmFlashcardsSession(
  cfg: FlashcardsConfig,
  sessionId: string
): Promise<void> {
  await flashcardsFetch(cfg, `/api/flashcards/bot/sessions/${sessionId}/confirm`, {
    method: "POST"
  });
}

export async function cancelFlashcardsSession(
  cfg: FlashcardsConfig,
  sessionId: string
): Promise<void> {
  await flashcardsFetch(cfg, `/api/flashcards/bot/sessions/${sessionId}/cancel`, {
    method: "POST"
  });
}

export async function listFlashcardsDispatchDue(
  cfg: FlashcardsConfig
): Promise<FlashcardDispatchDueItem[]> {
  const data = await flashcardsFetch<
    FlashcardDispatchDueItem[] | { items?: FlashcardDispatchDueItem[] }
  >(cfg, "/api/flashcards/bot/dispatch/due");
  if (Array.isArray(data)) return data;
  return data.items ?? [];
}

export async function markFlashcardsDispatchSent(
  cfg: FlashcardsConfig,
  dispatchId: string
): Promise<void> {
  await flashcardsFetch(cfg, `/api/flashcards/bot/dispatch/${dispatchId}/sent`, {
    method: "POST"
  });
}

export async function submitFlashcardsDispatchAnswer(
  cfg: FlashcardsConfig,
  dispatchId: string,
  rating: number
): Promise<void> {
  await flashcardsFetch(cfg, `/api/flashcards/bot/dispatch/${dispatchId}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating })
  });
}
