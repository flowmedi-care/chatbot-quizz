import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { config } from "./config";
import type { SendTimeSlot } from "./schedule";
import {
  addDaysIso,
  dateIsoInTimezone,
  formatDayLabelPt,
  nextNDayIsosAfter,
  omissaDayIsoForInstant,
  parseSendTimesJson,
  publishedDayIso,
  WEEKDAY_LABELS_PT
} from "./schedule";
import { AnswerInput, CreateQuestionInput, QuestionType } from "./types";
import { ECONOMY_TZ, OMISSAS_SCHEDULE } from "./economy/constants";
import {
  loadGroupOmissasContext,
  loadPublishedQuestionsContext,
  loadSemanaContext,
  loadShortIdsContext,
  loadUserAnswersContext
} from "./caderno-read-context";

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
const ASSETS_BUCKET = "question-assets";

/** ID curto exibido nas mensagens do grupo = sequência 1, 2, 3… por target_group_jid. */
function toShortId(id: number | string): string {
  return String(id).trim();
}

export function isPrivateQuizTargetJid(jid: string): boolean {
  const t = jid.trim().toLowerCase();
  return t.endsWith("@s.whatsapp.net") || t.endsWith("@lid");
}

export function isPrivateCadernoShortId(shortId: string): boolean {
  return /^\d+-\d+(-[A-Z0-9]+)?$/i.test(shortId.trim());
}

export function isGroupQuizTargetJid(jid: string): boolean {
  if (isPrivateQuizTargetJid(jid)) return false;
  return jid.trim().toLowerCase().endsWith("@g.us");
}

export function isBotCreatorJid(creatorJid: string): boolean {
  return creatorJid.trim().toLowerCase().startsWith("caderno:");
}

export function parseCadernoIdFromCreatorJid(creatorJid: string): number | null {
  const m = String(creatorJid || "").match(/^caderno:(\d+)@bot$/i);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Mesmo participante (ignora sufixo :NN do WhatsApp e domínio em minúsculas). */
export function isSameQuizParticipant(jidA: string, jidB: string): boolean {
  return jidComparableKeyShared(jidA) === jidComparableKeyShared(jidB);
}

export class SelfAnswerNotAllowedError extends Error {
  constructor() {
    super("Voce nao pode responder uma questao que voce criou.");
    this.name = "SelfAnswerNotAllowedError";
  }
}

function assertUserMayAnswerQuestion(creatorJid: string | null | undefined, userJid: string): void {
  if (!creatorJid?.trim() || isBotCreatorJid(creatorJid)) return;
  if (isSameQuizParticipant(creatorJid, userJid)) {
    throw new SelfAnswerNotAllowedError();
  }
}

/** IDs em `questions` que o agendador marcou como enviados (cadernos em grupo). */
export async function fetchPublishedCadernoQuestionIdsForGroup(
  groupJid: string
): Promise<Set<number>> {
  const { data: cadernos, error: cErr } = await supabase
    .from("cadernos")
    .select("id")
    .eq("target_group_jid", groupJid)
    .eq("delivery_mode", "group");

  if (cErr) {
    throw new Error(`Erro ao listar cadernos do grupo: ${cErr.message}`);
  }

  const cadernoIds = (cadernos ?? []).map((c) => Number(c.id)).filter((id) => Number.isFinite(id));
  if (cadernoIds.length === 0) return new Set();

  const { data: rows, error: qErr } = await supabase
    .from("caderno_questions")
    .select("published_question_id")
    .in("caderno_id", cadernoIds)
    .not("published_question_id", "is", null);

  if (qErr) {
    throw new Error(`Erro ao listar questoes publicadas do caderno: ${qErr.message}`);
  }

  const out = new Set<number>();
  for (const row of rows ?? []) {
    const id = Number(row.published_question_id);
    if (Number.isFinite(id)) out.add(id);
  }
  return out;
}

/** Questão do bot no grupo que nunca foi marcada em caderno_questions.published_question_id. */
export function isOrphanCadernoGroupQuestion(
  questionId: number,
  creatorJid: string,
  publishedCadernoIds: Set<number>
): boolean {
  if (!isBotCreatorJid(creatorJid)) return false;
  return !publishedCadernoIds.has(questionId);
}

/** Próximo # sequencial para questões publicadas no grupo (não usa id da linha). */
export async function nextGroupQuestionShortId(groupJid: string): Promise<string> {
  const { data, error } = await supabase
    .from("questions")
    .select("short_id")
    .eq("target_group_jid", groupJid);

  if (error) {
    throw new Error(`Erro ao calcular proximo numero da questao: ${error.message}`);
  }

  let max = 0;
  for (const row of data ?? []) {
    const s = String(row.short_id ?? "").trim();
    if (/^\d+$/.test(s)) {
      max = Math.max(max, parseInt(s, 10));
    }
  }
  return String(max + 1);
}

async function ensureBucket(): Promise<void> {
  const { data, error } = await supabase.storage.getBucket(ASSETS_BUCKET);
  if (!error && data) return;

  const { error: createError } = await supabase.storage.createBucket(ASSETS_BUCKET, {
    public: true
  });
  if (createError && !createError.message.toLowerCase().includes("already")) {
    throw new Error(`Erro ao preparar bucket de arquivos: ${createError.message}`);
  }
}

function buildFilePath(prefix: string, extension: string): string {
  const id = crypto.randomUUID();
  return `${prefix}/${Date.now()}-${id}.${extension}`;
}

async function uploadMedia(
  prefix: "statement" | "explanation",
  media: CreateQuestionInput["statementMedia"]
): Promise<{ url: string; mimeType: string } | null> {
  if (!media) return null;
  await ensureBucket();

  const path = buildFilePath(prefix, media.fileExt);
  const { error } = await supabase.storage.from(ASSETS_BUCKET).upload(path, media.data, {
    contentType: media.mimeType,
    upsert: false
  });

  if (error) {
    throw new Error(`Erro ao subir arquivo para storage: ${error.message}`);
  }

  const publicUrl = supabase.storage.from(ASSETS_BUCKET).getPublicUrl(path).data.publicUrl;
  return { url: publicUrl, mimeType: media.mimeType };
}

export async function createQuestion(
  input: CreateQuestionInput
): Promise<{ shortId: string; omissaDayIso: string }> {
  const statementUpload = await uploadMedia("statement", input.statementMedia);
  const explanationUpload = await uploadMedia("explanation", input.explanationMedia);
  const omissaDayIso = omissaDayIsoForInstant(
    new Date(),
    ECONOMY_TZ,
    OMISSAS_SCHEDULE.cutoffHour,
    OMISSAS_SCHEDULE.cutoffMinute
  );

  const insertRow: Record<string, unknown> = {
    // Campos novos (fluxo wizard)
    creator_jid: input.creatorJid,
    creator_name: input.creatorName,
    target_group_jid: input.targetGroupJid,
    question_type: input.questionType,
    statement_text: input.statementText,
    statement_media_url: statementUpload?.url ?? null,
    statement_media_mime_type: statementUpload?.mimeType ?? null,
    answer_key: input.answerKey.toUpperCase(),
    explanation_text: input.explanationText,
    explanation_media_url: explanationUpload?.url ?? null,
    explanation_media_mime_type: explanationUpload?.mimeType ?? null,
    omissa_day_iso: omissaDayIso,
    // Compatibilidade com schema legado
    group_jid: input.targetGroupJid,
    sender_jid: input.creatorJid,
    message_type: input.statementMedia ? "media" : "text",
    text_content: input.statementText,
    media_mime_type: statementUpload?.mimeType ?? null,
    wa_message_id: `wizard-${Date.now()}-${crypto.randomUUID()}`,
    sent_at: new Date().toISOString()
  };
  if (input.materiaId != null && Number.isFinite(Number(input.materiaId))) {
    insertRow.materia_id = Number(input.materiaId);
  }

  let { data, error } = await supabase
    .from("questions")
    .insert(insertRow)
    .select("id")
    .single();

  if (
    error &&
    insertRow.materia_id != null &&
    String(error.message || "")
      .toLowerCase()
      .includes("materia_id")
  ) {
    delete insertRow.materia_id;
    const retry = await supabase.from("questions").insert(insertRow).select("id").single();
    data = retry.data;
    error = retry.error;
  }

  if (
    error &&
    insertRow.omissa_day_iso != null &&
    String(error.message || "")
      .toLowerCase()
      .includes("omissa_day_iso")
  ) {
    delete insertRow.omissa_day_iso;
    const retry = await supabase.from("questions").insert(insertRow).select("id").single();
    data = retry.data;
    error = retry.error;
  }

  if (error || !data) {
    throw new Error(`Erro ao criar questao: ${error?.message ?? "sem dados"}`);
  }

  const shortId = isGroupQuizTargetJid(input.targetGroupJid)
    ? await nextGroupQuestionShortId(input.targetGroupJid)
    : toShortId(data.id);

  const { error: updateError } = await supabase
    .from("questions")
    .update({ short_id: shortId })
    .eq("id", data.id);

  if (updateError) {
    throw new Error(`Erro ao atualizar short_id: ${updateError.message}`);
  }

  try {
    await persistEngagementQuizDisplayName(input.targetGroupJid, input.creatorJid, input.creatorName);
  } catch (e) {
    console.warn("[engagement] quiz_display_name (criador):", (e as Error).message);
  }

  return { shortId, omissaDayIso };
}

function looksLikeRawJidLabel(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/^\d{8,}$/.test(t)) return true;
  return false;
}

function isBetterQuizDisplayName(current: string | null | undefined, candidate: string): boolean {
  const c = candidate.trim();
  if (!c || looksLikeRawJidLabel(c)) return false;
  if (current == null || !String(current).trim()) return true;
  const cur = String(current).trim();
  if (looksLikeRawJidLabel(cur)) return true;
  return c.length > cur.length;
}

/** Grava nome legível na tabela de engajamento (linha precisa existir ou é criada sem user_label até o /sync-membros). */
export async function persistEngagementQuizDisplayName(
  groupJid: string,
  userJid: string,
  candidateName: string
): Promise<void> {
  const c = candidateName.trim();
  if (!c || looksLikeRawJidLabel(c)) return;

  const { data: row, error: readErr } = await supabase
    .from("group_member_engagement")
    .select("engaged, quiz_display_name, user_label")
    .eq("group_jid", groupJid)
    .eq("user_jid", userJid)
    .maybeSingle();

  if (readErr) {
    const msg = readErr.message.toLowerCase();
    if (msg.includes("column") && msg.includes("does not exist")) return;
    if (msg.includes("relation") && msg.includes("does not exist")) return;
    throw new Error(`Erro ao ler engajamento para nome: ${readErr.message}`);
  }

  const currentName = row?.quiz_display_name != null ? String(row.quiz_display_name) : null;
  if (row && !isBetterQuizDisplayName(currentName, c)) return;

  const engaged = row ? Boolean(row.engaged) : false;
  const userLabel = row?.user_label != null ? row.user_label : null;
  const ts = new Date().toISOString();

  if (row) {
    const { error } = await supabase
      .from("group_member_engagement")
      .update({ quiz_display_name: c, updated_at: ts })
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid);

    if (error) {
      const em = error.message.toLowerCase();
      if (em.includes("column") && em.includes("does not exist")) return;
      throw new Error(`Erro ao gravar nome no engajamento: ${error.message}`);
    }
    return;
  }

  const { error: insErr } = await supabase.from("group_member_engagement").insert({
    group_jid: groupJid,
    user_jid: userJid,
    user_label: userLabel,
    engaged,
    quiz_display_name: c,
    updated_at: ts
  });

  if (insErr) {
    const em = insErr.message.toLowerCase();
    if (em.includes("column") && em.includes("does not exist")) return;
    throw new Error(`Erro ao criar linha de engajamento com nome: ${insErr.message}`);
  }
}

export async function insertAnswer(input: AnswerInput): Promise<{ answerId: number }> {
  const { data: question, error: findError } = await supabase
    .from("questions")
    .select("id, question_type, creator_jid, target_group_jid, group_jid")
    .eq("short_id", input.questionShortId.toUpperCase())
    .maybeSingle();

  if (findError) {
    throw new Error(`Erro ao buscar questao: ${findError.message}`);
  }

  if (!question) {
    throw new Error("Questao nao encontrada");
  }

  assertUserMayAnswerQuestion(
    question.creator_jid != null ? String(question.creator_jid) : null,
    input.userJid
  );

  const { data: inserted, error } = await supabase
    .from("answers")
    .insert({
      question_id: question.id,
      question_short_id: input.questionShortId.toUpperCase(),
      user_jid: input.userJid,
      user_name: input.userName,
      answer_letter: input.answerLetter.toLowerCase(),
      answer_comment: input.answerComment?.trim() || null,
      source_message_id: input.sourceMessageId,
      sent_at: input.sentAt
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return updateUserAnswer(input);
    }
    throw new Error(`Erro ao salvar resposta: ${error.message}`);
  }

  const gj = question.target_group_jid || question.group_jid;
  if (gj) {
    try {
      await persistEngagementQuizDisplayName(String(gj), input.userJid, input.userName);
    } catch (e) {
      console.warn("[engagement] quiz_display_name:", (e as Error).message);
    }
  }

  return { answerId: Number(inserted?.id) };
}

export async function getUserAnswer(
  questionShortId: string,
  userJid: string
): Promise<{ answerId: number; answerLetter: string; answerComment: string | null } | null> {
  const { data, error } = await supabase
    .from("answers")
    .select("id, answer_letter, answer_comment")
    .eq("question_short_id", questionShortId.toUpperCase())
    .eq("user_jid", userJid)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao buscar resposta existente: ${error.message}`);
  }

  if (!data) return null;
  const commentRaw = data.answer_comment != null ? String(data.answer_comment).trim() : "";
  return {
    answerId: Number(data.id),
    answerLetter: String(data.answer_letter),
    answerComment: commentRaw.length > 0 ? commentRaw : null
  };
}

export async function updateUserAnswer(input: AnswerInput): Promise<{ answerId: number }> {
  const { data: question, error: findError } = await supabase
    .from("questions")
    .select("id, creator_jid, target_group_jid, group_jid")
    .eq("short_id", input.questionShortId.toUpperCase())
    .maybeSingle();

  if (findError) {
    throw new Error(`Erro ao buscar questao para update: ${findError.message}`);
  }

  if (!question) {
    throw new Error("Questao nao encontrada");
  }

  assertUserMayAnswerQuestion(
    question.creator_jid != null ? String(question.creator_jid) : null,
    input.userJid
  );

  const { data: updatedRows, error } = await supabase
    .from("answers")
    .update({
      question_short_id: input.questionShortId.toUpperCase(),
      user_name: input.userName,
      answer_letter: input.answerLetter.toLowerCase(),
      answer_comment: input.answerComment?.trim() || null,
      source_message_id: input.sourceMessageId,
      sent_at: input.sentAt
    })
    .eq("question_id", question.id)
    .eq("user_jid", input.userJid)
    .select("id");

  if (error) {
    throw new Error(`Erro ao atualizar resposta: ${error.message}`);
  }

  if (!updatedRows?.length) {
    const { data: inserted, error: insErr } = await supabase
      .from("answers")
      .insert({
        question_id: question.id,
        question_short_id: input.questionShortId.toUpperCase(),
        user_jid: input.userJid,
        user_name: input.userName,
        answer_letter: input.answerLetter.toLowerCase(),
        answer_comment: input.answerComment?.trim() || null,
        source_message_id: input.sourceMessageId,
        sent_at: input.sentAt
      })
      .select("id")
      .maybeSingle();
    if (insErr) {
      throw new Error(`Erro ao gravar resposta (fallback): ${insErr.message}`);
    }

    const gjIns = question.target_group_jid || question.group_jid;
    if (gjIns) {
      try {
        await persistEngagementQuizDisplayName(String(gjIns), input.userJid, input.userName);
      } catch (e) {
        console.warn("[engagement] quiz_display_name:", (e as Error).message);
      }
    }
    return { answerId: Number(inserted?.id) };
  }

  const gj = question.target_group_jid || question.group_jid;
  if (gj) {
    try {
      await persistEngagementQuizDisplayName(String(gj), input.userJid, input.userName);
    } catch (e) {
      console.warn("[engagement] quiz_display_name:", (e as Error).message);
    }
  }

  return { answerId: Number(updatedRows[0]!.id) };
}

export type QuestionRespondent = {
  name: string;
  letter: string;
  comment: string | null;
};

export type QuestionResult = {
  questionId: number;
  shortId: string;
  answerKey: string;
  questionType: QuestionType;
  statementText: string | null;
  statementHasMedia: boolean;
  statementMediaUrl: string | null;
  statementMediaMimeType: string | null;
  explanationText: string | null;
  explanationMediaUrl: string | null;
  explanationMediaMimeType: string | null;
  distribution: Record<string, number>;
  correctUsers: string[];
  wrongUsers: string[];
  correctRespondents: QuestionRespondent[];
  wrongRespondents: QuestionRespondent[];
};

export async function getQuestionTargetGroupJid(shortId: string): Promise<string | null> {
  const normalizedId = shortId.toUpperCase();
  const { data, error } = await supabase
    .from("questions")
    .select("target_group_jid")
    .eq("short_id", normalizedId)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao buscar grupo da questao: ${error.message}`);
  }
  const jid = data?.target_group_jid ? String(data.target_group_jid) : null;
  return jid && jid.length > 0 ? jid : null;
}

export async function listAnswerUserJidsForQuestion(shortId: string): Promise<string[]> {
  const normalizedId = shortId.toUpperCase();
  const { data, error } = await supabase.from("answers").select("user_jid").eq("question_short_id", normalizedId);

  if (error) {
    throw new Error(`Erro ao listar respostas: ${error.message}`);
  }

  const set = new Set<string>();
  for (const row of data ?? []) {
    if (row.user_jid) set.add(String(row.user_jid));
  }
  return [...set];
}

