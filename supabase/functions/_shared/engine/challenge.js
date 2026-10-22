import { GAMES } from './games.js';
import { makeView, steer, newFlickTarget, flickStep, makeTrack, trackStep, newTurnTarget, turnStep, angleTo, trackAim, TRACK_V1, TRACK_V2 } from './sim.js';
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

// Rule versions. The code decides the version, so a recorded run always replays under the rules it
// was played with: daily ranges before V2_FROM are version 1, everything else version 2.
// Version 2 is tuned for controllers: aim assist (medium) on every controller run, a pace yardstick
// based on thumbstick pointing research instead of mouse speed, a smaller miss penalty, a near miss
// that keeps the streak, a short pause between targets, fewer up-and-down targets, calmer moving
// targets, the true-angle hit test and the engine-2 stick rules (sim.js steer).
// Version 3 (dailies from V3_FROM, and all practice runs): moving targets score only while you hold
// fire on them, like an automatic weapon on a strafing enemy. Firing off target costs nothing; a
// moving target keeps the streak when at least trackKeep of the firing time was on it.
export const V2_FROM = '2026-10-22', V3_FROM = '2026-10-23';
const R2 = { flickTimeout: 3.5, missPenalty: 10, vertShare: 0.25, gap: 15, nearMiss: true, track: TRACK_V2, ang: true, eng: 2 };
export const RULES = {
  1: { flickTimeout: 3, missPenalty: 25, vertShare: 0.4, gap: 0, nearMiss: false, track: TRACK_V1, ang: false, eng: 1 },
  2: R2,
  3: { ...R2, holdFire: true, trackKeep: 0.7 }
};
export const versionOf = code => {
  if (!code.startsWith('d-')) return 3;
  const day = code.slice(2);
  return day < V2_FROM ? 1 : day < V3_FROM ? 2 : 3;
};

// Seconds a hit "should" take for its difficulty (Fitts' index of difficulty, ID). Version 1 used a
// mouse-speed yardstick for everyone (about 3 bits/s); version 2 keeps that for mice and gives sticks
// about 2 bits/s, in line with published thumbstick throughput (1.5-2.4 bits/s).
export function parTime(T, v = 1, mouse = false) {
  const id = Math.log2(T.D / T.W + 1);
  return v >= 2 && !mouse ? 0.45 + 0.30 * id : 0.35 + 0.18 * id;
}
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
  const v = versionOf(code), P = RULES[v], mouse = GAMES[gameId].device === 'mouse';
  // Rule-set fields come from the version, never from the submitted settings.
  const s = { ...settings };
  delete s.eng; delete s.aa;
  if (P.eng >= 2) { s.eng = 2; if (!mouse) s.aa = 1; }
  const st = {
    code, gameId, v, P, mouse, wait: 0, settings: s, rng: mulberry32(hashSeed(code)),
    ticks: Math.round((opts.seconds || CH.seconds) * CH.hz), log: [],
    tick: 0, view: makeView(), item: null, items: 0, prevFire: false, done: false,
    score: 0, streak: 0, bestStreak: 0, hits: 0, shots: 0, timeouts: 0, hitTime: 0,
    trackOn: 0, trackT: 0, trackFire: 0, trackFireOn: 0, events: []
  };
  nextItem(st);
  return st;
}

// Mostly flicks (about 2 in 5 above or below), with a tracking burst or a turn-around about one
// item in eight each. The first two items are always flicks.
function nextItem(st) {
  st.items++;
  const r = st.rng(), P = st.P;
  const kind = st.items <= 2 ? 'flick' : r < 0.12 ? 'track' : r < 0.24 ? 'turn' : 'flick';
  if (kind === 'flick') st.item = { kind, pts: 0, T: newFlickTarget(st.view, st.rng, st.rng() < P.vertShare, 1, P.ang) };
  else if (kind === 'turn') st.item = { kind, pts: 0, T: newTurnTarget(st.view, st.rng, st.rng() < 0.5 ? 1 : -1, P.ang) };
  else {
    const TR = makeTrack(0, 1, P.track);
    TR.tgt.yaw = st.view.yaw + (st.rng() < 0.5 ? -6 : 6);
    TR.pitch0 = clamp(st.view.pitch, -20, 20);
    TR.tgt.pitch = TR.pitch0;
    st.item = { kind, pts: 0, TR };
  }
}

// Points for a hit: harder targets (Fitts' index of difficulty) and faster hits score more,
// and a streak of hits adds up to +100%.
export function hitPoints(T, streak, v = 1, mouse = false) {
  const id = Math.log2(T.D / T.W + 1);
  const speed = clamp(2 - T.t / parTime(T, v, mouse), 0.5, 2);
  const mult = 1 + CH.streakStep * Math.min(streak - 1, CH.streakCap);
  return CH.hitBase * id * speed * mult;
}

