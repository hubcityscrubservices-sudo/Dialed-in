import { clamp } from './util.js';

// Curve slots, from most responsive near center to softest. A game can swap in its own shape per slot.
export const CURVE_EXP = { linear: 1.0, mid: 1.8, expo: 2.5 };
// Engine 2 softens the exponential slot: at 2.5, half a push gave only 15% of full speed, so small
// corrections needed big pushes. No game publishes its exponent; 2.0 gives 22% at half a push.
const CURVE_EXP2 = { ...CURVE_EXP, expo: 2.0 };
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

// Vertical turn speed at full stick. Games with their own vertical setting use it; the rest turn
// vertically at PITCH_SCALE of horizontal, times an optional relative adjustment.
export function verticalRate(game, settings) {
  if (game.vsens && settings.vsens != null) return game.vsens.rate(settings.vsens);
  return game.sens.rate(settings.sens) * PITCH_SCALE * (settings.vmult ?? 1);
}

// Turns the view for one frame. `settings` is { sens, vsens?, vmult?, curve, dz, outer?, adsMult?, zoomed? }.
// Aiming down sights multiplies both axes by adsMult and uses the game's zoom look boost if it has one.
//
// settings.eng = 2 turns on the engine-2 rules: a softer exponential curve, and look boost that
// starts on a firm (not perfect) push, ignores tiny dips and has no extra delay. Without it the
// original rules apply, so challenge runs recorded before engine 2 replay exactly.
// aim = { yaw, pitch, r, vy?, vp? } is the target in play; with settings.aa (strength, 1 = medium)
// and the game's assist profile it adds aim assist (see assistTurn).
export function steer(view, input, settings, game, dt, minDz = 0, aim = null) {
  if (game.device === 'mouse') return steerMouse(view, input, settings, game, dt);
  const e2 = settings.eng >= 2;
  // kTurn scales the profile's estimated turn speed to the player's measured one (the spin-timer check).
  const kt = settings.kTurn ?? 1;
  const rate = game.sens.rate(settings.sens) * kt;
  const curve = (game.curve.fn && game.curve.fn[settings.curve]) || (e2 ? CURVE_EXP2 : CURVE_EXP)[settings.curve];
  const dz = Math.max(settings.dz, minDz), outer = settings.outer ?? 1;
  const [sx, sy, mag] = shape(input.rx, input.ry, dz, curve, outer);
  let boost = 1, vboost = 1;
  let b = settings.zoomed && game.zoomBoost ? game.zoomBoost : game.boost;
  // The player's own hip-fire boost values (percent extra speed, ramp-up seconds) override the profile's.
  if (b && !settings.zoomed && settings.boost != null) b = { ...b, mult: 1 + settings.boost / 100, ramp: settings.boostRamp ?? b.ramp };
  if (b) {
    if (e2) {
      // Push before the curve, so every curve boosts at the same stick position; dips under 0.1 s keep the ramp.
      const push = Math.min(1, Math.max(0, (Math.hypot(input.rx, input.ry) - dz) / (outer - dz)));
      if (push >= 0.9) { view.boostT += dt; view.dipT = 0; }
      else { view.dipT = (view.dipT || 0) + dt; if (view.dipT > 0.1) view.boostT = 0; }
    } else view.boostT = mag >= 0.95 ? view.boostT + dt : 0;
    const ramp = clamp((view.boostT - (e2 ? 0 : BOOST_DELAY)) / (b.ramp ?? BOOST_RAMP), 0, 1);
    boost = 1 + (b.mult - 1) * ramp;
    vboost = 1 + ((b.vmult ?? 1) - 1) * ramp;
  }
  const ads = settings.adsMult ?? 1;
  let vy = sx * rate * boost * ads, vp = -sy * verticalRate(game, settings) * kt * vboost * ads;
  if (aim && settings.aa && game.assist) [vy, vp] = assistTurn(vy, vp, mag, view, aim, game.assist, settings.aa);
  view.yaw += vy * dt;
  view.pitch = clamp(view.pitch + vp * dt, -40, 40);
  return { vy, vp, mag };
}

/* ---------- aim assist ---------- */

