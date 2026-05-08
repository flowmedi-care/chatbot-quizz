create table if not exists public.questions (
  id bigint generated always as identity primary key,
  short_id text unique,
  creator_jid text not null,
  creator_name text not null,
  target_group_jid text not null,
  question_type text not null check (question_type in ('multiple_choice', 'true_false')),
  statement_text text,
  statement_media_url text,
  statement_media_mime_type text,
  answer_key text not null check (answer_key in ('A', 'B', 'C', 'D', 'E')),
  explanation_text text,
  explanation_media_url text,
  explanation_media_mime_type text,
  created_at timestamptz not null default now()
);

create index if not exists idx_questions_short_id on public.questions(short_id);
create index if not exists idx_questions_target_group_jid on public.questions(target_group_jid);

create table if not exists public.answers (
  id bigint generated always as identity primary key,
  question_id bigint not null references public.questions(id) on delete cascade,
  question_short_id text not null,
  user_jid text not null,
  user_name text not null,
  answer_letter text not null check (answer_letter in ('a', 'b', 'c', 'd', 'e')),
  source_message_id text not null,
  sent_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (question_id, user_jid)
);

create index if not exists idx_answers_question_short_id on public.answers(question_short_id);
create index if not exists idx_answers_question_id on public.answers(question_id);
create index if not exists idx_answers_user_jid on public.answers(user_jid);

create table if not exists public.bot_user_quiz_mode (
  user_jid text primary key,
  quiz_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists idx_bot_user_quiz_mode_enabled on public.bot_user_quiz_mode(quiz_enabled);
