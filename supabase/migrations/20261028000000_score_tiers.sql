-- Medal cutoffs from real scores: percentiles of version-3 daily scores (each row is one player's
-- best on one day), controllers (pad, virtual) and mice separately. The app uses them once n is big
-- enough and falls back to fixed cutoffs before that.
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
  where s.code like 'd-%' and s.code >= 'd-2026-10-23'
    and (case when coalesce(p_mouse, false) then s.input = 'mouse' else s.input in ('pad', 'virtual') end);
$$;

revoke all on function public.score_tiers(boolean) from public;
grant execute on function public.score_tiers(boolean) to anon, authenticated;
