const AI_SEP = "— Comentário da IA —";
const AI_MISSING_HINT =
  "sem resposta — crédito da API esgotado ou Via Aprovação ainda não vinculada.";

function splitAnswerComments(row) {
  let raw = row && row.answer_comment != null ? String(row.answer_comment).trim() : "";
  let aiCol = row && row.ai_comment != null ? String(row.ai_comment).trim() : "";
  if (raw.includes(AI_SEP)) {
    const idx = raw.indexOf(AI_SEP);
    const fromBlob = raw.slice(idx + AI_SEP.length).trim();
    raw = raw.slice(0, idx).trim();
    if (!aiCol) aiCol = fromBlob;
  }
  return { comment: raw || null, aiComment: aiCol || null };
}

function truncateText(text, max) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function formatAiGroupMessage(input) {
  const userName = String(input.userName || "").trim();
  const ai = String(input.aiComment || "").trim();
  const who = (userName.split(/\s+/)[0] || "alguém").toLowerCase();
  const lines = [`---Resposta anotação ${who}---`];
  if (ai) lines.push(truncateText(ai, 1500));
  return lines.join("\n");
}

module.exports = {
  AI_SEP,
  AI_MISSING_HINT,
  splitAnswerComments,
  formatAiGroupMessage,
  truncateText
};
