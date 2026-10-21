-- Mouse runs join the leaderboard. They are verified like stick runs; the board can be read per
-- input type or combined.
alter table public.scores drop constraint scores_input_check;
alter table public.scores add constraint scores_input_check check (input in ('pad', 'virtual', 'mouse'));

-- The combined board reads by code and score across inputs.
create index scores_board_all on public.scores (code, score desc, created_at);
