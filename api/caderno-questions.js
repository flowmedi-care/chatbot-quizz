const { getClient, applyCors } = require("./_lib.js");

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const cadernoId = Number((req.query && req.query.cadernoId) || 0);
  if (!Number.isFinite(cadernoId) || cadernoId <= 0) {
    return res.status(400).json({ error: "Informe cadernoId" });
  }

  const offset = Math.max(0, Number((req.query && req.query.offset) || 0));
  const limitRaw = Number((req.query && req.query.limit) || 20);
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 20));

  try {
    const supabase = getClient();

    const { data: caderno, error: cErr } = await supabase
      .from("cadernos")
      .select("id, name, target_group_jid, status, cursor")
      .eq("id", cadernoId)
      .maybeSingle();

    if (cErr) throw cErr;
    if (!caderno) return res.status(404).json({ error: "Caderno nao encontrado" });

    const { data: questions, error: qErr } = await supabase
      .from("caderno_questions")
      .select(
        "id, position, tec_question_id, tec_url, banca, subject, question_type, statement_text, answer_key, published_question_id, published_at"
      )
      .eq("caderno_id", cadernoId)
      .order("position", { ascending: true })
      .range(offset, offset + limit - 1);

    if (qErr) throw qErr;

    const { count, error: countErr } = await supabase
      .from("caderno_questions")
      .select("id", { count: "exact", head: true })
      .eq("caderno_id", cadernoId);

    if (countErr) throw countErr;

    return res.status(200).json({
      caderno: {
        id: caderno.id,
        name: caderno.name,
        targetGroupJid: caderno.target_group_jid,
        status: caderno.status,
        cursor: caderno.cursor,
        totalQuestions: count || 0
      },
      offset,
      limit,
      questions: (questions || []).map((q) => ({
        id: q.id,
        position: q.position,
        tecQuestionId: q.tec_question_id,
        tecUrl: q.tec_url,
        banca: q.banca,
        subject: q.subject,
        questionType: q.question_type,
        statementText: q.statement_text,
        answerKey: q.answer_key,
        publishedQuestionId: q.published_question_id,
        publishedAt: q.published_at
      }))
    });
  } catch (e) {
    console.error("[caderno-questions]", e);
    return res.status(500).json({ error: e.message || "Erro ao listar questoes" });
  }
};
