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

test('fine aim: small targets just off the crosshair, one from each distance and size layer', async () => {
  const { finePlan, FINE_PLAN } = await import('../src/sim.js');
  const plan = finePlan(mulberry32(3), 13, 1);
  assert.equal(plan.length, 13);
  assert.equal(plan[0].bands[0][0], FINE_PLAN.warm.d);
  const ds = plan.slice(1).map(p => p.bands[0][0]).sort((a, b) => a - b), w = (FINE_PLAN.d[1] - FINE_PLAN.d[0]) / 12;
  ds.forEach((d, i) => assert.ok(d >= FINE_PLAN.d[0] + w * i - 1e-9 && d <= FINE_PLAN.d[0] + w * (i + 1) + 1e-9));
  assert.ok(plan.every(p => p.r[0] >= 0.5 && p.r[0] <= 1));
});

test('fine aim decides the curve: going past small targets softens it, stopping short quickens it', async () => {
  const { fineStats, recommend, summarize } = await import('../src/analysis.js');
  const T = o => ({ D: 2, r: 0.7, W: 1.4, t: 0.6, hit: true, shots: 1, lastIn: 0.5, segs: 1, maxProj: 2.2, path: 2.1, ...o });
  const past = fineStats(Array.from({ length: 12 }, (_, i) => T(i < 6 ? { maxProj: 3.5 } : {})));
  const short = fineStats(Array.from({ length: 12 }, (_, i) => T(i < 6 ? { segs: 4 } : {})));
  const clean = fineStats(Array.from({ length: 12 }, () => T()));
  assert.ok(past.over === 0.5 && short.under === 0.5 && clean.over === 0 && clean.under === 0);
  const s = summarize([], { T: 0, on: 0, behind: 0, ahead: 0 });
  const c = { game: 'arc', style: 'balanced', sens: 80, curve: 'mid', dz: 0.05 };
  assert.equal(recommend(s, c, null, past).curve, 'expo');
  assert.equal(recommend(s, c, null, short).curve, 'linear');
  const keep = recommend(s, c, null, clean);
  assert.equal(keep.curve, 'mid');
  assert.match(keep.curveWhy, /fine-aim test/);
});

test('up-and-down strafer moves in pitch inside its band, and lean is judged along that axis', async () => {
  const { trackLean } = await import('../src/analysis.js');
  const P = { ...TRACK_V2, vertical: true, lo: 6, span: 14, band: 10, vAmp: 2, vFreq: 1.1, accel: 7 };
  const run = lag => {
    const rng = mulberry32(5), TR = makeTrack(1, 1, P);
    TR.script = trackScript(rng, 9, P);
    const view = { yaw: 0, pitch: 0 }, H = [];
    let maxP = 0;
    while (TR.t < 9) {
      H.push({ p: TR.tgt.pitch, y: TR.tgt.yaw });
      const d = H[Math.max(0, H.length - 1 - lag)];
      view.pitch = d.p; view.yaw = d.y;
      trackStep(TR, view, 0, 1 / 60, rng);
      maxP = Math.max(maxP, Math.abs(TR.tgt.pitch));
    }
    return { TR, maxP };
  };
  const exact = run(0), late = run(30);
  assert.ok(exact.maxP > 5 && exact.maxP < 11, String(exact.maxP));
  assert.ok(exact.TR.on / exact.TR.T > 0.95);
  assert.ok(trackLean(late.TR) > trackLean(exact.TR) + 0.1, `${trackLean(late.TR)} vs ${trackLean(exact.TR)}`);
});

test('vertical suggestion uses the up-and-down strafer: trailing it more than the side-to-side one raises vertical', async () => {
  const { recommendVertical } = await import('../src/analysis.js');
  const c = { game: 'arc', style: 'balanced', sens: 80, vsens: 60, curve: 'expo', dz: 0.05 };
  const up = recommendVertical([], c, 80, { lean: 0.35, hLean: 0.05 });
  const same = recommendVertical([], c, 80, { lean: 0.06, hLean: 0.05 });
  const none = recommendVertical([], c, 80, null);
  assert.ok(up.vsens > 60 && up.vMeasured, JSON.stringify(up));
  assert.equal(same.vsens, 60);
  assert.equal(none.vMeasured, false);
});
