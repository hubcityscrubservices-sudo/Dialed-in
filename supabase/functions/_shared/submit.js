// Leaderboard submission, independent of Supabase so it can be tested in Node.
// The run is replayed from its recorded input; only the score the replay produces is stored.
import { GAMES } from './engine/games.js';
import { CH, isCode, decodeReplay, replay } from './engine/challenge.js';

export const LIMITS = { bodyBytes: 64 * 1024, ticks: CH.seconds * CH.hz };
const NAME = /^[A-Za-z0-9 _.\-]{2,20}$/;
const BLOCKED = ['fuck', 'shit', 'cunt', 'nigg', 'fag', 'rape', 'hitler'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (status, error) => ({ status, body: { ok: false, error } });

export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!NAME.test(name)) return null;
  const low = name.toLowerCase().replace(/[^a-z]/g, '');
  return BLOCKED.some(w => low.includes(w)) ? null : name;
}

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const onStep = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-6;

// Rebuilds the settings object the browser played with, rejecting anything outside the game's menu.
export function cleanSettings(game, s) {
  if (!s || typeof s !== 'object') return null;
  const g = GAMES[game];
  const out = {};
  if (!num(s.sens, g.sens.min, g.sens.max) || !onStep(s.sens, g.sens.step)) return null;
  out.sens = s.sens;
  // Mouse runs carry their degrees per count: a full turn somewhere between ~0.5 and ~300 cm at
  // common DPIs. Any value in range is a legitimate sensitivity choice.
  if (g.device === 'mouse') { if (!num(s.dpc, 0.0005, 1)) return null; out.dpc = s.dpc; }
  else if (s.dpc != null) return null;
  if (g.vsens) {
    if (!num(s.vsens, g.vsens.min, g.vsens.max) || !onStep(s.vsens, g.vsens.step)) return null;
    out.vsens = s.vsens;
  }
  if (s.vmult != null) { if (!num(s.vmult, 0.5, 2)) return null; out.vmult = s.vmult; }
  if (!['linear', 'mid', 'expo'].includes(s.curve)) return null;
  out.curve = s.curve;
  if (!num(s.dz, 0, 0.3)) return null;
  out.dz = s.dz;
  if (s.outer != null) { if (!num(s.outer, 0.75, 1)) return null; out.outer = s.outer; }
  const bs = g.boost && g.boost.setting;
  if (s.boost != null) { if (!bs || !num(s.boost, bs.min, bs.max)) return null; out.boost = s.boost; }
  if (s.boostRamp != null) { if (!bs || !num(s.boostRamp, g.boost.rampSetting.min, g.boost.rampSetting.max)) return null; out.boostRamp = s.boostRamp; }
  return out;
}

// Daily codes for days that haven't started yet (UTC) are refused, so nobody practises tomorrow's targets.
export function codeAllowed(code, now) {
  if (!isCode(code)) return false;
  if (code.startsWith('d-')) {
    const day = code.slice(2);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    return day <= now.toISOString().slice(0, 10);
  }
  return true;
}

// db: { getBest(code, playerId, input), save(row), rank(code, input | null, score) -> { rank, total } }
// rank with input null counts every input type (the combined board).
export async function handleSubmit(raw, db, now = new Date()) {
  if (typeof raw !== 'string' || raw.length > LIMITS.bodyBytes) return fail(413, 'Submission is too large.');
  let b;
  try { b = JSON.parse(raw); } catch (e) { return fail(400, 'Submission is not valid JSON.'); }
  if (!b || typeof b !== 'object') return fail(400, 'Submission is empty.');
  if (!codeAllowed(b.code, now)) return fail(400, 'That challenge code is not open.');
  if (!GAMES[b.game]) return fail(400, 'Unknown game.');
  // Mouse games are played with a mouse and controller games with a stick, so input and game must agree.
  const mouseGame = GAMES[b.game].device === 'mouse';
  if (!(mouseGame ? ['mouse'] : ['pad', 'virtual']).includes(b.input)) return fail(400, 'Unknown input type for this game.');
  if (typeof b.playerId !== 'string' || !UUID.test(b.playerId)) return fail(400, 'Missing player id.');
  const name = cleanName(b.name);
  if (!name) return fail(400, 'Names are 2 to 20 letters, numbers, spaces, dots, dashes or underscores.');
  const settings = cleanSettings(b.game, b.settings);
  if (!settings) return fail(400, 'Settings are outside what the game allows.');
  const r = b.replay;
  if (!r || r.n !== LIMITS.ticks || typeof r.sticks !== 'string' || typeof r.fire !== 'string') return fail(400, 'Only full 60-second runs can be submitted.');

  let sum;
  try { sum = replay(b.code, b.game, settings, decodeReplay(r)); }
  catch (e) { return fail(400, 'The recording could not be read.'); }
  if (sum.score !== b.score) return fail(422, `The replay scored ${sum.score}, not ${b.score}, so the score was not saved.`);

  const prev = await db.getBest(b.code, b.playerId, b.input);
  let saved = false;
  if (!prev || sum.score > prev.score) {
    await db.save({
      code: b.code, player_id: b.playerId, input: b.input, name, game: b.game,
      score: sum.score, accuracy: sum.accuracy, hits: sum.hits, best_streak: sum.bestStreak,
      avg_time: sum.avgTime, settings, replay: r
    });
    saved = true;
  }
  const best = saved ? sum.score : prev.score;
  const { rank, total } = await db.rank(b.code, b.input, best);
  const all = await db.rank(b.code, null, best);
  return { status: 200, body: { ok: true, verified: sum.score, saved, best, rank, total, rankAll: all.rank, totalAll: all.total } };
}
