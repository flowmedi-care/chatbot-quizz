-- =============================================================================
-- CADERNOS: upload de PDF Tec Concursos + envio agendado no grupo
-- =============================================================================
-- Cria duas tabelas:
--   - cadernos: configuração e agenda de cada cadernão (nome, grupo, horário,
--     intervalo, status, cursor de progresso).
--   - caderno_questions: questões já extraídas do PDF, em ordem (position).
--     Ao publicar, marca published_question_id apontando para a linha criada
--     em public.questions, mantendo o vínculo com respostas/ranking.
--
-- Rode no SQL Editor do Supabase. Compatível com schema atual; não altera
-- tabelas existentes (questions, answers, group_member_engagement, etc.).
-- =============================================================================

create table if not exists public.cadernos (
  id bigint generated always as identity primary key,
  name text not null,
  target_group_jid text not null,
  created_by_jid text,
  created_at timestamptz not null default now(),
  -- Modelo novo (envio distribuído ao longo do dia):
  questions_per_day smallint not null default 3 check (questions_per_day between 1 and 24),
  start_hour smallint not null default 7 check (start_hour between 0 and 23),
  start_minute smallint not null default 0 check (start_minute between 0 and 59),
  wait_for_answers boolean not null default false,
  current_day_date date,
  current_day_sent smallint not null default 0,
  -- Colunas legadas (modelo anterior em lote). Mantidas para compatibilidade;
  -- a lógica nova ignora.
  questions_per_run smallint not null default 3 check (questions_per_run between 1 and 20),
  interval_days smallint not null default 2 check (interval_days between 1 and 30),
  send_hour smallint not null default 9 check (send_hour between 0 and 23),
  send_minute smallint not null default 0 check (send_minute between 0 and 59),
  timezone text not null default 'America/Sao_Paulo',
  status text not null default 'inactive'
    check (status in ('inactive', 'active', 'paused_waiting_decision', 'finished')),
  cursor integer not null default 0,
  random_order boolean not null default false,
  last_run_at timestamptz,
  next_run_at timestamptz,
  delivery_mode text not null default 'group'
    check (delivery_mode in ('group', 'private'))
);

create table if not exists public.caderno_questions (
  id bigint generated always as identity primary key,
  caderno_id bigint not null references public.cadernos(id) on delete cascade,
  position integer not null,
  tec_question_id text,
  tec_url text not null,
  banca text,
  subject text,
  question_type text not null check (question_type in ('multiple_choice', 'true_false')),
  statement_text text not null,
  answer_key text not null check (answer_key in ('A', 'B', 'C', 'D', 'E')),
  published_question_id bigint references public.questions(id) on delete set null,
  published_at timestamptz,
  unique (caderno_id, position)
);

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

create index if not exists idx_cadernos_status_next on public.cadernos(status, next_run_at);
create index if not exists idx_cadernos_target_group on public.cadernos(target_group_jid);
create index if not exists idx_caderno_questions_caderno on public.caderno_questions(caderno_id, position);
