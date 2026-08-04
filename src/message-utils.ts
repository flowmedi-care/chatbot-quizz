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

/** Estatísticas do grupo: /q&a (criadas e respondidas por pessoa + bot). */
export function parseQaCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  const normalized = normalizeInput(t);
  return (
    t === "/q&a" ||
    normalized === "q&a" ||
    normalized === "/qa" ||
    normalized === "qa"
  );
}

/** Lista questoes em aberto no privado; depois sim/nao para receber enunciados. */
export function parseOmissasCommand(text: string): boolean {
  const t = normalizeInput(text.trim());
  return t === "/omissas" || t === "omissas";
}

/** Backlog antigo (não conta no streak). */
export function parseAtrasadasCommand(text: string): boolean {
  const t = normalizeInput(text.trim());
  return t === "/atrasadas" || t === "atrasadas";
}

/** Adiantar questões dos próximos N dias: adiantar 2, /adiantar 2 */
export function parseAdiantarCommand(text: string): { days: number } | null {
  const t = normalizeInput(text.trim());
  const m = t.match(/^\/?adiantar\s+(\d+)$/);
  if (!m) return null;
  const days = Number(m[1]);
  if (!Number.isFinite(days) || days < 1 || days > 7) return null;
  return { days };
}

export type EconomyCommand =
  | { kind: "perfil" }
  | { kind: "auras" }
  | { kind: "loja" }
  | { kind: "comprar"; itemKey: string }
  | { kind: "equipar"; itemKey: string }
  | { kind: "aplicar"; amount: number }
  | { kind: "diario" }
  | { kind: "eliminar"; questionShortId: string }
  | { kind: "ranking_eco"; board: "aura" | "producao" | "disciplina" | "duelo" }
  | {
      kind: "intimar";
      defenderQuery: string;
      stake: number;
      questionShortId: string;
    };

/** /perfil /aura /loja /comprar X /equipar X /aplicar N /diario /ranking aura|... /intimar /auras */
export function parseEconomyCommand(text: string): EconomyCommand | null {
  const t = normalizeInput(text.trim());
  if (
    t === "/auras" ||
    t === "auras" ||
    t === "/aura todos" ||
    t === "aura todos" ||
    t === "/aura grupo" ||
    t === "aura grupo"
  ) {
    return { kind: "auras" };
  }
  if (t === "/perfil" || t === "perfil" || t === "/aura" || t === "aura") {
    return { kind: "perfil" };
  }
  if (t === "/loja" || t === "loja" || t === "/portal" || t === "portal") {
    return { kind: "loja" };
  }
  if (t === "/diario" || t === "diario") {
    return { kind: "diario" };
  }
  const comprar = t.match(/^\/?comprar\s+([a-z0-9_-]+)$/);
  if (comprar) return { kind: "comprar", itemKey: comprar[1] };
  const eliminar = t.match(/^\/?eliminar\s+([a-z0-9-]+)$/);
  if (eliminar) return { kind: "eliminar", questionShortId: eliminar[1].toUpperCase() };
  const equipar = t.match(/^\/?equipar\s+([a-z0-9_-]+)$/);
  if (equipar) return { kind: "equipar", itemKey: equipar[1] };
  const aplicar = t.match(/^\/?aplicar\s+(\d+)$/);
  if (aplicar) {
    const amount = Number(aplicar[1]);
    if (!Number.isFinite(amount) || amount < 1) return null;
    return { kind: "aplicar", amount };
  }
  const rank = t.match(/^\/?ranking(?:\s+(aura|producao|produção|disciplina|duelo|streak))?$/);
  if (rank) {
    const raw = (rank[1] || "aura").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let board: "aura" | "producao" | "disciplina" | "duelo" = "aura";
    if (raw === "producao") board = "producao";
    else if (raw === "disciplina" || raw === "streak") board = "disciplina";
    else if (raw === "duelo") board = "duelo";
    return { kind: "ranking_eco", board };
  }
  // /intimar nome_ou_jid 50 123
  const intimar = text.trim().match(/^\/?intimar\s+(.+?)\s+(\d+)\s+([a-z0-9-]+)$/i);
  if (intimar) {
    return {
      kind: "intimar",
      defenderQuery: intimar[1].trim(),
      stake: Number(intimar[2]),
      questionShortId: intimar[3].toUpperCase()
    };
  }
  return null;
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

function parseAnswerWithOptionalComment(text: string):
  | { answer: string; questionId: string; comment?: string }
  | null {
  const raw = text.trim();
  const normalized = normalizeInput(raw);

  const bracketMatch = raw.match(/^\[\s*([a-z0-9-]+)\s+([abcde])(?:\s*,\s*(.+))?\s*\]$/i);
  if (bracketMatch) {
    const comment = bracketMatch[3]?.trim();
    return {
      questionId: bracketMatch[1].toUpperCase().trim(),
      answer: bracketMatch[2].toLowerCase(),
      comment: comment || undefined
    };
  }

  const bracketAlt = raw.match(/^\[\s*([abcde])\s+([a-z0-9-]+)(?:\s*,\s*(.+))?\s*\]$/i);
  if (bracketAlt) {
    const comment = bracketAlt[3]?.trim();
    return {
      answer: bracketAlt[1].toLowerCase(),
      questionId: bracketAlt[2].toUpperCase().trim(),
      comment: comment || undefined
    };
  }

  const commaLetterFirst = normalized.match(/^([abcde])\s*([a-z0-9-]+)\s*,\s*(.+)$/i);
  if (commaLetterFirst) {
    return {
      answer: commaLetterFirst[1].toLowerCase(),
      questionId: commaLetterFirst[2].toUpperCase().trim(),
      comment: commaLetterFirst[3].trim()
    };
  }

  const commaIdFirst = normalized.match(/^([a-z0-9-]+)\s*([abcde])\s*,\s*(.+)$/i);
  if (commaIdFirst) {
    return {
      answer: commaIdFirst[2].toLowerCase(),
      questionId: commaIdFirst[1].toUpperCase().trim(),
      comment: commaIdFirst[3].trim()
    };
  }

  return null;
}

export function parsePrivateCommand(text: string):
  | { kind: "new_question" }
  | { kind: "answer"; answer: string; questionId: string; comment?: string }
  | { kind: "answer_key"; questionId: string }
  | { kind: "ranking" }
  | { kind: "qa_stats" }
  | { kind: "unknown" } {
  const normalized = normalizeInput(text);

  if (normalized === "nova questao") {
    return { kind: "new_question" };
  }

  if (normalized === "ranking") {
    return { kind: "ranking" };
  }

  if (parseQaCommand(text)) {
    return { kind: "qa_stats" };
  }

  const withComment = parseAnswerWithOptionalComment(text);
  if (withComment) {
    return {
      kind: "answer",
      answer: withComment.answer,
      questionId: withComment.questionId,
      comment: withComment.comment
    };
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

/** Divide texto longo em partes para envio no WhatsApp (limite ~4096 chars). */
export function splitWhatsAppText(text: string, maxLen = 3800): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];

  const chunks: string[] = [];
  let rest = t;
  while (rest.length > maxLen) {
    const slice = rest.slice(0, maxLen);
    const paraBreak = slice.lastIndexOf("\n\n");
    const lineBreak = slice.lastIndexOf("\n");
    let cut = maxLen;
    if (paraBreak > maxLen * 0.4) cut = paraBreak;
    else if (lineBreak > maxLen * 0.4) cut = lineBreak;

    const part = rest.slice(0, cut).trim();
    if (part) chunks.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
