-- Digest diário "bom dia" no grupo (uma mensagem por dia por grupo).
-- Rode no SQL Editor do Supabase.

create table if not exists public.group_daily_digest (
  group_jid text not null,
  day_iso text not null,
  sent_at timestamptz not null default now(),
  primary key (group_jid, day_iso)
);

comment on table public.group_daily_digest is
  'Controla envio único do digest diário (bom dia) por grupo e data civil YYYY-MM-DD.';