export async function getQuestionResult(shortId: string): Promise<QuestionResult> {
  const normalizedId = shortId.toUpperCase();
  const { data: question, error: questionError } = await supabase
    .from("questions")
    .select(
      "id, short_id, question_type, answer_key, statement_text, statement_media_url, statement_media_mime_type, explanation_text, explanation_media_url, explanation_media_mime_type"
    )
    .eq("short_id", normalizedId)
    .maybeSingle();

  if (questionError) {
    throw new Error(`Erro ao buscar questao: ${questionError.message}`);
  }

  if (!question) {
    throw new Error("Questao nao encontrada.");
  }

  const { data: answers, error } = await supabase
    .from("answers")
    .select("answer_letter, user_name, user_jid, answer_comment")
    .eq("question_short_id", normalizedId);

  if (error) {
    throw new Error(`Erro ao buscar respostas: ${error.message}`);
  }

  const distribution: Record<string, number> =
    question.question_type === "true_false" ? { C: 0, E: 0 } : { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const correctUsers: string[] = [];
  const wrongUsers: string[] = [];
  const correctRespondents: QuestionRespondent[] = [];
  const wrongRespondents: QuestionRespondent[] = [];

  for (const row of answers) {
    const letter = String(row.answer_letter).toUpperCase();
    if (distribution[letter] !== undefined) {
      distribution[letter] += 1;
    }

    const label = (row.user_name && row.user_name.trim()) || row.user_jid;
    const commentRaw = row.answer_comment != null ? String(row.answer_comment).trim() : "";
    const comment = commentRaw.length > 0 ? commentRaw : null;
    const respondent: QuestionRespondent = { name: label, letter, comment };

    if (letter === String(question.answer_key).toUpperCase()) {
      correctUsers.push(label);
      correctRespondents.push(respondent);
    } else {
      wrongUsers.push(label);
      wrongRespondents.push(respondent);
    }
  }

  const statementRaw = question.statement_text ? String(question.statement_text).trim() : "";
  const statementText = statementRaw.length > 0 ? statementRaw : null;

  return {
    questionId: Number(question.id),
    shortId: normalizedId,
    answerKey: String(question.answer_key).toUpperCase(),
    questionType: question.question_type as QuestionType,
    statementText,
    statementHasMedia: Boolean(question.statement_media_url),
    statementMediaUrl: question.statement_media_url ?? null,
    statementMediaMimeType: question.statement_media_mime_type ?? null,
    explanationText: question.explanation_text,
    explanationMediaUrl: question.explanation_media_url,
    explanationMediaMimeType: question.explanation_media_mime_type,
    distribution,
    correctUsers,
    wrongUsers,
    correctRespondents,
    wrongRespondents
  };
}

export type QuestionRepeatPayload = {
  shortId: string;
  creatorName: string;
  statementText: string | null;
  statementMediaUrl: string | null;
  statementMediaMimeType: string | null;
  cadernoName: string | null;
  engagedNames: string[];
};

export async function getQuestionForRepeat(shortId: string): Promise<QuestionRepeatPayload | null> {
  const normalizedId = shortId.toUpperCase();
  const { data, error } = await supabase
    .from("questions")
    .select("short_id, creator_name, statement_text, statement_media_url, statement_media_mime_type")
    .eq("short_id", normalizedId)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao buscar questao: ${error.message}`);
  }

  if (!data) return null;

  const statementText = data.statement_text && String(data.statement_text).trim() ? String(data.statement_text).trim() : null;

  let cadernoName: string | null = null;
  let engagedNames: string[] = [];
  const cadernoId = await getCadernoIdForQuestion(normalizedId);
  if (cadernoId != null) {
    const caderno = await getCadernoById(cadernoId);
    if (caderno) cadernoName = caderno.name;
    engagedNames = await getEngagedDisplayNamesForCaderno(cadernoId);
  }

  return {
    shortId: String(data.short_id ?? normalizedId).toUpperCase(),
    creatorName: data.creator_name ? String(data.creator_name) : "Autor",
    statementText,
    statementMediaUrl: data.statement_media_url ?? null,
    statementMediaMimeType: data.statement_media_mime_type ?? null,
    cadernoName,
    engagedNames
  };
}

export type RankingEntry = {
  userLabel: string;
  userJid: string;
  correctCount: number;
};

export type QaStatsParticipant = {
  userLabel: string;
  userJid: string;
  createdCount: number;
  answeredCount: number;
};

export type QaStats = {
  participants: QaStatsParticipant[];
  botCreatedCount: number;
  totals: {
    questionsCreated: number;
    answersRecorded: number;
  };
};

export async function getQaStatsForGroup(groupJid: string): Promise<QaStats> {
  const { data: byTarget, error: errTarget } = await supabase
    .from("questions")
    .select("id, short_id, creator_jid, creator_name, target_group_jid, created_at")
    .eq("target_group_jid", groupJid);

  if (errTarget) {
    throw new Error(`Erro ao buscar questoes do grupo: ${errTarget.message}`);
  }

  let byLegacy: {
    id: number;
    short_id: string | null;
    creator_jid: string;
    creator_name: string;
    target_group_jid: string;
    created_at: string;
  }[] = [];
  const legacyRes = await supabase
    .from("questions")
    .select("id, short_id, creator_jid, creator_name, target_group_jid, created_at")
    .eq("group_jid", groupJid);
  if (!legacyRes.error && legacyRes.data) {
    byLegacy = legacyRes.data as typeof byLegacy;
  }

  const questionMap = new Map<number, (typeof byTarget)[0]>();
  for (const q of [...(byTarget ?? []), ...byLegacy]) {
    questionMap.set(q.id, q);
  }

  const publishedCadernoIds = await fetchPublishedCadernoQuestionIdsForGroup(groupJid);

  const questions = [...questionMap.values()].filter((q) => {
    const target = String(q.target_group_jid || groupJid);
    if (isPrivateQuizTargetJid(target)) return false;
    if (isPrivateCadernoShortId(String(q.short_id ?? ""))) return false;
    if (!isGroupQuizTargetJid(target)) return false;
    if (isOrphanCadernoGroupQuestion(q.id, String(q.creator_jid ?? ""), publishedCadernoIds)) {
      return false;
    }
    return true;
  });

  const questionIds = questions.map((q) => q.id);
  const botCreatedCount = publishedCadernoIds.size;
  if (questionIds.length === 0) {
    return {
      participants: [],
      botCreatedCount: publishedCadernoIds.size,
      totals: { questionsCreated: 0, answersRecorded: 0 }
    };
  }

  const { data: answers, error: aErr } = await supabase
    .from("answers")
    .select("question_id, user_jid, user_name")
    .in("question_id", questionIds);

  if (aErr) {
    throw new Error(`Erro ao buscar respostas para Q&A: ${aErr.message}`);
  }

  const byUser = new Map<string, QaStatsParticipant>();

  function touch(jid: string, label: string): QaStatsParticipant {
    const key = jid || label;
    let row = byUser.get(key);
    if (!row) {
      row = { userJid: jid || key, userLabel: label, createdCount: 0, answeredCount: 0 };
      byUser.set(key, row);
    }
    return row;
  }

  for (const q of questions) {
    if (isBotCreatorJid(String(q.creator_jid ?? ""))) {
      continue;
    }
    const label =
      (q.creator_name && String(q.creator_name).trim()) || String(q.creator_jid ?? "Autor");
    touch(String(q.creator_jid ?? label), label).createdCount += 1;
  }

  for (const row of answers ?? []) {
    const label = (row.user_name && String(row.user_name).trim()) || String(row.user_jid);
    touch(String(row.user_jid), label).answeredCount += 1;
  }

  const participants = [...byUser.values()].sort((a, b) => {
    if (b.answeredCount !== a.answeredCount) return b.answeredCount - a.answeredCount;
    if (b.createdCount !== a.createdCount) return b.createdCount - a.createdCount;
    return a.userLabel.localeCompare(b.userLabel, "pt-BR");
  });

  return {
    participants,
    botCreatedCount,
    totals: {
      questionsCreated: questions.length,
      answersRecorded: (answers ?? []).length
    }
  };
}

export function formatQaStatsMessage(stats: QaStats): string {
  const { participants, botCreatedCount, totals } = stats;
  const lines: string[] = [
    "Q&A do grupo",
    "",
    `Total de questoes (grupo): ${totals.questionsCreated}`,
    `Total de respostas registradas: ${totals.answersRecorded}`,
    `Questoes enviadas pelo bot (cadernos): ${botCreatedCount}`,
    ""
  ];

  if (participants.length === 0) {
    lines.push("Nenhum participante com criacao ou resposta no grupo ainda.");
    return lines.join("\n");
  }

  lines.push("Por participante (criadas | respondidas):");
  for (const p of participants) {
    lines.push(`- ${p.userLabel}: ${p.createdCount} | ${p.answeredCount}`);
  }
  return lines.join("\n");
}

export async function getRankingForGroup(groupJid: string): Promise<RankingEntry[]> {
  const { data: byTarget, error: errTarget } = await supabase
    .from("questions")
    .select("id, answer_key, short_id, target_group_jid")
    .eq("target_group_jid", groupJid);

  if (errTarget) {
    throw new Error(`Erro ao buscar questoes do grupo: ${errTarget.message}`);
  }

  let byLegacy: { id: number; answer_key: string; short_id: string | null; target_group_jid: string }[] | null =
    null;
  const legacyRes = await supabase
    .from("questions")
    .select("id, answer_key, short_id, target_group_jid")
    .eq("group_jid", groupJid);
  if (legacyRes.error) {
    const msg = legacyRes.error.message.toLowerCase();
    if (!msg.includes("column") && !msg.includes("schema cache")) {
      throw new Error(`Erro ao buscar questoes (legado): ${legacyRes.error.message}`);
    }
  } else {
    byLegacy = legacyRes.data;
  }

  const answerKeyByQuestionId = new Map<number, string>();
  for (const q of [...(byTarget ?? []), ...(byLegacy ?? [])]) {
    const target = String(q.target_group_jid || groupJid);
    if (isPrivateQuizTargetJid(target)) continue;
    if (isPrivateCadernoShortId(String(q.short_id ?? ""))) continue;
    if (!isGroupQuizTargetJid(target)) continue;
    answerKeyByQuestionId.set(q.id, String(q.answer_key).toUpperCase());
  }

  if (answerKeyByQuestionId.size === 0) {
    return [];
  }

  const questionIds = [...answerKeyByQuestionId.keys()];

  const { data: answers, error: aErr } = await supabase
    .from("answers")
    .select("question_id, user_jid, user_name, answer_letter")
    .in("question_id", questionIds);

  if (aErr) {
    throw new Error(`Erro ao buscar respostas para ranking: ${aErr.message}`);
  }

  const counts = new Map<string, { userLabel: string; userJid: string; correctCount: number }>();

  for (const row of answers ?? []) {
    const key = row.user_jid;
    const label = (row.user_name && String(row.user_name).trim()) || key;
    const expected = answerKeyByQuestionId.get(row.question_id);
    if (!expected) continue;

    const given = String(row.answer_letter).toUpperCase();
    if (given !== expected) continue;

    const prev = counts.get(key);
    if (prev) {
      prev.correctCount += 1;
    } else {
      counts.set(key, { userLabel: label, userJid: key, correctCount: 1 });
    }
  }

  return Array.from(counts.values()).sort((a, b) => {
    if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
    return a.userLabel.localeCompare(b.userLabel, "pt-BR");
  });
}

export function formatRankingMessage(entries: RankingEntry[]): string {
  if (entries.length === 0) {
    return "Ranking: ainda nao ha acertos registrados neste grupo (ou nenhuma questao vinculada ao grupo).";
  }

  const lines = entries.map((e, i) => `${i + 1}. ${e.userLabel} — ${e.correctCount} acerto(s)`);
  return ["Ranking de acertos", "", ...lines].join("\n");
}

const quizModeCache = new Map<string, boolean>();

export async function getQuizModePrivate(userJid: string): Promise<boolean> {
  if (quizModeCache.has(userJid)) {
    return quizModeCache.get(userJid)!;
  }

  const { data, error } = await supabase
    .from("bot_user_quiz_mode")
    .select("quiz_enabled")
    .eq("user_jid", userJid)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao ler modo quiz: ${error.message}`);
  }

  const enabled = Boolean(data?.quiz_enabled);
  quizModeCache.set(userJid, enabled);
  return enabled;
}

export async function setQuizModePrivate(userJid: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from("bot_user_quiz_mode").upsert(
    {
      user_jid: userJid,
      quiz_enabled: enabled,
      updated_at: new Date().toISOString()
    },
    { onConflict: "user_jid" }
  );

  if (error) {
    throw new Error(`Erro ao salvar modo quiz: ${error.message}`);
  }

  quizModeCache.set(userJid, enabled);
}

export type GroupMemberEngagementRow = {
  userJid: string;
  userLabel: string | null;
  quizDisplayName: string | null;
  engaged: boolean;
  updatedAt: string | null;
};

export async function getQuestionCreatorAndGroup(
  shortId: string
): Promise<{ creatorJid: string; targetGroupJid: string; materiaId: number | null } | null> {
  const id = shortId.toUpperCase();
  const { data, error } = await supabase
    .from("questions")
    .select("creator_jid, target_group_jid, materia_id")
    .eq("short_id", id)
    .maybeSingle();

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("column") && msg.includes("materia_id")) {
      const fb = await supabase
        .from("questions")
        .select("creator_jid, target_group_jid")
        .eq("short_id", id)
        .maybeSingle();
      if (fb.error) throw new Error(`Erro ao buscar criador da questao: ${fb.error.message}`);
      if (!fb.data?.creator_jid || !fb.data?.target_group_jid) return null;
      return {
        creatorJid: String(fb.data.creator_jid),
        targetGroupJid: String(fb.data.target_group_jid),
        materiaId: null
      };
    }
    throw new Error(`Erro ao buscar criador da questao: ${error.message}`);
  }
  if (!data?.creator_jid || !data?.target_group_jid) return null;
  const mid = data.materia_id != null ? Number(data.materia_id) : null;
  return {
    creatorJid: String(data.creator_jid),
    targetGroupJid: String(data.target_group_jid),
    materiaId: Number.isFinite(mid) && mid != null && mid > 0 ? mid : null
  };
}

export type MateriaRow = {
  id: number;
  name: string;
  sortOrder: number;
};

export async function listMateriasForGroup(groupJid: string): Promise<MateriaRow[]> {
  const { data, error } = await supabase
    .from("materias")
    .select("id, name, sort_order")
    .eq("group_jid", groupJid)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao listar matérias: ${error.message}`);
  }

  return (data || [])
    .map((r) => ({
      id: Number(r.id),
      name: String(r.name || "").trim(),
      sortOrder: Number(r.sort_order) || 0
    }))
    .filter((r) => Number.isFinite(r.id) && r.id > 0 && r.name);
}

export async function getEngagedUserJidsForMateria(materiaId: number): Promise<string[]> {
  const { data, error } = await supabase
    .from("materia_engagement")
    .select("user_jid")
    .eq("materia_id", materiaId)
    .eq("engaged", true);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao ler engajamento da matéria: ${error.message}`);
  }

  return [...new Set((data ?? []).map((r) => String(r.user_jid)).filter(Boolean))];
}

export async function getEngagedUserJidsForGroup(groupJid: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("group_member_engagement")
    .select("user_jid")
    .eq("group_jid", groupJid)
    .eq("engaged", true);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      return [];
    }
    throw new Error(`Erro ao ler engajamento: ${error.message}`);
  }

  return [...new Set((data ?? []).map((r) => String(r.user_jid)).filter(Boolean))];
}

/**
 * Engajados elegíveis a responder uma questão publicada em `publishedAt`.
 * Inclui: `engaged=true` e (`engaged_since` é nulo OU `engaged_since <= publishedAt`).
 * Quem virou engajado **depois** que a questão foi publicada não conta.
 */
export async function getEngagedEligibleUserJidsAt(
  groupJid: string,
  publishedAtIso: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("group_member_engagement")
    .select("user_jid, engaged_since")
    .eq("group_jid", groupJid)
    .eq("engaged", true);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    if (msg.includes("column") && msg.includes("does not exist")) {
      return getEngagedUserJidsForGroup(groupJid);
    }
    throw new Error(`Erro ao ler engajamento elegível: ${error.message}`);
  }

  const pubTs = new Date(publishedAtIso).getTime();
  const out = new Set<string>();
  for (const row of data ?? []) {
    const jid = row.user_jid ? String(row.user_jid) : "";
    if (!jid) continue;
    const since = row.engaged_since ? new Date(String(row.engaged_since)).getTime() : 0;
    if (!Number.isFinite(since) || since <= pubTs) {
      out.add(jid);
    }
  }
  return [...out];
}

export async function listGroupMembersEngagementRows(groupJid: string): Promise<GroupMemberEngagementRow[]> {
  const { data, error } = await supabase
    .from("group_member_engagement")
    .select("user_jid, user_label, quiz_display_name, engaged, updated_at")
    .eq("group_jid", groupJid)
    .order("user_label", { ascending: true, nullsFirst: false });

  if (error) {
    throw new Error(`Erro ao listar membros: ${error.message}`);
  }

  return (data ?? []).map((r) => ({
    userJid: String(r.user_jid),
    userLabel: r.user_label ? String(r.user_label) : null,
    quizDisplayName: r.quiz_display_name != null ? String(r.quiz_display_name) : null,
    engaged: Boolean(r.engaged),
    updatedAt: r.updated_at ? String(r.updated_at) : null
  }));
}

export async function setGroupMemberEngaged(
  groupJid: string,
  userJid: string,
  engaged: boolean
): Promise<void> {
  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = { engaged, updated_at: nowIso };

  if (engaged) {
    const { data: existing } = await supabase
      .from("group_member_engagement")
      .select("engaged, engaged_since")
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid)
      .maybeSingle();
    const wasEngaged = Boolean(existing && existing.engaged);
    const hadSince = Boolean(existing && existing.engaged_since);
    if (!wasEngaged || !hadSince) {
      update.engaged_since = nowIso;
    }
  } else {
    update.engaged_since = null;
  }

  const { error } = await supabase
    .from("group_member_engagement")
    .update(update)
    .eq("group_jid", groupJid)
    .eq("user_jid", userJid);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("column") && msg.includes("engaged_since")) {
      const { error: e2 } = await supabase
        .from("group_member_engagement")
        .update({ engaged, updated_at: nowIso })
        .eq("group_jid", groupJid)
        .eq("user_jid", userJid);
      if (e2) throw new Error(`Erro ao atualizar engajamento: ${e2.message}`);
      return;
    }
    throw new Error(`Erro ao atualizar engajamento: ${error.message}`);
  }
}

export type CadernoEngagementRow = GroupMemberEngagementRow & {
  passive: boolean;
};

function engagementDisplayLabel(row: {
  userJid: string;
  userLabel: string | null;
  quizDisplayName: string | null;
}): string {
  if (row.quizDisplayName && row.quizDisplayName.trim()) return row.quizDisplayName.trim();
  if (row.userLabel && row.userLabel.trim()) return row.userLabel.trim();
  const at = row.userJid.indexOf("@");
  return at > 0 ? row.userJid.slice(0, at) : row.userJid;
}

