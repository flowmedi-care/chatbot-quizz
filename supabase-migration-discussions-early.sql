-- Early discussion posts + feed_at for date filters.
-- Rode no SQL Editor do Supabase (depois de supabase-migration-discussions.sql).

alter table public.discussion_posts
  drop constraint if exists discussion_posts_source_check;

alter table public.discussion_posts
  add constraint discussion_posts_source_check
  check (source in ('auto_gabarito', 'gabarito', 'early'));

alter table public.discussion_posts
  add column if not exists feed_at timestamptz;

update public.discussion_posts
set feed_at = created_at
where feed_at is null
  and source in ('auto_gabarito', 'gabarito');

create index if not exists discussion_posts_feed_at_idx
  on public.discussion_posts (feed_at desc nulls last);

comment on column public.discussion_posts.feed_at is
  'Quando a questão entrou no feed público (gabarito). Null = só discussão antecipada.';
comment on column public.discussion_posts.source is
  'early = comentários antes do gabarito no grupo; auto_gabarito/gabarito = no feed.';
