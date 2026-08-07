-- Lote do dia: horário máximo de liberação = 15:00 (corte de omissas).
-- end_hour / send_times deixam de dripar; espelham o horário de início.

update public.cadernos
set
  start_hour = least(coalesce(start_hour, send_hour, 7), 15),
  send_hour = least(coalesce(start_hour, send_hour, 7), 15),
  start_minute = case
    when least(coalesce(start_hour, send_hour, 7), 15) >= 15 then 0
    else coalesce(start_minute, send_minute, 0)
  end,
  send_minute = case
    when least(coalesce(start_hour, send_hour, 7), 15) >= 15 then 0
    else coalesce(start_minute, send_minute, 0)
  end,
  end_hour = least(coalesce(start_hour, send_hour, 7), 15),
  end_minute = case
    when least(coalesce(start_hour, send_hour, 7), 15) >= 15 then 0
    else coalesce(start_minute, send_minute, 0)
  end
where true;

-- Compacta send_times: todos os slots = horário de liberação (quando a coluna existe).
do $$
declare
  r record;
  n int;
  sh int;
  sm int;
  arr jsonb;
  i int;
begin
  for r in
    select id, questions_per_day, questions_per_run, start_hour, start_minute, send_hour, send_minute, send_times
    from public.cadernos
  loop
    n := greatest(1, coalesce(r.questions_per_day, r.questions_per_run, 3));
    sh := least(coalesce(r.start_hour, r.send_hour, 7), 15);
    sm := case when sh >= 15 then 0 else coalesce(r.start_minute, r.send_minute, 0) end;
    arr := '[]'::jsonb;
    for i in 1..n loop
      arr := arr || jsonb_build_array(jsonb_build_object('hour', sh, 'minute', sm));
    end loop;
    update public.cadernos set send_times = arr where id = r.id;
  end loop;
exception
  when undefined_column then
    null;
end $$;

-- Destinatários privados (se a tabela existir)
do $$
begin
  update public.caderno_private_recipients
  set
    start_hour = least(coalesce(start_hour, 7), 15),
    start_minute = case
      when least(coalesce(start_hour, 7), 15) >= 15 then 0
      else coalesce(start_minute, 0)
    end,
    end_hour = least(coalesce(start_hour, 7), 15),
    end_minute = case
      when least(coalesce(start_hour, 7), 15) >= 15 then 0
      else coalesce(start_minute, 0)
    end
  where true;
exception
  when undefined_table then
    null;
end $$;
