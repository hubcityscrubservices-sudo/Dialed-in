-- Where a just-submitted daily score stands all time (same rows as all_time_board: version-3
-- dailies, each player's best per input). Rank counts other players' bests above the score; the
-- player's own best and the best of everyone else come back so the app can say "new record" or
-- "your best is higher". Player ids stay inside the function.
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
    where s.code like 'd-%' and s.code >= 'd-2026-10-23' and (p_input is null or s.input = p_input)
    order by s.player_id, s.input, s.score desc
  )
  select
    (select count(*) from b where b.player_id <> p_player and b.score > p_score)::integer + 1,
    (select count(*) from b)::integer,
    (select max(b.score) from b where b.player_id = p_player)::integer,
    (select max(b.score) from b where b.player_id <> p_player)::integer;
$$;

revoke all on function public.all_time_rank(uuid, text, integer) from public;
grant execute on function public.all_time_rank(uuid, text, integer) to anon, authenticated;