export async function getCadernoIdForQuestion(shortId: string): Promise<number | null> {
  const normalizedId = shortId.toUpperCase();
  const { data: question, error } = await supabase
    .from("questions")
    .select("id, creator_jid")
    .eq("short_id", normalizedId)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao buscar questao para caderno: ${error.message}`);
  }
  if (!question) return null;

  const creatorJid = question.creator_jid ? String(question.creator_jid) : "";
  const m = creatorJid.match(/^caderno:(\d+)@bot$/i);
  if (m) {
    const id = Number(m[1]);
    if (Number.isFinite(id) && id > 0) return id;
  }

  const qid = Number(question.id);
  if (!Number.isFinite(qid)) return null;

  const { data: cq, error: cqErr } = await supabase
    .from("caderno_questions")
    .select("caderno_id")
    .eq("published_question_id", qid)
    .maybeSingle();

  if (cqErr) {
    const msg = cqErr.message.toLowerCase();
    if (!msg.includes("relation") || !msg.includes("does not exist")) {
      throw new Error(`Erro ao buscar caderno da questao: ${cqErr.message}`);
    }
    return null;
  }

  if (!cq?.caderno_id) return null;
  const cadernoId = Number(cq.caderno_id);
  return Number.isFinite(cadernoId) && cadernoId > 0 ? cadernoId : null;
}

export async function getEngagedUserJidsForCaderno(cadernoId: number): Promise<string[]> {
  const { data, error } = await supabase
    .from("caderno_engagement")
    .select("user_jid")
    .eq("caderno_id", cadernoId)
    .eq("engaged", true);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao ler engajamento do caderno: ${error.message}`);
  }

  return [...new Set((data ?? []).map((r) => String(r.user_jid)).filter(Boolean))];
}

export async function getEngagedEligibleUserJidsForCadernoAt(
  cadernoId: number,
  publishedAtIso: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("caderno_engagement")
    .select("user_jid, engaged_since")
    .eq("caderno_id", cadernoId)
    .eq("engaged", true);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    if (msg.includes("column") && msg.includes("does not exist")) {
      return getEngagedUserJidsForCaderno(cadernoId);
    }
    throw new Error(`Erro ao ler engajamento elegivel do caderno: ${error.message}`);
  }

  const pubTs = new Date(publishedAtIso).getTime();
  const out = new Set<string>();
  for (const row of data ?? []) {
    const jid = row.user_jid ? String(row.user_jid) : "";
    if (!jid) continue;
    const since = row.engaged_since ? new Date(String(row.engaged_since)).getTime() : 0;
    if (!Number.isFinite(since) || since <= pubTs) {
      out.add(jid);
    }
  }
  return [...out];
}

export async function getEngagedDisplayNamesForCaderno(cadernoId: number): Promise<string[]> {
  const { data, error } = await supabase
    .from("caderno_engagement")
    .select("user_jid, user_label, quiz_display_name")
    .eq("caderno_id", cadernoId)
    .eq("engaged", true);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao ler nomes engajados do caderno: ${error.message}`);
  }

  return (data ?? []).map((r) =>
    engagementDisplayLabel({
      userJid: String(r.user_jid),
      userLabel: r.user_label ? String(r.user_label) : null,
      quizDisplayName: r.quiz_display_name != null ? String(r.quiz_display_name) : null
    })
  );
}

export async function getEngagedDisplayNameForUser(
  cadernoId: number,
  userJid: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("caderno_engagement")
    .select("user_jid, user_label, quiz_display_name")
    .eq("caderno_id", cadernoId)
    .eq("user_jid", userJid)
    .maybeSingle();

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return null;
    throw new Error(`Erro ao buscar nome engajado: ${error.message}`);
  }
  if (!data) return null;

  return engagementDisplayLabel({
    userJid: String(data.user_jid),
    userLabel: data.user_label ? String(data.user_label) : null,
    quizDisplayName: data.quiz_display_name != null ? String(data.quiz_display_name) : null
  });
}

export async function listCadernoEngagementMembers(
  cadernoId: number,
  groupJid: string
): Promise<CadernoEngagementRow[]> {
  const groupMembers = await listGroupMembersEngagementRows(groupJid);
  const { data: cadernoRows, error } = await supabase
    .from("caderno_engagement")
    .select("user_jid, user_label, quiz_display_name, engaged, passive, engaged_since, updated_at")
    .eq("caderno_id", cadernoId);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      return groupMembers.map((m) => ({ ...m, engaged: false, passive: false }));
    }
    if (msg.includes("column") && msg.includes("passive")) {
      const { data: fallbackRows, error: e2 } = await supabase
        .from("caderno_engagement")
        .select("user_jid, user_label, quiz_display_name, engaged, engaged_since, updated_at")
        .eq("caderno_id", cadernoId);
      if (e2) throw new Error(`Erro ao listar engajamento do caderno: ${e2.message}`);
      return mergeCadernoEngagementMembers(groupMembers, fallbackRows ?? [], false);
    }
    throw new Error(`Erro ao listar engajamento do caderno: ${error.message}`);
  }

  return mergeCadernoEngagementMembers(groupMembers, cadernoRows ?? [], true);
}

function mergeCadernoEngagementMembers(
  groupMembers: GroupMemberEngagementRow[],
  cadernoRows: Record<string, unknown>[],
  hasPassiveCol: boolean
): CadernoEngagementRow[] {
  const byJid = new Map(
    cadernoRows.map((r) => [
      String(r.user_jid),
      {
        userJid: String(r.user_jid),
        userLabel: r.user_label ? String(r.user_label) : null,
        quizDisplayName: r.quiz_display_name != null ? String(r.quiz_display_name) : null,
        engaged: Boolean(r.engaged),
        passive: hasPassiveCol ? Boolean(r.passive) : false,
        updatedAt: r.updated_at ? String(r.updated_at) : null
      } satisfies CadernoEngagementRow
    ])
  );

  const out: CadernoEngagementRow[] = [];
  const seen = new Set<string>();

  for (const m of groupMembers) {
    seen.add(m.userJid);
    const ce = byJid.get(m.userJid);
    out.push(
      ce ?? {
        userJid: m.userJid,
        userLabel: m.userLabel,
        quizDisplayName: m.quizDisplayName,
        engaged: false,
        passive: false,
        updatedAt: null
      }
    );
  }

  for (const [jid, ce] of byJid) {
    if (!seen.has(jid)) out.push(ce);
  }

  return out.sort((a, b) =>
    engagementDisplayLabel(a).localeCompare(engagementDisplayLabel(b), "pt-BR")
  );
}

export async function setCadernoEngagement(
  cadernoId: number,
  groupJid: string,
  userJid: string,
  engaged: boolean,
  passive = false
): Promise<void> {
  const nowIso = new Date().toISOString();
  let nextEngaged = engaged;
  let nextPassive = passive;
  if (nextEngaged && nextPassive) {
    nextPassive = false;
  }

  const { data: groupRow } = await supabase
    .from("group_member_engagement")
    .select("user_label, quiz_display_name")
    .eq("group_jid", groupJid)
    .eq("user_jid", userJid)
    .maybeSingle();

  const userLabel = groupRow?.user_label ? String(groupRow.user_label) : null;
  const quizDisplayName =
    groupRow?.quiz_display_name != null ? String(groupRow.quiz_display_name) : null;

  const { data: existing } = await supabase
    .from("caderno_engagement")
    .select("engaged, engaged_since, passive")
    .eq("caderno_id", cadernoId)
    .eq("user_jid", userJid)
    .maybeSingle();

  const patch: Record<string, unknown> = {
    caderno_id: cadernoId,
    user_jid: userJid,
    user_label: userLabel,
    quiz_display_name: quizDisplayName,
    engaged: nextEngaged,
    passive: nextPassive,
    updated_at: nowIso
  };

  if (nextEngaged) {
    const wasEngaged = Boolean(existing && existing.engaged);
    const hadSince = Boolean(existing && existing.engaged_since);
    if (!wasEngaged || !hadSince) {
      patch.engaged_since = nowIso;
    } else if (existing?.engaged_since) {
      patch.engaged_since = existing.engaged_since;
    }
  } else {
    patch.engaged_since = null;
  }

  const { error } = await supabase.from("caderno_engagement").upsert(patch, {
    onConflict: "caderno_id,user_jid"
  });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("column") && msg.includes("passive")) {
      const fallback = { ...patch };
      delete fallback.passive;
      const { error: e2 } = await supabase.from("caderno_engagement").upsert(fallback, {
        onConflict: "caderno_id,user_jid"
      });
      if (e2) throw new Error(`Erro ao atualizar engajamento do caderno: ${e2.message}`);
      return;
    }
    if (msg.includes("column") && msg.includes("engaged_since")) {
      const fallback = { ...patch };
      delete fallback.engaged_since;
      const { error: e2 } = await supabase.from("caderno_engagement").upsert(fallback, {
        onConflict: "caderno_id,user_jid"
      });
      if (e2) throw new Error(`Erro ao atualizar engajamento do caderno: ${e2.message}`);
      return;
    }
    throw new Error(`Erro ao atualizar engajamento do caderno: ${error.message}`);
  }
}

export async function countEngagedForCaderno(cadernoId: number): Promise<number> {
  const jids = await getEngagedUserJidsForCaderno(cadernoId);
  return jids.length;
}

export async function upsertGroupMembersFromSync(
  groupJid: string,
  members: { userJid: string; userLabel: string }[]
): Promise<void> {
  for (const m of members) {
    const { data: existing } = await supabase
      .from("group_member_engagement")
      .select("engaged, quiz_display_name")
      .eq("group_jid", groupJid)
      .eq("user_jid", m.userJid)
      .maybeSingle();

    const engaged = existing ? Boolean(existing.engaged) : false;
    const quizDisplayName =
      existing && existing.quiz_display_name != null ? String(existing.quiz_display_name) : null;

    const { error } = await supabase.from("group_member_engagement").upsert(
      {
        group_jid: groupJid,
        user_jid: m.userJid,
        user_label: m.userLabel || null,
        engaged,
        quiz_display_name: quizDisplayName,
        updated_at: new Date().toISOString()
      },
      { onConflict: "group_jid,user_jid" }
    );

    if (error) {
      throw new Error(`Erro ao sincronizar membro: ${error.message}`);
    }
  }
}

export type CadernoRow = {
  id: number;
  name: string;
  targetGroupJid: string;
  createdByJid: string | null;
  deliveryMode: "group" | "private";
  status: "inactive" | "active" | "paused_waiting_decision" | "finished";
  /** Modelo novo: total de questões enviadas por dia, espaçadas na janela início–fim. */
  questionsPerDay: number;
  /** Horários explícitos por questão do dia; se null, distribui entre início e fim. */
  sendTimes: SendTimeSlot[] | null;
  startHour: number;
  startMinute: number;
  /** Fim da janela de envio no mesmo dia (fuso do caderno). */
  endHour: number;
  endMinute: number;
  waitForAnswers: boolean;
  currentDayDate: string | null;
  currentDaySent: number;
  /** Colunas legadas (modelo antigo) — preservadas para o GET da API. */
  questionsPerRun: number;
  intervalDays: number;
  sendHour: number;
  sendMinute: number;
  timezone: string;
  cursor: number;
  randomOrder: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
};

export type CadernoQuestionRow = {
  id: number;
  cadernoId: number;
  position: number;
  tecQuestionId: string | null;
  tecUrl: string;
  banca: string | null;
  subject: string | null;
  questionType: QuestionType;
  statementText: string;
  answerKey: string;
};

function mapCadernoRow(row: Record<string, unknown>): CadernoRow {
  const questionsPerDayRaw =
    row.questions_per_day != null ? Number(row.questions_per_day) : Number(row.questions_per_run);
  const startHourRaw =
    row.start_hour != null ? Number(row.start_hour) : Number(row.send_hour);
  const startMinuteRaw =
    row.start_minute != null ? Number(row.start_minute) : Number(row.send_minute);
  return {
    id: Number(row.id),
    name: String(row.name),
    targetGroupJid: String(row.target_group_jid),
    createdByJid: row.created_by_jid ? String(row.created_by_jid) : null,
    deliveryMode: (row.delivery_mode === "private" ? "private" : "group") as CadernoRow["deliveryMode"],
    status: String(row.status) as CadernoRow["status"],
    questionsPerDay: Number.isFinite(questionsPerDayRaw) ? questionsPerDayRaw : 3,
    sendTimes: parseSendTimesJson(row.send_times),
    startHour: Number.isFinite(startHourRaw) ? startHourRaw : 7,
    startMinute: Number.isFinite(startMinuteRaw) ? startMinuteRaw : 0,
    endHour: Number.isFinite(Number(row.end_hour)) ? Number(row.end_hour) : 15,
    endMinute: Number.isFinite(Number(row.end_minute)) ? Number(row.end_minute) : 0,
    waitForAnswers: Boolean(row.wait_for_answers),
    currentDayDate: row.current_day_date ? String(row.current_day_date) : null,
    currentDaySent: Number(row.current_day_sent || 0),
    questionsPerRun: Number(row.questions_per_run),
    intervalDays: Number(row.interval_days),
    sendHour: Number(row.send_hour),
    sendMinute: Number(row.send_minute),
    timezone: String(row.timezone || "America/Sao_Paulo"),
    cursor: Number(row.cursor || 0),
    randomOrder: Boolean(row.random_order),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null
  };
}

function formatDateInTimezone(d: Date, timeZone: string): string {
  return publishedDayIso(d, timeZone);
}

const CADERNO_SELECT_COLUMNS =
  "id, name, target_group_jid, created_by_jid, delivery_mode, status, questions_per_day, send_times, start_hour, start_minute, end_hour, end_minute, wait_for_answers, current_day_date, current_day_sent, questions_per_run, interval_days, send_hour, send_minute, timezone, cursor, random_order, last_run_at, next_run_at";

function mapCadernoQuestionRow(row: Record<string, unknown>): CadernoQuestionRow {
  return {
    id: Number(row.id),
    cadernoId: Number(row.caderno_id),
    position: Number(row.position),
    tecQuestionId: row.tec_question_id ? String(row.tec_question_id) : null,
    tecUrl: String(row.tec_url),
    banca: row.banca ? String(row.banca) : null,
    subject: row.subject ? String(row.subject) : null,
    questionType: String(row.question_type) as QuestionType,
    statementText: String(row.statement_text),
    answerKey: String(row.answer_key).toUpperCase()
  };
}

/** Cadernos em modo grupo: agenda em `cadernos.next_run_at`. */
export async function listCadernosDueForRun(): Promise<CadernoRow[]> {
  const nowIso = new Date().toISOString();
  const colsWithDm = CADERNO_SELECT_COLUMNS;
  const colsNoDm = CADERNO_SELECT_COLUMNS.replace(", delivery_mode", "");

  let { data, error } = await supabase
    .from("cadernos")
    .select(colsWithDm)
    .eq("status", "active")
    .neq("delivery_mode", "private")
    .lte("next_run_at", nowIso);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    if (msg.includes("column") && msg.includes("delivery_mode")) {
      const r = await supabase
        .from("cadernos")
        .select(colsNoDm)
        .eq("status", "active")
        .lte("next_run_at", nowIso);
      if (r.error) {
        if (r.error.message.toLowerCase().includes("relation")) return [];
        throw new Error(`Erro ao listar cadernos: ${r.error.message}`);
      }
      return (r.data ?? []).map((row) =>
        mapCadernoRow({
          ...(row as unknown as Record<string, unknown>),
          delivery_mode: "group"
        })
      );
    }
    throw new Error(`Erro ao listar cadernos: ${error.message}`);
  }

  return (data ?? []).map(mapCadernoRow);
}

export async function getCadernoById(id: number): Promise<CadernoRow | null> {
  const { data, error } = await supabase
    .from("cadernos")
    .select(CADERNO_SELECT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return null;
    throw new Error(`Erro ao buscar caderno: ${error.message}`);
  }
  if (!data) return null;
  return mapCadernoRow(data);
}

export type CadernoPrivateRecipientRow = {
  id: number;
  cadernoId: number;
  userJid: string;
  active: boolean;
  questionsPerDay: number | null;
  sendTimes: SendTimeSlot[] | null;
  startHour: number | null;
  startMinute: number | null;
  endHour: number | null;
  endMinute: number | null;
  waitForAnswers: boolean | null;
  randomOrder: boolean | null;
  timezone: string | null;
  currentDayDate: string | null;
  currentDaySent: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
};

function mapPrivateRecipientRow(row: Record<string, unknown>): CadernoPrivateRecipientRow {
  return {
    id: Number(row.id),
    cadernoId: Number(row.caderno_id),
    userJid: String(row.user_jid),
    active: Boolean(row.active),
    questionsPerDay: row.questions_per_day != null ? Number(row.questions_per_day) : null,
    sendTimes: parseSendTimesJson(row.send_times),
    startHour: row.start_hour != null ? Number(row.start_hour) : null,
    startMinute: row.start_minute != null ? Number(row.start_minute) : null,
    endHour: row.end_hour != null ? Number(row.end_hour) : null,
    endMinute: row.end_minute != null ? Number(row.end_minute) : null,
    waitForAnswers: row.wait_for_answers != null ? Boolean(row.wait_for_answers) : null,
    randomOrder: row.random_order != null ? Boolean(row.random_order) : null,
    timezone: row.timezone != null ? String(row.timezone) : null,
    currentDayDate: row.current_day_date ? String(row.current_day_date) : null,
    currentDaySent: Number(row.current_day_sent || 0),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null
  };
}

/** Agenda efetiva do destinatário (null no registro = herdar do caderno). */
export function effectivePrivateRecipientSchedule(
  caderno: CadernoRow,
  r: CadernoPrivateRecipientRow
): {
  questionsPerDay: number;
  sendTimes: SendTimeSlot[] | null;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  waitForAnswers: boolean;
  randomOrder: boolean;
  timezone: string;
} {
  return {
    questionsPerDay: r.questionsPerDay ?? caderno.questionsPerDay,
    sendTimes: r.sendTimes ?? caderno.sendTimes,
    startHour: r.startHour ?? caderno.startHour,
    startMinute: r.startMinute ?? caderno.startMinute,
    endHour: r.endHour ?? caderno.endHour,
    endMinute: r.endMinute ?? caderno.endMinute,
    waitForAnswers: r.waitForAnswers ?? caderno.waitForAnswers,
    randomOrder: r.randomOrder ?? caderno.randomOrder,
    timezone: (r.timezone && r.timezone.trim()) || caderno.timezone
  };
}

export async function listPrivateRecipientsDueForRun(): Promise<
  { caderno: CadernoRow; recipient: CadernoPrivateRecipientRow }[]
> {
  const nowIso = new Date().toISOString();
  const { data: recs, error } = await supabase
    .from("caderno_private_recipients")
    .select(
      "id, caderno_id, user_jid, active, questions_per_day, send_times, start_hour, start_minute, end_hour, end_minute, wait_for_answers, random_order, timezone, current_day_date, current_day_sent, last_run_at, next_run_at"
    )
    .eq("active", true)
    .lte("next_run_at", nowIso);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao listar destinatarios privados: ${error.message}`);
  }

  const out: { caderno: CadernoRow; recipient: CadernoPrivateRecipientRow }[] = [];
  for (const row of recs ?? []) {
    const caderno = await getCadernoById(Number(row.caderno_id));
    if (!caderno || caderno.deliveryMode !== "private" || caderno.status !== "active") continue;
    out.push({ caderno, recipient: mapPrivateRecipientRow(row) });
  }
  return out;
}

