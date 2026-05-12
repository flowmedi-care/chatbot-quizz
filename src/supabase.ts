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

  try {
    await persistEngagementQuizDisplayName(input.targetGroupJid, input.creatorJid, input.creatorName);
  } catch (e) {
    console.warn("[engagement] quiz_display_name (criador):", (e as Error).message);
  }

  return { shortId };
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

export async function insertAnswer(input: AnswerInput): Promise<void> {
  const { data: question, error: findError } = await supabase
    .from("questions")
    .select("id, question_type, target_group_jid, group_jid")
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

  const gj = question.target_group_jid || question.group_jid;
  if (gj) {
    try {
      await persistEngagementQuizDisplayName(String(gj), input.userJid, input.userName);
    } catch (e) {
      console.warn("[engagement] quiz_display_name:", (e as Error).message);
    }
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
    .select("id, target_group_jid, group_jid")
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

  const gj = question.target_group_jid || question.group_jid;
  if (gj) {
    try {
      await persistEngagementQuizDisplayName(String(gj), input.userJid, input.userName);
    } catch (e) {
      console.warn("[engagement] quiz_display_name:", (e as Error).message);
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

export type GroupMemberEngagementRow = {
  userJid: string;
  userLabel: string | null;
  quizDisplayName: string | null;
  engaged: boolean;
  updatedAt: string | null;
};

export async function getQuestionCreatorAndGroup(
  shortId: string
): Promise<{ creatorJid: string; targetGroupJid: string } | null> {
  const id = shortId.toUpperCase();
  const { data, error } = await supabase
    .from("questions")
    .select("creator_jid, target_group_jid")
    .eq("short_id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao buscar criador da questao: ${error.message}`);
  }
  if (!data?.creator_jid || !data?.target_group_jid) return null;
  return {
    creatorJid: String(data.creator_jid),
    targetGroupJid: String(data.target_group_jid)
  };
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
  status: "inactive" | "active" | "paused_waiting_decision" | "finished";
  /** Modelo novo: total de questões enviadas por dia, espaçadas em 24h/N. */
  questionsPerDay: number;
  startHour: number;
  startMinute: number;
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
    status: String(row.status) as CadernoRow["status"],
    questionsPerDay: Number.isFinite(questionsPerDayRaw) ? questionsPerDayRaw : 3,
    startHour: Number.isFinite(startHourRaw) ? startHourRaw : 7,
    startMinute: Number.isFinite(startMinuteRaw) ? startMinuteRaw : 0,
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

const CADERNO_SELECT_COLUMNS =
  "id, name, target_group_jid, created_by_jid, status, questions_per_day, start_hour, start_minute, wait_for_answers, current_day_date, current_day_sent, questions_per_run, interval_days, send_hour, send_minute, timezone, cursor, random_order, last_run_at, next_run_at";

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

/** Cadernos prontos para envio: status=active e next_run_at <= now. */
export async function listCadernosDueForRun(): Promise<CadernoRow[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("cadernos")
    .select(CADERNO_SELECT_COLUMNS)
    .eq("status", "active")
    .lte("next_run_at", nowIso);

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("relation") && msg.includes("does not exist")) return [];
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

/**
 * Lê o próximo lote de questões a enviar. Critério: `published_question_id IS NULL`
 * (ainda não foi publicada). Em modo aleatório embaralha o lote; senão segue por
 * `position` crescente.
 *
 * Para random, lemos um buffer maior (`limit * 10`, capado em 200) e sorteamos
 * `limit` localmente. Isso evita ORDER BY random() no Postgres (caro em tabelas
 * grandes) sem precisar de função RPC.
 */
export async function listNextCadernoQuestionsToSend(
  cadernoId: number,
  limit: number,
  randomOrder: boolean
): Promise<CadernoQuestionRow[]> {
  const selectCols =
    "id, caderno_id, position, tec_question_id, tec_url, banca, subject, question_type, statement_text, answer_key";

  if (!randomOrder) {
    const { data, error } = await supabase
      .from("caderno_questions")
      .select(selectCols)
      .eq("caderno_id", cadernoId)
      .is("published_question_id", null)
      .order("position", { ascending: true })
      .limit(limit);

    if (error) throw new Error(`Erro ao listar questoes do caderno: ${error.message}`);
    return (data ?? []).map(mapCadernoQuestionRow);
  }

  const bufferSize = Math.min(200, Math.max(limit * 10, limit + 5));
  const { data, error } = await supabase
    .from("caderno_questions")
    .select(selectCols)
    .eq("caderno_id", cadernoId)
    .is("published_question_id", null)
    .order("position", { ascending: true })
    .limit(bufferSize);

  if (error) throw new Error(`Erro ao listar questoes do caderno: ${error.message}`);

  const rows = (data ?? []).map(mapCadernoQuestionRow);
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
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
 */
export async function listCadernoQuestionsPublishedOnDate(
  cadernoId: number,
  dayIso: string,
  timeZone: string
): Promise<{ publishedQuestionId: number; publishedAt: string }[]> {
  const { data, error } = await supabase
    .from("caderno_questions")
    .select("published_question_id, published_at")
    .eq("caderno_id", cadernoId)
    .not("published_question_id", "is", null);

  if (error) {
    throw new Error(`Erro ao listar publicações do dia: ${error.message}`);
  }

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

function formatDateInTimezone(d: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(d);
}

/** Lista IDs de quem respondeu (set por question_id). */
export async function listAnswersForQuestionIds(
  questionIds: number[]
): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>();
  if (questionIds.length === 0) return out;
  const { data, error } = await supabase
    .from("answers")
    .select("question_id, user_jid")
    .in("question_id", questionIds);

  if (error) throw new Error(`Erro ao listar respostas: ${error.message}`);

  for (const row of data ?? []) {
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
  return out;
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

export type CadernoQuestionPublishInput = {
  caderno: CadernoRow;
  question: CadernoQuestionRow;
};

/**
 * Cria uma linha em `questions` para uma questao do caderno, sem midia.
 * Retorna { shortId, dbId } — `shortId` e mostrado no grupo; `dbId` linka
 * a published_question_id na caderno_questions.
 */
export async function createQuestionFromCaderno(
  input: CadernoQuestionPublishInput
): Promise<{ shortId: string; dbId: number }> {
  const { caderno, question } = input;
  const creatorJid = `caderno:${caderno.id}@bot`;
  const creatorName = `Caderno: ${caderno.name}`;

  const explanationParts: string[] = [
    "Resolução completa no Tec Concursos:",
    question.tecUrl
  ];
  if (question.banca) explanationParts.push("", `Banca: ${question.banca}`);
  if (question.subject) explanationParts.push(`Matéria: ${question.subject}`);
  const explanationText = explanationParts.join("\n");

  const { data, error } = await supabase
    .from("questions")
    .insert({
      creator_jid: creatorJid,
      creator_name: creatorName,
      target_group_jid: caderno.targetGroupJid,
      question_type: question.questionType,
      statement_text: question.statementText,
      statement_media_url: null,
      statement_media_mime_type: null,
      answer_key: question.answerKey.toUpperCase(),
      explanation_text: explanationText,
      explanation_media_url: null,
      explanation_media_mime_type: null,
      group_jid: caderno.targetGroupJid,
      sender_jid: creatorJid,
      message_type: "text",
      text_content: question.statementText,
      media_mime_type: null,
      wa_message_id: `caderno-${caderno.id}-${question.id}-${Date.now()}`,
      sent_at: new Date().toISOString()
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Erro ao criar questao a partir de caderno: ${error?.message ?? "sem dados"}`);
  }

  const shortId = String(data.id).trim();

  const { error: updateError } = await supabase
    .from("questions")
    .update({ short_id: shortId })
    .eq("id", data.id);

  if (updateError) {
    throw new Error(`Erro ao atualizar short_id da questao do caderno: ${updateError.message}`);
  }

  return { shortId, dbId: Number(data.id) };
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
 *    **todos** os engajados do grupo (mesmo critério do auto-gabarito).
 *  - `withAnyAnswer`: das publicadas, quantas tiveram **pelo menos uma**
 *    resposta. Útil quando não há engajados configurados.
 *  - `engagedCount`: total de engajados no grupo (referência para o cálculo).
 */
export async function getCadernoProgress(cadernoId: number): Promise<CadernoProgress | null> {
  const caderno = await getCadernoById(cadernoId);
  if (!caderno) return null;

  const totalQuestions = await countCadernoQuestions(cadernoId);

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

  const engagedJids = await getEngagedUserJidsForGroup(caderno.targetGroupJid);
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

export async function listUnansweredShortIdsForUser(
  userJid: string,
  groupJid: string,
  limit = 25
): Promise<string[]> {
  const { data: questions, error: qErr } = await supabase
    .from("questions")
    .select("id, short_id")
    .eq("target_group_jid", groupJid)
    .order("created_at", { ascending: false })
    .limit(300);

  if (qErr) {
    throw new Error(`Erro ao listar questoes: ${qErr.message}`);
  }

  const { data: answered, error: aErr } = await supabase
    .from("answers")
    .select("question_id")
    .eq("user_jid", userJid);

  if (aErr) {
    throw new Error(`Erro ao listar respostas do usuario: ${aErr.message}`);
  }

  const answeredIds = new Set((answered ?? []).map((r) => r.question_id as number));
  const out: string[] = [];
  for (const q of questions ?? []) {
    if (!q.short_id) continue;
    if (answeredIds.has(q.id as number)) continue;
    out.push(String(q.short_id).toUpperCase());
    if (out.length >= limit) break;
  }
  return out;
}
