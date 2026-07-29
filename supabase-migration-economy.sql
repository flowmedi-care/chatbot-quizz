-- Gamificação Papa Vagas: Aura, Créditos Orçamentários, loja, mandados, aplicação, diário

create table if not exists public.user_economy (
  user_jid text primary key,
  aura integer not null default 0,
  credits integer not null default 0,
  credits_escrowed integer not null default 0,
  lifetime_answers integer not null default 0,
  mandados_won integer not null default 0,
  active_title text,
  display_name text,
  updated_at timestamptz not null default now()
);

create table if not exists public.economy_ledger (
  id bigserial primary key,
  user_jid text not null,
  delta_aura integer not null default 0,
  delta_credits integer not null default 0,
  reason text not null,
  ref_type text,
  ref_id text,
  day_iso text,
  meta jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists economy_ledger_user_reason_ref_uidx
  on public.economy_ledger (user_jid, reason, ref_id)
  where ref_id is not null;

create index if not exists economy_ledger_day_idx on public.economy_ledger (day_iso, created_at desc);
create index if not exists economy_ledger_user_created_idx on public.economy_ledger (user_jid, created_at desc);

create table if not exists public.user_streak (
  user_jid text primary key,
  current_streak integer not null default 0,
  best_streak integer not null default 0,
  last_completed_day text,
  miss_streak integer not null default 0,
  abandon_penalty_applied boolean not null default false,
  streak_insurance_charges integer not null default 0,
  prepaid_days text[] not null default '{}',
  milestones_claimed integer[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists public.user_achievements (
  user_jid text not null,
  achievement_key text not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_jid, achievement_key)
);

create table if not exists public.shop_catalog (
  item_key text primary key,
  name text not null,
  category text not null,
  price_credits integer not null,
  min_aura integer not null default 0,
  consumable boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  active boolean not null default true
);

create table if not exists public.user_inventory (
  user_jid text not null,
  item_key text not null references public.shop_catalog(item_key),
  qty integer not null default 1,
  equipped boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_jid, item_key)
);

create table if not exists public.purchase_confirmations (
  id bigserial primary key,
  token text not null unique,
  user_jid text not null,
  item_key text not null,
  qty integer not null default 1,
  price_credits integer not null,
  status text not null default 'pending',
  source text not null default 'site',
  notified_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists purchase_confirmations_pending_idx
  on public.purchase_confirmations (status, notified_at, expires_at)
  where status = 'pending';

create table if not exists public.intimacoes (
  id bigserial primary key,
  challenger_jid text not null,
  challenger_label text,
  defender_jid text not null,
  defender_label text,
  group_jid text,
  question_short_id text not null,
  question_label text,
  materia text,
  stake integer not null,
  fee_burned integer not null default 0,
  status text not null default 'pending',
  expires_at timestamptz not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists intimacoes_defender_pending_idx
  on public.intimacoes (defender_jid, status)
  where status = 'pending';

create table if not exists public.aplicacoes_orcamentarias (
  id bigserial primary key,
  user_jid text not null,
  principal integer not null,
  return_amount integer not null,
  started_day text not null,
  matures_day text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index if not exists aplicacoes_one_active_uidx
  on public.aplicacoes_orcamentarias (user_jid)
  where status = 'active';

create table if not exists public.diario_oficial_events (
  id bigserial primary key,
  group_jid text,
  day_iso text not null,
  event_type text not null,
  actor_jid text,
  actor_label text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists diario_oficial_day_idx
  on public.diario_oficial_events (day_iso, created_at desc);

create table if not exists public.economy_group_announces (
  id bigserial primary key,
  group_jid text not null,
  day_iso text not null,
  announce_key text not null,
  actor_jid text,
  created_at timestamptz not null default now(),
  unique (group_jid, day_iso, announce_key, actor_jid)
);

create table if not exists public.economy_day_flags (
  group_jid text not null,
  day_iso text not null,
  flag_key text not null,
  user_jid text,
  meta jsonb,
  created_at timestamptz not null default now(),
  primary key (group_jid, day_iso, flag_key)
);

-- Seed catálogo
insert into public.shop_catalog (item_key, name, category, price_credits, min_aura, consumable, metadata, sort_order) values
  ('assist_eliminate', 'Eliminar uma alternativa', 'assistencias', 50, 0, true, '{"uses":1}'::jsonb, 10),
  ('streak_insurance', 'Seguro de Streak', 'protecao', 300, 0, true, '{"charges":1}'::jsonb, 20),
  ('frame_basic', 'Moldura básica', 'cosmeticos', 80, 0, false, '{"slot":"frame","css":"frame-basic"}'::jsonb, 30),
  ('frame_rare', 'Moldura rara', 'cosmeticos', 220, 100, false, '{"slot":"frame","css":"frame-rare"}'::jsonb, 40),
  ('name_color', 'Cor do nome', 'cosmeticos', 120, 50, false, '{"slot":"name_color","css":"name-accent"}'::jsonb, 50),
  ('emoji_exclusive', 'Emoji exclusivo', 'cosmeticos', 150, 80, false, '{"slot":"emoji","emoji":"⚡"}'::jsonb, 60),
  ('banner_profile', 'Banner do perfil', 'cosmeticos', 280, 150, false, '{"slot":"banner","css":"banner-gold"}'::jsonb, 70),
  ('avatar_exclusive', 'Avatar exclusivo', 'cosmeticos', 400, 200, false, '{"slot":"avatar","css":"avatar-star"}'::jsonb, 80),
  ('aura_brasa', 'Efeito Aura — Brasa', 'aura', 180, 120, false, '{"slot":"aura_fx","css":"aura-brasa"}'::jsonb, 90),
  ('aura_relampago', 'Efeito Aura — Relâmpago', 'aura', 350, 300, false, '{"slot":"aura_fx","css":"aura-relampago"}'::jsonb, 100),
  ('aura_nazli', 'Efeito Aura — Nazli', 'aura', 600, 600, false, '{"slot":"aura_fx","css":"aura-nazli"}'::jsonb, 110)
on conflict (item_key) do update set
  name = excluded.name,
  category = excluded.category,
  price_credits = excluded.price_credits,
  min_aura = excluded.min_aura,
  consumable = excluded.consumable,
  metadata = excluded.metadata,
  sort_order = excluded.sort_order,
  active = true;
