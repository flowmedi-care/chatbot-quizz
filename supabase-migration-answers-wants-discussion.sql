-- Marca “quero discutir” sem alterar a confiança (chute/inseguro/seguro).
-- O gabarito do grupo sai se alguém errou, chutou ou pediu discussão.

alter table public.answers
  add column if not exists wants_discussion boolean not null default false;
