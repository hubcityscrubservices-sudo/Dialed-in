import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, steer, makeView, newFlickTarget, flickStep, makeTrack, trackStep } from '../src/sim.js';
import { flickThroughput, recommend, summarize, driftDeadzone, recommendVertical, isVertical, settingsChanged } from '../src/analysis.js';
import { verifyPlan, verifyCompare } from '../src/verify.js';
import { GAMES } from '../src/games.js';
import { mulberry32 } from '../src/util.js';

const trial = (D, along, t) => ({ D, first: { along, t } });

test('shape: inside the deadzone is zero, full deflection is full output', () => {
  assert.deepEqual(shape(0.05, 0, 0.1, 1.8), [0, 0, 0]);
  const [x, , m] = shape(1, 0, 0.1, 1.8);
  assert.equal(x, 1); assert.equal(m, 1);
  // A curve with a higher exponent gives less output for the same half push.
  assert.ok(shape(0.5, 0, 0.1, 2.5)[2] < shape(0.5, 0, 0.1, 1)[2]);
});

test('steer: look boost speeds up turning only after holding full stick', () => {
  const game = GAMES.arc, s = { sens: 100, curve: 'linear', dz: 0.05 };
  const v = makeView();
  const first = steer(v, { rx: 1, ry: 0 }, s, game, 0.05).vy;
  for (let i = 0; i < 20; i++) steer(v, { rx: 1, ry: 0 }, s, game, 0.05);
  const mid = steer(v, { rx: 1, ry: 0 }, s, game, 0.05).vy; // still ramping at 1 s
  for (let i = 0; i < 40; i++) steer(v, { rx: 1, ry: 0 }, s, game, 0.05);
  const later = steer(v, { rx: 1, ry: 0 }, s, game, 0.05).vy;
  assert.ok(mid > first && mid < later);
  assert.ok(Math.abs(later / first - 1.55) < 1e-9);
  // Games without boost turn at a constant rate.
  const w = makeView();
  const a = steer(w, { rx: 1, ry: 0 }, { sens: 6, curve: 'mid', dz: 0.1 }, GAMES.cod, 0.05).vy;
  for (let i = 0; i < 20; i++) steer(w, { rx: 1, ry: 0 }, { sens: 6, curve: 'mid', dz: 0.1 }, GAMES.cod, 0.05);
  assert.equal(steer(w, { rx: 1, ry: 0 }, { sens: 6, curve: 'mid', dz: 0.1 }, GAMES.cod, 0.05).vy, a);
});

test('flick trial records first-shot endpoint and overshoot', () => {
  const view = makeView();
  const T = newFlickTarget(view, mulberry32(1));
  // Jump past the target, fire (miss), come back and hit.
  view.yaw = T.sy + T.ux * (T.D + 3 * T.r); view.pitch = T.sp + T.uy * (T.D + 3 * T.r);
  assert.equal(flickStep(T, view, 1, true, 0.3), 'miss');
  assert.ok(T.first.along > T.D);
  view.yaw = T.yaw; view.pitch = T.pitch;
  assert.equal(flickStep(T, view, 0.5, true, 0.2), 'hit');
  assert.equal(T.overshoot, true);
  assert.equal(T.shots, 2);
});

test('flick trial times out with an endpoint', () => {
  const view = makeView();
  const T = newFlickTarget(view, mulberry32(2));
  assert.equal(flickStep(T, view, 0, false, 5), 'timeout');
  assert.ok(Math.abs(T.first.along) < 1e-9);
});

test('throughput rewards speed and penalizes scatter', () => {
  const tight = [trial(20, 20.2, 0.6), trial(30, 29.7, 0.7), trial(25, 25.1, 0.65), trial(15, 14.8, 0.5)];
  const slow = tight.map(t => trial(t.D, t.first.along, t.first.t * 1.5));
  const loose = [trial(20, 23, 0.6), trial(30, 26, 0.7), trial(25, 28, 0.65), trial(15, 12, 0.5)];
  assert.ok(flickThroughput(tight) > flickThroughput(slow));
  assert.ok(flickThroughput(tight) > flickThroughput(loose));
  assert.equal(flickThroughput(tight.slice(0, 2)), null);
});

const base = { throughput: 3, hitRate: 0.8, avgTime: 0.8, trackErr: 3, onTarget: 0.5, jitter: 0 };
const cfg = { game: 'cod', style: 'balanced', sens: 6, curve: 'mid', dz: 0.1 };

test('recommend: overshooting and running ahead lowers sensitivity', () => {
  const r = recommend({ ...base, over: 0.6, under: 0.1, behind: 0.1, ahead: 0.5 }, cfg, null);
  assert.ok(r.sens < 6);
  assert.equal(r.curve, 'expo');
  assert.equal(r.dz, 0.1);
  assert.equal(r.dzMeasured, false);
});

test('recommend: stopping short and trailing raises sensitivity', () => {
  const r = recommend({ ...base, over: 0.1, under: 0.6, behind: 0.6, ahead: 0.1 }, cfg, null);
  assert.ok(r.sens > 6);
  assert.equal(r.curve, 'linear');
});

