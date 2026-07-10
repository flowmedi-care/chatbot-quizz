-- Engajamento por caderno (escopo por caderno, não global no grupo).
-- Rode no SQL Editor do Supabase.

create table if not exists public.caderno_engagement (
  caderno_id bigint not null references public.cadernos(id) on delete cascade,
  user_jid text not null,
  user_label text,
  quiz_display_name text,
  engaged boolean not null default false,
  engaged_since timestamptz,
  updated_at timestamptz not null default now(),
  primary key (caderno_id, user_jid)
);

create index if not exists idx_caderno_engagement_caderno
  on public.caderno_engagement (caderno_id);

create index if not exists idx_caderno_engagement_engaged
  on public.caderno_engagement (caderno_id) where engaged = true;

comment on table public.caderno_engagement is
  'Engajados por caderno. Define quem conta no fechamento automatico do gabarito e wait_for_answers.';

-- Seed: copia engajados globais do grupo para cada caderno em modo group.
insert into public.caderno_engagement (
  caderno_id,
  user_jid,
  user_label,
  quiz_display_name,
  engaged,
  engaged_since,
  updated_at
)
select
  c.id,
  gme.user_jid,
  gme.user_label,
  gme.quiz_display_name,
  gme.engaged,
  gme.engaged_since,
  coalesce(gme.updated_at, now())
from public.cadernos c
inner join public.group_member_engagement gme
  on gme.group_jid = c.target_group_jid
  and gme.engaged = true
where coalesce(c.delivery_mode, 'group') = 'group'
on conflict (caderno_id, user_jid) do nothing;
