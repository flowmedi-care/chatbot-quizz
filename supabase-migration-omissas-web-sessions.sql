-- Sessões pessoais de omissas no site + fila de efeitos para o bot WhatsApp.
-- Rode no SQL Editor do Supabase.

create table if not exists public.omissas_web_sessions (
  token text primary key,
  user_jid text not null,
  user_name text,
  group_jid text not null,
  mode text not null check (mode in ('hoje', 'atrasadas', 'adiantar')),
  short_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz
);

create index if not exists omissas_web_sessions_user_jid_idx
  on public.omissas_web_sessions (user_jid);

create index if not exists omissas_web_sessions_expires_at_idx
  on public.omissas_web_sessions (expires_at);

comment on table public.omissas_web_sessions is
  'Link pessoal /omissas?t=TOKEN: lista de short_ids congelada por usuário.';

create table if not exists public.bot_pending_events (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists bot_pending_events_pending_idx
  on public.bot_pending_events (created_at)
  where processed_at is null;

comment on table public.bot_pending_events is
  'Eventos do site (ex.: web_answer) para o bot aplicar economia / anúncios / wake de caderno.';
