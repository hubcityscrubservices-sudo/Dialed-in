// Supabase project for the leaderboard. The public (anon / publishable) key is meant to be visible in
// web pages; row-level security keeps everything but the board columns private. Never put the
// service role key here. Leave both empty to switch leaderboards off.
export const SUPABASE = {
  url: '',
  key: ''
};