export async function listPrivateRecipientsByCaderno(
  cadernoId: number
): Promise<CadernoPrivateRecipientRow[]> {
  const { data, error } = await supabase
    .from("caderno_private_recipients")
    .select(
      "id, caderno_id, user_jid, active, questions_per_day, send_times, start_hour, start_minute, end_hour, end_minute, wait_for_answers, random_order, timezone, current_day_date, current_day_sent, last_run_at, next_run_at"
    )
    .eq("caderno_id", cadernoId)
    .order("user_jid", { ascending: true });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao listar destinatarios: ${error.message}`);
  }
  return (data ?? []).map((row) => mapPrivateRecipientRow(row as Record<string, unknown>));
}

export async function replacePrivateRecipientsForCaderno(
  cadernoId: number,
  rows: {
    userJid: string;
    active?: boolean;
    questionsPerDay?: number | null;
    sendTimes?: SendTimeSlot[] | null;
    startHour?: number | null;
    startMinute?: number | null;
    endHour?: number | null;
    endMinute?: number | null;
    waitForAnswers?: boolean | null;
    randomOrder?: boolean | null;
    timezone?: string | null;
    nextRunAtIso?: string | null;
  }[]
): Promise<void> {
  const { error: delErr } = await supabase
    .from("caderno_private_recipients")
    .delete()
    .eq("caderno_id", cadernoId);
  if (delErr) throw new Error(`Erro ao limpar destinatarios: ${delErr.message}`);

  if (rows.length === 0) return;

  const insert = rows.map((r) => ({
    caderno_id: cadernoId,
    user_jid: r.userJid,
    active: r.active !== false,
    questions_per_day: r.questionsPerDay ?? null,
    send_times: r.sendTimes != null ? r.sendTimes : null,
    start_hour: r.startHour ?? null,
    start_minute: r.startMinute ?? null,
    end_hour: r.endHour ?? null,
    end_minute: r.endMinute ?? null,
    wait_for_answers: r.waitForAnswers ?? null,
    random_order: r.randomOrder ?? null,
    timezone: r.timezone ?? null,
    current_day_date: null,
    current_day_sent: 0,
    next_run_at: r.nextRunAtIso ?? null
  }));

  const { error: insErr } = await supabase.from("caderno_private_recipients").insert(insert);
  if (insErr) throw new Error(`Erro ao gravar destinatarios: ${insErr.message}`);
}

export async function listPrivateSendsPublishedOnDate(
  cadernoId: number,
  recipientJid: string,
  dayIso: string,
  timeZone: string
): Promise<{ publishedQuestionId: number; publishedAt: string }[]> {
  const { data, error } = await supabase
    .from("caderno_private_send")
    .select("published_question_id, published_at")
    .eq("caderno_id", cadernoId)
    .eq("recipient_jid", recipientJid)
    .not("published_question_id", "is", null);

  if (error) throw new Error(`Erro ao listar envios privados do dia: ${error.message}`);

  const out: { publishedQuestionId: number; publishedAt: string }[] = [];
  for (const row of data ?? []) {
    const pubAt = row.published_at ? String(row.published_at) : null;
    const pubId = row.published_question_id != null ? Number(row.published_question_id) : null;
    if (!pubAt || !pubId) continue;
    const isoDay = formatDateInTimezone(new Date(pubAt), timeZone);
    if (isoDay === dayIso) {
      out.push({ publishedQuestionId: pubId, publishedAt: pubAt });
    }
  }
  return out;
}

async function listSentQuestionIdsForPrivateRecipient(
  cadernoId: number,
  recipientJid: string
): Promise<number[]> {
  const { data, error } = await supabase
    .from("caderno_private_send")
    .select("caderno_question_id")
    .eq("caderno_id", cadernoId)
    .eq("recipient_jid", recipientJid);

  if (error) throw new Error(`Erro ao listar envios privados: ${error.message}`);
  return (data ?? [])
    .map((r) => Number(r.caderno_question_id))
    .filter((id) => Number.isFinite(id));
}

/** Próximas questões do PDF ainda não enviadas a este destinatário (modo privado). */
export async function listNextPrivateCadernoQuestionsToSend(
  cadernoId: number,
  recipientJid: string,
  limit: number,
  randomOrder: boolean
): Promise<CadernoQuestionRow[]> {
  const selectCols =
    "id, caderno_id, position, tec_question_id, tec_url, banca, subject, question_type, statement_text, answer_key";

  const sentIds = await listSentQuestionIdsForPrivateRecipient(cadernoId, recipientJid);
  const sentSet = new Set(sentIds);

  if (!randomOrder) {
    const { data, error } = await supabase
      .from("caderno_questions")
      .select(selectCols)
      .eq("caderno_id", cadernoId)
      .order("position", { ascending: true })
      .limit(500);

    if (error) throw new Error(`Erro ao listar questoes do caderno (privado): ${error.message}`);
    const rows = (data ?? []).map(mapCadernoQuestionRow).filter((q) => !sentSet.has(q.id));
    return rows.slice(0, limit);
  }

  const unsentCount = Math.max(0, (await countCadernoQuestions(cadernoId)) - sentSet.size);
  const bufferSize = Math.min(500, Math.max(unsentCount, limit));
  const { data, error } = await supabase
    .from("caderno_questions")
    .select(selectCols)
    .eq("caderno_id", cadernoId)
    .order("position", { ascending: true })
    .limit(bufferSize);

  if (error) throw new Error(`Erro ao listar questoes do caderno (privado): ${error.message}`);

  const rows = shuffleCadernoQuestionRows(
    (data ?? []).map(mapCadernoQuestionRow).filter((q) => !sentSet.has(q.id))
  );
  return rows.slice(0, limit);
}

export async function countUnsentPrivateQuestionsForRecipient(
  cadernoId: number,
  recipientJid: string
): Promise<number> {
  const total = await countCadernoQuestions(cadernoId);
  const { count, error } = await supabase
    .from("caderno_private_send")
    .select("id", { count: "exact", head: true })
    .eq("caderno_id", cadernoId)
    .eq("recipient_jid", recipientJid);

  if (error) throw new Error(`Erro ao contar envios privados: ${error.message}`);
  const sent = count || 0;
  return Math.max(0, total - sent);
}

export async function getPrivateSendPublishedQuestionId(
  cadernoId: number,
  recipientJid: string,
  cadernoQuestionId: number
): Promise<number | null> {
  const { data, error } = await supabase
    .from("caderno_private_send")
    .select("published_question_id")
    .eq("caderno_id", cadernoId)
    .eq("recipient_jid", recipientJid)
    .eq("caderno_question_id", cadernoQuestionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao ler envio privado do caderno: ${error.message}`);
  }
  const id = data?.published_question_id != null ? Number(data.published_question_id) : NaN;
  return Number.isFinite(id) ? id : null;
}

export async function recordPrivateSend(
  cadernoId: number,
  recipientJid: string,
  cadernoQuestionId: number,
  publishedQuestionDbId: number
): Promise<void> {
  const { error } = await supabase.from("caderno_private_send").insert({
    caderno_id: cadernoId,
    recipient_jid: recipientJid,
    caderno_question_id: cadernoQuestionId,
    published_question_id: publishedQuestionDbId,
    published_at: new Date().toISOString()
  });
  if (error) throw new Error(`Erro ao registrar envio privado: ${error.message}`);
}

export async function updatePrivateRecipientDayState(
  recipientRowId: number,
  patch: {
    currentDayDate?: string | null;
    currentDaySent?: number;
    nextRunAtIso?: string | null;
    updateLastRun?: boolean;
    active?: boolean;
  }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(patch, "currentDayDate")) {
    update.current_day_date = patch.currentDayDate;
  }
  if (typeof patch.currentDaySent === "number") {
    update.current_day_sent = patch.currentDaySent;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "nextRunAtIso")) {
    update.next_run_at = patch.nextRunAtIso;
  }
  if (patch.updateLastRun) {
    update.last_run_at = new Date().toISOString();
  }
  if (typeof patch.active === "boolean") {
    update.active = patch.active;
  }
  if (Object.keys(update).length === 0) return;

  const { error } = await supabase
    .from("caderno_private_recipients")
    .update(update)
    .eq("id", recipientRowId);

  if (error) throw new Error(`Erro ao atualizar destinatario privado: ${error.message}`);
}

export async function deletePrivateSendsForCaderno(cadernoId: number): Promise<void> {
  const { error } = await supabase.from("caderno_private_send").delete().eq("caderno_id", cadernoId);
  if (error) throw new Error(`Erro ao limpar envios privados: ${error.message}`);
}

export async function resetPrivateRecipientsProgress(cadernoId: number): Promise<void> {
  const { error } = await supabase
    .from("caderno_private_recipients")
    .update({
      current_day_date: null,
      current_day_sent: 0,
      last_run_at: null
    })
    .eq("caderno_id", cadernoId);

  if (error) throw new Error(`Erro ao resetar destinatarios: ${error.message}`);
}

/**
 * Verifica se `recipientJid` respondeu todas as questões publicadas no dia
 * (modo privado — não usa engajamento do grupo).
 */
export async function isPrivateRecipientDayComplete(
  cadernoId: number,
  recipientJid: string,
  dayIso: string,
  timeZone: string
): Promise<boolean> {
  const published = await listPrivateSendsPublishedOnDate(
    cadernoId,
    recipientJid,
    dayIso,
    timeZone
  );
  if (published.length === 0) return true;

  const questionIds = published.map((p) => p.publishedQuestionId);
  const answersByQ = await listAnswersForQuestionIds(questionIds);
  const pk = jidComparableKeyShared(recipientJid);

  for (const pub of published) {
    const set = answersByQ.get(pub.publishedQuestionId) ?? new Set<string>();
    if (!set.has(pk)) return false;
  }
  return true;
}

async function anyActivePrivateRecipientHasPendingQuestions(cadernoId: number): Promise<boolean> {
  const recs = await listPrivateRecipientsByCaderno(cadernoId);
  for (const r of recs) {
    if (!r.active) continue;
    const left = await countUnsentPrivateQuestionsForRecipient(cadernoId, r.userJid);
    if (left > 0) return true;
  }
  return false;
}

/** Se nenhum destinatário ativo tem questão pendente, pausa o caderno. */
export async function maybePausePrivateCadernoWhenExhausted(
  cadernoId: number
): Promise<boolean> {
  const c = await getCadernoById(cadernoId);
  if (!c || c.deliveryMode !== "private" || c.status !== "active") return false;
  const pending = await anyActivePrivateRecipientHasPendingQuestions(cadernoId);
  if (pending) return false;
  await setCadernoStatus(cadernoId, "paused_waiting_decision", { nextRunAt: null });
  return true;
}

/**
 * Lê o próximo lote de questões a enviar. Critério: `published_question_id IS NULL`
 * (ainda não foi publicada). Em modo aleatório embaralha o lote; senão segue por
 * `position` crescente.
 *
 * Para random, embaralhamos todas as pendentes (até 500) em memória e tiramos `limit`.
 * Antes o buffer era `limit * 10` (ex.: só 10 questões com limit=1), o que parecia ordem do PDF.
 */
function shuffleCadernoQuestionRows(rows: CadernoQuestionRow[]): CadernoQuestionRow[] {
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows;
}

export async function listNextCadernoQuestionsToSend(
  cadernoId: number,
  limit: number,
  randomOrder: boolean
): Promise<CadernoQuestionRow[]> {
  const selectCols =
    "id, caderno_id, position, tec_question_id, tec_url, banca, subject, question_type, statement_text, answer_key";

  const queuedIds = await listQueuedCadernoQuestionIds(cadernoId);
  const excludeSet = new Set(queuedIds);

  if (!randomOrder) {
    const { data, error } = await supabase
      .from("caderno_questions")
      .select(selectCols)
      .eq("caderno_id", cadernoId)
      .is("published_question_id", null)
      .order("position", { ascending: true })
      .limit(Math.max(limit + excludeSet.size, limit));

    if (error) throw new Error(`Erro ao listar questoes do caderno: ${error.message}`);
    const filtered = (data ?? [])
      .map(mapCadernoQuestionRow)
      .filter((q) => !excludeSet.has(q.id));
    return filtered.slice(0, limit);
  }

  const pendingCount = await countUnpublishedCadernoQuestions(cadernoId);
  const bufferSize = Math.min(500, Math.max(pendingCount, limit + excludeSet.size));
  const { data, error } = await supabase
    .from("caderno_questions")
    .select(selectCols)
    .eq("caderno_id", cadernoId)
    .is("published_question_id", null)
    .order("position", { ascending: true })
    .limit(bufferSize);

  if (error) throw new Error(`Erro ao listar questoes do caderno: ${error.message}`);

  const rows = shuffleCadernoQuestionRows(
    (data ?? []).map(mapCadernoQuestionRow).filter((q) => !excludeSet.has(q.id))
  );
  return rows.slice(0, limit);
}

export async function countCadernoQuestions(cadernoId: number): Promise<number> {
  const { count, error } = await supabase
    .from("caderno_questions")
    .select("id", { count: "exact", head: true })
    .eq("caderno_id", cadernoId);

  if (error) throw new Error(`Erro ao contar questoes do caderno: ${error.message}`);
  return count || 0;
}

export async function countUnpublishedCadernoQuestions(cadernoId: number): Promise<number> {
  const { count, error } = await supabase
    .from("caderno_questions")
    .select("id", { count: "exact", head: true })
    .eq("caderno_id", cadernoId)
    .is("published_question_id", null);

  if (error) throw new Error(`Erro ao contar questoes pendentes do caderno: ${error.message}`);
  return count || 0;
}

export async function countPublishedCadernoQuestions(cadernoId: number): Promise<number> {
  const { count, error } = await supabase
    .from("caderno_questions")
    .select("id", { count: "exact", head: true })
    .eq("caderno_id", cadernoId)
    .not("published_question_id", "is", null);

  if (error) throw new Error(`Erro ao contar questoes publicadas do caderno: ${error.message}`);
  return count || 0;
}

/** Reseta publicações ao reciclar: questões voltam a contar como "pendentes". */
export async function resetCadernoPublishedQuestions(cadernoId: number): Promise<void> {
  const { error } = await supabase
    .from("caderno_questions")
    .update({ published_question_id: null, published_at: null })
    .eq("caderno_id", cadernoId);

  if (error) throw new Error(`Erro ao reciclar caderno: ${error.message}`);

  try {
    await deleteCadernoSendQueue(cadernoId);
  } catch (e) {
    const msg = (e as Error).message.toLowerCase();
    if (!msg.includes("relation") && !msg.includes("does not exist")) throw e;
  }

  try {
    await deletePrivateSendsForCaderno(cadernoId);
    await resetPrivateRecipientsProgress(cadernoId);
  } catch (e) {
    const msg = (e as Error).message.toLowerCase();
    if (!msg.includes("relation") && !msg.includes("does not exist")) throw e;
  }
}

export async function listCadernosForOwner(
  ownerJid: string
): Promise<CadernoRow[]> {
  const { data, error } = await supabase
    .from("cadernos")
    .select(CADERNO_SELECT_COLUMNS)
    .eq("created_by_jid", ownerJid)
    .order("created_at", { ascending: false });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao listar cadernos: ${error.message}`);
  }

  return (data ?? []).map(mapCadernoRow);
}

export async function updateCadernoAfterRun(
  cadernoId: number,
  newCursor: number,
  nextRunAtIso: string | null
): Promise<void> {
  const { error } = await supabase
    .from("cadernos")
    .update({
      cursor: newCursor,
      last_run_at: new Date().toISOString(),
      next_run_at: nextRunAtIso
    })
    .eq("id", cadernoId);

  if (error) throw new Error(`Erro ao atualizar caderno apos envio: ${error.message}`);
}

/**
 * Atualiza estado do dia em curso + agenda próximo tick. Não mexe em cursor
 * (cursor virou métrica de "quantas já enviadas no total"; usamos
 * `published_question_id IS NULL` como filtro de pendentes).
 */
export async function updateCadernoDayState(
  cadernoId: number,
  patch: {
    currentDayDate?: string | null;
    currentDaySent?: number;
    cursor?: number;
    nextRunAtIso?: string | null;
    updateLastRun?: boolean;
  }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(patch, "currentDayDate")) {
    update.current_day_date = patch.currentDayDate;
  }
  if (typeof patch.currentDaySent === "number") {
    update.current_day_sent = patch.currentDaySent;
  }
  if (typeof patch.cursor === "number") {
    update.cursor = patch.cursor;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "nextRunAtIso")) {
    update.next_run_at = patch.nextRunAtIso;
  }
  if (patch.updateLastRun) {
    update.last_run_at = new Date().toISOString();
  }
  if (Object.keys(update).length === 0) return;

  const { error } = await supabase.from("cadernos").update(update).eq("id", cadernoId);
  if (error) throw new Error(`Erro ao atualizar estado do caderno: ${error.message}`);
}

/**
 * Lista as questões `caderno_questions` publicadas em uma data específica
 * (`current_day_date` no fuso do caderno). Retorna a published_at e o id da
 * linha em `questions` para checar respostas.
 *
 * Só entram linhas em que o agendador de **grupo** chamou `markCadernoQuestionPublished`
 * (envio automático no grupo). Questões do wizard/site e envios privados do caderno
 * não atualizam `caderno_questions.published_question_id`, logo não entram no
 * `waitForAnswers` / calendário do caderno em grupo.
 */
export async function listCadernoQuestionsPublishedOnDate(
  cadernoId: number,
  dayIso: string,
  timeZone: string
): Promise<{ publishedQuestionId: number; publishedAt: string }[]> {
  const published = await loadPublishedQuestionsContext([cadernoId]);
  const out: { publishedQuestionId: number; publishedAt: string }[] = [];
  for (const row of published.byCaderno.get(cadernoId) || []) {
    if (publishedDayIso(row.publishedAt, timeZone) === dayIso) {
      out.push({ publishedQuestionId: row.publishedQuestionId, publishedAt: row.publishedAt });
    }
  }
  return out;
}

/** Lista IDs de quem respondeu (set por question_id). */
export async function listAnswersForQuestionIds(
  questionIds: number[]
): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>();
  if (questionIds.length === 0) return out;

  // PostgREST limita URL/`.in` e retorna no máx. ~1000 linhas por request —
  // sem chunk a omissa “esquece” respostas e relista questão já respondida.
  const CHUNK = 80;
  for (let i = 0; i < questionIds.length; i += CHUNK) {
    const chunk = questionIds.slice(i, i + CHUNK);
    let from = 0;
    const PAGE = 1000;
    for (;;) {
      const { data, error } = await supabase
        .from("answers")
        .select("question_id, user_jid")
        .in("question_id", chunk)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Erro ao listar respostas: ${error.message}`);
      const rows = data ?? [];
      for (const row of rows) {
        const qid = Number(row.question_id);
        const jid = row.user_jid ? String(row.user_jid) : "";
        if (!Number.isFinite(qid) || !jid) continue;
        let set = out.get(qid);
        if (!set) {
          set = new Set<string>();
          out.set(qid, set);
        }
        set.add(jidComparableKeyShared(jid));
      }
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }
  return out;
}