// Console-style aim assist. Inside a window around the target (win x its radius, easing in from the
// edge) the turn slows by up to `slow`, and while the stick is in use the view also follows a
// moving target at `rot` of its speed. Strengths aren't published by any studio; profiles hold
// estimates, scaled by the player's strength setting (aa: 0.6 low, 1 medium, 1.4 high).
// Only sim state goes in, so it is deterministic and replays exactly.
export function assistWeight(e, r, win) {
  const outer = r * win;
  if (e <= r) return 1;
  if (e >= outer) return 0;
  const x = (outer - e) / (outer - r);
  return x * x * (3 - 2 * x);
}
export function assistTurn(vy, vp, mag, view, aim, A, aa) {
  const w = assistWeight(angleTo(view, aim), aim.r, A.win);
  if (!w) return [vy, vp];
  const f = Math.max(0.1, 1 - A.slow * aa * w);
  vy *= f; vp *= f;
  if (mag > 0) { vy += A.rot * aa * w * (aim.vy || 0); vp += A.rot * aa * w * (aim.vp || 0); }
  return [vy, vp];
}

// The strafing target as an aim-assist target: where it is and how fast it moves.
export function trackAim(TR) {
  const g = TR.tgt;
  return { yaw: g.yaw, pitch: g.pitch, r: TR.r, vy: g.v, vp: 3 * TR.scale * 1.3 * Math.cos(TR.t * 1.3) };
}

// True angle between the view and a target, in degrees: a sideways gap counts for less when looking
// up or down, as it does on screen. (The original hit test used the plain yaw/pitch difference.)
export function angleTo(view, t) {
  const c = Math.cos(((view.pitch + t.pitch) / 2) * Math.PI / 180);
  return Math.hypot((view.yaw - t.yaw) * c, view.pitch - t.pitch);
}

// Speed (degrees per second) that counts as a full push for a mouse, so flick segmentation and the
// turn drill read a mouse's movement on the same 0..1 scale as a stick's.
export const MOUSE_FULL = 150;

// A mouse turns by counts x degrees per count, the same on both axes (no curve, deadzone or boost).
// input = { mx, my } counts since the last step; +my is the mouse moving toward the player (look down).
// settings.dpc, when set, is the degrees per count to use as is: challenge runs carry it so a replay
// (in the browser or on the server) needs no knowledge of the player's mouse or calibration.
export function steerMouse(view, input, settings, game, dt) {
  const dpc = (settings.dpc ?? game.sens.rate(settings.sens)) * (settings.adsMult ?? 1);
  const dy = (input.mx || 0) * dpc, dp = -(input.my || 0) * dpc * (settings.vmult ?? 1);
  view.yaw += dy;
  view.pitch = clamp(view.pitch + dp, -40, 40);
  const vy = dt ? dy / dt : 0, vp = dt ? dp / dt : 0;
  return { vy, vp, mag: Math.min(1, Math.hypot(vy, vp) / MOUSE_FULL) };
}

/* ---------- flick trials ---------- */

