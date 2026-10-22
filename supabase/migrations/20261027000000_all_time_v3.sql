-- Challenge rules version 3 (hold fire on moving targets) starts with the 2026-10-23 daily (src/challenge.js V3_FROM). Scores under
-- the two rule sets aren't comparable, so the all-time board counts version-3 dailies only. Older
-- rows stay stored (and still verify), they just aren't ranked here.
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
    where s.code like 'd-%' and s.code >= 'd-2026-10-23' and (p_input is null or s.input = p_input)
    order by s.player_id, s.input, s.score desc, s.created_at
  ) b
  order by b.score desc, b.created_at
  limit least(greatest(coalesce(p_limit, 25), 1), 200);
$$;
