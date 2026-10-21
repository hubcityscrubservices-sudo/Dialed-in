import { GAMES } from './games.js';
import { makeView, steer, newFlickTarget, flickStep, makeTrack, trackStep, newTurnTarget, turnStep } from './sim.js';
import { mulberry32, clamp } from './util.js';

// Warm-up challenge: 60 seconds of flicks, short tracking bursts and turn-arounds, scored for speed
// and accuracy. Everything runs in fixed 1/60 s ticks from a seeded generator, and stick input is
// rounded to 1/1000 before use, so the same seed and the same recorded input always give the same
// score. That lets a server replay a run to check a leaderboard entry.
export const CH = {
  seconds: 60, hz: 60,
  trackSeconds: 4, flickTimeout: 3,
  hitBase: 30, trackPerSecond: 60, missPenalty: 25, streakStep: 0.1, streakCap: 10
};
export const DT = 1 / CH.hz;
export const TICKS = CH.seconds * CH.hz;

/* ---------- seeds ---------- */

// FNV-1a: challenge code -> 32-bit seed.
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
// Codes are plain tokens so they survive in a link's #fragment: d-2026-10-21, p-k3x9q2.
export const dailyCode = (date = new Date()) => 'd-' + date.toISOString().slice(0, 10);
export function practiceCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 6; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(rand() * 36)];
  return 'p-' + s;
}
export const isCode = s => /^[dp]-[a-z0-9-]{4,16}$/.test(s);

export const quantize = v => clamp(Math.round(v * 1000), -1000, 1000);

/* ---------- engine ---------- */

// opts.seconds shortens the run (the settings duel uses 30 s runs). st.log keeps every finished
// target with its points, for the report card.
export function createChallenge(code, gameId, settings, opts = {}) {
  const st = {
    code, gameId, settings: { ...settings }, rng: mulberry32(hashSeed(code)),
    ticks: Math.round((opts.seconds || CH.seconds) * CH.hz), log: [],
    tick: 0, view: makeView(), item: null, items: 0, prevFire: false, done: false,
    score: 0, streak: 0, bestStreak: 0, hits: 0, shots: 0, timeouts: 0, hitTime: 0,
    trackOn: 0, trackT: 0, events: []
  };
  nextItem(st);
  return st;
}

// Mostly flicks (about 2 in 5 above or below), with a tracking burst or a turn-around about one
// item in eight each. The first two items are always flicks.
function nextItem(st) {
  st.items++;
  const r = st.rng();
  const kind = st.items <= 2 ? 'flick' : r < 0.12 ? 'track' : r < 0.24 ? 'turn' : 'flick';
  if (kind === 'flick') st.item = { kind, pts: 0, T: newFlickTarget(st.view, st.rng, st.rng() < 0.4) };
  else if (kind === 'turn') st.item = { kind, pts: 0, T: newTurnTarget(st.view, st.rng, st.rng() < 0.5 ? 1 : -1) };
  else {
    const TR = makeTrack(0);
    TR.tgt.yaw = st.view.yaw + (st.rng() < 0.5 ? -6 : 6);
    TR.pitch0 = clamp(st.view.pitch, -20, 20);
    TR.tgt.pitch = TR.pitch0;
    st.item = { kind, pts: 0, TR };
  }
}

// Points for a hit: harder targets (Fitts' index of difficulty) and faster hits score more,
// and a streak of hits adds up to +100%.
export function hitPoints(T, streak) {
  const id = Math.log2(T.D / T.W + 1);
  const expected = 0.35 + 0.18 * id;
  const speed = clamp(2 - T.t / expected, 0.5, 2);
  const mult = 1 + CH.streakStep * Math.min(streak - 1, CH.streakCap);
  return CH.hitBase * id * speed * mult;
}

