-- Categorias pessoais do usuário, ligadas ao registro de resposta (answers).
-- Rode no SQL Editor do Supabase.

create table if not exists public.user_categories (
  id bigint generated always as identity primary key,
  user_jid text not null,
  name text not null,
  name_normalized text not null,
  created_at timestamptz not null default now(),
  unique (user_jid, name_normalized)
);

create index if not exists user_categories_user_jid_idx
  on public.user_categories (user_jid);

comment on table public.user_categories is
  'Categorias pessoais por usuário (WhatsApp JID). Cada usuário tem seu próprio catálogo.';

create table if not exists public.answer_categories (
  answer_id bigint not null references public.answers (id) on delete cascade,
  category_id bigint not null references public.user_categories (id) on delete cascade,
  primary key (answer_id, category_id)
);

create index if not exists answer_categories_category_id_idx
  on public.answer_categories (category_id);

comment on table public.answer_categories is
  'N:N entre answers e user_categories — tags da resposta daquele usuário.';
