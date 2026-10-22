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

import { screenPlan, altCurve, screenAnalyze } from '../src/deep.js';

test('screening plan covers every curve/vertical pairing once', () => {
  for (const seed of [1, 2, 3]) {
    const plan = screenPlan(mulberry32(seed));
    assert.deepEqual(plan.map(p => `${p.curve}${p.vert}`).sort(), ['00', '01', '10', '11']);
  }
});

test('alternative curve: follows the read-out when the menu can show it, else a neighbour', () => {
  assert.equal(altCurve(GAMES.arc, 'expo', 'linear'), 'linear');
  assert.equal(altCurve(GAMES.arc, 'expo', 'expo'), 'mid');
  assert.equal(altCurve(GAMES.fortnite, 'mid', 'expo'), 'linear'); // expo shows as the same "Exponential"
  assert.equal(altCurve(GAMES.cod, 'linear', null), 'mid');
});

// A screening round: overall quality q (lower is better), vertical quality vq applied to up/down targets.
function sround(curve, vert, rng, q, vq) {
  const flicks = [], chunks = [];
  for (let i = 0; i < 7; i++) {
    const v = i % 3 === 1;
    const D = 12 + rng() * 24, k = v ? vq : q;
    flicks.push({ D, uy: v ? 0.95 : 0.2, first: { along: D + (rng() - 0.5) * 3 * k, t: 0.6 * k * (0.9 + rng() * 0.2) } });
  }
  for (let i = 0; i < 7; i++) chunks.push(3 * q * (0.9 + rng() * 0.2));
  return { curve, vert, flicks, chunks };
}

test('screening finds the setting that matters and calls the other one close', () => {
  const rng = mulberry32(71);
  // The alternative curve is clearly better overall; vertical speed makes no difference.
  const rounds = screenPlan(rng).map(p => sround(p.curve, p.vert, rng, p.curve ? 0.75 : 1.1, p.curve ? 0.75 : 1.1));
  const res = screenAnalyze(rounds, w, mulberry32(72), 600);
  assert.equal(res.curve.verdict, 'better');
  assert.equal(res.vert.verdict, 'close');
});

test('screening judges vertical speed on up/down targets only', () => {
  const rng = mulberry32(73);
  const rounds = screenPlan(rng).map(p => sround(p.curve, p.vert, rng, 1, p.vert ? 1.5 : 0.7));
  const res = screenAnalyze(rounds, w, mulberry32(74), 600);
  assert.equal(res.vert.verdict, 'worse'); // the faster vertical level did worse
  assert.notEqual(res.curve.verdict, 'better');
});

import { MORE, morePlan } from '../src/deep.js';

test('pooled sittings each get their own level and share one curve', () => {
  const xs = [-0.5, 0, 0.5, 0.3, -0.2, 0.6, 0, 0.3];
  const blocks = [0, 0, 0, 0, 1, 1, 1, 1];
  const ts = [0, 1 / 3, 2 / 3, 1, 0, 1 / 3, 2 / 3, 1];
  // Day two scores 0.3 higher everywhere; the peak stays at 0.2.
  const ys = xs.map((x, i) => 1 - (x - 0.2) ** 2 + (blocks[i] ? 0.3 : 0));
  const fit = fitCurve(xs, ts, ys, blocks);
  assert.ok(Math.abs(peakOf(fit, -0.5, 0.6).x - 0.2) < 1e-6);
  assert.ok(Math.abs(fit.off(4) - fit.off(0) - 0.3) < 1e-6);
});

test('more rounds extend a finished search around its best guess', () => {
  const rng = mulberry32(31);
  const history = runSearch(31, 0.3, 4);
  const n = history.length;
  const order = morePlan(history, w, rng);
  assert.equal(order.length, 3);
  const opts = { base: n, min: MORE, max: MORE, control: -1 };
  for (;;) {
    const next = deepNext(history, w, game, cur, order, opts);
    if (!next) break;
    history.push(round(next.x, rng, 0.3, 4));
  }
  assert.equal(history.length, n + MORE);
  const res = deepAnalyze(history, w, game, cur, mulberry32(32), 200);
  assert.ok(Math.abs(res.best.x - 0.3) < 0.35);
});

test('a second sitting adds to the first and plays its own full search', () => {
  const rng = mulberry32(41);
  const first = runSearch(41, -0.3, 4);
  const history = first.map(h => ({ ...h, block: 0 }));
  const base = history.length, order = shuffled(DEEP.initial, rng);
  for (;;) {
    const next = deepNext(history, w, game, cur, order, { base });
    if (!next) break;
    const r = round(next.x, rng, -0.3, 4);
    r.chunks = r.chunks.map(c => c * 0.8); // sharper today
    history.push({ ...r, block: 1 });
  }
  assert.ok(history.length - base >= DEEP.minRounds);
  const res = deepAnalyze(history, w, game, cur, mulberry32(42), 200);
  assert.ok(Math.abs(res.best.x + 0.3) < 0.35);
});
