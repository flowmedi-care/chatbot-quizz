-- Nome amigável aprendido quando a pessoa responde ou cria questão (além do user_label do WhatsApp).
-- Rode no SQL Editor do Supabase depois de group_member_engagement existir.

alter table public.group_member_engagement
  add column if not exists quiz_display_name text;

comment on column public.group_member_engagement.quiz_display_name is
  'Atualizado pelo bot ao gravar resposta ou criar questão; preferido na UI em relação ao user_label cru.';
