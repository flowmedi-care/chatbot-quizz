-- Modo quiz por usuario no privado (/quiz persistente)
create table if not exists public.bot_user_quiz_mode (
  user_jid text primary key,
  quiz_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists idx_bot_user_quiz_mode_enabled on public.bot_user_quiz_mode(quiz_enabled);