test('recommend: balanced errors keep the setting', () => {
  const r = recommend({ ...base, over: 0.3, under: 0.3, behind: 0.3, ahead: 0.3 }, cfg, null);
  assert.equal(r.sens, 6);
  assert.equal(r.curve, 'mid');
});

test('recommend: never suggests a curve the menu shows the same as the current one', () => {
  const fortnite = { ...cfg, game: 'fortnite', sens: 45 };
  const r = recommend({ ...base, over: 0.6, under: 0.1, behind: 0.1, ahead: 0.5 }, fortnite, null);
  assert.equal(r.curve, 'mid'); // Fortnite shows both softer slots as "Exponential"
  assert.match(r.curveWhy, /so keep it/);
});

test('recommend: deadzone follows measured drift unless the menu cannot show the change', () => {
  const drift = { r: 0.04, l: 0.02, rec: driftDeadzone(0.04) };
  assert.equal(drift.rec, 0.07);
  assert.equal(recommend({ ...base, over: 0.3, under: 0.3, behind: 0.3, ahead: 0.3 }, cfg, drift).dz, 0.07);
  const apex = { ...cfg, game: 'apex', sens: 3 };
  // 0.07 and 0.10 both show as "Small" in Apex, so keep the current value.
  assert.equal(recommend({ ...base, over: 0.3, under: 0.3, behind: 0.3, ahead: 0.3 }, apex, drift).dz, 0.1);
});

test('tracking skips warm-up time and records one-second chunks', () => {
  const TR = makeTrack(1.5);
  const view = makeView();
  const rng = mulberry32(3);
  for (let i = 0; i < 300; i++) trackStep(TR, view, 0, 1 / 60, rng);
  assert.ok(Math.abs(TR.T - 3.5) < 0.02);
  assert.equal(TR.chunks.length, 3);
  const s = summarize([], TR);
  assert.ok(s.trackErr > 0);
});

test('verifyPlan is counterbalanced', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const plan = verifyPlan('a', 'b', mulberry32(seed));
    const keys = plan.map(p => p.key).join('');
    assert.ok(keys === 'ABBA' || keys === 'BAAB');
    assert.equal(plan.find(p => p.key === 'A').settings, 'a');
  }
});

function fakeSide(rng, speed, scatter, err) {
  const flicks = [], chunks = [];
  for (let i = 0; i < 12; i++) {
    const D = 12 + rng() * 24;
    flicks.push(trial(D, D + (rng() - 0.5) * scatter, speed * (0.8 + rng() * 0.4)));
  }
  for (let i = 0; i < 14; i++) chunks.push(err * (0.8 + rng() * 0.4));
  return { flicks, chunks };
}

test('verifyCompare: clearly better settings read as better', () => {
  const rng = mulberry32(7);
  const data = { A: fakeSide(rng, 0.9, 6, 4), B: fakeSide(rng, 0.6, 3, 2.5) };
  const v = verifyCompare(data, { wf: 0.5, wt: 0.5 }, mulberry32(8), 1000);
  assert.equal(v.verdict, 'better');
  assert.ok(v.flick.delta > 0 && v.track.delta > 0);
});

test('verifyCompare: same settings read as too close to call', () => {
  const rng = mulberry32(9);
  const side = fakeSide(rng, 0.7, 4, 3);
  const v = verifyCompare({ A: side, B: side }, { wf: 0.5, wt: 0.5 }, mulberry32(10), 1000);
  assert.equal(v.verdict, 'close');
});

test('verifyCompare: worse settings read as worse', () => {
  const rng = mulberry32(11);
  const data = { A: fakeSide(rng, 0.6, 3, 2.5), B: fakeSide(rng, 0.9, 6, 4) };
  assert.equal(verifyCompare(data, { wf: 0.5, wt: 0.5 }, mulberry32(12), 1000).verdict, 'worse');
});

test('verifyCompare: a side that scores zero throughput still compares', () => {
  const rng = mulberry32(13);
  const stuck = { flicks: Array.from({ length: 10 }, () => trial(20, 0, 4)), chunks: Array(12).fill(40) };
  const v = verifyCompare({ A: stuck, B: fakeSide(rng, 0.7, 4, 3) }, { wf: 0.5, wt: 0.5 }, mulberry32(14), 500);
  assert.equal(v.verdict, 'better');
  assert.ok(v.flick.delta > 0);
});

test('ARC Raiders curves: linear, sinusoidal S-curve, exponential', () => {
  const g = GAMES.arc;
  assert.deepEqual([g.curve.linear, g.curve.mid, g.curve.expo], ['Linear', 'Sinusoidal', 'Exponential']);
  assert.equal(g.curve.def, 'expo');
  const sin = g.curve.fn.mid;
  assert.equal(sin(0), 0); assert.ok(Math.abs(sin(1) - 1) < 1e-12); assert.ok(Math.abs(sin(0.5) - 0.5) < 1e-12);
  // Softer than linear near center, quicker than the exponential slot through the middle.
  assert.ok(sin(0.15) < 0.15);
  assert.ok(sin(0.4) > shape(0.4, 0, 0, 2.5)[2]);
  // The range uses the game's own shape for that slot.
  const v = makeView();
  const vy = steer(v, { rx: 0.4, ry: 0 }, { sens: 100, curve: 'mid', dz: 0 }, g, 0.05).vy;
  assert.ok(Math.abs(vy - sin(0.4) * g.sens.rate(100)) < 1e-9);
});