/**
 * True se todos os engajados elegíveis do caderno responderam todas as questões
 * publicadas em `dayIso`. `excludeComparableKeys` remove JIDs (ex.: bot).
 */
export async function isCadernoDayCompleteForEngaged(
  cadernoId: number,
  dayIso: string,
  timeZone: string,
  excludeComparableKeys?: Set<string>
): Promise<boolean> {
  const publishedToday = await listCadernoQuestionsPublishedOnDate(cadernoId, dayIso, timeZone);
  if (publishedToday.length === 0) return true;

  const questionIds = publishedToday.map((p) => p.publishedQuestionId);
  const answersByQ = await listAnswersForQuestionIds(questionIds);
  const creatorKey = jidComparableKeyShared(`caderno:${cadernoId}@bot`);

  for (const pub of publishedToday) {
    const eligible = await getEngagedEligibleUserJidsForCadernoAt(cadernoId, pub.publishedAt);
    if (eligible.length === 0) continue;

    const eligibleSet = new Set<string>();
    for (const jid of eligible) {
      const jc = jidComparableKeyShared(jid);
      if (excludeComparableKeys?.has(jc)) continue;
      if (jc === creatorKey) continue;
      eligibleSet.add(jc);
    }
    if (eligibleSet.size === 0) continue;

    const answeredSet = answersByQ.get(pub.publishedQuestionId) ?? new Set<string>();
    for (const jc of eligibleSet) {
      if (!answeredSet.has(jc)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Engajados elegíveis que ainda não responderam alguma questão publicada
 * em `cadernoId` + `dayIso` (mesma noção de `isCadernoDayCompleteForEngaged`).
 * Usado para penalidade de travamento — não misturar com omissas de outros cadernos/dias.
 */
export async function listEngagedJidsMissingCadernoDayAnswers(
  cadernoId: number,
  dayIso: string,
  timeZone: string,
  excludeComparableKeys?: Set<string>
): Promise<string[]> {
  const publishedToday = await listCadernoQuestionsPublishedOnDate(cadernoId, dayIso, timeZone);
  if (publishedToday.length === 0) return [];

  const questionIds = publishedToday.map((p) => p.publishedQuestionId);
  const answersByQ = await listAnswersForQuestionIds(questionIds);
  const creatorKey = jidComparableKeyShared(`caderno:${cadernoId}@bot`);
  const missingByKey = new Map<string, string>();

  for (const pub of publishedToday) {
    const eligible = await getEngagedEligibleUserJidsForCadernoAt(cadernoId, pub.publishedAt);
    if (eligible.length === 0) continue;

    const answeredSet = answersByQ.get(pub.publishedQuestionId) ?? new Set<string>();
    for (const jid of eligible) {
      const jc = jidComparableKeyShared(jid);
      if (excludeComparableKeys?.has(jc)) continue;
      if (jc === creatorKey) continue;
      if (!answeredSet.has(jc)) {
        missingByKey.set(jc, jid);
      }
    }
  }
  return [...missingByKey.values()];
}

export async function setCadernoStatus(
  cadernoId: number,
  status: CadernoRow["status"],
  extra: { nextRunAt?: string | null; cursor?: number } = {}
): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (Object.prototype.hasOwnProperty.call(extra, "nextRunAt")) {
    update.next_run_at = extra.nextRunAt ?? null;
  }
  if (typeof extra.cursor === "number") {
    update.cursor = extra.cursor;
  }

  const { error } = await supabase.from("cadernos").update(update).eq("id", cadernoId);
  if (error) throw new Error(`Erro ao mudar status do caderno: ${error.message}`);
}

/** Linha em `questions` já criada por tentativa anterior (falha no WhatsApp). */
export async function findOrphanCadernoQuestionRow(
  cadernoId: number,
  cadernoQuestionId: number,
  targetGroupJid: string,
  recipientJid?: string | null
): Promise<{ shortId: string; dbId: number } | null> {
  const creator = `caderno:${cadernoId}@bot`;
  const suffix = recipientJid?.trim()
    ? `-${jidComparableKeyShared(recipientJid.trim())}`
    : "";
  const waPrefix = `caderno-${cadernoId}-${cadernoQuestionId}${suffix}-`;

  const { data, error } = await supabase
    .from("questions")
    .select("id, short_id")
    .eq("creator_jid", creator)
    .eq("target_group_jid", targetGroupJid)
    .like("wa_message_id", `${waPrefix}%`)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao buscar questao orfa do caderno: ${error.message}`);
  }
  if (!data?.id || !data.short_id) return null;

  return {
    dbId: Number(data.id),
    shortId: String(data.short_id).toUpperCase()
  };
}

export async function getPublishedQuestionIdForCadernoQuestion(
  cadernoQuestionId: number
): Promise<number | null> {
  const { data, error } = await supabase
    .from("caderno_questions")
    .select("published_question_id")
    .eq("id", cadernoQuestionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao ler publicacao do caderno: ${error.message}`);
  }
  const id = data?.published_question_id != null ? Number(data.published_question_id) : NaN;
  return Number.isFinite(id) ? id : null;
}

export async function getQuestionShortIdByDbId(dbId: number): Promise<string | null> {
  const { data, error } = await supabase
    .from("questions")
    .select("short_id")
    .eq("id", dbId)
    .maybeSingle();

  if (error) throw new Error(`Erro ao buscar short_id: ${error.message}`);
  if (!data?.short_id) return null;
  return String(data.short_id).toUpperCase();
}

export async function markCadernoQuestionPublished(
  cadernoQuestionId: number,
  publishedQuestionDbId: number
): Promise<void> {
  const { error } = await supabase
    .from("caderno_questions")
    .update({
      published_question_id: publishedQuestionDbId,
      published_at: new Date().toISOString()
    })
    .eq("id", cadernoQuestionId);

  if (error) {
    console.warn("[caderno] markCadernoQuestionPublished:", error.message);
  }
}

export type CadernoSendQueueRow = {
  id: number;
  cadernoId: number;
  cadernoQuestionId: number;
  plannedDayIso: string;
  slotIndex: number;
  publishedQuestionId: number | null;
  releasedAt: string | null;
};

function mapCadernoSendQueueRow(row: Record<string, unknown>): CadernoSendQueueRow {
  return {
    id: Number(row.id),
    cadernoId: Number(row.caderno_id),
    cadernoQuestionId: Number(row.caderno_question_id),
    plannedDayIso: String(row.planned_day_iso),
    slotIndex: Number(row.slot_index) || 0,
    publishedQuestionId:
      row.published_question_id != null ? Number(row.published_question_id) : null,
    releasedAt: row.released_at ? String(row.released_at) : null
  };
}

export async function listQueuedCadernoQuestionIds(cadernoId: number): Promise<number[]> {
  const { data, error } = await supabase
    .from("caderno_send_queue")
    .select("caderno_question_id")
    .eq("caderno_id", cadernoId)
    .is("released_at", null);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao listar fila do caderno: ${error.message}`);
  }
  return (data ?? [])
    .map((r) => Number(r.caderno_question_id))
    .filter((id) => Number.isFinite(id));
}

export async function getCadernoSendQueueItem(
  cadernoId: number,
  plannedDayIso: string,
  slotIndex: number
): Promise<CadernoSendQueueRow | null> {
  const { data, error } = await supabase
    .from("caderno_send_queue")
    .select(
      "id, caderno_id, caderno_question_id, planned_day_iso, slot_index, published_question_id, released_at"
    )
    .eq("caderno_id", cadernoId)
    .eq("planned_day_iso", plannedDayIso)
    .eq("slot_index", slotIndex)
    .maybeSingle();

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return null;
    throw new Error(`Erro ao buscar item da fila: ${error.message}`);
  }
  if (!data) return null;
  return mapCadernoSendQueueRow(data as Record<string, unknown>);
}

export async function getCadernoQuestionById(
  cadernoQuestionId: number
): Promise<CadernoQuestionRow | null> {
  const { data, error } = await supabase
    .from("caderno_questions")
    .select(
      "id, caderno_id, position, tec_question_id, tec_url, banca, subject, question_type, statement_text, answer_key"
    )
    .eq("id", cadernoQuestionId)
    .maybeSingle();

  if (error) throw new Error(`Erro ao buscar questao do caderno: ${error.message}`);
  if (!data) return null;
  return mapCadernoQuestionRow(data as Record<string, unknown>);
}

export async function markCadernoSendQueueReleased(
  queueId: number,
  publishedQuestionId: number
): Promise<void> {
  const { error } = await supabase
    .from("caderno_send_queue")
    .update({
      released_at: new Date().toISOString(),
      published_question_id: publishedQuestionId
    })
    .eq("id", queueId);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return;
    console.warn("[caderno] markCadernoSendQueueReleased:", error.message);
  }
}

export async function deleteCadernoSendQueue(cadernoId: number): Promise<void> {
  const { error } = await supabase.from("caderno_send_queue").delete().eq("caderno_id", cadernoId);
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return;
    throw new Error(`Erro ao limpar fila do caderno: ${error.message}`);
  }
}

export async function listQueueItemsForDay(
  cadernoId: number,
  plannedDayIso: string
): Promise<CadernoSendQueueRow[]> {
  const { data, error } = await supabase
    .from("caderno_send_queue")
    .select(
      "id, caderno_id, caderno_question_id, planned_day_iso, slot_index, published_question_id, released_at"
    )
    .eq("caderno_id", cadernoId)
    .eq("planned_day_iso", plannedDayIso)
    .order("slot_index", { ascending: true });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao listar fila do dia: ${error.message}`);
  }
  return (data ?? []).map((row) => mapCadernoSendQueueRow(row as Record<string, unknown>));
}

export async function listFutureQueueDays(cadernoId: number): Promise<string[]> {
  const { data, error } = await supabase
    .from("caderno_send_queue")
    .select("planned_day_iso")
    .eq("caderno_id", cadernoId)
    .is("released_at", null)
    .order("planned_day_iso", { ascending: true });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao listar dias da fila: ${error.message}`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of data ?? []) {
    const d = String(row.planned_day_iso || "");
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

export async function countUnreleasedQueueItems(cadernoId: number): Promise<number> {
  const { count, error } = await supabase
    .from("caderno_send_queue")
    .select("id", { count: "exact", head: true })
    .eq("caderno_id", cadernoId)
    .is("released_at", null);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return 0;
    throw new Error(`Erro ao contar fila: ${error.message}`);
  }
  return count || 0;
}

export type DayActivityStatus =
  | "feito"
  | "pendente"
  | "atrasado"
  | "passou"
  | "hoje";

export type UserCadernoDayStatus = {
  dayIso: string;
  status: DayActivityStatus;
  questionIds: number[];
  shortIds: string[];
  answeredCount: number;
  totalCount: number;
  label: string;
};

async function resolveQuestionIdsForCadernoDay(
  caderno: CadernoRow,
  dayIso: string
): Promise<{ questionIds: number[]; fromQueue: boolean }> {
  const tz = caderno.timezone || "America/Sao_Paulo";
  const queue = await listQueueItemsForDay(caderno.id, dayIso);
  const fromQueueIds = queue
    .map((q) => q.publishedQuestionId)
    .filter((id): id is number => id != null && Number.isFinite(id));

  if (fromQueueIds.length > 0) {
    return { questionIds: [...new Set(fromQueueIds)], fromQueue: true };
  }

  const published = await listCadernoQuestionsPublishedOnDate(caderno.id, dayIso, tz);
  return {
    questionIds: published.map((p) => p.publishedQuestionId),
    fromQueue: false
  };
}

function weekdayLabelForIso(dayIso: string): string {
  const [y, m, d] = dayIso.split("-").map(Number);
  const utcDay = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  const idx = utcDay === 0 ? 6 : utcDay - 1;
  return WEEKDAY_LABELS_PT[idx];
}

/**
 * Status do usuário para um dia de um caderno (fila adiantada e/ou publicadas no dia).
 */
export async function getUserCadernoDayStatus(
  caderno: CadernoRow,
  userJid: string,
  dayIso: string,
  todayIso?: string
): Promise<UserCadernoDayStatus> {
  const tz = caderno.timezone || ECONOMY_TZ;
  const today = todayIso || dateIsoInTimezone(new Date(), tz);
  const { questionIds } = await resolveQuestionIdsForCadernoDay(caderno, dayIso);
  const [shortCtx, answersCtx] = await Promise.all([
    loadShortIdsContext(questionIds),
    loadUserAnswersContext(questionIds, userJid)
  ]);
  const shortIds: string[] = [];
  let answeredCount = 0;
  for (const qid of questionIds) {
    const sid = shortCtx.shortIdByQuestionId.get(qid);
    if (sid) shortIds.push(sid);
    if (answersCtx.answeredQuestionIds.has(qid)) answeredCount += 1;
  }
  const totalCount = questionIds.length;
  const allDone = totalCount > 0 && answeredCount >= totalCount;

  let status: DayActivityStatus;
  if (dayIso === today) {
    if (allDone) status = "feito";
    else status = "hoje";
  } else if (dayIso < today) {
    if (totalCount === 0) status = "passou";
    else if (allDone) status = "feito";
    else status = "atrasado";
  } else if (totalCount === 0) {
    status = "pendente";
  } else if (allDone) {
    status = "feito";
  } else {
    status = "pendente";
  }

  return {
    dayIso,
    status,
    questionIds,
    shortIds,
    answeredCount,
    totalCount,
    label: `${weekdayLabelForIso(dayIso)} ${formatDayLabelPt(dayIso)}`
  };
}

/** Agrega status do usuário em vários cadernos. */
export function mergeDayStatuses(statuses: UserCadernoDayStatus[]): DayActivityStatus {
  if (statuses.length === 0) return "passou";
  if (statuses.some((s) => s.status === "atrasado")) return "atrasado";
  if (statuses.some((s) => s.status === "hoje")) return "hoje";
  const withQ = statuses.filter((s) => s.totalCount > 0);
  if (withQ.length > 0 && withQ.every((s) => s.status === "feito")) return "feito";
  if (statuses.some((s) => s.status === "pendente")) return "pendente";
  if (statuses.every((s) => s.status === "feito")) return "feito";
  if (statuses.every((s) => s.status === "passou")) return "passou";
  return "pendente";
}

export type AdiantarDayResult = {
  dayIso: string;
  status: "feito" | "pendente" | "novo" | "skipped" | "error";
  shortIds: string[];
  message: string;
  newlyReserved: boolean;
};

export type AdiantarCadernoResult = {
  shortIds: string[];
  daysFilled: number;
  plannedDays: string[];
  newlyPlannedDays: string[];
  dayResults: AdiantarDayResult[];
  message: string;
};

/**
 * Adianta dias explícitos: não pula dias já na fila.
 * - fila existe + user respondeu tudo → "já feito"
 * - fila existe + falta responder → reoferece short_ids
 * - sem fila → materializa
 */
export async function adiantarCadernoDays(
  caderno: CadernoRow,
  dayIsos: string[],
  userJid: string
): Promise<AdiantarCadernoResult> {
  const N = Math.max(1, caderno.questionsPerDay);
  const tz = caderno.timezone || "America/Sao_Paulo";
  const todayIso = dateIsoInTimezone(new Date(), tz);
  const uniqueDays = [...new Set(dayIsos.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();

  const dayResults: AdiantarDayResult[] = [];
  const offerShortIds: string[] = [];
  const newlyPlannedDays: string[] = [];
  let daysFilled = 0;

  for (const dayIso of uniqueDays) {
    if (dayIso <= todayIso) {
      dayResults.push({
        dayIso,
        status: "skipped",
        shortIds: [],
        message: `${formatDayLabelPt(dayIso)}: use /omissas para hoje (ou dia já passou).`,
        newlyReserved: false
      });
      continue;
    }

    const queue = await listQueueItemsForDay(caderno.id, dayIso);
    if (queue.length > 0) {
      const questionIds = queue
        .map((q) => q.publishedQuestionId)
        .filter((id): id is number => id != null && Number.isFinite(id));
      const shortIds: string[] = [];
      for (const qid of questionIds) {
        const sid = await getQuestionShortIdByDbId(qid);
        if (sid) shortIds.push(sid);
      }
      const answersByQ = await listAnswersForQuestionIds(questionIds);
      const userKey = jidComparableKeyShared(userJid);
      const allDone =
        questionIds.length > 0 &&
        questionIds.every((qid) => answersByQ.get(qid)?.has(userKey));

      if (allDone) {
        dayResults.push({
          dayIso,
          status: "feito",
          shortIds: [],
          message: `${formatDayLabelPt(dayIso)}: já feito.`,
          newlyReserved: false
        });
      } else {
        dayResults.push({
          dayIso,
          status: "pendente",
          shortIds,
          message: `${formatDayLabelPt(dayIso)}: pendente (${shortIds.length} questão(ões)).`,
          newlyReserved: false
        });
        offerShortIds.push(...shortIds);
        daysFilled += 1;
      }
      continue;
    }

    const pending = await listNextCadernoQuestionsToSend(caderno.id, N, caderno.randomOrder);
    if (pending.length === 0) {
      dayResults.push({
        dayIso,
        status: "error",
        shortIds: [],
        message: `${formatDayLabelPt(dayIso)}: sem questões pendentes no caderno.`,
        newlyReserved: false
      });
      continue;
    }

    const shortIds: string[] = [];
    let slotsThisDay = 0;
    for (let slot = 0; slot < N && slot < pending.length; slot++) {
      const question = pending[slot];
      const { shortId, dbId } = await createQuestionFromCaderno({ caderno, question });
      const { error } = await supabase.from("caderno_send_queue").insert({
        caderno_id: caderno.id,
        caderno_question_id: question.id,
        planned_day_iso: dayIso,
        slot_index: slot,
        published_question_id: dbId
      });
      if (error) {
        throw new Error(`Erro ao reservar questao na fila: ${error.message}`);
      }
      shortIds.push(shortId);
      slotsThisDay += 1;
    }

    if (slotsThisDay > 0) {
      daysFilled += 1;
      newlyPlannedDays.push(dayIso);
      offerShortIds.push(...shortIds);
      dayResults.push({
        dayIso,
        status: "novo",
        shortIds,
        message: `${formatDayLabelPt(dayIso)}: ${shortIds.length} questão(ões) reservada(s).`,
        newlyReserved: true
      });
    }
  }

  const lines = dayResults.map((r) => r.message);
  return {
    shortIds: [...new Set(offerShortIds)],
    daysFilled,
    plannedDays: newlyPlannedDays,
    newlyPlannedDays,
    dayResults,
    message: [`Caderno #${caderno.id} "${caderno.name}":`, ...lines].join("\n")
  };
}

