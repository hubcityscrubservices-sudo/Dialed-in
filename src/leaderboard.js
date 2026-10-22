import { SUPABASE } from './config.js';

// Browser side of the leaderboard: submit a recorded run for verification, read a board.
export const boardsOn = () => !!(SUPABASE.url && SUPABASE.key);

// Legacy anon keys are JWTs and go in Authorization too; newer publishable keys only go in apikey.
function headers(json) {
  const h = { apikey: SUPABASE.key };
  if (SUPABASE.key.startsWith('eyJ')) h.Authorization = `Bearer ${SUPABASE.key}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

export async function submitScore(payload) {
  const res = await fetch(`${SUPABASE.url}/functions/v1/submit-score`, { method: 'POST', headers: headers(true), body: JSON.stringify(payload) });
  try { return await res.json(); } catch (e) { return { ok: false, error: `The leaderboard replied with ${res.status}.` }; }
}

// input: 'pad' | 'virtual' | 'mouse', or 'all' for the combined board.
export async function fetchBoard(code, input, limit = 25) {
  const q = new URLSearchParams({
    select: 'name,score,accuracy,best_streak,game,input,created_at',
    code: `eq.${code}`, order: 'score.desc,created_at.asc', limit: String(limit)
  });
  if (input !== 'all') q.set('input', `eq.${input}`);
  const res = await fetch(`${SUPABASE.url}/rest/v1/scores?${q}`, { headers: headers(false) });
  if (!res.ok) throw new Error(`Board request failed with ${res.status}`);
  return res.json();
}

// All-time board: each player's best daily score ever (database function all_time_board).
// input: one input type, or 'all'.
export async function fetchAllTime(input, limit = 25) {
  const res = await fetch(`${SUPABASE.url}/rest/v1/rpc/all_time_board`, {
    method: 'POST', headers: headers(true), body: JSON.stringify({ p_input: input === 'all' ? null : input, p_limit: limit })
  });
  if (!res.ok) throw new Error(`Board request failed with ${res.status}`);
  return res.json();
}

// Pooled turn-speed timings (seconds for 5 full spins at full stick, at a sensitivity).
export async function addTurnSample(game, sens, seconds) {
  const res = await fetch(`${SUPABASE.url}/rest/v1/rpc/add_turn_sample`, {
    method: 'POST', headers: headers(true), body: JSON.stringify({ p_player: playerId(), p_game: game, p_sens: sens, p_seconds: seconds })
  });
  if (!res.ok) throw new Error(`Turn sample failed with ${res.status}`);
}
export async function fetchTurnSamples(game) {
  const res = await fetch(`${SUPABASE.url}/rest/v1/rpc/turn_samples_for`, {
    method: 'POST', headers: headers(true), body: JSON.stringify({ p_game: game })
  });
  if (!res.ok) throw new Error(`Turn samples failed with ${res.status}`);
  return res.json();
}

// A random id kept in this browser so a player's runs replace their own best, not someone else's.
const ID_KEY = 'dialed-in:player', NAME_KEY = 'dialed-in:name';
let sessionId = null;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
export function playerId() {
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) { id = uuid(); localStorage.setItem(ID_KEY, id); }
    return id;
  } catch (e) { return sessionId || (sessionId = uuid()); }
}
export function savedName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; } }
export function saveName(n) { try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* storage blocked: name isn't remembered */ } }
