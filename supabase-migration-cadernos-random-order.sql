-- =============================================================================
-- CADERNOS: random_order
-- =============================================================================
-- Migration incremental: adiciona coluna `random_order` em `cadernos`.
-- Quando true, o scheduler sorteia a próxima questão entre as ainda não
-- enviadas (published_question_id IS NULL) em vez de seguir por position.
--
-- Rode no SQL Editor do Supabase apenas se o caderno já existir sem essa
-- coluna. Quem rodar `supabase-migration-cadernos.sql` do zero já pega.
-- =============================================================================

alter table public.cadernos
  add column if not exists random_order boolean not null default false;
