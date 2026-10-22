-- Pooled turn-speed timings. Games don't publish how fast a controller sensitivity turns, so players
-- who time 5 full spins at full stick contribute (game, sensitivity, seconds), and the app uses the
-- median of everyone's timings as its estimate. One row per player and game; a new timing replaces it.
create table public.turn_samples (
  player_id uuid not null,
  game text not null check (game ~ '^[a-z][a-z0-9-]{1,23}$'),
  sens real not null check (sens > 0 and sens <= 1000),
  seconds real not null check (seconds >= 1 and seconds <= 60),
  created_at timestamptz not null default now(),
  primary key (player_id, game)
);

alter table public.turn_samples enable row level security;
-- No policies and no grants: browsers reach the table only through the two functions below.
revoke all on public.turn_samples from anon, authenticated;

-- Adds or replaces this player's timing for a game. 5 spins = 1800 degrees, so the turn speed must
-- land between 20 and 2000 degrees per second to count.
create or replace function public.add_turn_sample(p_player uuid, p_game text, p_sens real, p_seconds real)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.turn_samples (player_id, game, sens, seconds)
  select p_player, p_game, p_sens, p_seconds
  where 1800 / p_seconds between 20 and 2000
  on conflict (player_id, game) do update set sens = excluded.sens, seconds = excluded.seconds, created_at = now();
$$;

-- The most recent timings for a game, without player ids.
create or replace function public.turn_samples_for(p_game text)
returns table (sens real, seconds real)
language sql
stable
security definer
set search_path = public
as $$
  select t.sens, t.seconds from public.turn_samples t where t.game = p_game order by t.created_at desc limit 200;
$$;

revoke all on function public.add_turn_sample(uuid, text, real, real) from public;
revoke all on function public.turn_samples_for(text) from public;
grant execute on function public.add_turn_sample(uuid, text, real, real) to anon, authenticated;
grant execute on function public.turn_samples_for(text) to anon, authenticated;
