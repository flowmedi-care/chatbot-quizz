-- =============================================================================
-- Remove respostas em que o usuário respondeu a própria questão (distorce Q&A/ranking)
--
-- 1) Rode o relatório (SELECT).
-- 2) Rode o DELETE.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.quiz_jid_compare_key(jid text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jid IS NULL OR trim(jid) = '' THEN ''
    WHEN strpos(jid, '@') > 0 THEN lower(
      CASE
        WHEN strpos(split_part(jid, '@', 1), ':') > 0 THEN split_part(split_part(jid, '@', 1), ':', 1)
        ELSE split_part(jid, '@', 1)
      END || '@' || lower(split_part(jid, '@', 2))
    )
    ELSE lower(trim(jid))
  END;
$$;

-- Relatório
SELECT
  COUNT(*) AS respostas_propria_questao,
  COUNT(DISTINCT a.user_jid) AS participantes_afetados,
  COUNT(DISTINCT a.question_id) AS questoes_afetadas
FROM public.answers a
INNER JOIN public.questions q ON q.id = a.question_id
WHERE q.creator_jid IS NOT NULL
  AND q.creator_jid NOT LIKE 'caderno:%'
  AND public.quiz_jid_compare_key(a.user_jid) = public.quiz_jid_compare_key(q.creator_jid);

SELECT
  a.id AS answer_id,
  q.short_id,
  q.creator_jid,
  a.user_jid,
  a.answer_letter,
  a.sent_at
FROM public.answers a
INNER JOIN public.questions q ON q.id = a.question_id
WHERE q.creator_jid IS NOT NULL
  AND q.creator_jid NOT LIKE 'caderno:%'
  AND public.quiz_jid_compare_key(a.user_jid) = public.quiz_jid_compare_key(q.creator_jid)
ORDER BY a.sent_at DESC
LIMIT 100;

-- Limpeza
DELETE FROM public.answers a
USING public.questions q
WHERE a.question_id = q.id
  AND q.creator_jid IS NOT NULL
  AND q.creator_jid NOT LIKE 'caderno:%'
  AND public.quiz_jid_compare_key(a.user_jid) = public.quiz_jid_compare_key(q.creator_jid);

-- Opcional: remover a função auxiliar se não quiser deixar no schema
-- DROP FUNCTION IF EXISTS public.quiz_jid_compare_key(text);
