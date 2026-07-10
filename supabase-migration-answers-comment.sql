-- Comentário opcional na resposta do usuário (via WhatsApp).
-- Rode no SQL Editor do Supabase.

alter table public.answers
  add column if not exists answer_comment text;

comment on column public.answers.answer_comment is
  'Comentário opcional do respondente explicando a escolha (ex.: prazo decadencial).';