/**
 * Adianta os próximos `days` dias civis após hoje (sem pular dias já na fila).
 */
export async function adiantarCadernoQuestions(
  caderno: CadernoRow,
  days: number,
  userJid: string
): Promise<AdiantarCadernoResult> {
  const tz = caderno.timezone || "America/Sao_Paulo";
  const todayIso = dateIsoInTimezone(new Date(), tz);
  const dayIsos = nextNDayIsosAfter(todayIso, days);
  return adiantarCadernoDays(caderno, dayIsos, userJid);
}

export type SemanaCadernoReport = {
  caderno: CadernoRow;
  weekStart: string;
  weekEnd: string;
  todayIso: string;
  days: UserCadernoDayStatus[];
};

export async function buildSemanaReportForUser(
  userJid: string,
  groupJid: string,
  anchorIso?: string
): Promise<SemanaCadernoReport[]> {
  const reports = await loadSemanaContext(userJid, groupJid, anchorIso);
  return reports.map((r) => ({
    caderno: r.caderno,
    weekStart: r.weekStart,
    weekEnd: r.weekEnd,
    todayIso: r.todayIso,
    days: r.days
  }));
}

export function formatSemanaReportText(reports: SemanaCadernoReport[]): string {
  if (reports.length === 0) {
    return "Voce nao esta engajado em nenhum caderno ativo deste grupo.";
  }
  const blocks: string[] = [];
  for (const r of reports) {
    const lines = [
      `Semana ${formatDayLabelPt(r.weekStart)}–${formatDayLabelPt(r.weekEnd)} (caderno #${r.caderno.id} ${r.caderno.name}):`
    ];
    for (const d of r.days) {
      let tag: string = d.status;
      if (d.dayIso === r.todayIso) {
        if (d.status === "feito") tag = "hoje · feito";
        else if (d.totalCount > 0) tag = "hoje · pendente";
        else tag = "hoje";
      } else if (d.status === "passou") {
        tag = "—";
      }
      const detail = d.totalCount > 0 ? ` (${d.answeredCount}/${d.totalCount})` : "";
      lines.push(`${d.label}: ${tag}${detail}`);
    }
    lines.push("");
    lines.push("Atalhos: adiantar 1 | adiantar sab + domingo");
    lines.push("Site: /atividades");
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

export async function listActiveGroupCadernos(groupJid: string): Promise<CadernoRow[]> {
  const { data, error } = await supabase
    .from("cadernos")
    .select(CADERNO_SELECT_COLUMNS)
    .eq("status", "active")
    .eq("target_group_jid", groupJid)
    .neq("delivery_mode", "private")
    .order("id", { ascending: true });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    if (msg.includes("column") && msg.includes("delivery_mode")) {
      const r = await supabase
        .from("cadernos")
        .select(CADERNO_SELECT_COLUMNS.replace(", delivery_mode", ""))
        .eq("status", "active")
        .eq("target_group_jid", groupJid)
        .order("id", { ascending: true });
      if (r.error) throw new Error(`Erro ao listar cadernos ativos: ${r.error.message}`);
      return (r.data ?? []).map((row) =>
        mapCadernoRow({
          ...(row as unknown as Record<string, unknown>),
          delivery_mode: "group"
        })
      );
    }
    throw new Error(`Erro ao listar cadernos ativos: ${error.message}`);
  }
  return (data ?? []).map(mapCadernoRow);
}

export async function wasGroupDailyDigestSent(
  groupJid: string,
  dayIso: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("group_daily_digest")
    .select("day_iso")
    .eq("group_jid", groupJid)
    .eq("day_iso", dayIso)
    .maybeSingle();

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return false;
    throw new Error(`Erro ao checar digest diario: ${error.message}`);
  }
  return Boolean(data);
}

export async function recordGroupDailyDigest(groupJid: string, dayIso: string): Promise<boolean> {
  const { error } = await supabase.from("group_daily_digest").insert({
    group_jid: groupJid,
    day_iso: dayIso,
    sent_at: new Date().toISOString()
  });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("duplicate") || msg.includes("unique")) return false;
    if (msg.includes("relation") && msg.includes("does not exist")) return false;
    throw new Error(`Erro ao gravar digest diario: ${error.message}`);
  }
  return true;
}

export async function getPassiveCadernoIdsForUser(
  userJid: string,
  groupJid: string
): Promise<Set<number>> {
  const { data: cadernos, error: cErr } = await supabase
    .from("cadernos")
    .select("id")
    .eq("target_group_jid", groupJid);

  if (cErr) {
    throw new Error(`Erro ao listar cadernos do grupo: ${cErr.message}`);
  }

  const cadernoIds = (cadernos ?? []).map((c) => Number(c.id)).filter((id) => Number.isFinite(id));
  if (cadernoIds.length === 0) return new Set();

  const { data: rows, error } = await supabase
    .from("caderno_engagement")
    .select("caderno_id, user_jid")
    .in("caderno_id", cadernoIds)
    .eq("passive", true);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return new Set();
    if (msg.includes("column") && msg.includes("passive")) return new Set();
    throw new Error(`Erro ao ler cadernos passivos do usuario: ${error.message}`);
  }

  const userKey = jidComparableKeyShared(userJid);
  const out = new Set<number>();
  for (const row of rows ?? []) {
    const cid = Number(row.caderno_id);
    if (!Number.isFinite(cid)) continue;
    const rowJid = row.user_jid ? String(row.user_jid) : "";
    if (rowJid && jidComparableKeyShared(rowJid) === userKey) {
      out.add(cid);
    }
  }
  return out;
}

export async function listEngagedGroupCadernosForUser(
  userJid: string,
  groupJid: string
): Promise<CadernoRow[]> {
  const engagedIds = await getEngagedCadernoIdsForUser(userJid, groupJid);
  if (engagedIds.size === 0) return [];
  const active = await listActiveGroupCadernos(groupJid);
  return active.filter((c) => engagedIds.has(c.id));
}

