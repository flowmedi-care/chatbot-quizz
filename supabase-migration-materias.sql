-- Matérias + engajados por matéria (questões manuais / nova questao).
-- Rode no SQL Editor do Supabase.

create table if not exists public.materias (
  id bigserial primary key,
  group_jid text not null,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_materias_group
  on public.materias (group_jid, sort_order, id);

comment on table public.materias is
  'Catálogo de matérias do grupo para questões manuais (nova questao) e engajamento por matéria.';

create table if not exists public.materia_engagement (
  materia_id bigint not null references public.materias(id) on delete cascade,
  user_jid text not null,
  user_label text,
  quiz_display_name text,
  engaged boolean not null default false,
  engaged_since timestamptz,
  updated_at timestamptz not null default now(),
  primary key (materia_id, user_jid)
);

create index if not exists idx_materia_engagement_materia
  on public.materia_engagement (materia_id);

create index if not exists idx_materia_engagement_engaged
  on public.materia_engagement (materia_id) where engaged = true;

comment on table public.materia_engagement is
  'Engajados por matéria. Define quem conta no fechamento automático do gabarito de questões manuais.';

alter table public.questions
  add column if not exists materia_id bigint references public.materias(id) on delete set null;

create index if not exists idx_questions_materia_id
  on public.questions (materia_id)
  where materia_id is not null;
