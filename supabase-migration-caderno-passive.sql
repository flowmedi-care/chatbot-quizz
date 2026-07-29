-- Participantes passivos por caderno (recebem omissas só do dia; não bloqueiam ritmo).
-- Rode no SQL Editor do Supabase.

alter table public.caderno_engagement
  add column if not exists passive boolean not null default false;

comment on column public.caderno_engagement.passive is
  'Passivo: recebe /omissas só das questões do dia deste caderno; não conta no wait_for_answers nem auto-gabarito.';

-- Engajado e passivo são mutuamente exclusivos.
update public.caderno_engagement
set passive = false
where engaged = true and passive = true;
