-- Fila reservada de envios do caderno (adiantar X + ordem aleatória estável).
-- Rode no SQL Editor do Supabase.

create table if not exists public.caderno_send_queue (
  id bigint generated always as identity primary key,
  caderno_id bigint not null references public.cadernos(id) on delete cascade,
  caderno_question_id bigint not null references public.caderno_questions(id) on delete cascade,
  planned_day_iso text not null,
  slot_index integer not null default 0,
  published_question_id bigint,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique (caderno_id, caderno_question_id),
  unique (caderno_id, planned_day_iso, slot_index)
);

create index if not exists idx_caderno_send_queue_caderno_day
  on public.caderno_send_queue (caderno_id, planned_day_iso, slot_index);

create index if not exists idx_caderno_send_queue_unreleased
  on public.caderno_send_queue (caderno_id) where released_at is null;

comment on table public.caderno_send_queue is
  'Reserva questões para dias/slots futuros (comando adiantar). Scheduler prioriza esta fila.';
