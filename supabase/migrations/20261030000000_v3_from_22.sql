-- Version 3 (hold fire on moving targets) was brought forward to the 2026-10-22 daily, so the all-time
-- board, the all-time rank and the medal percentiles count dailies from that day.

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
    where s.code like 'd-%' and s.code >= 'd-2026-10-22' and (p_input is null or s.input = p_input)
    order by s.player_id, s.input, s.score desc, s.created_at
  ) b
  order by b.score desc, b.created_at
  limit least(greatest(coalesce(p_limit, 25), 1), 200);
$$;

create or replace function public.all_time_rank(p_player uuid, p_input text, p_score integer)
returns table (rank integer, total integer, own_best integer, others_best integer)
language sql
stable
security definer
set search_path = public
as $$
  with b as (
    select distinct on (s.player_id, s.input) s.player_id, s.score
    from public.scores s
    where s.code like 'd-%' and s.code >= 'd-2026-10-22' and (p_input is null or s.input = p_input)
    order by s.player_id, s.input, s.score desc
  )
  select
    (select count(*) from b where b.player_id <> p_player and b.score > p_score)::integer + 1,
    (select count(*) from b)::integer,
    (select max(b.score) from b where b.player_id = p_player)::integer,
    (select max(b.score) from b where b.player_id <> p_player)::integer;
$$;

create or replace function public.score_tiers(p_mouse boolean default false)
returns table (n integer, bronze real, silver real, gold real, ace real)
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer,
    percentile_cont(0.40) within group (order by s.score)::real,
    percentile_cont(0.65) within group (order by s.score)::real,
    percentile_cont(0.85) within group (order by s.score)::real,
    percentile_cont(0.95) within group (order by s.score)::real
  from public.scores s
  where s.code like 'd-%' and s.code >= 'd-2026-10-22'
    and (case when coalesce(p_mouse, false) then s.input = 'mouse' else s.input in ('pad', 'virtual') end);
$$;
