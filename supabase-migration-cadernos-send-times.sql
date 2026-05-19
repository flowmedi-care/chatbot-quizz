-- Horários explícitos por questão do dia (JSON array de {hour, minute}).
-- Se preenchido com N itens (= questions_per_day), o agendador usa esses horários
-- em vez de distribuir uniformemente entre início e fim.

alter table public.cadernos
  add column if not exists send_times jsonb;

alter table public.caderno_private_recipients
  add column if not exists send_times jsonb;

comment on column public.cadernos.send_times is
  'Array JSON: [{"hour":7,"minute":0},...] — um horário por questão/dia; length = questions_per_day';

comment on column public.caderno_private_recipients.send_times is
  'Override opcional por destinatário; null herda do caderno';
