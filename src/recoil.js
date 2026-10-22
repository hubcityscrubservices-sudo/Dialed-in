import { shape, verticalRate, curveFor } from './sim.js';
import { mean, std, settingValues, clamp } from './util.js';

// Recoil check. Aimed in at a distant target, the player holds fire for short bursts while the view
// climbs like an automatic rifle (a harder first kick, then a steady climb with a slow sideways wander)
// and pulls down to stay on target. It is a generic rifle, not any real gun: every weapon kicks
// differently and patches change them. What it measures is where on the stick the pull-down lands with
// the player's settings, and whether they under-pull, over-pull or bounce.
// Pitch is positive up; a stick's ry is positive down (steer turns ry > 0 into a downward turn).
export const RECOIL = {
  bursts: 5, warm: 1, burst: 3, settle: 0.4,
  climb: 6, kick: 14, kickT: 0.15, side: 1.6, sideStep: 0.25,
  r: 1.3, zoom: 1.5
};

export function makeRecoil(rng = Math.random, P = RECOIL) {
  const R = { P, rng, bursts: [], tries: 0, cur: null, T: { yaw: 0, pitch: 0, r: P.r }, wait: false, hv: 0, hvNext: 0 };
  return R;
}

// One frame. fire = trigger held, ry = vertical stick (after the player's own pull). A burst starts on
// a press and stops recoiling after P.burst seconds; releasing early ends it (and counts only past half
// a burst). Returns 'burst' when one ends and 'done' after the last.
export function recoilStep(R, view, fire, ry, dt) {
  const P = R.P;
  if (!R.cur) {
    if (R.wait) { if (!fire) R.wait = false; return null; }
    if (!fire) return null;
    R.cur = { t: 0, ev: [], eh: [], pull: [], early: 0 };
    R.hv = 0; R.hvNext = 0;
  }
  const B = R.cur;
  if (!fire || B.t >= P.burst) {
    if (B.t >= P.burst * 0.5) R.bursts.push(B);
    R.tries++;
    R.cur = null;
    R.wait = fire;
    // The next target: a short re-aim away, so each burst starts from a fresh settle.
    const a = R.rng() * Math.PI * 2, d = 2 + R.rng() * 2;
    R.T = { yaw: view.yaw + Math.cos(a) * d, pitch: clamp(view.pitch + Math.sin(a) * d * 0.5, -25, 25), r: P.r };
    // Bursts let go too early don't count; after three times the bursts' worth of tries it ends anyway.
    return R.bursts.length >= P.bursts || R.tries >= P.bursts * 3 ? 'done' : 'burst';
  }
  B.t += dt;
  if (B.t >= R.hvNext) { R.hv = (R.rng() * 2 - 1) * P.side; R.hvNext = B.t + P.sideStep; }
  view.pitch = clamp(view.pitch + (B.t <= P.kickT ? P.kick : P.climb) * dt, -40, 40);
  view.yaw += R.hv * dt;
  const ev = view.pitch - R.T.pitch, eh = view.yaw - R.T.yaw;
  if (B.t <= P.settle) B.early = Math.max(B.early, ev);
  else { B.ev.push(ev); B.eh.push(Math.abs(eh)); B.pull.push(ry); }
  return null;
}

// bias: mean height above the target while firing (degrees; negative = pulled below), wobble: the
// up-and-down bounce within a burst, side: mean sideways gap, early: how far the first kick carried,
// pull: the stick pull the player held. All in degrees except pull (0..1). The first burst is warm-up.
export function recoilSummary(R) {
  const bs = R.bursts.slice(R.P.warm).filter(b => b.ev.length > 10);
  if (!bs.length) return null;
  return {
    n: bs.length, r: R.P.r,
    bias: mean(bs.map(b => mean(b.ev))),
    wobble: mean(bs.map(b => std(b.ev))),
    side: mean(bs.map(b => mean(b.eh))),
    early: mean(bs.map(b => b.early)),
    pull: mean(bs.map(b => mean(b.pull)))
  };
}

// Stick output (0..1) at a push past the deadzone (0..1), with the player's curve.
function outAt(p, g, s, curve) {
  const dz = s.dz, outer = s.outer ?? 1;
  return shape(0, dz + clamp(p, 0, 1) * (outer - dz), dz, curve, outer, s.curveK ?? 1)[2];
}
// Push needed for an output, by bisection (the curve is increasing).
function pushFor(o, g, s, curve) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (outAt(m, g, s, curve) < o) lo = m; else hi = m; }
  return hi;
}

// s = the settings played (with adsMult).
// The pull a perfect player needs is fixed by the climb and the vertical speed while aimed in. The
// suggestion moves vertical speed so the pull the player naturally held would have been the right one,
// within ×0.75..×1.35, and only when the miss is clear (more than half the target's radius on average).
export const PULL = { low: 0.2, high: 0.85, factor: [0.75, 1.35] };
export function recommendRecoil(sum, g, s) {
  if (!sum) return null;
  const curve = curveFor(g, s);
  const vRate = verticalRate(g, s) * (s.kTurn ?? 1) * (s.adsMult ?? 1);
  const needOut = RECOIL.climb / vRate;
  const need = needOut >= 1 ? 1 : pushFor(needOut, g, s, curve);
  const heldPush = clamp(Math.abs(sum.pull) - s.dz, 0, 1) / ((s.outer ?? 1) - s.dz);
  const clear = Math.abs(sum.bias) > sum.r * 0.5;
  let f = 1;
  if (needOut >= 1) f = PULL.factor[1];
  // Under-pulling with a pull short of what's needed, or over-pulling past it: rescale so that pull fits.
  // (Above the target with enough pull means a late catch of the first kick, which speed won't fix.)
  else if (clear && heldPush > 0.02 && (sum.bias > 0) === (heldPush < need)) f = needOut / Math.max(1e-3, outAt(heldPush, g, s, curve));
  else if (need < PULL.low && sum.wobble > sum.r * 0.6) f = 0.85;
  f = clamp(f, PULL.factor[0], PULL.factor[1]);
  if (Math.abs(f - 1) < 0.08) f = 1;
  const out = { need, held: heldPush, f, verdict: f > 1 ? 'raise' : f < 1 ? 'lower' : 'keep' };
  // On a game with its own vertical setting, the nearest menu value to the new speed.
  if (g.vsens && s.vsens != null && f !== 1) {
    const target = g.vsens.rate(s.vsens) * f;
    let best = s.vsens, err = Infinity;
    for (const v of settingValues(g.vsens)) { const e = Math.abs(Math.log(g.vsens.rate(v) / target)); if (e < err) { err = e; best = v; } }
    out.vsens = best;
    if (best === s.vsens) { out.f = 1; out.verdict = 'keep'; }
  }
  return out;
}
