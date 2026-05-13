-- =============================================================================
-- CADERNOS: envio em grupo vs. privado (1:1 no WhatsApp)
-- =============================================================================
-- delivery_mode:
--   'group'  — igual ao comportamento atual (publica no target_group_jid).
--   'private' — questões vão no privado de cada destinatário; métricas do
--               grupo não são usadas (target da questão = JID do usuário).
--
-- caderno_private_recipients: quem recebe no privado + agenda própria
--   (questions_per_day, start_hour, etc.; null = herdar do caderno na app).
--
-- caderno_private_send: rastreia qual questão do PDF cada destinatário já
--   recebeu (o mesmo PDF pode ir para vários sem compartilhar published_question_id
--   em caderno_questions, usado só no modo grupo).
--
-- Rode no SQL Editor do Supabase (idempotente).
-- =============================================================================

alter table public.cadernos
  add column if not exists delivery_mode text not null default 'group'
    check (delivery_mode in ('group', 'private'));

create table if not exists public.caderno_private_recipients (
  id bigint generated always as identity primary key,
  caderno_id bigint not null references public.cadernos(id) on delete cascade,
  user_jid text not null,
  active boolean not null default true,
  questions_per_day smallint check (questions_per_day between 1 and 24),
  start_hour smallint check (start_hour between 0 and 23),
  start_minute smallint check (start_minute between 0 and 59),
  wait_for_answers boolean,
  random_order boolean,
  timezone text,
  current_day_date date,
  current_day_sent smallint not null default 0,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  unique (caderno_id, user_jid)
);

create index if not exists idx_caderno_priv_rec_next
  on public.caderno_private_recipients (caderno_id)
  where active = true and next_run_at is not null;

create table if not exists public.caderno_private_send (
  id bigint generated always as identity primary key,
  caderno_id bigint not null references public.cadernos(id) on delete cascade,
  recipient_jid text not null,
  caderno_question_id bigint not null references public.caderno_questions(id) on delete cascade,
  published_question_id bigint references public.questions(id) on delete set null,
  published_at timestamptz,
  unique (caderno_id, recipient_jid, caderno_question_id)
);

create index if not exists idx_caderno_priv_send_lookup
  on public.caderno_private_send (caderno_id, recipient_jid);
