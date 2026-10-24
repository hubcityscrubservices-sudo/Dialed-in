import { angleTo } from './sim.js';
import { mean } from './util.js';

// Dodge-roll drill: fire, roll, get back on target, fire again, as top ARC Raiders players do.
// Timings come from a frame-by-frame look at a controller tutorial clip (about 20 fps steps, so
// ±0.05 s): the roll takes about 0.45 s from going down to being back up, the roll starts about
// 0.25 s after a shot, the next shot comes about 0.27 s after landing, and a full loop takes about
// 1.0 s. Through the roll the camera keeps facing forward and the target shifts only a few degrees: a
// closer look at the screen centre shows a dummy about 10-15 m away sliding about 7 degrees across the
// view during one roll, the horizon staying level, and the crosshair dot staying visible but fainter.
// The roll moves the player sideways, so the target slides across the view by atan(shift / distance):
// about 9 degrees at 10 m, 4 degrees at 25 m. Shooting is locked while rolling. On controller the roll
// is a double press of crouch (Circle / B), within DOUBLE seconds.
export const ROLL = {
  seconds: 45, rollT: 0.45, shift: 1.6, dists: [10, 14, 18, 25], r: 1.4, double: 0.3,
  drift: 3, driftT: 1.5,
  pro: { loop: 1.0, snap: 0.27, commit: 0.25 }
};

export function makeRollDrill(rng = Math.random, P = ROLL) {
  return { P, rng, t: 0, done: false, T: { yaw: 0, pitch: 0, r: P.r }, d: P.dists[0], di: 0,
    roll: null, lastPress: -1, lastHit: null, lastLand: null, lastRollEnd: null,
    driftV: 0, driftNext: 0, rollIdle: 0, rollTime: 0, side: 1,
    shots: [], loops: [], rolls: 0, hits: 0, misses: 0 };
}

// One frame, after the view has turned. inp = { fireEdge, rollPress (edge of the roll button), rollNow (the
// on-screen ROLL button: one tap rolls), lx, stick }
// where stick is how far the right stick is pushed (0..1), for "was the thumb on the stick while rolling".
export function rollStep(D, view, inp, dt) {
  const P = D.P;
  if (D.done) return null;
  D.t += dt;
  // The enemy drifts slowly side to side.
  if (D.t >= D.driftNext) { D.driftV = (D.rng() * 2 - 1) * P.drift; D.driftNext = D.t + P.driftT * (0.6 + D.rng() * 0.8); }
  D.T.yaw += D.driftV * dt;
  let ev = null;
  if (D.roll) {
    const R = D.roll, prev = R.k;
    R.t += dt;
    // Ease in and out: the view slides as the character tumbles sideways.
    R.k = Math.min(1, R.t / P.rollT);
    const ease = k => k * k * (3 - 2 * k);
    D.T.yaw += (ease(R.k) - ease(prev)) * R.shiftDeg;
    D.rollTime += dt;
    if (inp.stick < 0.15) D.rollIdle += dt;
    if (R.k >= 1) { D.lastDir = -Math.sign(R.shiftDeg) || 1; D.roll = null; D.lastLand = D.t; ev = 'land'; }
  } else if (inp.rollPress || inp.rollNow) {
    if (inp.rollNow || D.t - D.lastPress <= P.double) {
      // The roll goes the way the left stick points, or alternates when it's centred.
      const dir = Math.abs(inp.lx) > 0.3 ? Math.sign(inp.lx) : (D.side = -D.side);
      D.d = P.dists[D.di++ % P.dists.length];
      const shiftDeg = Math.atan(P.shift / D.d) * 180 / Math.PI;
      // Rolling right moves you right, so the target slides left in view.
      D.roll = { t: 0, k: 0, shiftDeg: -dir * shiftDeg, after: D.lastHit != null && D.lastHit > (D.lastLand ?? -1) ? D.t - D.lastHit : null };
      D.rolls++;
      D.lastPress = -1;
      ev = 'roll';
    } else D.lastPress = D.t;
  }
  if (inp.fireEdge && !D.roll) {
    const hit = angleTo(view, D.T) <= D.T.r;
    const afterLand = D.lastLand != null && D.shots.every(s => s.t < D.lastLand) ? D.t - D.lastLand : null;
    D.shots.push({ t: D.t, hit, afterLand });
    if (hit) {
      D.hits++;
      // A loop: hit, roll, first shot after landing hits.
      if (afterLand != null && D.prevHit != null && D.prevHit < D.lastLand) D.loops.push({ loop: D.t - D.prevHit, snap: afterLand, commit: D.commit });
      D.prevHit = D.t; D.lastHit = D.t;
    } else D.misses++;
    ev = hit ? 'hit' : 'miss';
  }
  if (ev === 'roll' && D.roll.after != null) D.commit = D.roll.after;
  if (D.t >= P.seconds && !D.roll) D.done = true;
  return ev;
}

// Loop time (hit to hit through a roll), snap (landing to the first shot), commit (hit to roll start),
// how often the first shot after a roll hit, and how much of the roll the right stick sat still.
export function rollSummary(D) {
  const firsts = D.shots.filter(s => s.afterLand != null);
  const L = D.loops;
  return {
    loops: L.length, rolls: D.rolls, hits: D.hits, misses: D.misses,
    loop: L.length ? mean(L.map(l => l.loop)) : null,
    snap: L.length ? mean(L.map(l => l.snap)) : null,
    commit: L.filter(l => l.commit != null).length ? mean(L.filter(l => l.commit != null).map(l => l.commit)) : null,
    firstHit: firsts.length ? firsts.filter(s => s.hit).length / firsts.length : null,
    idle: D.rollTime ? D.rollIdle / D.rollTime : null,
    perMin: D.hits / (D.P.seconds / 60)
  };
}
