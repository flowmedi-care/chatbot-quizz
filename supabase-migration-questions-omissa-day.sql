-- Dia civil em que a questão conta como omissa (corte 15h America/Sao_Paulo).
-- Null = fallback para published_at / created_at (comportamento legado).
-- Rode no SQL Editor do Supabase.

alter table public.questions
  add column if not exists omissa_day_iso text;

comment on column public.questions.omissa_day_iso is
  'YYYY-MM-DD (ECONOMY_TZ) em que a questão entra em /omissas do dia; null = usar created_at/published_at.';

create index if not exists questions_omissa_day_iso_idx
  on public.questions (omissa_day_iso)
  where omissa_day_iso is not null;