test('recommend keeps the current curve when there is no clear pattern', () => {
  const arc = { ...cfg, game: 'arc', sens: 80, curve: 'expo' };
  const r = recommend({ ...base, over: 0.3, under: 0.3, behind: 0.3, ahead: 0.3 }, arc, null);
  assert.equal(r.curve, 'expo');
});

test('recommend says so when the current curve already matches the advice', () => {
  const arc = { ...cfg, game: 'arc', sens: 80, curve: 'expo' };
  const r = recommend({ ...base, over: 0.6, under: 0.1, behind: 0.1, ahead: 0.5 }, arc, null);
  assert.equal(r.curve, 'expo');
  assert.match(r.curveWhy, /current Exponential curve already does that/);
});

// Flick records with a direction and an outcome.
const fl = (vertical, outcome) => ({ uy: vertical ? 0.95 : 0.2, overshoot: outcome === 'over', hit: outcome !== 'miss', segs: outcome === 'short' ? 3 : 1 });
const mix = (vOut, hOut) => [...vOut.map(o => fl(true, o)), ...hOut.map(o => fl(false, o))];

test('vertical targets sit mostly above or below', () => {
  const rng = mulberry32(31);
  for (let i = 0; i < 50; i++) {
    const view = { yaw: 0, pitch: (rng() - 0.5) * 30, boostT: 0 };
    const T = newFlickTarget(view, rng, true);
    assert.ok(isVertical(T), `uy ${T.uy}`);
    assert.ok(T.D >= 8, `D ${T.D}`);
  }
});

test('vertical speed: overshooting only up and down lowers vertical relative to horizontal', () => {
  const c = { ...cfg, game: 'arc', sens: 80, vsens: 60 };
  const r = recommendVertical(mix(['over', 'over', 'over', 'ok'], ['ok', 'ok', 'short', 'over', 'ok']), c, 80);
  assert.ok(r.vsens < 60);
  assert.equal(r.vMeasured, true);
  assert.match(r.vWhy, /runs ahead/);
});

test('vertical speed: stopping short only up and down raises it', () => {
  const c = { ...cfg, game: 'cod', sens: 6, vsens: 6 };
  const r = recommendVertical(mix(['short', 'short', 'miss', 'ok'], ['ok', 'ok', 'over', 'ok', 'short']), c, 6);
  assert.ok(r.vsens > 6);
});

test('vertical speed follows the horizontal change when the patterns match', () => {
  const c = { ...cfg, game: 'arc', sens: 80, vsens: 60 };
  const r = recommendVertical(mix(['ok', 'over', 'short', 'ok'], ['ok', 'over', 'short', 'ok']), c, 100);
  assert.equal(r.vsens, 75); // 60 * 100/80
  assert.match(r.vWhy, /follows your horizontal change/);
});

test('games without a vertical setting get a relative adjustment', () => {
  const c = { ...cfg, game: 'fortnite', sens: 45 };
  const r = recommendVertical(mix(['over', 'over', 'over'], ['ok', 'ok', 'ok']), c, 45);
  assert.equal(r.vsens, undefined);
  assert.ok(r.vmult < 1);
  const few = recommendVertical(mix(['over'], ['ok', 'ok', 'ok']), c, 45);
  assert.equal(few.vMeasured, false);
  assert.equal(few.vmult, 1);
});

test('vertical changes count as a settings change', () => {
  assert.ok(settingsChanged({ ...cfg, vsens: 60 }, { ...cfg, vsens: 55 }));
  assert.ok(!settingsChanged({ ...cfg, vmult: 1 }, { ...cfg, vmult: 1.005 }));
});

test('ARC Raiders turns vertically at its own setting, boosted by Vertical Look Boost', () => {
  const g = GAMES.arc, s = { sens: 80, vsens: 60, curve: 'linear', dz: 0 };
  const v = makeView();
  const first = steer(v, { rx: 0, ry: -1 }, s, g, 0.05).vp;
  assert.ok(Math.abs(first - g.vsens.rate(60)) < 1e-9);
  for (let i = 0; i < 60; i++) steer(v, { rx: 0, ry: -1 }, s, g, 0.05);
  assert.ok(Math.abs(steer(v, { rx: 0, ry: -1 }, s, g, 0.05).vp / first - 1.15) < 1e-9);
});

test('ordinary targets stay mostly sideways even when the player is looking up or down', () => {
  const rng = mulberry32(41);
  let vertical = 0, short = 0;
  for (let i = 0; i < 2000; i++) {
    const view = { yaw: 0, pitch: (rng() - 0.5) * 80, boostT: 0 };
    const T = newFlickTarget(view, rng, false);
    if (isVertical(T)) vertical++;
    if (T.D < 8) short++;
  }
  assert.equal(vertical, 0);
  assert.ok(short / 2000 < 0.01, `short share ${short / 2000}`);
});
