-- Warm-up challenge leaderboard. One row per player, code and input type, holding their best
-- verified run. Rows are written only by the submit-score function (service role), which replays
-- each run first; browsers can read the board columns but never the recordings or player ids.
create table public.scores (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[dp]-[a-z0-9-]{4,16}$'),
  player_id uuid not null,
  input text not null check (input in ('pad', 'virtual')),
  name text not null check (char_length(name) between 2 and 20),
  game text not null,
  score integer not null check (score >= 0),
  accuracy real,
  hits integer,
  best_streak integer,
  avg_time real,
  settings jsonb not null,
  replay jsonb not null,
  created_at timestamptz not null default now(),
  unique (code, player_id, input)
);

create index scores_board on public.scores (code, input, score desc, created_at);

alter table public.scores enable row level security;

-- Anyone may read the board; no insert, update or delete policies, so only the function writes.
create policy "Leaderboard is public" on public.scores for select to anon, authenticated using (true);

-- Column-level grants keep recordings, settings and player ids private.
revoke all on public.scores from anon, authenticated;
grant select (id, code, input, name, game, score, accuracy, hits, best_streak, avg_time, created_at)
  on public.scores to anon, authenticated;
