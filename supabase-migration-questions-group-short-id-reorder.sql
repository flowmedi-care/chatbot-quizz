-- =============================================================================
-- Renumera short_id das questões do GRUPO (1, 2, 3…) na ordem de criação.
-- Atualiza answers.question_short_id para manter respostas ligadas.
--
-- Escopo (não mexe em caderno privado):
--   - target_group_jid termina com @g.us
--   - short_id atual não é formato privado (ex.: 2-16, 3-5-ABC)
--
-- Rode no SQL Editor do Supabase. Idempotente se já estiver 1..N na ordem certa.
-- Se tiver mais de um grupo @g.us, cada grupo recebe sua própria sequência 1..N
-- (short_id é UNIQUE global — só use com um grupo de quiz ou ajuste o script).
-- =============================================================================

do $$
declare
  g_jid text;
  r record;
  n int;
begin
  for g_jid in
    select distinct q.target_group_jid
    from public.questions q
    where q.target_group_jid like '%@g.us'
      and q.target_group_jid not like '%@s.whatsapp.net'
      and q.target_group_jid not like '%@lid'
  loop
    -- Fase 1: libera short_id (evita colisão UNIQUE)
    update public.questions q
    set short_id = 'MIG-' || q.id::text
    where q.target_group_jid = g_jid
      and q.short_id !~ '^\d+-\d+(-[A-Z0-9]+)?$';

    -- Fase 2: numera 1..N e espelha em answers
    n := 0;
    for r in
      select q.id
      from public.questions q
      where q.target_group_jid = g_jid
        and q.short_id like 'MIG-%'
      order by q.created_at asc, q.id asc
    loop
      n := n + 1;
      update public.questions
      set short_id = n::text
      where id = r.id;

      update public.answers a
      set question_short_id = n::text
      where a.question_id = r.id;
    end loop;

    raise notice 'Grupo %: % questao(oes) renumeradas.', g_jid, n;
  end loop;
end $$;
