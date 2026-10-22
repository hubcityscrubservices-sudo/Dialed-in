-- The board page shows 25 rows with a Show more button, so allow up to 200 rows per request.
create or replace function public.all_time_board(p_input text default null, p_limit integer default 25)
returns table (name text, score integer, accuracy real, best_streak integer, game text, input text, code text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select b.name, b.score, b.accuracy, b.best_streak, b.game, b.input, b.code, b.created_at
  from (
    select distinct on (s.player_id, s.input)
      s.name, s.score, s.accuracy, s.best_streak, s.game, s.input, s.code, s.created_at
    from public.scores s
    where s.code like 'd-%' and (p_input is null or s.input = p_input)
    order by s.player_id, s.input, s.score desc, s.created_at
  ) b
  order by b.score desc, b.created_at
  limit least(greatest(coalesce(p_limit, 25), 1), 200);
$$;