/** Próximo número exibido no privado (parte antes do `-`), por caderno + destinatário. */
async function nextPrivateDisplayOrdinal(cadernoId: number, recipientJid: string): Promise<number> {
  const creator = `caderno:${cadernoId}@bot`;
  const { data, error } = await supabase
    .from("questions")
    .select("short_id")
    .eq("creator_jid", creator)
    .eq("target_group_jid", recipientJid);

  if (error) throw new Error(`Erro ao alocar ordinal da questao privada: ${error.message}`);
  let max = 0;
  const re = /^(\d+)-\d+/;
  for (const row of data ?? []) {
    const s = String(row.short_id ?? "").trim();
    const m = re.exec(s);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/** 2 caracteres alfanuméricos estáveis a partir do JID (evita colisão entre destinatários). */
function privateRecipientShortTag(recipientJid: string): string {
  const h = crypto.createHash("sha256").update(jidComparableKeyShared(recipientJid)).digest("hex");
  const n = parseInt(h.slice(0, 8), 16);
  return n.toString(36).slice(0, 2).padStart(2, "0");
}

export type CadernoQuestionPublishInput = {
  caderno: CadernoRow;
  question: CadernoQuestionRow;
  /** Se definido, a questão fica associada ao privado deste JID (métricas só dele). */
  recipientJid?: string | null;
};

/**
 * Cria uma linha em `questions` para uma questao do caderno, sem midia.
 * Grupo: `short_id` = id numérico (ex.: 16) — respostas `e 16`.
 * Privado: `short_id` = `n-{idCaderno}` (ex.: 16-3) ou `n-{id}-{tag}` se houver mais de um destinatário ativo.
 */
export async function createQuestionFromCaderno(
  input: CadernoQuestionPublishInput
): Promise<{ shortId: string; dbId: number }> {
  const { caderno, question, recipientJid } = input;
  const creatorJid = `caderno:${caderno.id}@bot`;
  const creatorName = `Caderno: ${caderno.name}`;
  const targetJid = (recipientJid && recipientJid.trim()) || caderno.targetGroupJid;

  const explanationParts: string[] = [
    "Resolução completa no Tec Concursos:",
    question.tecUrl
  ];
  if (question.banca) explanationParts.push("", `Banca: ${question.banca}`);
  if (question.subject) explanationParts.push(`Matéria: ${question.subject}`);
  const explanationText = explanationParts.join("\n");

  const suffix = recipientJid ? `-${jidComparableKeyShared(recipientJid)}` : "";

  const { data, error } = await supabase
    .from("questions")
    .insert({
      creator_jid: creatorJid,
      creator_name: creatorName,
      target_group_jid: targetJid,
      question_type: question.questionType,
      statement_text: question.statementText,
      statement_media_url: null,
      statement_media_mime_type: null,
      answer_key: question.answerKey.toUpperCase(),
      explanation_text: explanationText,
      explanation_media_url: null,
      explanation_media_mime_type: null,
      group_jid: targetJid,
      sender_jid: creatorJid,
      message_type: "text",
      text_content: question.statementText,
      media_mime_type: null,
      wa_message_id: `caderno-${caderno.id}-${question.id}${suffix}-${Date.now()}`,
      sent_at: new Date().toISOString()
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Erro ao criar questao a partir de caderno: ${error?.message ?? "sem dados"}`);
  }

  const dbId = Number(data.id);
  let shortId: string;
  if (recipientJid && recipientJid.trim()) {
    const n = await nextPrivateDisplayOrdinal(caderno.id, recipientJid.trim());
    const recs = await listPrivateRecipientsByCaderno(caderno.id);
    const activeCount = recs.filter((r) => r.active).length;
    const tag = privateRecipientShortTag(recipientJid.trim());
    shortId =
      activeCount > 1 ? `${n}-${caderno.id}-${tag}` : `${n}-${caderno.id}`;
  } else {
    shortId = await nextGroupQuestionShortId(caderno.targetGroupJid);
  }
  shortId = shortId.toUpperCase();

  const { error: updateError } = await supabase
    .from("questions")
    .update({ short_id: shortId })
    .eq("id", data.id);

  if (updateError) {
    throw new Error(`Erro ao atualizar short_id da questao do caderno: ${updateError.message}`);
  }

  return { shortId, dbId };
}

export type CadernoProgress = {
  caderno: CadernoRow;
  totalQuestions: number;
  publishedCount: number;
  resolvedByEngaged: number;
  withAnyAnswer: number;
  engagedCount: number;
};

/**
 * Calcula o progresso do caderno:
 *  - `publishedCount`: quantas questões do caderno já foram enviadas ao grupo.
 *  - `resolvedByEngaged`: das publicadas, quantas tiveram resposta de
 *    **todos** os engajados **deste caderno** (mesmo critério do auto-gabarito).
 *  - `withAnyAnswer`: das publicadas, quantas tiveram **pelo menos uma**
 *    resposta. Útil quando não há engajados configurados.
 *  - `engagedCount`: total de engajados neste caderno (referência para o cálculo).
 */
export async function getCadernoProgress(cadernoId: number): Promise<CadernoProgress | null> {
  const caderno = await getCadernoById(cadernoId);
  if (!caderno) return null;

  const totalQuestions = await countCadernoQuestions(cadernoId);

  if (caderno.deliveryMode === "private") {
    const { data: sends, error: sErr } = await supabase
      .from("caderno_private_send")
      .select("published_question_id, recipient_jid")
      .eq("caderno_id", cadernoId)
      .not("published_question_id", "is", null);

    if (sErr) throw new Error(`Erro ao buscar envios privados: ${sErr.message}`);

    const publishedIds = (sends ?? [])
      .map((r) => Number(r.published_question_id))
      .filter((x) => Number.isFinite(x));
    const publishedCount = publishedIds.length;

    const recs = await listPrivateRecipientsByCaderno(cadernoId);
    const engagedCount = recs.filter((r) => r.active).length;

    if (publishedCount === 0) {
      return {
        caderno,
        totalQuestions,
        publishedCount: 0,
        resolvedByEngaged: 0,
        withAnyAnswer: 0,
        engagedCount
      };
    }

    const { data: answers, error: ansErr } = await supabase
      .from("answers")
      .select("question_id, user_jid")
      .in("question_id", publishedIds);

    if (ansErr) throw new Error(`Erro ao buscar respostas para progresso: ${ansErr.message}`);

    const answeredByQuestion = new Map<number, Set<string>>();
    for (const row of answers ?? []) {
      const qid = Number(row.question_id);
      if (!Number.isFinite(qid)) continue;
      const userJid = String(row.user_jid || "");
      if (!userJid) continue;
      let set = answeredByQuestion.get(qid);
      if (!set) {
        set = new Set<string>();
        answeredByQuestion.set(qid, set);
      }
      set.add(jidComparableKeyShared(userJid));
    }

    let resolvedByEngaged = 0;
    let withAnyAnswer = 0;
    for (const row of sends ?? []) {
      const qid = Number(row.published_question_id);
      const who = String(row.recipient_jid || "");
      if (!Number.isFinite(qid) || !who) continue;
      const userSet = answeredByQuestion.get(qid);
      if (!userSet || userSet.size === 0) continue;
      withAnyAnswer += 1;
      if (userSet.has(jidComparableKeyShared(who))) {
        resolvedByEngaged += 1;
      }
    }

    return {
      caderno,
      totalQuestions,
      publishedCount,
      resolvedByEngaged,
      withAnyAnswer,
      engagedCount
    };
  }

  const { data: publishedRows, error: pubErr } = await supabase
    .from("caderno_questions")
    .select("id, published_question_id")
    .eq("caderno_id", cadernoId)
    .not("published_question_id", "is", null);

  if (pubErr) throw new Error(`Erro ao buscar questoes publicadas: ${pubErr.message}`);

  const publishedIds = (publishedRows ?? [])
    .map((r) => Number(r.published_question_id))
    .filter((x) => Number.isFinite(x));
  const publishedCount = publishedIds.length;

  if (publishedCount === 0) {
    return {
      caderno,
      totalQuestions,
      publishedCount: 0,
      resolvedByEngaged: 0,
      withAnyAnswer: 0,
      engagedCount: 0
    };
  }

  const engagedJids = await getEngagedUserJidsForCaderno(cadernoId);
  const engagedCount = engagedJids.length;
  const engagedComparable = new Set(engagedJids.map((j) => jidComparableKeyShared(j)));

  const { data: answers, error: ansErr } = await supabase
    .from("answers")
    .select("question_id, user_jid")
    .in("question_id", publishedIds);

  if (ansErr) throw new Error(`Erro ao buscar respostas para progresso: ${ansErr.message}`);

  const answeredByQuestion = new Map<number, Set<string>>();
  for (const row of answers ?? []) {
    const qid = Number(row.question_id);
    if (!Number.isFinite(qid)) continue;
    const userJid = String(row.user_jid || "");
    if (!userJid) continue;
    let set = answeredByQuestion.get(qid);
    if (!set) {
      set = new Set<string>();
      answeredByQuestion.set(qid, set);
    }
    set.add(jidComparableKeyShared(userJid));
  }

  let resolvedByEngaged = 0;
  let withAnyAnswer = 0;
  for (const qid of publishedIds) {
    const userSet = answeredByQuestion.get(qid);
    if (!userSet || userSet.size === 0) continue;
    withAnyAnswer += 1;
    if (engagedCount > 0) {
      let allAnswered = true;
      for (const jc of engagedComparable) {
        if (!userSet.has(jc)) {
          allAnswered = false;
          break;
        }
      }
      if (allAnswered) resolvedByEngaged += 1;
    }
  }

  return {
    caderno,
    totalQuestions,
    publishedCount,
    resolvedByEngaged,
    withAnyAnswer,
    engagedCount
  };
}

function jidComparableKeyShared(jid: string): string {
  const at = jid.indexOf("@");
  if (at < 0) return jid.toLowerCase().trim();
  const userPart = jid.slice(0, at);
  const userNoDevice = userPart.includes(":") ? userPart.split(":")[0]! : userPart;
  const domain = jid.slice(at + 1).toLowerCase();
  return `${userNoDevice}@${domain}`;
}

export async function getEngagedCadernoIdsForUser(
  userJid: string,
  groupJid: string
): Promise<Set<number>> {
  const sinceMap = await getEngagedCadernoSinceMapForUser(userJid, groupJid);
  return new Set(sinceMap.keys());
}

/** caderno_id → engaged_since ISO (null = engajado “desde sempre”, vê o histórico). */
export async function getEngagedCadernoSinceMapForUser(
  userJid: string,
  groupJid: string
): Promise<Map<number, string | null>> {
  const { data: cadernos, error: cErr } = await supabase
    .from("cadernos")
    .select("id")
    .eq("target_group_jid", groupJid);

  if (cErr) {
    throw new Error(`Erro ao listar cadernos do grupo: ${cErr.message}`);
  }

  const cadernoIds = (cadernos ?? []).map((c) => Number(c.id)).filter((id) => Number.isFinite(id));
  if (cadernoIds.length === 0) return new Map();

  let rows: { caderno_id: unknown; user_jid: unknown; engaged_since?: unknown }[] | null = null;
  let error: { message: string } | null = null;

  {
    const res = await supabase
      .from("caderno_engagement")
      .select("caderno_id, user_jid, engaged_since")
      .in("caderno_id", cadernoIds)
      .eq("engaged", true);
    error = res.error;
    rows = res.data;
    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("column") && msg.includes("engaged_since")) {
        const fb = await supabase
          .from("caderno_engagement")
          .select("caderno_id, user_jid")
          .in("caderno_id", cadernoIds)
          .eq("engaged", true);
        error = fb.error;
        rows = (fb.data || []).map((r) => ({ ...r, engaged_since: null }));
      }
    }
  }

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return new Map();
    throw new Error(`Erro ao ler cadernos engajados do usuario: ${error.message}`);
  }

  const userKey = jidComparableKeyShared(userJid);
  const out = new Map<number, string | null>();
  for (const row of rows ?? []) {
    const cid = Number(row.caderno_id);
    if (!Number.isFinite(cid)) continue;
    const rowJid = row.user_jid ? String(row.user_jid) : "";
    if (rowJid && jidComparableKeyShared(rowJid) === userKey) {
      const since =
        row.engaged_since != null && String(row.engaged_since).trim()
          ? String(row.engaged_since)
          : null;
      out.set(cid, since);
    }
  }
  return out;
}

/**
 * IDs de questões do caderno publicadas no dia `fromDayIso` (TZ) ou depois.
 */
export async function listCadernoQuestionIdsPublishedFromDay(
  cadernoId: number,
  fromDayIso: string,
  timeZone: string
): Promise<number[]> {
  const published = await loadPublishedQuestionsContext([cadernoId]);
  const out: number[] = [];
  for (const row of published.byCaderno.get(cadernoId) || []) {
    if (publishedDayIso(row.publishedAt, timeZone) >= fromDayIso) {
      out.push(row.publishedQuestionId);
    }
  }
  return out;
}

export async function getCadernoQuestionPublishedAt(
  shortId: string
): Promise<string | null> {
  const cadernoId = await getCadernoIdForQuestion(shortId);
  if (cadernoId == null) return null;

  const normalizedId = shortId.toUpperCase();
  const { data: question, error } = await supabase
    .from("questions")
    .select("id, created_at")
    .eq("short_id", normalizedId)
    .maybeSingle();
  if (error || !question) return null;

  const qid = Number(question.id);
  const { data: cq } = await supabase
    .from("caderno_questions")
    .select("published_at")
    .eq("caderno_id", cadernoId)
    .eq("published_question_id", qid)
    .maybeSingle();

  if (cq?.published_at) return String(cq.published_at);
  if (question.created_at) return String(question.created_at);
  return null;
}

export async function isUserGloballyEngaged(userJid: string, groupJid: string): Promise<boolean> {
  const engaged = await getEngagedUserJidsForGroup(groupJid);
  const userKey = jidComparableKeyShared(userJid);
  return engaged.some((jid) => jidComparableKeyShared(jid) === userKey);
}

export type UnansweredOmissasBuckets = {
  /** Publicadas no dia civil `dayIso` (ECONOMY_TZ) e ainda sem resposta. */
  today: string[];
  /** Publicadas antes de `dayIso` e ainda sem resposta. */
  atrasadas: string[];
  /** Quantas questões elegíveis foram publicadas em `dayIso` (respondidas ou não). */
  dueOnDayCount: number;
  /** Quantas de `dueOnDayCount` ainda estão abertas. */
  openOnDayCount: number;
};

export type ListOmissasOptions = {
  /** Dia civil de referência (default: hoje em ECONOMY_TZ). */
  dayIso?: string;
  todayLimit?: number;
  atrasadasLimit?: number;
  /** Inclui bucket atrasadas (default true). */
  includeAtrasadas?: boolean;
};

/**
 * Questões em aberto do usuário, separadas em “do dia” vs atrasadas.
 * Streak / bônus de zerar / miss eval usam só `today`.
 * `/omissas` mostra `today`; `/atrasadas` mostra o backlog.
 *
 * Usa composição `loadGroupOmissasContext` (loaders genéricos) —
 * round-trips não crescem com nº de cadernos × dias.
 */
export async function listUnansweredOmissasForUser(
  userJid: string,
  groupJid: string,
  opts: ListOmissasOptions = {}
): Promise<UnansweredOmissasBuckets> {
  const todayLimit = Math.max(1, opts.todayLimit ?? 40);
  const atrasadasLimit = Math.max(0, opts.atrasadasLimit ?? 40);
  const includeAtrasadas = opts.includeAtrasadas !== false;

  const ctx = await loadGroupOmissasContext(userJid, groupJid, opts.dayIso);
  const dayIso = ctx.dayIso;
  const engagedCadernoIds = new Set(ctx.cadernos.engagedSinceMap.keys());
  const pubDayByQuestionId = ctx.pubDayEconomyByQuestionId;
  const unreleasedPlannedDay = ctx.queue.unreleasedPlannedDayByQuestionId;

  const { data: questions, error: qErr } = await supabase
    .from("questions")
    .select("id, short_id, creator_jid, created_at, omissa_day_iso")
    .eq("target_group_jid", groupJid)
    .order("created_at", { ascending: false })
    .limit(400);

  if (qErr) {
    // Coluna nova pode não existir ainda — fallback sem omissa_day_iso.
    if (String(qErr.message || "").toLowerCase().includes("omissa_day_iso")) {
      const retry = await supabase
        .from("questions")
        .select("id, short_id, creator_jid, created_at")
        .eq("target_group_jid", groupJid)
        .order("created_at", { ascending: false })
        .limit(400);
      if (retry.error) {
        throw new Error(`Erro ao listar questoes: ${retry.error.message}`);
      }
      return listUnansweredOmissasForUserFromRows(
        userJid,
        groupJid,
        opts,
        dayIso,
        todayLimit,
        atrasadasLimit,
        includeAtrasadas,
        (retry.data ?? []) as {
          id: number;
          short_id: string | null;
          creator_jid: string | null;
          created_at: string | null;
          omissa_day_iso?: string | null;
        }[],
        pubDayByQuestionId,
        unreleasedPlannedDay,
        engagedCadernoIds,
        ctx.passiveTodayDbIds,
        ctx.engagedRestrictedCadernos,
        ctx.engagedSinceAllowedDbIds,
        ctx.visibleCadernoQuestionIds,
        ctx.cadernos.globallyEngaged
      );
    }
    throw new Error(`Erro ao listar questoes: ${qErr.message}`);
  }

  return listUnansweredOmissasForUserFromRows(
    userJid,
    groupJid,
    opts,
    dayIso,
    todayLimit,
    atrasadasLimit,
    includeAtrasadas,
    (questions ?? []) as {
      id: number;
      short_id: string | null;
      creator_jid: string | null;
      created_at: string | null;
      omissa_day_iso?: string | null;
    }[],
    pubDayByQuestionId,
    unreleasedPlannedDay,
    engagedCadernoIds,
    ctx.passiveTodayDbIds,
    ctx.engagedRestrictedCadernos,
    ctx.engagedSinceAllowedDbIds,
    ctx.visibleCadernoQuestionIds,
    ctx.cadernos.globallyEngaged
  );
}

async function listUnansweredOmissasForUserFromRows(
  userJid: string,
  groupJid: string,
  _opts: ListOmissasOptions,
  dayIso: string,
  todayLimit: number,
  atrasadasLimit: number,
  includeAtrasadas: boolean,
  questions: {
    id: number;
    short_id: string | null;
    creator_jid: string | null;
    created_at: string | null;
    omissa_day_iso?: string | null;
  }[],
  pubDayByQuestionId: Map<number, string>,
  unreleasedPlannedDay: Map<number, string>,
  engagedCadernoIds: Set<number>,
  passiveTodayDbIds: Set<number>,
  engagedRestrictedCadernos: Set<number>,
  engagedSinceAllowedDbIds: Set<number>,
  visibleCadernoQuestionIds: Set<number>,
  globallyEngaged: boolean
): Promise<UnansweredOmissasBuckets> {
  type Candidate = { sid: string; qid: number; pubDay: string };
  const candidates: Candidate[] = [];

  for (const q of questions) {
    if (!q.short_id) continue;
    const sid = String(q.short_id).toUpperCase();
    if (isPrivateCadernoShortId(sid)) continue;
    const qid = q.id as number;
    const creatorJid = String(q.creator_jid ?? "");
    if (creatorJid && isSameQuizParticipant(creatorJid, userJid)) {
      continue;
    }

    // Adiantadas ainda não liberadas: não entram em /omissas nem /atrasadas.
    const plannedFuture = unreleasedPlannedDay.get(qid);
    if (plannedFuture && plannedFuture > dayIso) {
      continue;
    }

    if (isBotCreatorJid(creatorJid)) {
      const cadernoId = parseCadernoIdFromCreatorJid(creatorJid);
      if (cadernoId == null) continue;
      const isEngaged = engagedCadernoIds.has(cadernoId);
      const isPassiveToday = passiveTodayDbIds.has(qid);
      if (!isEngaged && !isPassiveToday) continue;
      if (isEngaged && isOrphanCadernoGroupQuestion(qid, creatorJid, visibleCadernoQuestionIds)) {
        continue;
      }
      if (isEngaged && engagedRestrictedCadernos.has(cadernoId) && !engagedSinceAllowedDbIds.has(qid)) {
        continue;
      }
    } else if (!globallyEngaged) {
      continue;
    }

    let pubDay = pubDayByQuestionId.get(qid);
    if (!pubDay && plannedFuture) pubDay = plannedFuture;
    // Questões avulsas: omissa_day_iso (corte 15h) tem prioridade sobre created_at.
    if (!isBotCreatorJid(creatorJid) && q.omissa_day_iso) {
      pubDay = String(q.omissa_day_iso);
    } else if (!pubDay && q.omissa_day_iso) {
      pubDay = String(q.omissa_day_iso);
    }
    if (!pubDay && q.created_at) {
      pubDay = formatDateInTimezone(new Date(String(q.created_at)), "America/Sao_Paulo");
    }
    if (!pubDay) continue;
    // Futuro (ainda não “do dia”) — não lista.
    if (pubDay > dayIso) continue;

    candidates.push({ sid, qid, pubDay });
  }

  const questionIds = candidates.map((c) => c.qid);
  const answersCtx = await loadUserAnswersContext(questionIds, userJid);

  const today: string[] = [];
  const atrasadas: string[] = [];
  let dueOnDayCount = 0;
  let openOnDayCount = 0;

  for (const c of candidates) {
    const answered = answersCtx.answeredQuestionIds.has(c.qid);
    if (c.pubDay === dayIso) {
      dueOnDayCount += 1;
      if (!answered) {
        openOnDayCount += 1;
        if (today.length < todayLimit) today.push(c.sid);
      }
      continue;
    }
    if (!includeAtrasadas || answered) continue;
    if (c.pubDay < dayIso && atrasadas.length < atrasadasLimit) {
      atrasadas.push(c.sid);
    }
  }

  return { today, atrasadas, dueOnDayCount, openOnDayCount };
}

/** Compat: só omissas do dia (streak / bônus / miss). */
export async function listUnansweredShortIdsForUser(
  userJid: string,
  groupJid: string,
  limit = 25
): Promise<string[]> {
  const buckets = await listUnansweredOmissasForUser(userJid, groupJid, {
    todayLimit: limit,
    atrasadasLimit: 0,
    includeAtrasadas: false
  });
  return buckets.today;
}

/** Todas as omissas abertas (hoje + atrasadas), para oferta de enunciados. */
export async function listAllUnansweredShortIdsForUser(
  userJid: string,
  groupJid: string,
  limit = 50
): Promise<string[]> {
  const half = Math.max(1, Math.floor(limit / 2));
  const buckets = await listUnansweredOmissasForUser(userJid, groupJid, {
    todayLimit: half,
    atrasadasLimit: limit - half
  });
  return [...buckets.today, ...buckets.atrasadas].slice(0, limit);
}

/* ——— Omissas web sessions + bot pending events ——— */

export type OmissasWebSessionMode = "hoje" | "atrasadas" | "adiantar";

export type OmissasWebSession = {
  token: string;
  userJid: string;
  userName: string | null;
  groupJid: string;
  mode: OmissasWebSessionMode;
  shortIds: string[];
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
};

function mapOmissasWebSession(row: Record<string, unknown>): OmissasWebSession {
  const shortIds = Array.isArray(row.short_ids)
    ? (row.short_ids as unknown[]).map((s) => String(s).toUpperCase())
    : [];
  return {
    token: String(row.token),
    userJid: String(row.user_jid),
    userName: row.user_name != null ? String(row.user_name) : null,
    groupJid: String(row.group_jid),
    mode: String(row.mode) as OmissasWebSessionMode,
    shortIds,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    completedAt: row.completed_at != null ? String(row.completed_at) : null
  };
}

function newOmissasWebToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export async function createOmissasWebSession(input: {
  userJid: string;
  userName?: string | null;
  groupJid: string;
  mode: OmissasWebSessionMode;
  shortIds: string[];
  expiresInHours?: number;
}): Promise<OmissasWebSession> {
  const token = newOmissasWebToken();
  const hours = input.expiresInHours ?? 24;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const shortIds = [...new Set(input.shortIds.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];

  const { data, error } = await supabase
    .from("omissas_web_sessions")
    .insert({
      token,
      user_jid: input.userJid,
      user_name: input.userName?.trim() || null,
      group_jid: input.groupJid,
      mode: input.mode,
      short_ids: shortIds,
      expires_at: expiresAt
    })
    .select("token, user_jid, user_name, group_jid, mode, short_ids, created_at, expires_at, completed_at")
    .single();

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      throw new Error(
        "Tabela omissas_web_sessions inexistente. Rode supabase-migration-omissas-web-sessions.sql"
      );
    }
    throw new Error(`Erro ao criar sessao omissas web: ${error.message}`);
  }
  return mapOmissasWebSession(data as Record<string, unknown>);
}

export async function getOmissasWebSessionByToken(token: string): Promise<OmissasWebSession | null> {
  const t = String(token || "").trim();
  if (!t) return null;
  const { data, error } = await supabase
    .from("omissas_web_sessions")
    .select("token, user_jid, user_name, group_jid, mode, short_ids, created_at, expires_at, completed_at")
    .eq("token", t)
    .maybeSingle();
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      throw new Error(
        "Tabela omissas_web_sessions inexistente. Rode supabase-migration-omissas-web-sessions.sql"
      );
    }
    throw new Error(`Erro ao buscar sessao omissas web: ${error.message}`);
  }
  return data ? mapOmissasWebSession(data as Record<string, unknown>) : null;
}

export async function markOmissasWebSessionCompleted(token: string): Promise<void> {
  const { error } = await supabase
    .from("omissas_web_sessions")
    .update({ completed_at: new Date().toISOString() })
    .eq("token", token)
    .is("completed_at", null);
  if (error) {
    console.warn("[omissas-web] mark completed:", error.message);
  }
}

export type BotPendingEvent = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export async function enqueueBotPendingEvent(
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from("bot_pending_events").insert({
    kind,
    payload
  });
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) {
      throw new Error(
        "Tabela bot_pending_events inexistente. Rode supabase-migration-omissas-web-sessions.sql"
      );
    }
    throw new Error(`Erro ao enfileirar evento bot: ${error.message}`);
  }
}

export async function listUnprocessedBotPendingEvents(limit = 40): Promise<BotPendingEvent[]> {
  const { data, error } = await supabase
    .from("bot_pending_events")
    .select("id, kind, payload, created_at")
    .is("processed_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
    throw new Error(`Erro ao listar bot_pending_events: ${error.message}`);
  }
  return (data || []).map((row) => ({
    id: Number(row.id),
    kind: String(row.kind),
    payload: (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<
      string,
      unknown
    >,
    createdAt: String(row.created_at)
  }));
}

export async function markBotPendingEventProcessed(id: number): Promise<void> {
  const { error } = await supabase
    .from("bot_pending_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    console.warn("[bot-pending] mark processed:", error.message);
  }
}

/* ——— Categorias pessoais (por user_jid, ligadas à resposta) ——— */

export type UserCategory = {
  id: number;
  name: string;
  nameNormalized: string;
  createdAt: string;
};

function normalizeCategoryName(text: string): string {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function displayCategoryName(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/;+\s*$/g, "")
    .trim();
}

export async function listUserCategories(userJid: string): Promise<UserCategory[]> {
  const { data, error } = await supabase
    .from("user_categories")
    .select("id, name, name_normalized, created_at")
    .eq("user_jid", userJid)
    .order("name", { ascending: true });
  if (error) {
    throw new Error(`Erro ao listar categorias: ${error.message}`);
  }
  return (data || []).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    nameNormalized: String(row.name_normalized),
    createdAt: String(row.created_at)
  }));
}

export async function createUserCategory(
  userJid: string,
  rawName: string
): Promise<UserCategory & { alreadyExisted: boolean }> {
  const name = displayCategoryName(rawName);
  if (!name) throw new Error("Informe o nome da categoria");
  const nameNormalized = normalizeCategoryName(name);
  if (!nameNormalized) throw new Error("Nome de categoria invalido");

  const { data, error } = await supabase
    .from("user_categories")
    .insert({
      user_jid: userJid,
      name,
      name_normalized: nameNormalized
    })
    .select("id, name, name_normalized, created_at")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      const { data: existing, error: findErr } = await supabase
        .from("user_categories")
        .select("id, name, name_normalized, created_at")
        .eq("user_jid", userJid)
        .eq("name_normalized", nameNormalized)
        .maybeSingle();
      if (findErr) throw new Error(`Erro ao buscar categoria: ${findErr.message}`);
      if (existing) {
        return {
          id: Number(existing.id),
          name: String(existing.name),
          nameNormalized: String(existing.name_normalized),
          createdAt: String(existing.created_at),
          alreadyExisted: true
        };
      }
    }
    throw new Error(`Erro ao criar categoria: ${error.message}`);
  }

  return {
    id: Number(data!.id),
    name: String(data!.name),
    nameNormalized: String(data!.name_normalized),
    createdAt: String(data!.created_at),
    alreadyExisted: false
  };
}

export async function resolveCategoryNames(
  userJid: string,
  names: string[]
): Promise<{
  known: { id: number; name: string }[];
  unknown: string[];
  catalog: UserCategory[];
}> {
  const catalog = await listUserCategories(userJid);
  const byNorm = new Map(catalog.map((c) => [c.nameNormalized, c]));
  const known: { id: number; name: string }[] = [];
  const knownIds = new Set<number>();
  const unknown: string[] = [];
  const seenUnknown = new Set<string>();

  for (const raw of names) {
    const display = displayCategoryName(raw);
    if (!display) continue;
    const norm = normalizeCategoryName(display);
    if (!norm) continue;
    const hit = byNorm.get(norm);
    if (hit) {
      if (!knownIds.has(hit.id)) {
        knownIds.add(hit.id);
        known.push({ id: hit.id, name: hit.name });
      }
    } else if (!seenUnknown.has(norm)) {
      seenUnknown.add(norm);
      unknown.push(display);
    }
  }

  return { known, unknown, catalog };
}

export async function listCategoriesForAnswer(
  answerId: number
): Promise<{ id: number; name: string }[]> {
  const { data, error } = await supabase
    .from("answer_categories")
    .select("category_id, user_categories(id, name)")
    .eq("answer_id", answerId);
  if (error) throw new Error(`Erro ao listar categorias da resposta: ${error.message}`);
  const out: { id: number; name: string }[] = [];
  for (const row of data || []) {
    const raw = (row as { user_categories?: unknown }).user_categories;
    const cat = Array.isArray(raw) ? raw[0] : raw;
    if (!cat || typeof cat !== "object") continue;
    const c = cat as { id?: number; name?: string };
    if (c.id == null || c.name == null) continue;
    out.push({ id: Number(c.id), name: String(c.name) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return out;
}

export async function setAnswerCategories(
  answerId: number,
  categoryIds: number[]
): Promise<{ id: number; name: string }[]> {
  const ids = [
    ...new Set(categoryIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))
  ];

  const { error: delErr } = await supabase.from("answer_categories").delete().eq("answer_id", answerId);
  if (delErr) throw new Error(`Erro ao limpar categorias: ${delErr.message}`);

  if (!ids.length) return [];

  const rows = ids.map((category_id) => ({ answer_id: answerId, category_id }));
  const { error: insErr } = await supabase.from("answer_categories").insert(rows);
  if (insErr) throw new Error(`Erro ao associar categorias: ${insErr.message}`);

  return listCategoriesForAnswer(answerId);
}

export async function clearAnswerCategories(answerId: number): Promise<void> {
  await setAnswerCategories(answerId, []);
}

/* ——— Discussões (WA anchors + feed) ——— */

export type DiscussionPostSource = "auto_gabarito" | "gabarito" | "early";
export type DiscussionCommentSource = "whatsapp" | "web";
export type QuestionWaMessageRole = "statement" | "result" | "explanation_media";

export type DiscussionPost = {
  id: number;
  questionId: number;
  shortId: string;
  groupJid: string;
  source: DiscussionPostSource;
  createdAt: string;
  feedAt?: string | null;
  statementPreview?: string | null;
  commentCount?: number;
};

export type DiscussionComment = {
  id: number;
  postId: number;
  parentId: number | null;
  authorJid: string;
  authorName: string | null;
  body: string;
  source: DiscussionCommentSource;
  waMessageId: string | null;
  sharedToWaAt: string | null;
  createdAt: string;
};

function mapDiscussionPost(row: Record<string, unknown>): DiscussionPost {
  return {
    id: Number(row.id),
    questionId: Number(row.question_id),
    shortId: String(row.short_id || "").toUpperCase(),
    groupJid: String(row.group_jid || ""),
    source: String(row.source) as DiscussionPostSource,
    createdAt: String(row.created_at),
    feedAt: row.feed_at != null ? String(row.feed_at) : null
  };
}

function mapDiscussionComment(row: Record<string, unknown>): DiscussionComment {
  return {
    id: Number(row.id),
    postId: Number(row.post_id),
    parentId: row.parent_id != null ? Number(row.parent_id) : null,
    authorJid: String(row.author_jid || ""),
    authorName: row.author_name != null ? String(row.author_name) : null,
    body: String(row.body || ""),
    source: String(row.source) as DiscussionCommentSource,
    waMessageId: row.wa_message_id != null ? String(row.wa_message_id) : null,
    sharedToWaAt: row.shared_to_wa_at != null ? String(row.shared_to_wa_at) : null,
    createdAt: String(row.created_at)
  };
}

function discussionsMissingTable(error: { message?: string } | null): boolean {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("relation") && msg.includes("does not exist");
}

const DISCUSSION_POST_SELECT =
  "id, question_id, short_id, group_jid, source, created_at, feed_at";

function isFeedSource(source: string): boolean {
  return source === "auto_gabarito" || source === "gabarito";
}

export async function insertQuestionWaMessage(input: {
  questionId: number;
  shortId: string;
  groupJid: string;
  waMessageId: string;
  role: QuestionWaMessageRole;
}): Promise<void> {
  const waId = String(input.waMessageId || "").trim();
  if (!waId) return;
  const { error } = await supabase.from("question_wa_messages").upsert(
    {
      question_id: input.questionId,
      short_id: input.shortId.toUpperCase(),
      group_jid: input.groupJid,
      wa_message_id: waId,
      role: input.role
    },
    { onConflict: "group_jid,wa_message_id", ignoreDuplicates: true }
  );
  if (error) {
    if (discussionsMissingTable(error)) {
      console.warn(
        "[discussions] Tabela question_wa_messages inexistente. Rode supabase-migration-discussions.sql"
      );
      return;
    }
    console.warn("[discussions] insertQuestionWaMessage:", error.message);
  }
}

/** Cria ou promove post. early não entra no feed; auto_gabarito/gabarito seta feed_at. */
export async function upsertDiscussionPost(input: {
  questionId: number;
  shortId: string;
  groupJid: string;
  source: DiscussionPostSource;
}): Promise<DiscussionPost | null> {
  const { data: existing, error: findErr } = await supabase
    .from("discussion_posts")
    .select(DISCUSSION_POST_SELECT)
    .eq("question_id", input.questionId)
    .maybeSingle();

  if (findErr) {
    if (discussionsMissingTable(findErr)) {
      console.warn(
        "[discussions] Tabela discussion_posts inexistente. Rode supabase-migration-discussions.sql"
      );
      return null;
    }
    throw new Error(`Erro ao buscar discussion_post: ${findErr.message}`);
  }

  const nowIso = new Date().toISOString();
  const promoteToFeed = isFeedSource(input.source);

  if (existing) {
    const prevSource = String(existing.source || "");
    const patch: Record<string, unknown> = {};
    if (promoteToFeed) {
      if (!isFeedSource(prevSource)) patch.source = input.source;
      if (existing.feed_at == null) patch.feed_at = nowIso;
    }

    if (Object.keys(patch).length > 0) {
      const { data: updated, error: upErr } = await supabase
        .from("discussion_posts")
        .update(patch)
        .eq("id", existing.id)
        .select(DISCUSSION_POST_SELECT)
        .single();
      if (upErr) {
        console.warn("[discussions] promote post:", upErr.message);
        return mapDiscussionPost(existing as Record<string, unknown>);
      }
      return mapDiscussionPost(updated as Record<string, unknown>);
    }
    return mapDiscussionPost(existing as Record<string, unknown>);
  }

  const insertRow: Record<string, unknown> = {
    question_id: input.questionId,
    short_id: input.shortId.toUpperCase(),
    group_jid: input.groupJid,
    source: input.source,
    feed_at: promoteToFeed ? nowIso : null
  };

  const { data, error } = await supabase
    .from("discussion_posts")
    .insert(insertRow)
    .select(DISCUSSION_POST_SELECT)
    .single();

  if (error) {
    if (String(error.message || "").toLowerCase().includes("duplicate")) {
      const { data: again } = await supabase
        .from("discussion_posts")
        .select(DISCUSSION_POST_SELECT)
        .eq("question_id", input.questionId)
        .maybeSingle();
      return again ? mapDiscussionPost(again as Record<string, unknown>) : null;
    }
    throw new Error(`Erro ao criar discussion_post: ${error.message}`);
  }
  return mapDiscussionPost(data as Record<string, unknown>);
}

export async function findQuestionByWaMessageId(
  groupJid: string,
  waMessageId: string
): Promise<{ questionId: number; shortId: string; role: QuestionWaMessageRole } | null> {
  const { data, error } = await supabase
    .from("question_wa_messages")
    .select("question_id, short_id, role")
    .eq("group_jid", groupJid)
    .eq("wa_message_id", waMessageId)
    .maybeSingle();
  if (error) {
    if (discussionsMissingTable(error)) return null;
    throw new Error(`Erro ao buscar âncora WA: ${error.message}`);
  }
  if (!data) return null;
  return {
    questionId: Number(data.question_id),
    shortId: String(data.short_id || "").toUpperCase(),
    role: String(data.role) as QuestionWaMessageRole
  };
}

export async function findDiscussionCommentByWaMessageId(
  waMessageId: string
): Promise<DiscussionComment | null> {
  const { data, error } = await supabase
    .from("discussion_comments")
    .select(
      "id, post_id, parent_id, author_jid, author_name, body, source, wa_message_id, shared_to_wa_at, created_at"
    )
    .eq("wa_message_id", waMessageId)
    .maybeSingle();
  if (error) {
    if (discussionsMissingTable(error)) return null;
    throw new Error(`Erro ao buscar comentário WA: ${error.message}`);
  }
  return data ? mapDiscussionComment(data as Record<string, unknown>) : null;
}

export async function getDiscussionPostByQuestionId(
  questionId: number
): Promise<DiscussionPost | null> {
  const { data, error } = await supabase
    .from("discussion_posts")
    .select(DISCUSSION_POST_SELECT)
    .eq("question_id", questionId)
    .maybeSingle();
  if (error) {
    if (discussionsMissingTable(error)) return null;
    throw new Error(`Erro ao buscar discussion_post: ${error.message}`);
  }
  return data ? mapDiscussionPost(data as Record<string, unknown>) : null;
}

export async function getDiscussionPostById(postId: number): Promise<DiscussionPost | null> {
  const { data, error } = await supabase
    .from("discussion_posts")
    .select(DISCUSSION_POST_SELECT)
    .eq("id", postId)
    .maybeSingle();
  if (error) {
    if (discussionsMissingTable(error)) return null;
    throw new Error(`Erro ao buscar discussion_post: ${error.message}`);
  }
  return data ? mapDiscussionPost(data as Record<string, unknown>) : null;
}

export async function getDiscussionPostByShortId(
  shortId: string
): Promise<DiscussionPost | null> {
  const id = String(shortId || "").trim().toUpperCase();
  if (!id) return null;
  const { data, error } = await supabase
    .from("discussion_posts")
    .select(DISCUSSION_POST_SELECT)
    .eq("short_id", id)
    .maybeSingle();
  if (error) {
    if (discussionsMissingTable(error)) return null;
    throw new Error(`Erro ao buscar discussion_post: ${error.message}`);
  }
  return data ? mapDiscussionPost(data as Record<string, unknown>) : null;
}

/** Árvore de comentários formatada para WhatsApp. */
export function formatDiscussionCommentsTree(
  comments: DiscussionComment[],
  maxChars = 3500
): string {
  if (!comments.length) return "";
  const byId = new Map(comments.map((c) => [c.id, c]));
  const byParent = new Map<string, DiscussionComment[]>();
  for (const c of comments) {
    const key = c.parentId == null ? "root" : String(c.parentId);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }
  const lines: string[] = [];
  function walk(parentKey: string, depth: number) {
    const list = byParent.get(parentKey) || [];
    for (const c of list) {
      const indent = "  ".repeat(Math.min(depth, 6));
      const author = (c.authorName && c.authorName.trim()) || "Participante";
      const parent = c.parentId != null ? byId.get(c.parentId) : null;
      const replyBit = parent
        ? ` → ${((parent.authorName && parent.authorName.trim()) || "Participante")}`
        : "";
      lines.push(`${indent}• ${author}${replyBit}: ${c.body}`);
      walk(String(c.id), depth + 1);
    }
  }
  walk("root", 0);
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}

export async function getResultWaMessageIdForQuestion(
  questionId: number,
  groupJid: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("question_wa_messages")
    .select("wa_message_id")
    .eq("question_id", questionId)
    .eq("group_jid", groupJid)
    .eq("role", "result")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (discussionsMissingTable(error)) return null;
    console.warn("[discussions] getResultWaMessageId:", error.message);
    return null;
  }
  return data?.wa_message_id ? String(data.wa_message_id) : null;
}

export async function insertDiscussionComment(input: {
  postId: number;
  parentId?: number | null;
  authorJid: string;
  authorName?: string | null;
  body: string;
  source: DiscussionCommentSource;
  waMessageId?: string | null;
}): Promise<DiscussionComment | null> {
  const body = String(input.body || "").trim();
  if (!body) return null;

  if (input.waMessageId) {
    const existing = await findDiscussionCommentByWaMessageId(input.waMessageId);
    if (existing) return existing;
  }

  const { data, error } = await supabase
    .from("discussion_comments")
    .insert({
      post_id: input.postId,
      parent_id: input.parentId ?? null,
      author_jid: input.authorJid,
      author_name: input.authorName?.trim() || null,
      body,
      source: input.source,
      wa_message_id: input.waMessageId || null
    })
    .select(
      "id, post_id, parent_id, author_jid, author_name, body, source, wa_message_id, shared_to_wa_at, created_at"
    )
    .single();

  if (error) {
    if (discussionsMissingTable(error)) {
      console.warn(
        "[discussions] Tabela discussion_comments inexistente. Rode supabase-migration-discussions.sql"
      );
      return null;
    }
    if (input.waMessageId && String(error.message || "").toLowerCase().includes("duplicate")) {
      return findDiscussionCommentByWaMessageId(input.waMessageId);
    }
    throw new Error(`Erro ao inserir comentário: ${error.message}`);
  }
  return mapDiscussionComment(data as Record<string, unknown>);
}

export async function markDiscussionCommentSharedToWa(commentId: number): Promise<void> {
  const { error } = await supabase
    .from("discussion_comments")
    .update({ shared_to_wa_at: new Date().toISOString() })
    .eq("id", commentId)
    .is("shared_to_wa_at", null);
  if (error) {
    console.warn("[discussions] mark shared:", error.message);
  }
}

export async function getDiscussionCommentById(
  commentId: number
): Promise<DiscussionComment | null> {
  const { data, error } = await supabase
    .from("discussion_comments")
    .select(
      "id, post_id, parent_id, author_jid, author_name, body, source, wa_message_id, shared_to_wa_at, created_at"
    )
    .eq("id", commentId)
    .maybeSingle();
  if (error) {
    if (discussionsMissingTable(error)) return null;
    throw new Error(`Erro ao buscar comentário: ${error.message}`);
  }
  return data ? mapDiscussionComment(data as Record<string, unknown>) : null;
}

export async function listDiscussionCommentsForPost(
  postId: number
): Promise<DiscussionComment[]> {
  const { data, error } = await supabase
    .from("discussion_comments")
    .select(
      "id, post_id, parent_id, author_jid, author_name, body, source, wa_message_id, shared_to_wa_at, created_at"
    )
    .eq("post_id", postId)
    .order("created_at", { ascending: true });
  if (error) {
    if (discussionsMissingTable(error)) return [];
    throw new Error(`Erro ao listar comentários: ${error.message}`);
  }
  return (data || []).map((row) => mapDiscussionComment(row as Record<string, unknown>));
}

export async function listRecentDiscussionPosts(limit = 40): Promise<DiscussionPost[]> {
  const { data, error } = await supabase
    .from("discussion_posts")
    .select("id, question_id, short_id, group_jid, source, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (discussionsMissingTable(error)) return [];
    throw new Error(`Erro ao listar discussion_posts: ${error.message}`);
  }
  const posts = (data || []).map((row) => mapDiscussionPost(row as Record<string, unknown>));
  if (!posts.length) return posts;

  const questionIds = posts.map((p) => p.questionId);
  const { data: qRows } = await supabase
    .from("questions")
    .select("id, statement_text")
    .in("id", questionIds);
  const previewById = new Map<number, string | null>();
  for (const row of qRows || []) {
    const raw = row.statement_text != null ? String(row.statement_text).trim() : "";
    previewById.set(Number(row.id), raw ? raw.slice(0, 220) : null);
  }

  const postIds = posts.map((p) => p.id);
  const { data: cRows } = await supabase
    .from("discussion_comments")
    .select("post_id")
    .in("post_id", postIds);
  const countByPost = new Map<number, number>();
  for (const row of cRows || []) {
    const pid = Number(row.post_id);
    countByPost.set(pid, (countByPost.get(pid) || 0) + 1);
  }

  return posts.map((p) => ({
    ...p,
    statementPreview: previewById.get(p.questionId) ?? null,
    commentCount: countByPost.get(p.id) || 0
  }));
}

/** Threads de discussão por short_id (para relatório). */
export async function listDiscussionThreadsByShortIds(
  shortIds: string[]
): Promise<Record<string, DiscussionComment[]>> {
  const ids = [...new Set(shortIds.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  const out: Record<string, DiscussionComment[]> = {};
  if (!ids.length) return out;

  const { data: posts, error: pErr } = await supabase
    .from("discussion_posts")
    .select("id, short_id")
    .in("short_id", ids);
  if (pErr) {
    if (discussionsMissingTable(pErr)) return out;
    throw new Error(`Erro ao listar posts para relatório: ${pErr.message}`);
  }
  if (!posts?.length) return out;

  const postIdToShort = new Map<number, string>();
  for (const p of posts) {
    postIdToShort.set(Number(p.id), String(p.short_id).toUpperCase());
  }
  const postIds = [...postIdToShort.keys()];
  const { data: comments, error: cErr } = await supabase
    .from("discussion_comments")
    .select(
      "id, post_id, parent_id, author_jid, author_name, body, source, wa_message_id, shared_to_wa_at, created_at"
    )
    .in("post_id", postIds)
    .order("created_at", { ascending: true });
  if (cErr) {
    if (discussionsMissingTable(cErr)) return out;
    throw new Error(`Erro ao listar comentários para relatório: ${cErr.message}`);
  }

  for (const row of comments || []) {
    const shortId = postIdToShort.get(Number(row.post_id));
    if (!shortId) continue;
    if (!out[shortId]) out[shortId] = [];
    out[shortId].push(mapDiscussionComment(row as Record<string, unknown>));
  }
  return out;
}
