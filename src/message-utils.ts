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
/** Lista quem respondeu: quem respondeu 7, respondentes 12, /responderam ABC */
export function parseRespondentsCommand(text: string): string | null {
  const t = normalizeInput(text.trim());
  const patterns = [
    /^quem\s+respondeu\s+([a-z0-9-]+)$/,
    /^respondentes\s+([a-z0-9-]+)$/,
    /^responderam\s+([a-z0-9-]+)$/,
    /^\/responderam\s+([a-z0-9-]+)$/,
    /^respondidos\s+([a-z0-9-]+)$/
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

export function parseGabaritoCommand(text: string): string | null {
  const normalized = normalizeInput(text.trim());
  const m =
    normalized.match(/^\/gabarito\s+([a-z0-9-]+)$/i) ??
    normalized.match(/^gabarito\s+([a-z0-9-]+)$/i);
  return m ? m[1].toUpperCase() : null;
}

/** Lista questoes em aberto no privado; depois sim/nao para receber enunciados. */
export function parseOmissasCommand(text: string): boolean {
  const t = normalizeInput(text.trim());
  return t === "/omissas" || t === "omissas";
}

/** No grupo: sincroniza participantes no Supabase para marcar engajamento no site. */
export function parseSyncMembrosCommand(text: string): boolean {
  const t = normalizeInput(text.trim());
  return t === "/sync-membros" || t === "sync-membros" || t === "/sync membros" || t === "sync membros";
}

/** Repetir enunciado salvo: /questao 5 ou questao 7B */
export function parseRepeatQuestionCommand(text: string): { shortId: string } | null {
  const t = text.trim();
  const m = t.match(/^\/questao\s+([a-z0-9-]+)$/i) ?? t.match(/^questao\s+([a-z0-9-]+)$/i);
  if (!m) return null;
  return { shortId: m[1].toUpperCase() };
}

/**
 * `/progresso #1` (ou `progresso 1`, `/progresso 1`, `progresso #1`).
 * Aceito em grupo e privado.
 */
export function parseProgressoCommand(text: string): { cadernoId: number } | null {
  const t = normalizeInput(text.trim());
  const m = t.match(/^\/?progresso\s+#?(\d+)$/i);
  if (!m) return null;
  const id = Number(m[1]);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { cadernoId: id };
}

export type CadernoCommand =
  | { kind: "list" }
  | { kind: "pause"; id: number }
  | { kind: "resume"; id: number }
  | { kind: "next"; id: number }
  | { kind: "recycle"; id: number }
  | { kind: "deactivate"; id: number }
  | { kind: "delete"; id: number };

/**
 * Comandos de caderno (privado, restritos ao created_by_jid no handler):
 *   /cadernos
 *   /caderno pause <id>     (e variantes: pausar, parar)
 *   /caderno resume <id>    (retomar, voltar, ativar)
 *   /caderno next <id>      (envia agora — debug)
 *   reciclar caderno <id>   (loop do início)
 *   desativar caderno <id>  (fim definitivo)
 *   /caderno delete <id>    (apaga linha)
 */
export function parseCadernoCommand(text: string): CadernoCommand | null {
  const t = normalizeInput(text.trim());
  if (t === "/cadernos" || t === "cadernos") return { kind: "list" };

  const slashMatch = t.match(/^\/?caderno\s+([a-z]+)\s+(\d+)$/i);
  if (slashMatch) {
    const verb = slashMatch[1];
    const id = Number(slashMatch[2]);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (verb === "pause" || verb === "pausar" || verb === "parar") return { kind: "pause", id };
    if (
      verb === "resume" ||
      verb === "retomar" ||
      verb === "voltar" ||
      verb === "ativar"
    )
      return { kind: "resume", id };
    if (verb === "next" || verb === "agora" || verb === "enviar") return { kind: "next", id };
    if (verb === "delete" || verb === "apagar" || verb === "excluir")
      return { kind: "delete", id };
    return null;
  }

  const recycleMatch = t.match(/^(?:reciclar|recomecar)\s+caderno\s+(\d+)$/i);
  if (recycleMatch) {
    const id = Number(recycleMatch[1]);
    if (Number.isFinite(id) && id > 0) return { kind: "recycle", id };
  }
  const deactivateMatch = t.match(/^(?:desativar|encerrar|finalizar)\s+caderno\s+(\d+)$/i);
  if (deactivateMatch) {
    const id = Number(deactivateMatch[1]);
    if (Number.isFinite(id) && id > 0) return { kind: "deactivate", id };
  }

  return null;
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

  /* Letra + id (ex: c 9, c9, e 12). Opcional: id + letra (ex: 9 c, 12e). */
  let answerMatch = normalized.match(/^([abcde])\s*([a-z0-9-]+)$/i);
  if (!answerMatch) {
    answerMatch = normalized.match(/^([a-z0-9-]+)\s*([abcde])$/i);
    if (answerMatch) {
      return {
        kind: "answer",
        answer: answerMatch[2].toLowerCase(),
        questionId: answerMatch[1].toUpperCase().trim()
      };
    }
  } else {
    return {
      kind: "answer",
      answer: answerMatch[1].toLowerCase(),
      questionId: answerMatch[2].toUpperCase().trim()
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

function stripOuterPunctuation(s: string): string {
  return s.replace(/^[\s.:;!?)\]]+|[\s.:;!?)\]]+$/g, "");
}

/** Interpreta texto do gabarito na criacao da questao (wizard). Aceita pontuacao trivial e grafias simples extras. */
export function parseAnswerKeyByType(text: string, type: QuestionType): string | null {
  const normalizedLine = normalizeInput(text);
  const trimmed = normalizedLine.trim();
  const stripped = stripOuterPunctuation(trimmed);
  const noSpace = stripped.replace(/\s+/g, "");
  const compact = stripped.replace(/\s+/g, " ").trim();

  if (type === "true_false") {
    if (/\bcerto\b|\bverdadeiro\b|^v$/i.test(compact)) return "C";
    if (/\berrado\b|\bfalso\b|^f$/i.test(compact)) return "E";
    if (/^(certo|[cv])$/i.test(noSpace.replace(/\./g, ""))) return "C";
    if (/^(errado|[ef])(\.|\?)?$/i.test(noSpace.replace(/\./g, ""))) return "E";
    const ce = /^([ce])(\.|\?|:)?$/i.exec(noSpace);
    if (ce) return ce[1].toUpperCase() as "C" | "E";
    return null;
  }

  const singleLetter = /^([a-e])(\.|\?|:)?$/i.exec(noSpace);
  if (singleLetter) return singleLetter[1].toUpperCase();

  const inWord = compact.match(/\b([a-e])\b/i);
  if (inWord) return inWord[1].toUpperCase();

  const onlyLetter = trimmed.replace(/\./g, "").replace(/\s+/g, "");
  return ["a", "b", "c", "d", "e"].includes(onlyLetter) ? onlyLetter.toUpperCase() : null;
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
