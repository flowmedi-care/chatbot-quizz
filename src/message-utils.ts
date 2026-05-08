import { WAMessage } from "@whiskeysockets/baileys";
import { QuestionType } from "./types";

function getTextFromMessage(msg: WAMessage): string {
  return (
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ??
    msg.message?.imageMessage?.caption ??
    msg.message?.videoMessage?.caption ??
    msg.message?.documentMessage?.caption ??
    ""
  );
}

export function extractMessageType(msg: WAMessage): string {
  const message = msg.message;
  if (!message) {
    return "unknown";
  }
  if (message.conversation || message.extendedTextMessage) return "text";
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.documentMessage) return "document";
  if (message.audioMessage) return "audio";
  return "other";
}

export function extractMediaMimeType(msg: WAMessage): string | null {
  return (
    msg.message?.imageMessage?.mimetype ??
    msg.message?.videoMessage?.mimetype ??
    msg.message?.documentMessage?.mimetype ??
    msg.message?.audioMessage?.mimetype ??
    null
  );
}

export function extractText(msg: WAMessage): string {
  return getTextFromMessage(msg).trim();
}

export function normalizeInput(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/** Comandos de sessao no privado (/quiz, /quizoff, /ajuda). Verificar texto bruto ou normalizado. */
export function parseSlashSessionCommand(text: string): "quiz" | "quizoff" | "help" | null {
  const t = normalizeInput(text.trim());
  if (t === "/quiz") return "quiz";
  if (t === "/quizoff") return "quizoff";
  if (t === "/ajuda") return "help";
  if (t === "guia") return "help";
  return null;
}

export function isSlashSessionCommand(text: string): boolean {
  return parseSlashSessionCommand(text) !== null;
}

/** Ver resultado completo: /gabarito 5 (aceita tambem gabarito 5 sem slash) */
export function parseGabaritoCommand(text: string): string | null {
  const normalized = normalizeInput(text.trim());
  const m =
    normalized.match(/^\/gabarito\s+([a-z0-9]+)$/i) ?? normalized.match(/^gabarito\s+([a-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : null;
}

/** Repetir enunciado salvo: /questao 5 ou questao 7B */
export function parseRepeatQuestionCommand(text: string): { shortId: string } | null {
  const t = text.trim();
  const m = t.match(/^\/questao\s+([a-z0-9]+)$/i) ?? t.match(/^questao\s+([a-z0-9]+)$/i);
  if (!m) return null;
  return { shortId: m[1].toUpperCase() };
}

export function hasSupportedMedia(msg: WAMessage): boolean {
  return Boolean(msg.message?.imageMessage) || Boolean(msg.message?.documentMessage);
}

export function parsePrivateCommand(text: string):
  | { kind: "new_question" }
  | { kind: "answer"; answer: string; questionId: string }
  | { kind: "answer_key"; questionId: string }
  | { kind: "ranking" }
  | { kind: "unknown" } {
  const normalized = normalizeInput(text);

  if (normalized === "nova questao") {
    return { kind: "new_question" };
  }

  if (normalized === "ranking") {
    return { kind: "ranking" };
  }

  const answerMatch = normalized.match(/^([abcde])\s+([a-z0-9]+)$/i);
  if (answerMatch) {
    return {
      kind: "answer",
      answer: answerMatch[1].toLowerCase(),
      questionId: answerMatch[2].toUpperCase()
    };
  }

  const gabaritoId = parseGabaritoCommand(text);
  if (gabaritoId) {
    return { kind: "answer_key", questionId: gabaritoId };
  }

  return { kind: "unknown" };
}

export function parseTypeSelection(text: string): QuestionType | null {
  const normalized = normalizeInput(text);
  if (normalized === "1") return "multiple_choice";
  if (normalized === "2") return "true_false";
  return null;
}

export function isSkipCommand(text: string): boolean {
  return normalizeInput(text) === "pular";
}

export function parseAnswerKeyByType(text: string, type: QuestionType): string | null {
  const normalized = normalizeInput(text).toUpperCase();
  if (type === "multiple_choice") {
    return ["A", "B", "C", "D", "E"].includes(normalized) ? normalized : null;
  }
  return ["C", "E"].includes(normalized) ? normalized : null;
}

export function isValidUserAnswer(answer: string, type: QuestionType): boolean {
  const normalized = answer.toUpperCase();
  if (type === "multiple_choice") {
    return ["A", "B", "C", "D", "E"].includes(normalized);
  }
  return ["C", "E"].includes(normalized);
}

export function buildOptionsLabel(type: QuestionType): string {
  if (type === "true_false") {
    return "c = certo, e = errado";
  }
  return "a, b, c, d, e";
}

export function buildDistributionKeys(type: QuestionType): string[] {
  if (type === "true_false") {
    return ["C", "E"];
  }
  return ["A", "B", "C", "D", "E"];
}
