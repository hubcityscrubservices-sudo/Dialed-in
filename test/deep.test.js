import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEEP, snap, lstsq, fitCurve, peakOf, deepNext, deepAnalyze, shuffled } from '../src/deep.js';
import { GAMES } from '../src/games.js';
import { mulberry32 } from '../src/util.js';

const game = GAMES.other; // rate = 6 per step, 1..100: fine resolution
const cur = 50;
const w = { wf: 0.5, wt: 0.5 };

// A simulated player whose aim is best at speed x = peak and falls off with distance from it.
function round(x, rng, peak, steep) {
  const s = snap(x, game, cur);
  const pen = 1 + steep * (s.x - peak) ** 2;
  const flicks = [], chunks = [];
  for (let i = 0; i < 7; i++) {
    const D = 12 + rng() * 24;
    flicks.push({ D, first: { along: D + (rng() - 0.5) * 3, t: 0.6 * pen * (0.9 + rng() * 0.2) } });
  }
  for (let i = 0; i < 7; i++) chunks.push(3 * pen * (0.9 + rng() * 0.2));
  return { ...s, flicks, chunks };
}

function runSearch(seed, peak, steep) {
  const rng = mulberry32(seed);
  const order = shuffled(DEEP.initial, rng);
  const history = [];
  for (;;) {
    const next = deepNext(history, w, game, cur, order);
    if (!next) break;
    history.push(round(next.x, rng, peak, steep));
  }
  return history;
}

test('snap picks the nearest real setting', () => {
  assert.equal(snap(0, game, cur).sens, 50);
  assert.equal(snap(1, game, cur).sens, 100);
  assert.equal(snap(5, game, cur).sens, 100); // clamped by the menu
  const apex = snap(0.3, GAMES.apex, 3);
  assert.ok([3, 4].includes(apex.sens));
});

test('lstsq recovers a known quadratic', () => {
  const xs = [-1, -0.5, 0, 0.5, 1, 0.25];
  const beta = lstsq(xs.map(x => [1, x, x * x]), xs.map(x => 2 + 0.5 * x - 1.5 * x * x));
  [2, 0.5, -1.5].forEach((v, i) => assert.ok(Math.abs(beta[i] - v) < 1e-6));
});

test('fit removes a warm-up trend and finds the peak', () => {
  const xs = [-0.5, 0.5, 0, 0.3, 0, 0.8];
  const ts = xs.map((_, i) => i / (xs.length - 1));
  const ys = xs.map((x, i) => 1 - (x - 0.3) ** 2 + 0.2 * ts[i]);
  const fit = fitCurve(xs, ts, ys);
  assert.ok(Math.abs(fit.d - 0.2) < 1e-6);
  assert.ok(Math.abs(peakOf(fit, -0.5, 0.8).x - 0.3) < 1e-6);
  assert.equal(fitCurve([0, 0, 0.5], [0, 0.5, 1], [1, 1, 1]), null); // needs three distinct speeds
});

test('peakOf flags a peak at the edge of what was tested', () => {
  const rising = fitCurve([-0.5, 0, 0.5], [0, 0.5, 1], [0.8, 0.9, 1.0]);
  assert.equal(peakOf(rising, -0.5, 0.5).edge, 'hi');
});

test('deepNext plays the initial design, then the control round', () => {
  const rng = mulberry32(1);
  const order = [0.5, -0.5, 0];
  const h = [];
  for (let i = 0; i < 3; i++) {
    const s = deepNext(h, w, game, cur, order);
    assert.ok(Math.abs(s.x - snap(order[i], game, cur).x) < 1e-9);
    h.push(round(s.x, rng, 0, 4));
  }
  h.push(round(deepNext(h, w, game, cur, order).x, rng, 0, 4));
  assert.equal(deepNext(h, w, game, cur, order).sens, cur); // round 5 repeats the current setting
});

test('deepNext pushes outward when the best score is at the edge', () => {
  const rng = mulberry32(2);
  const h = [-0.5, 0, 0.5].map(x => round(x, rng, 1.0, 3));
  const next = deepNext(h, w, game, cur, [-0.5, 0, 0.5]);
  assert.ok(next.x > 0.6);
});

test('deep search finds a player whose best speed is faster than their current one', () => {
  const history = runSearch(3, 0.4, 4);
  assert.ok(history.length >= DEEP.minRounds && history.length <= DEEP.maxRounds);
  const res = deepAnalyze(history, w, game, cur, mulberry32(4), 300);
  assert.equal(res.verdict, 'matters');
  assert.ok(Math.abs(res.best.x - 0.4) < 0.2, `best x ${res.best.x}`);
  assert.ok(res.best.sens > cur);
  assert.ok(res.range[0].sens <= res.best.sens && res.best.sens <= res.range[1].sens);
});

test('deep search reports flat when speed makes no difference', () => {
  const history = runSearch(5, 0, 0);
  const res = deepAnalyze(history, w, game, cur, mulberry32(6), 300);
  assert.notEqual(res.verdict, 'matters');
});

test('no setting is played more than twice', () => {
  const history = runSearch(7, 0.1, 6);
  for (const h of history) {
    const near = history.filter(o => Math.abs(o.x - h.x) < 0.05).length;
    assert.ok(near <= 2, `speed ${h.sens} played ${near} times`);
  }
});

test('a score that keeps rising to the edge counts as mattering', () => {
  const rng = mulberry32(21);
  // Best speed far beyond what the menu allows: every round is better the faster it goes.
  const history = [-0.5, 0, 0.5, 0.75, 0, 1.0, 1.0].map(x => round(x, rng, 3, 0.4));
  const res = deepAnalyze(history, w, game, cur, mulberry32(22), 300);
  assert.equal(res.verdict, 'matters');
  assert.equal(res.edge, 'hi');
  assert.ok(res.drop > 0.04);
});
