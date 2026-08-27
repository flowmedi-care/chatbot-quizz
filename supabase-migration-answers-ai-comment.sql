-- Comentário da IA (Via Aprovação), separado do comentário do aluno.
-- Rode no SQL Editor do Supabase.

alter table public.answers
  add column if not exists ai_comment text;

comment on column public.answers.ai_comment is
  'Resposta da IA à anotação do aluno (Via Aprovação). Distinto de answer_comment.';
