export const AI_COMMENT_SEP = "— Comentário da IA —";

export const AI_MISSING_HINT =
  "sem resposta — crédito da API esgotado ou Via Aprovação ainda não vinculada.";

export function splitAnswerComments(row: {
  answer_comment?: string | null;
  ai_comment?: string | null;
}): { comment: string | null; aiComment: string | null } {
  let raw = row.answer_comment != null ? String(row.answer_comment).trim() : "";
  let aiCol = row.ai_comment != null ? String(row.ai_comment).trim() : "";
  if (raw.includes(AI_COMMENT_SEP)) {
    const idx = raw.indexOf(AI_COMMENT_SEP);
    const fromBlob = raw.slice(idx + AI_COMMENT_SEP.length).trim();
    raw = raw.slice(0, idx).trim();
    if (!aiCol) aiCol = fromBlob;
  }
  return { comment: raw || null, aiComment: aiCol || null };
}

function truncateText(text: string, max: number): string {
  const s = text.trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function formatAiGroupMessage(input: {
  shortId: string;
  userName?: string | null;
  studentComment?: string | null;
  aiComment: string;
}): string {
  const shortId = String(input.shortId || "").toUpperCase();
  const userName = String(input.userName || "").trim();
  const student = String(input.studentComment || "").trim();
  const ai = String(input.aiComment || "").trim();
  const who = userName || "alguém";
  const lines = [`*IA — resposta à anotação de ${who} (#${shortId})*`];
  if (student) lines.push(`Anotação: "${truncateText(student, 400)}"`);
  if (ai) {
    lines.push("");
    lines.push(truncateText(ai, 1500));
  }
  return lines.join("\n");
}