// A vertical target sits mostly above or below (within 25 degrees of straight up or down),
// on whichever side has room. The rest sit left or right, up to 50 degrees off horizontal, so the
// two groups never overlap when vertical aim is scored separately.
// `scale` shrinks distance and size for aiming down sights at range (1 / zoom).
// `trueAngle` = use the true-angle hit test (engine 2).
export function newFlickTarget(view, rng = Math.random, vertical = false, scale = 1, trueAngle = false) {
  let yaw, pitch;
  if (vertical) {
    const up = view.pitch > 5 ? false : view.pitch < -5 ? true : rng() < 0.5;
    const ang = (up ? 1 : -1) * Math.PI / 2 + (rng() - 0.5) * (50 * Math.PI / 180);
    const dist = (10 + rng() * 12) * scale;
    yaw = view.yaw + Math.cos(ang) * dist;
    pitch = clamp(view.pitch + Math.sin(ang) * dist, -30, 30);
  } else {
    const ang = (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * (100 * Math.PI / 180);
    const dist = (12 + rng() * 24) * scale;
    yaw = view.yaw + Math.cos(ang) * dist;
    // Mirror rather than clamp when the target would leave the play band, so a player already looking
    // up or down doesn't get a squashed, mostly vertical target.
    let dp = Math.sin(ang) * dist * 0.6;
    if (Math.abs(view.pitch + dp) > 30) dp = -dp;
    pitch = clamp(view.pitch + dp, -30, 30);
  }
  const dy = yaw - view.yaw, dp = pitch - view.pitch, D = Math.hypot(dy, dp);
  const r = (1.8 + rng() * 1.2) * scale;
  return {
    yaw, pitch, r, W: 2 * r, D, sy: view.yaw, sp: view.pitch, ux: dy / D, uy: dp / D, ang: trueAngle,
    maxProj: 0, segs: 0, active: false, shots: 0, t: 0, hit: false, overshoot: false, first: null
  };
}

/* ---------- turn-around trials ---------- */

// A target 90-170 degrees to one side, so the turn needs full stick (and look boost, where the game has it).
export function newTurnTarget(view, rng = Math.random, side = 1, ang = false) {
  const yaw = view.yaw + side * (90 + rng() * 80);
  const pitch = clamp(view.pitch + (rng() - 0.5) * 10, -30, 30);
  const dy = yaw - view.yaw, dp = pitch - view.pitch, D = Math.hypot(dy, dp);
  const r = 3;
  return {
    yaw, pitch, r, W: 2 * r, D, sy: view.yaw, sp: view.pitch, ux: dy / D, uy: dp / D, ang,
    maxProj: 0, segs: 0, active: false, shots: 0, t: 0, hit: false, overshoot: false, first: null,
    turn: true, reachT: null, fullT: 0, stintT: 0, maxStint: 0
  };
}

export const REACH_DEG = 10;
// Before the crosshair first gets within REACH_DEG: time at full stick and the longest unbroken full push.
// Call before flickStep each frame.
export function turnStep(T, view, mag, dt) {
  if (T.reachT != null) return;
  if (mag >= 0.95) { T.fullT += dt; T.stintT += dt; T.maxStint = Math.max(T.maxStint, T.stintT); }
  else T.stintT = 0;
  if (Math.hypot(view.yaw - T.yaw, view.pitch - T.pitch) < REACH_DEG) T.reachT = T.t + dt;
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
    if ((T.ang ? angleTo(view, T) : Math.hypot(view.yaw - T.yaw, view.pitch - T.pitch)) <= T.r) { T.hit = true; return finish(T, view, 'hit'); }
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
// `scale` (1 / zoom) shrinks the target and its movement for aiming down sights at range.
// Strafing target movement. V1 is the original (fast, frequent random reversals); V2 is calmer, about
// a 4 m/s strafer at 6-25 m, reversing on about a third of its changes, and uses the true-angle test.
export const TRACK_V1 = { lo: 18, span: 50, segLo: 0.6, segSpan: 1.1, rev: null, ang: false };
export const TRACK_V2 = { lo: 10, span: 30, segLo: 0.8, segSpan: 1.2, rev: 0.35, ang: true };
export function makeTrack(warm = 0, scale = 1, P = TRACK_V1) {
  return {
    t: 0, warm, scale, P, r: 2.6 * scale, T: 0, errSum: 0, chunks: [], chunk: { sum: 0, time: 0 },
    on: 0, behind: 0, ahead: 0, near: 0, rev: 0, tRev: 0, last: 0,
    tgt: { yaw: 0, pitch: 0, v: 0, goal: 0, next: 0.4, on: false }
  };
}

export function trackStep(TR, view, vy, dt, rng = Math.random) {
  const g = TR.tgt;
  TR.t += dt;
  const P = TR.P || TRACK_V1;
  if (TR.t >= g.next) {
    // Same three draws in both versions: direction, speed, duration.
    const d = rng();
    const sign = P.rev == null ? (d < 0.5 ? -1 : 1) : (d < P.rev ? -1 : 1) * (Math.sign(g.v) || 1);
    g.goal = sign * (P.lo + rng() * P.span) * TR.scale;
    g.next = TR.t + P.segLo + rng() * P.segSpan;
  }
  const prevV = g.v;
  g.v += (g.goal - g.v) * Math.min(1, dt * 4);
  g.yaw += g.v * dt;
  g.pitch = (TR.pitch0 ?? 0) + 3 * TR.scale * Math.sin(TR.t * 1.3);
  const ey = view.yaw - g.yaw, ep = view.pitch - g.pitch, e = P.ang ? angleTo(view, g) : Math.hypot(ey, ep);
  g.on = e <= TR.r;
  if (TR.t <= TR.warm) return;

  TR.T += dt;
  TR.errSum += e * dt;
  TR.chunk.sum += e * dt; TR.chunk.time += dt;
  if (TR.chunk.time >= 1) { TR.chunks.push(TR.chunk.sum / TR.chunk.time); TR.chunk = { sum: 0, time: 0 }; }
  if (prevV && g.v && Math.sign(prevV) !== Math.sign(g.v)) TR.tRev++;
  if (g.on) TR.on += dt;
  else if (Math.abs(g.v) > 6 * TR.scale) { if (ey * Math.sign(g.v) < 0) TR.behind += dt; else TR.ahead += dt; }
  if (e < 5 * TR.scale) {
    TR.near += dt;
    if (Math.abs(vy) > 6 * TR.scale) {
      const sg = Math.sign(vy);
      if (TR.last && sg !== TR.last) TR.rev++;
      TR.last = sg;
    }
  }
}