// One tick. rx, ry are quantized stick values (-1000..1000); fire is the fire button held.
export function step(st, rx, ry, fire) {
  if (st.done) return;
  const fireEdge = fire && !st.prevFire;
  st.prevFire = fire;
  const s = steer(st.view, { rx: rx / 1000, ry: ry / 1000 }, st.settings, GAMES[st.gameId], DT);
  const it = st.item;
  if (it.kind === 'track') {
    trackStep(it.TR, st.view, s.vy, DT, st.rng);
    st.trackT += DT;
    if (it.TR.tgt.on) { st.trackOn += DT; st.score += CH.trackPerSecond * DT; it.pts += CH.trackPerSecond * DT; }
    if (it.TR.t >= CH.trackSeconds - 1e-9) { st.log.push(it); st.events.push({ type: 'trackEnd' }); nextItem(st); }
  } else {
    const T = it.T;
    if (it.kind === 'turn') turnStep(T, st.view, s.mag, DT);
    const out = flickStep(T, st.view, s.mag, fireEdge, DT);
    if (out === 'miss') {
      st.shots++; st.streak = 0;
      // The score never goes below zero; the target is charged only what was actually taken off.
      const lost = Math.min(CH.missPenalty, st.score);
      st.score -= lost;
      it.pts -= lost;
      st.events.push({ type: 'miss', yaw: st.view.yaw, pitch: st.view.pitch });
    } else if (out === 'hit') {
      st.shots++; st.hits++; st.streak++; st.bestStreak = Math.max(st.bestStreak, st.streak);
      st.hitTime += T.t;
      const pts = hitPoints(T, st.streak);
      st.score += pts;
      it.pts += pts;
      st.log.push(it);
      st.events.push({ type: 'hit', pts, yaw: T.yaw, pitch: T.pitch });
      nextItem(st);
    } else if (T.t >= CH.flickTimeout - 1e-9 || out === 'timeout') {
      st.timeouts++; st.streak = 0;
      st.log.push(it);
      st.events.push({ type: 'timeout' });
      nextItem(st);
    }
  }
  st.tick++;
  if (st.tick >= st.ticks) st.done = true;
}

export function summary(st) {
  return {
    code: st.code, game: st.gameId,
    score: Math.round(st.score),
    hits: st.hits, shots: st.shots, timeouts: st.timeouts,
    accuracy: st.shots ? st.hits / st.shots : 0,
    avgTime: st.hits ? st.hitTime / st.hits : null,
    bestStreak: st.bestStreak,
    tracking: st.trackT ? st.trackOn / st.trackT : null
  };
}

/* ---------- replays ---------- */

// Input per tick: two Int16 stick values and one fire bit, packed and base64-encoded (~15 KB).
export function newRecording() {
  return { rx: new Int16Array(TICKS), ry: new Int16Array(TICKS), fire: new Uint8Array(Math.ceil(TICKS / 8)), n: 0 };
}
export function record(rec, rx, ry, fire) {
  const i = rec.n++;
  rec.rx[i] = rx; rec.ry[i] = ry;
  if (fire) rec.fire[i >> 3] |= 1 << (i & 7);
}
const toB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); };
const fromB64 = b64 => { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

export function encodeReplay(rec) {
  const n = rec.n, sticks = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) { sticks[2 * i] = rec.rx[i]; sticks[2 * i + 1] = rec.ry[i]; }
  return { n, sticks: toB64(new Uint8Array(sticks.buffer)), fire: toB64(rec.fire.slice(0, Math.ceil(n / 8))) };
}
export function decodeReplay(r) {
  const bytes = fromB64(r.sticks);
  const sticks = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const fire = fromB64(r.fire);
  const rec = newRecording();
  for (let i = 0; i < r.n; i++) record(rec, sticks[2 * i], sticks[2 * i + 1], (fire[i >> 3] >> (i & 7)) & 1);
  return rec;
}

// Re-runs a recorded challenge from scratch: what a server does before accepting a score.
export function replay(code, gameId, settings, rec, opts = {}) {
  const st = createChallenge(code, gameId, settings, opts);
  for (let i = 0; i < rec.n && !st.done; i++) step(st, rec.rx[i], rec.ry[i], (rec.fire[i >> 3] >> (i & 7)) & 1 ? true : false);
  return summary(st);
}
