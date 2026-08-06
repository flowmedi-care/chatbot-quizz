-- Dia de folga: conta o dia escolhido como se não houvesse omissas (prepaid_days).
-- Mais caro que o Seguro de Streak (300).

insert into public.shop_catalog (item_key, name, category, price_credits, min_aura, consumable, metadata, sort_order, active)
values (
  'day_off',
  'Dia de folga',
  'protecao',
  450,
  0,
  true,
  '{"uses":1,"prepaid":true}'::jsonb,
  25,
  true
)
on conflict (item_key) do update set
  name = excluded.name,
  category = excluded.category,
  price_credits = excluded.price_credits,
  min_aura = excluded.min_aura,
  consumable = excluded.consumable,
  metadata = excluded.metadata,
  sort_order = excluded.sort_order,
  active = true;
