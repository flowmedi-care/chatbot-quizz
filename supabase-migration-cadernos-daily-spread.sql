-- =============================================================================
-- CADERNOS: envio espalhado pelo dia + toggle "esperar resposta"
-- =============================================================================
-- Mudanças vs. modelo antigo (1 envio em lote a cada N dias):
--   * cadernos.questions_per_day: total de questões no dia (1..24).
--   * cadernos.start_hour / start_minute: horário em que começa o ciclo do dia.
--     Os envios são distribuídos em intervalos de 24h / questions_per_day.
--       Ex.: 3 questões a partir das 07:00 ⇒ 07:00, 15:00, 23:00.
--   * cadernos.wait_for_answers: se true, só inicia um novo dia depois que todos
--     os engajados elegíveis tiverem respondido as questões do dia anterior.
--   * cadernos.current_day_date: data (no fuso do caderno) do dia em andamento.
--   * cadernos.current_day_sent: quantas das questões do dia já foram enviadas.
--
--   * group_member_engagement.engaged_since: timestamp em que o membro virou
--     engaged=true. Usado para ignorar engajados novos ao checar respostas do
--     dia anterior (alguém que entra agora não precisa responder histórico).
--
-- As colunas legadas (questions_per_run, send_hour, send_minute, interval_days,
-- cursor) ficam para histórico/compat mas deixam de ser usadas na nova lógica.
--
-- Rode no SQL Editor do Supabase. Idempotente (pode rodar várias vezes).
-- =============================================================================

alter table public.cadernos
  add column if not exists questions_per_day smallint check (questions_per_day between 1 and 24);

alter table public.cadernos
  add column if not exists start_hour smallint check (start_hour between 0 and 23);

alter table public.cadernos
  add column if not exists start_minute smallint check (start_minute between 0 and 59);

alter table public.cadernos
  add column if not exists wait_for_answers boolean not null default false;

alter table public.cadernos
  add column if not exists current_day_date date;

alter table public.cadernos
  add column if not exists current_day_sent smallint not null default 0;

-- Backfill a partir das colunas legadas.
update public.cadernos
set
  questions_per_day = coalesce(questions_per_day, questions_per_run, 3),
  start_hour = coalesce(start_hour, send_hour, 7),
  start_minute = coalesce(start_minute, send_minute, 0)
where questions_per_day is null or start_hour is null or start_minute is null;

alter table public.cadernos
  alter column questions_per_day set default 3,
  alter column start_hour set default 7,
  alter column start_minute set default 0;

alter table public.cadernos
  alter column questions_per_day set not null,
  alter column start_hour set not null,
  alter column start_minute set not null;

-- Engajamento: marcar quando virou engaged=true.
alter table public.group_member_engagement
  add column if not exists engaged_since timestamptz;

update public.group_member_engagement
set engaged_since = coalesce(engaged_since, updated_at, now())
where engaged = true and engaged_since is null;
