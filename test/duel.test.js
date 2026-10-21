import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChallenge, step, summary, quantize } from '../src/challenge.js';
import { duelPlan, duelCompare, runToRound, DUEL } from '../src/duel.js';
import { reportCard } from '../src/report.js';
import { mulberry32 } from '../src/util.js';

const base = { sens: 80, vsens: 60, curve: 'linear', dz: 0.05, outer: 1, boost: 55, boostRamp: 1.6 };

// Aims at the current target with gain `k` (per degree), reacting `react` ticks after a new target.
function play(code, settings, { k = 0.05, react = 12, seed = 1, seconds = DUEL.seconds, vk = k } = {}) {
  const st = createChallenge(code, 'arc', settings, { seconds });
  const rng = mulberry32(seed);
  let wait = 0, last = null;
  while (!st.done) {
    const it = st.item, tgt = it.kind === 'track' ? it.TR.tgt : it.T;
    if (tgt !== last) { last = tgt; wait = react; }
    let rx = 0, ry = 0, fire = false;
    if (wait > 0) wait--;
    else {
      const ey = tgt.yaw - st.view.yaw, ep = tgt.pitch - st.view.pitch;
      rx = quantize(Math.max(-1, Math.min(1, ey * k + (rng() - 0.5) * 0.05)));
      ry = quantize(Math.max(-1, Math.min(1, -ep * vk + (rng() - 0.5) * 0.05)));
      const r = it.kind === 'track' ? it.TR.r : it.T.r;
      fire = it.kind !== 'track' && Math.hypot(ey, ep) < r * 0.8 && !st.prevFire;
    }
    step(st, rx, ry, fire);
  }
  return st;
}

test('duel plan: ABBA or BAAB, two codes, each setting on both codes', () => {
  for (const seed of [1, 2, 3, 4]) {
    const plan = duelPlan(mulberry32(seed));
    const keys = plan.map(p => p.key).join('');
    assert.ok(keys === 'ABBA' || keys === 'BAAB');
    assert.equal(plan[0].code, plan[1].code);
    assert.equal(plan[2].code, plan[3].code);
    assert.notEqual(plan[0].code, plan[2].code);
  }
});

test('30-second runs stop at 30 seconds and log every finished target', () => {
  const st = play('p-abcd12', base);
  assert.equal(st.tick, 30 * 60);
  const s = summary(st);
  assert.equal(st.log.filter(i => i.kind !== 'track' && i.T.hit).length, s.hits);
  const round = runToRound(st.log);
  assert.ok(round.flicks.length >= s.hits && round.chunks.length > 0);
  // Finished targets plus the one still in play at the buzzer account for the whole score.
  assert.ok(Math.abs(st.log.reduce((a, i) => a + i.pts, 0) + st.item.pts - st.score) < 1e-6);
});

test('duel: far-too-slow old settings lose to sensible new ones', () => {
  const settings = { A: { ...base, sens: 15, vsens: 12 }, B: base };
  const runs = duelPlan(mulberry32(9)).map((p, i) => {
    const st = play(p.code, settings[p.key], { seed: i + 1 });
    return { ...p, score: summary(st).score, log: st.log };
  });
  const res = duelCompare(runs, { wf: 0.5, wt: 0.5 }, mulberry32(10));
  assert.equal(res.cmp.verdict, 'better');
  assert.ok(res.scoreDelta > 0.15, `delta ${res.scoreDelta}`);
  assert.equal(res.pairs.length, 2);
  assert.ok(res.pairs.every(p => p.b > p.a));
});

test('duel: identical settings read as too close', () => {
  const runs = duelPlan(mulberry32(11)).map((p, i) => {
    const st = play(p.code, base, { seed: i + 20 });
    return { ...p, score: summary(st).score, log: st.log };
  });
  assert.equal(duelCompare(runs, { wf: 0.5, wt: 0.5 }, mulberry32(12)).cmp.verdict, 'close');
});

test('report card splits points by kind of target and adds up to the score', () => {
  const st = play('d-2026-10-21', base, { seconds: 60 });
  const { rows } = reportCard(st.log, { game: 'arc', style: 'balanced' });
  const total = rows.side.pts + rows.vert.pts + rows.turn.pts + rows.track.pts;
  assert.ok(Math.abs(total - st.log.reduce((a, i) => a + i.pts, 0)) < 1e-6);
  assert.ok(rows.side.n > 0 && rows.vert.n > 0);
});

test('report card: weak up-and-down aim gets a vertical hint, balanced aim gets none for it', () => {
  // Weak vertical: the player barely moves the stick up or down.
  const weak = play('d-2026-10-21', base, { seconds: 60, vk: 0.008 });
  const hw = reportCard(weak.log, { game: 'arc', style: 'balanced' }).hints;
  assert.ok(hw.some(h => h.area === 'vertical'), JSON.stringify(hw));
  const even = play('d-2026-10-21', base, { seconds: 60 });
  const he = reportCard(even.log, { game: 'arc', style: 'balanced' }).hints;
  assert.ok(!he.some(h => h.area === 'vertical'), JSON.stringify(he));
});

test('report card: synthetic turn overshoots suggest less look boost', () => {
  const turnT = past => ({ D: 150, W: 6, t: 0.9, hit: true, overshoot: past > 3, maxProj: 150 + past, reachT: 0.6, fullT: 0.5, maxStint: 0.5, uy: 0 });
  const log = [12, 14, 2].map(p => ({ kind: 'turn', pts: 100, T: turnT(p) }));
  const { hints } = reportCard(log, { game: 'arc', style: 'balanced' });
  assert.ok(hints.some(h => h.area === 'turn' && /too strong/.test(h.text)));
});

test('report card: no hints from a run with almost no hits, and points never go negative', () => {
  const miss = () => ({ kind: 'flick', pts: 0, T: { D: 20, W: 4, t: 3, hit: false, overshoot: false, uy: 0.2, segs: 1, maxProj: 5, first: { t: 1, along: 5 } } });
  const { rows, hints } = reportCard(Array.from({ length: 10 }, miss), { game: 'arc', style: 'balanced' });
  assert.deepEqual(hints, []);
  assert.equal(rows.side.pts, 0);
  // Firing at nothing from the start: the score and every target's points stay at zero.
  const st = createChallenge('p-zz9911', 'arc', base, { seconds: 10 });
  for (let i = 0; !st.done; i++) step(st, 0, 0, i % 20 === 0);
  assert.equal(st.score, 0);
  assert.ok(st.log.every(i => i.pts === 0));
});
