-- Espelho com o app de estudo: opções estruturadas, origem do caderno, confiança/duração.

alter table public.cadernos
  add column if not exists origin_notebook_id uuid;

comment on column public.cadernos.origin_notebook_id is
  'UUID do caderno no app de estudo (app-vercel-next) quando importado via API.';

alter table public.caderno_questions
  add column if not exists options jsonb not null default '[]'::jsonb;

comment on column public.caderno_questions.options is
  'Alternativas [{label, text}]. Vazio em PDF legado; preenchido na importação JSON.';

alter table public.questions
  add column if not exists options jsonb;

alter table public.answers
  add column if not exists confidence_level text
    check (confidence_level is null or confidence_level in ('seguro', 'inseguro', 'chute')),
  add column if not exists duration_ms integer,
  add column if not exists sync_source text
    check (sync_source is null or sync_source in ('whatsapp', 'app', 'web'));

create index if not exists idx_cadernos_origin_notebook
  on public.cadernos (origin_notebook_id)
  where origin_notebook_id is not null;

create index if not exists idx_caderno_questions_tec
  on public.caderno_questions (tec_question_id);
