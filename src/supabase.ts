import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { config } from "./config";
import { AnswerInput, CreateQuestionInput, QuestionType } from "./types";

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
const ASSETS_BUCKET = "question-assets";

/** ID curto exibido nas mensagens = id numerico da linha no Supabase (legivel, ex. 12, 348). */
function toShortId(id: number | string): string {
  return String(id).trim();
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

export async function createQuestion(input: CreateQuestionInput): Promise<{ shortId: string }> {
  const statementUpload = await uploadMedia("statement", input.statementMedia);
  const explanationUpload = await uploadMedia("explanation", input.explanationMedia);

  const { data, error } = await supabase
    .from("questions")
    .insert({
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
      // Compatibilidade com schema legado
      group_jid: input.targetGroupJid,
      sender_jid: input.creatorJid,
      message_type: input.statementMedia ? "media" : "text",
      text_content: input.statementText,
      media_mime_type: statementUpload?.mimeType ?? null,
      wa_message_id: `wizard-${Date.now()}-${crypto.randomUUID()}`,
      sent_at: new Date().toISOString()
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Erro ao criar questao: ${error?.message ?? "sem dados"}`);
  }

  const shortId = toShortId(data.id);

  const { error: updateError } = await supabase
    .from("questions")
    .update({ short_id: shortId })
    .eq("id", data.id);

  if (updateError) {
    throw new Error(`Erro ao atualizar short_id: ${updateError.message}`);
  }

  return { shortId };
}

export async function insertAnswer(input: AnswerInput): Promise<void> {
  const { data: question, error: findError } = await supabase
    .from("questions")
    .select("id, question_type")
    .eq("short_id", input.questionShortId.toUpperCase())
    .maybeSingle();

  if (findError) {
    throw new Error(`Erro ao buscar questao: ${findError.message}`);
  }

  if (!question) {
    throw new Error("Questao nao encontrada");
  }

  const { error } = await supabase.from("answers").insert({
    question_id: question.id,
    question_short_id: input.questionShortId.toUpperCase(),
    user_jid: input.userJid,
    user_name: input.userName,
    answer_letter: input.answerLetter.toLowerCase(),
    source_message_id: input.sourceMessageId,
    sent_at: input.sentAt
  });

  if (error) {
    if (error.code === "23505") {
      await updateUserAnswer(input);
      return;
    }
    throw new Error(`Erro ao salvar resposta: ${error.message}`);
  }
}

export async function getUserAnswer(
  questionShortId: string,
  userJid: string
): Promise<{ answerLetter: string } | null> {
  const { data, error } = await supabase
    .from("answers")
    .select("answer_letter")
    .eq("question_short_id", questionShortId.toUpperCase())
    .eq("user_jid", userJid)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao buscar resposta existente: ${error.message}`);
  }

  if (!data) return null;
  return { answerLetter: String(data.answer_letter) };
}

export async function updateUserAnswer(input: AnswerInput): Promise<void> {
  const { data: question, error: findError } = await supabase
    .from("questions")
    .select("id")
    .eq("short_id", input.questionShortId.toUpperCase())
    .maybeSingle();

  if (findError) {
    throw new Error(`Erro ao buscar questao para update: ${findError.message}`);
  }

  if (!question) {
    throw new Error("Questao nao encontrada");
  }

  const { data: updatedRows, error } = await supabase
    .from("answers")
    .update({
      question_short_id: input.questionShortId.toUpperCase(),
      user_name: input.userName,
      answer_letter: input.answerLetter.toLowerCase(),
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
    const { error: insErr } = await supabase.from("answers").insert({
      question_id: question.id,
      question_short_id: input.questionShortId.toUpperCase(),
      user_jid: input.userJid,
      user_name: input.userName,
      answer_letter: input.answerLetter.toLowerCase(),
      source_message_id: input.sourceMessageId,
      sent_at: input.sentAt
    });
    if (insErr) {
      throw new Error(`Erro ao gravar resposta (fallback): ${insErr.message}`);
    }
  }
}

export type QuestionResult = {
  shortId: string;
  answerKey: string;
  questionType: QuestionType;
  explanationText: string | null;
  explanationMediaUrl: string | null;
  explanationMediaMimeType: string | null;
  distribution: Record<string, number>;
  correctUsers: string[];
  wrongUsers: string[];
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
      "id, short_id, question_type, answer_key, explanation_text, explanation_media_url, explanation_media_mime_type"
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
    .select("answer_letter, user_name, user_jid")
    .eq("question_short_id", normalizedId);

  if (error) {
    throw new Error(`Erro ao buscar respostas: ${error.message}`);
  }

  const distribution: Record<string, number> =
    question.question_type === "true_false" ? { C: 0, E: 0 } : { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const correctUsers: string[] = [];
  const wrongUsers: string[] = [];

  for (const row of answers) {
    const letter = String(row.answer_letter).toUpperCase();
    if (distribution[letter] !== undefined) {
      distribution[letter] += 1;
    }

    const label = (row.user_name && row.user_name.trim()) || row.user_jid;
    if (letter === String(question.answer_key).toUpperCase()) {
      correctUsers.push(label);
    } else {
      wrongUsers.push(label);
    }
  }

  return {
    shortId: normalizedId,
    answerKey: String(question.answer_key).toUpperCase(),
    questionType: question.question_type as QuestionType,
    explanationText: question.explanation_text,
    explanationMediaUrl: question.explanation_media_url,
    explanationMediaMimeType: question.explanation_media_mime_type,
    distribution,
    correctUsers,
    wrongUsers
  };
}

export type QuestionRepeatPayload = {
  shortId: string;
  creatorName: string;
  statementText: string | null;
  statementMediaUrl: string | null;
  statementMediaMimeType: string | null;
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

  return {
    shortId: String(data.short_id ?? normalizedId).toUpperCase(),
    creatorName: data.creator_name ? String(data.creator_name) : "Autor",
    statementText,
    statementMediaUrl: data.statement_media_url ?? null,
    statementMediaMimeType: data.statement_media_mime_type ?? null
  };
}

export type RankingEntry = {
  userLabel: string;
  userJid: string;
  correctCount: number;
};

export async function getRankingForGroup(groupJid: string): Promise<RankingEntry[]> {
  const { data: byTarget, error: errTarget } = await supabase
    .from("questions")
    .select("id, answer_key")
    .eq("target_group_jid", groupJid);

  if (errTarget) {
    throw new Error(`Erro ao buscar questoes do grupo: ${errTarget.message}`);
  }

  let byLegacy: { id: number; answer_key: string }[] | null = null;
  const legacyRes = await supabase.from("questions").select("id, answer_key").eq("group_jid", groupJid);
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