// One tick. rx, ry are quantized stick values (-1000..1000), or mouse counts for a mouse game; fire is held.
export function step(st, rx, ry, fire) {
  if (st.done) return;
  const fireEdge = fire && !st.prevFire;
  st.prevFire = fire;
  // A mouse run records raw counts per tick in the same two slots a stick run uses for its axes.
  const g = GAMES[st.gameId];
  const it = st.item;
  const aim = !it ? null : it.kind === 'track' ? trackAim(it.TR) : it.T;
  const s = steer(st.view, g.device === 'mouse' ? { mx: rx, my: ry } : { rx: rx / 1000, ry: ry / 1000 }, st.settings, g, DT, 0, aim);
  // Between targets (version 2): the view still turns, and the next target appears when the pause ends.
  if (!it) {
    if (--st.wait <= 0) nextItem(st);
    st.tick++;
    if (st.tick >= st.ticks) st.done = true;
    return;
  }
  if (it.kind === 'track') {
    trackStep(it.TR, st.view, s.vy, DT, st.rng);
    st.trackT += DT;
    const on = it.TR.tgt.on;
    if (on) st.trackOn += DT;
    if (st.P.holdFire) {
      // Points only while firing on target; the item keeps its own firing tally for the streak and report.
      if (fire) { st.trackFire += DT; it.fire = (it.fire || 0) + DT; }
      if (fire && on) { st.trackFireOn += DT; it.fireOn = (it.fireOn || 0) + DT; st.score += CH.trackPerSecond * DT; it.pts += CH.trackPerSecond * DT; }
    } else if (on) { st.score += CH.trackPerSecond * DT; it.pts += CH.trackPerSecond * DT; }
    if (it.TR.t >= CH.trackSeconds - 1e-9) {
      if (st.P.holdFire && !(it.fire >= 0.5 && it.fireOn / it.fire >= st.P.trackKeep)) st.streak = 0;
      st.log.push(it); st.events.push({ type: 'trackEnd' }); after(st);
    }
  } else {
    const T = it.T;
    if (it.kind === 'turn') turnStep(T, st.view, s.mag, DT);
    const out = flickStep(T, st.view, s.mag, fireEdge, DT);
    if (out === 'miss') {
      st.shots++;
      // Version 2 forgives the first near miss on a target (within twice its radius): the streak stays.
      const near = st.P.nearMiss && !T.nearUsed && angleTo(st.view, T) <= 2 * T.r;
      if (near) T.nearUsed = true; else st.streak = 0;
      // The score never goes below zero; the target is charged only what was actually taken off.
      const lost = Math.min(st.P.missPenalty, st.score);
      st.score -= lost;
      it.pts -= lost;
      st.events.push({ type: 'miss', yaw: st.view.yaw, pitch: st.view.pitch });
    } else if (out === 'hit') {
      st.shots++; st.hits++; st.streak++; st.bestStreak = Math.max(st.bestStreak, st.streak);
      st.hitTime += T.t;
      const pts = hitPoints(T, st.streak, st.v, st.mouse);
      st.score += pts;
      it.pts += pts;
      st.log.push(it);
      st.events.push({ type: 'hit', pts, yaw: T.yaw, pitch: T.pitch });
      after(st);
    } else if (T.t >= st.P.flickTimeout - 1e-9 || out === 'timeout') {
      st.timeouts++; st.streak = 0;
      st.log.push(it);
      st.events.push({ type: 'timeout' });
      after(st);
    }
  }
  st.tick++;
  if (st.tick >= st.ticks) st.done = true;
}

// The next target now (version 1), or after a short pause with nothing to aim at (version 2).
function after(st) {
  if (st.P.gap) { st.item = null; st.wait = st.P.gap; } else nextItem(st);
}

export function summary(st) {
  return {
    code: st.code, game: st.gameId,
    score: Math.round(st.score),
    hits: st.hits, shots: st.shots, timeouts: st.timeouts,
    accuracy: st.shots ? st.hits / st.shots : 0,
    avgTime: st.hits ? st.hitTime / st.hits : null,
    bestStreak: st.bestStreak,
    tracking: st.trackT ? st.trackOn / st.trackT : null,
    // Version 3: share of firing time on the moving targets (null before version 3 or if never fired).
    trackAcc: st.P.holdFire && st.trackFire ? st.trackFireOn / st.trackFire : null
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
