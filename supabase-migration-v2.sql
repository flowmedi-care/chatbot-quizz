-- Migration incremental do schema antigo -> novo fluxo wizard
-- Pode rodar com tabelas ja existentes.

-- 1) QUESTIONS: adiciona novas colunas
alter table public.questions add column if not exists creator_jid text;
alter table public.questions add column if not exists creator_name text;
alter table public.questions add column if not exists target_group_jid text;
alter table public.questions add column if not exists question_type text;
alter table public.questions add column if not exists statement_text text;
alter table public.questions add column if not exists statement_media_url text;
alter table public.questions add column if not exists statement_media_mime_type text;
alter table public.questions add column if not exists answer_key text;
alter table public.questions add column if not exists explanation_text text;
alter table public.questions add column if not exists explanation_media_url text;
alter table public.questions add column if not exists explanation_media_mime_type text;

-- 2) Migra dados antigos para novos campos (best effort)
update public.questions
set
  creator_jid = coalesce(creator_jid, sender_jid, 'desconhecido'),
  creator_name = coalesce(creator_name, split_part(coalesce(sender_jid, 'desconhecido'), '@', 1)),
  target_group_jid = coalesce(target_group_jid, group_jid, 'grupo_nao_informado'),
  question_type = coalesce(question_type, 'multiple_choice'),
  statement_text = coalesce(statement_text, text_content),
  statement_media_mime_type = coalesce(statement_media_mime_type, media_mime_type),
  answer_key = coalesce(answer_key, 'A')
where
  creator_jid is null
  or creator_name is null
  or target_group_jid is null
  or question_type is null
  or answer_key is null;

-- 3) Ajusta constraints de question_type e answer_key
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'questions_question_type_check'
  ) then
    alter table public.questions
      add constraint questions_question_type_check
      check (question_type in ('multiple_choice', 'true_false'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'questions_answer_key_check'
  ) then
    alter table public.questions
      add constraint questions_answer_key_check
      check (answer_key in ('A', 'B', 'C', 'D', 'E'));
  end if;
end $$;

-- 4) Define NOT NULL nas colunas novas apos backfill
alter table public.questions alter column creator_jid set not null;
alter table public.questions alter column creator_name set not null;
alter table public.questions alter column target_group_jid set not null;
alter table public.questions alter column question_type set not null;
alter table public.questions alter column answer_key set not null;

-- 5) ANSWERS: adiciona user_name e unique(question_id, user_jid)
alter table public.answers add column if not exists user_name text;

update public.answers
set user_name = coalesce(user_name, split_part(user_jid, '@', 1), 'usuario')
where user_name is null;

alter table public.answers alter column user_name set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'answers_question_id_user_jid_key'
  ) then
    alter table public.answers
      add constraint answers_question_id_user_jid_key unique (question_id, user_jid);
  end if;
end $$;

-- 6) Indices novos
create index if not exists idx_questions_target_group_jid on public.questions(target_group_jid);
create index if not exists idx_answers_question_short_id on public.answers(question_short_id);
create index if not exists idx_answers_question_id on public.answers(question_id);
create index if not exists idx_answers_user_jid on public.answers(user_jid);
