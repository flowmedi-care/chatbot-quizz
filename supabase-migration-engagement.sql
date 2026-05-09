-- Membros do grupo WhatsApp + flag de engajamento (auto-gabarito quando todos os engajados exceto o criador responderem).
-- Rode no SQL Editor do Supabase apos as migracoes anteriores.

create table if not exists public.group_member_engagement (
  group_jid text not null,
  user_jid text not null,
  user_label text,
  engaged boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (group_jid, user_jid)
);

create index if not exists idx_group_member_engagement_group on public.group_member_engagement (group_jid);
create index if not exists idx_group_member_engagement_engaged on public.group_member_engagement (group_jid) where engaged = true;

comment on table public.group_member_engagement is 'Sincronizado pelo bot (/sync-membros). engaged=true entra no fechamento automatico do gabarito (exceto o criador da questao).';
