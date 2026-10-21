import { clamp } from './util.js';

// Curve slots, from most responsive near center to softest. A game can swap in its own shape per slot.
export const CURVE_EXP = { linear: 1.0, mid: 1.8, expo: 2.5 };
export const FOV = 80;          // horizontal degrees shown in the range
export const PITCH_SCALE = 0.8; // vertical turn speed relative to horizontal
export const FLICK_TIMEOUT = 4;
const BOOST_DELAY = 0.15, BOOST_RAMP = 0.4;

export function makeView() {
  return { yaw: 0, pitch: 0, boostT: 0 };
}

// Radial deadzone, rescaled so full output arrives at `outer` push, then the response curve
// (an exponent, or a function from 0..1 to 0..1).
export function shape(x, y, dz, curve, outer = 1) {
  const m = Math.hypot(x, y);
  if (m <= dz) return [0, 0, 0];
  const s = Math.min(1, (m - dz) / (outer - dz));
  const o = typeof curve === 'function' ? curve(s) : Math.pow(s, curve);
  return [x / m * o, y / m * o, o];
}

// Turns the view for one frame. `settings` is { sens, curve, dz, outer? }.
export function steer(view, input, settings, game, dt, minDz = 0) {
  const rate = game.sens.rate(settings.sens);
  const curve = (game.curve.fn && game.curve.fn[settings.curve]) || CURVE_EXP[settings.curve];
  const [sx, sy, mag] = shape(input.rx, input.ry, Math.max(settings.dz, minDz), curve, settings.outer ?? 1);
  let boost = 1;
  if (game.boost) {
    view.boostT = mag >= 0.95 ? view.boostT + dt : 0;
    boost = 1 + (game.boost.mult - 1) * clamp((view.boostT - BOOST_DELAY) / (game.boost.ramp ?? BOOST_RAMP), 0, 1);
  }
  const vy = sx * rate * boost, vp = -sy * rate * PITCH_SCALE;
  view.yaw += vy * dt;
  view.pitch = clamp(view.pitch + vp * dt, -40, 40);
  return { vy, vp, mag };
}

/* ---------- flick trials ---------- */

export function newFlickTarget(view, rng = Math.random) {
  const ang = rng() * Math.PI * 2;
  const dist = 12 + rng() * 24;
  const yaw = view.yaw + Math.cos(ang) * dist;
  const pitch = clamp(view.pitch + Math.sin(ang) * dist * 0.6, -18, 18);
  const dy = yaw - view.yaw, dp = pitch - view.pitch, D = Math.hypot(dy, dp);
  const r = 1.8 + rng() * 1.2;
  return {
    yaw, pitch, r, W: 2 * r, D, sy: view.yaw, sp: view.pitch, ux: dy / D, uy: dp / D,
    maxProj: 0, segs: 0, active: false, shots: 0, t: 0, hit: false, overshoot: false, first: null
  };
}

function along(T, view) {
  return (view.yaw - T.sy) * T.ux + (view.pitch - T.sp) * T.uy;
}

// Advances one flick trial. Returns 'hit', 'timeout', 'miss' (a shot that missed) or null.
export function flickStep(T, view, mag, fireEdge, dt) {
  T.t += dt;
  const proj = along(T, view);
  T.maxProj = Math.max(T.maxProj, proj);
  const act = mag > 0.12;
  if (act && !T.active) T.segs++;
  T.active = act;
  if (fireEdge) {
    T.shots++;
    // The first shot is the endpoint for Fitts' throughput.
    if (!T.first) T.first = { t: T.t, along: proj };
    if (Math.hypot(view.yaw - T.yaw, view.pitch - T.pitch) <= T.r) { T.hit = true; return finish(T, view, 'hit'); }
    return 'miss';
  }
  if (T.t >= FLICK_TIMEOUT) return finish(T, view, 'timeout');
  return null;
}

function finish(T, view, why) {
  if (!T.first) T.first = { t: T.t, along: along(T, view) };
  T.overshoot = (T.maxProj - T.D) > T.r;
  return why;
}

/* ---------- tracking ---------- */

// `warm` seconds at the start are played but not scored.
export function makeTrack(warm = 0) {
  return {
    t: 0, warm, r: 2.6, T: 0, errSum: 0, chunks: [], chunk: { sum: 0, time: 0 },
    on: 0, behind: 0, ahead: 0, near: 0, rev: 0, tRev: 0, last: 0,
    tgt: { yaw: 0, pitch: 0, v: 0, goal: 0, next: 0.4, on: false }
  };
}

export function trackStep(TR, view, vy, dt, rng = Math.random) {
  const g = TR.tgt;
  TR.t += dt;
  if (TR.t >= g.next) {
    g.goal = (rng() < 0.5 ? -1 : 1) * (18 + rng() * 50);
    g.next = TR.t + 0.6 + rng() * 1.1;
  }
  const prevV = g.v;
  g.v += (g.goal - g.v) * Math.min(1, dt * 4);
  g.yaw += g.v * dt;
  g.pitch = 3 * Math.sin(TR.t * 1.3);
  const ey = view.yaw - g.yaw, ep = view.pitch - g.pitch, e = Math.hypot(ey, ep);
  g.on = e <= TR.r;
  if (TR.t <= TR.warm) return;

  TR.T += dt;
  TR.errSum += e * dt;
  TR.chunk.sum += e * dt; TR.chunk.time += dt;
  if (TR.chunk.time >= 1) { TR.chunks.push(TR.chunk.sum / TR.chunk.time); TR.chunk = { sum: 0, time: 0 }; }
  if (prevV && g.v && Math.sign(prevV) !== Math.sign(g.v)) TR.tRev++;
  if (g.on) TR.on += dt;
  else if (Math.abs(g.v) > 6) { if (ey * Math.sign(g.v) < 0) TR.behind += dt; else TR.ahead += dt; }
  if (e < 5) {
    TR.near += dt;
    if (Math.abs(vy) > 6) {
      const sg = Math.sign(vy);
      if (TR.last && sg !== TR.last) TR.rev++;
      TR.last = sg;
    }
  }
}
