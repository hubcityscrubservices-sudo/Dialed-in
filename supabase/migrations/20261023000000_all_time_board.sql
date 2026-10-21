-- All-time board: each player's best daily-range score ever, per input type. Practice runs are left
-- out because their targets can be rerolled until an easy set comes up.
-- A function rather than a view so it can pick each player's best by player_id without exposing it:
-- it runs as its owner (security definer) and returns only the public board columns.
create or replace function public.all_time_board(p_input text default null, p_limit integer default 10)
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
  limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

revoke all on function public.all_time_board(text, integer) from public;
grant execute on function public.all_time_board(text, integer) to anon, authenticated;

-- Reading the board scans daily codes by score.
create index scores_daily_best on public.scores (player_id, input, score desc) where code like 'd-%';
