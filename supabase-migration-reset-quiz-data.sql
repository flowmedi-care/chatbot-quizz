-- =============================================================================
-- RESET COMPLETO: questões + respostas + contadores de ID
-- =============================================================================
-- Apaga TODAS as linhas de `answers` e `questions` e reinicia as sequências
-- (IDENTITY). A próxima questão criada pelo bot volta a ser #1 (short_id = id).
--
-- NÃO altera:
--   - bot_user_quiz_mode (preferência /quiz no privado)
--   - group_member_engagement (lista / engajamento — ver bloco opcional abaixo)
--
-- Arquivos no Storage (bucket question-assets / enunciados e PDFs) NÃO são
-- apagados por este script. Se quiser limpar também: Supabase → Storage →
-- esvaziar o bucket manualmente ou apagar a pasta via CLI.
--
-- Rode no SQL Editor do Supabase. Faça backup se tiver dúvida.
-- =============================================================================

begin;

truncate table public.questions restart identity cascade;

commit;

-- -----------------------------------------------------------------------------
-- OPCIONAL: zerar também a lista de membros / engajamento (refazer /sync-membros)
-- -----------------------------------------------------------------------------
-- Descomente as 3 linhas abaixo se quiser apagar tudo de group_member_engagement:
--
-- begin;
-- truncate table public.group_member_engagement;
-- commit;
