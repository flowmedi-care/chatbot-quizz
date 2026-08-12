-- Discussões de questões (WhatsApp replies + feed do site).
-- Rode no SQL Editor do Supabase.

create table if not exists public.question_wa_messages (
  id bigserial primary key,
  question_id bigint not null references public.questions (id) on delete cascade,
  short_id text not null,
  group_jid text not null,
  wa_message_id text not null,
  role text not null check (role in ('statement', 'result', 'explanation_media')),
  created_at timestamptz not null default now(),
  unique (group_jid, wa_message_id)
);

create index if not exists question_wa_messages_question_id_idx
  on public.question_wa_messages (question_id);

create index if not exists question_wa_messages_wa_message_id_idx
  on public.question_wa_messages (wa_message_id);

create table if not exists public.discussion_posts (
  id bigserial primary key,
  question_id bigint not null unique references public.questions (id) on delete cascade,
  short_id text not null,
  group_jid text not null,
  source text not null check (source in ('auto_gabarito', 'gabarito')),
  created_at timestamptz not null default now()
);

create index if not exists discussion_posts_created_at_idx
  on public.discussion_posts (created_at desc);

create index if not exists discussion_posts_short_id_idx
  on public.discussion_posts (short_id);

create table if not exists public.discussion_comments (
  id bigserial primary key,
  post_id bigint not null references public.discussion_posts (id) on delete cascade,
  parent_id bigint references public.discussion_comments (id) on delete cascade,
  author_jid text not null,
  author_name text,
  body text not null,
  source text not null check (source in ('whatsapp', 'web')),
  wa_message_id text,
  shared_to_wa_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists discussion_comments_post_id_idx
  on public.discussion_comments (post_id, created_at);

create index if not exists discussion_comments_parent_id_idx
  on public.discussion_comments (parent_id);

create unique index if not exists discussion_comments_wa_message_id_uidx
  on public.discussion_comments (wa_message_id)
  where wa_message_id is not null;

comment on table public.question_wa_messages is
  'IDs das mensagens WhatsApp do bot (enunciado/resultado) para amarrar replies à questão.';
comment on table public.discussion_posts is
  'Card de discussão no feed — um por questão após auto-gabarito ou /gabarito.';
comment on table public.discussion_comments is
  'Comentários aninhados (WhatsApp reply ou site).';
