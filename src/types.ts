export type QuestionType = "multiple_choice" | "true_false";

export type MediaPayload = {
  data: Buffer;
  mimeType: string;
  fileExt: string;
};

export type QuestionDraft = {
  creatorJid: string;
  creatorName: string;
  questionType: QuestionType;
  materiaId: number | null;
  statementText: string | null;
  statementMedia: MediaPayload | null;
  answerKey: string;
  explanationText: string | null;
  explanationMedia: MediaPayload | null;
};

export type CreateQuestionInput = {
  creatorJid: string;
  creatorName: string;
  questionType: QuestionType;
  materiaId?: number | null;
  statementText: string | null;
  statementMedia: MediaPayload | null;
  answerKey: string;
  explanationText: string | null;
  explanationMedia: MediaPayload | null;
  targetGroupJid: string;
};

export type AnswerInput = {
  questionShortId: string;
  userJid: string;
  userName: string;
  answerLetter: string;
  answerComment?: string | null;
  sentAt: string;
  sourceMessageId: string;
  confidenceLevel?: "seguro" | "inseguro" | "chute" | null;
  durationMs?: number | null;
  syncSource?: "whatsapp" | "app" | "web" | null;
};
