import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTrack, trackStep, trackScript, flickPlan, newFlickTarget, flickStep, TRACK_V2, FLICK_PLAN } from '../src/sim.js';
import { acquireRate, pathEfficiency } from '../src/analysis.js';
import { roundScores } from '../src/deep.js';
import { mulberry32 } from '../src/util.js';

const P = { ...TRACK_V2, accel: 7, vAmp: 4.5, vFreq: 1.6 };

test('scripted tracking rounds of the same length are equally hard: same reversals, stops and speeds', () => {
  const play = seed => {
    const rng = mulberry32(seed), TR = makeTrack(1.5, 1, P);
    TR.script = trackScript(rng, 9.5, P);
    const view = { yaw: 0, pitch: 0 };
    while (TR.t < 9.5) trackStep(TR, view, 0, 1 / 60, rng);
    const s = TR.script;
    return { rev: TR.tRev, stops: s.filter(x => x.goal === 0).length, speeds: s.filter(x => x.goal).map(x => Math.abs(x.goal)).sort((a, b) => a - b), total: s.reduce((a, x) => a + x.dur, 0) };
  };
  const a = play(1), b = play(2), c = play(3);
  assert.deepEqual(a.speeds, b.speeds);
  assert.equal(a.stops, b.stops);
  assert.ok(a.stops >= 1);
  for (const r of [a, b, c]) { assert.ok(Math.abs(r.rev - a.rev) <= 1, JSON.stringify([a.rev, b.rev, c.rev])); assert.ok(r.total >= 9.5 - 0.4); }
  assert.ok(a.rev >= 3);
});

test('flick rounds get one target from each distance and size layer, warm-up first', () => {
  const isVert = i => i % 5 === 1 || i % 5 === 3;
  const plan = flickPlan(mulberry32(4), 9, 1, isVert);
  assert.equal(plan.length, 9);
  assert.equal(plan[0].bands[0][0], FLICK_PLAN.warm.d);
  const side = plan.slice(1).filter((_, k) => !isVert(k + 1)).map(p => p.bands[0][0]).sort((x, y) => x - y);
  const [lo, hi] = FLICK_PLAN.side, w = (hi - lo) / side.length;
  side.forEach((d, i) => assert.ok(d >= lo + w * i - 1e-9 && d <= lo + w * (i + 1) + 1e-9, `${d} in layer ${i}`));
  // The target really lands at the planned distance and size.
  const T = newFlickTarget({ yaw: 0, pitch: 0 }, mulberry32(9), false, 1, true, 1, plan[2]);
  // Sideways targets keep the existing shape: the planned distance along a slant, flattened up and down.
  assert.ok(T.D <= plan[2].bands[0][0] + 1e-9 && T.D >= plan[2].bands[0][0] * 0.6);
  assert.equal(T.r, plan[2].r[0]);
});

test('settle rate and path efficiency: circling, misses and detours cost', () => {
  const T = (o = {}) => ({ D: 30, W: 4, t: 1, hit: true, shots: 1, lastIn: 0.8, path: 31, ...o });
  const clean = [T(), T(), T(), T()];
  const circled = [T({ lastIn: 0.95, path: 45 }), T(), T({ lastIn: 0.95, path: 45 }), T()];
  const missed = [T({ shots: 3 }), T(), T(), T()];
  assert.ok(acquireRate(clean) > acquireRate(circled));
  assert.ok(acquireRate(clean) > acquireRate(missed));
  assert.ok(pathEfficiency(clean) > pathEfficiency(circled));
  assert.equal(acquireRate([{ D: 30, W: 4, first: { t: 1, along: 30 } }, {}, {}]), null); // older saved rounds: not measured
  // A flick trial records its final entry and path as it plays.
  const F = newFlickTarget({ yaw: 0, pitch: 0 }, mulberry32(1), false, 1, true);
  const view = { yaw: 0, pitch: 0 };
  for (let i = 0; i < 30 && !F.inside; i++) { view.yaw += (F.yaw - view.yaw) * 0.3; view.pitch += (F.pitch - view.pitch) * 0.3; flickStep(F, view, 0.5, false, 1 / 60); }
  assert.ok(F.inside && F.lastIn > 0 && F.path >= F.D - F.r - 0.5, JSON.stringify([F.path, F.D, F.r]));
});

test('round scores use the new flick measures when every round has them', () => {
  const trials = (lastIn, path) => Array.from({ length: 6 }, (_, i) => ({ D: 30, W: 4, t: 1, hit: true, shots: 1, lastIn, path, first: { t: 1, along: 30 + (i % 2 ? 0.5 : -0.5) } }));
  const w = { wf: 1, wt: 0 };
  const ys = roundScores([{ flicks: trials(0.7, 31), chunks: [2] }, { flicks: trials(0.95, 45), chunks: [2] }], w);
  assert.ok(ys[0] > ys[1], JSON.stringify(ys));
});
