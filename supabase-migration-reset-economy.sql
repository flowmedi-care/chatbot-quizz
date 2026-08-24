-- =============================================================================
-- RESET COMPLETO DA GAMIFICAÇÃO (lançamento “de verdade”)
-- =============================================================================
-- Zera progresso de TODOS os jogadores: Aura, Créditos (moedas), streak,
-- inventário (molduras, efeitos, consumíveis), títulos, conquistas, mandados,
-- aplicações, compras pendentes, diário oficial e flags do dia.
--
-- NÃO altera:
--   - shop_catalog          (itens da loja continuam à venda)
--   - questions / answers   (histórico de quiz)
--   - cadernos / omissas
--   - group_member_engagement
--
-- Depois deste script, o próximo /perfil, resposta ou compra começa do zero
-- (Aura 0, Créditos 0, streak 0, sem moldura).
--
-- Rode no SQL Editor do Supabase. Faça backup se tiver dúvida.
-- =============================================================================

begin;

truncate table
  public.economy_ledger,
  public.user_inventory,
  public.user_achievements,
  public.purchase_confirmations,
  public.intimacoes,
  public.aplicacoes_orcamentarias,
  public.diario_oficial_events,
  public.economy_group_announces,
  public.economy_day_flags,
  public.user_streak,
  public.user_economy
restart identity;

commit;
