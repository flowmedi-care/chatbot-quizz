-- Complementar: acelera bulk reads de publicações por caderno.
-- A otimização principal é reduzir round-trips (camada de leitura), não este índice.
CREATE INDEX IF NOT EXISTS idx_caderno_questions_caderno_published_at
  ON caderno_questions (caderno_id, published_at)
  WHERE published_question_id IS NOT NULL;
