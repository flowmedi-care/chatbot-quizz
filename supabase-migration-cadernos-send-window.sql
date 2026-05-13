-- Janela de envio: horário final do dia (as questões ficam entre início e fim).
-- Modo grupo: colunas em `cadernos`. Modo privado: override opcional por destinatário.

alter table public.cadernos
  add column if not exists end_hour smallint check (end_hour between 0 and 23),
  add column if not exists end_minute smallint check (end_minute between 0 and 59);

update public.cadernos
set end_hour = coalesce(end_hour, 22),
    end_minute = coalesce(end_minute, 0)
where end_hour is null or end_minute is null;

alter table public.caderno_private_recipients
  add column if not exists end_hour smallint check (end_hour between 0 and 23),
  add column if not exists end_minute smallint check (end_minute between 0 and 59);
