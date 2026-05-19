-- =============================================================================
-- Caderno: questões órfãs em `questions` (criadas no DB, nunca publicadas no grupo)
--
-- Causa típica: falha no WhatsApp após INSERT em questions; retry criava outra linha.
-- `/progresso` conta só `caderno_questions.published_question_id` (correto).
-- `/q&a` antigo contava todo `creator_jid` caderno:* (inflava o número).
--
-- Rode cada bloco no SQL Editor do Supabase (na ordem).
-- =============================================================================

-- 1) Totais
WITH published AS (
  SELECT DISTINCT cq.published_question_id AS question_id
  FROM public.caderno_questions cq
  INNER JOIN public.cadernos c ON c.id = cq.caderno_id
  WHERE cq.published_question_id IS NOT NULL
    AND c.delivery_mode = 'group'
),
orphans AS (
  SELECT
    q.id,
    q.short_id,
    q.creator_jid,
    q.created_at,
    (SELECT COUNT(*)::int FROM public.answers a WHERE a.question_id = q.id) AS answer_count
  FROM public.questions q
  WHERE q.creator_jid LIKE 'caderno:%@bot'
    AND q.target_group_jid LIKE '%@g.us'
    AND q.id NOT IN (SELECT question_id FROM published)
)
SELECT
  COUNT(*) AS orphan_total,
  COUNT(*) FILTER (WHERE answer_count = 0) AS orphan_sem_resposta,
  COUNT(*) FILTER (WHERE answer_count > 0) AS orphan_com_resposta
FROM orphans;

-- 2) Por caderno (ex.: caderno:1@bot → 14 publicadas vs ~62 órfãs)
WITH published AS (
  SELECT DISTINCT cq.published_question_id AS question_id
  FROM public.caderno_questions cq
  INNER JOIN public.cadernos c ON c.id = cq.caderno_id
  WHERE cq.published_question_id IS NOT NULL
    AND c.delivery_mode = 'group'
),
orphans AS (
  SELECT
    q.creator_jid,
    (SELECT COUNT(*)::int FROM public.answers a WHERE a.question_id = q.id) AS answer_count
  FROM public.questions q
  WHERE q.creator_jid LIKE 'caderno:%@bot'
    AND q.target_group_jid LIKE '%@g.us'
    AND q.id NOT IN (SELECT question_id FROM published)
)
SELECT
  o.creator_jid,
  COUNT(*) AS orphans,
  COUNT(*) FILTER (WHERE o.answer_count = 0) AS sem_resposta
FROM orphans o
GROUP BY o.creator_jid
ORDER BY o.creator_jid;

-- 3) Amostra das órfãs sem resposta (provável origem das /omissas fantasmas)
WITH published AS (
  SELECT DISTINCT cq.published_question_id AS question_id
  FROM public.caderno_questions cq
  INNER JOIN public.cadernos c ON c.id = cq.caderno_id
  WHERE cq.published_question_id IS NOT NULL
    AND c.delivery_mode = 'group'
)
SELECT q.id, q.short_id, q.creator_jid, q.created_at
FROM public.questions q
WHERE q.creator_jid LIKE 'caderno:%@bot'
  AND q.target_group_jid LIKE '%@g.us'
  AND q.id NOT IN (SELECT question_id FROM published)
  AND NOT EXISTS (SELECT 1 FROM public.answers a WHERE a.question_id = q.id)
ORDER BY q.id
LIMIT 200;

-- 4) Limpeza: remove órfãs de grupo sem respostas
DELETE FROM public.questions q
WHERE q.creator_jid LIKE 'caderno:%@bot'
  AND q.target_group_jid LIKE '%@g.us'
  AND q.id NOT IN (
    SELECT cq.published_question_id
    FROM public.caderno_questions cq
    WHERE cq.published_question_id IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.answers a WHERE a.question_id = q.id
  );
