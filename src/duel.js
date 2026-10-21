import { verifyCompare, sideOf } from './verify.js';
import { practiceCode } from './challenge.js';

// Settings duel: four short challenge runs, old settings (A) against suggested ones (B), hidden.
// Order is ABBA or BAAB at random; runs 1-2 share one code and runs 3-4 another, so each setting
// plays both target sets and warm-up or fatigue hits both sides equally.
export const DUEL = { runs: 4, seconds: 30 };

export function duelPlan(rng = Math.random) {
  const codes = [practiceCode(rng), practiceCode(rng)];
  const order = rng() < 0.5 ? ['A', 'B', 'B', 'A'] : ['B', 'A', 'A', 'B'];
  return order.map((key, i) => ({ key, code: codes[i < 2 ? 0 : 1] }));
}

// A run as a round for the shared blind-test statistics: finished flick and turn targets, and
// one-second tracking chunks.
export function runToRound(log) {
  return {
    flicks: log.filter(i => i.kind !== 'track').map(i => i.T),
    chunks: log.filter(i => i.kind === 'track').flatMap(i => i.TR.chunks)
  };
}

// runs = [{ key, code, score, log }]. The verdict uses the same rule as Verify; the scores on
// identical targets are shown alongside.
export function duelCompare(runs, weights, rng = Math.random) {
  const side = k => sideOf(runs.filter(r => r.key === k).map(r => runToRound(r.log)));
  const cmp = verifyCompare({ A: side('A'), B: side('B') }, weights, rng);
  const codes = [...new Set(runs.map(r => r.code))];
  const pairs = codes.map(code => ({
    code,
    a: runs.find(r => r.code === code && r.key === 'A').score,
    b: runs.find(r => r.code === code && r.key === 'B').score
  }));
  const sa = pairs.reduce((s, p) => s + p.a, 0), sb = pairs.reduce((s, p) => s + p.b, 0);
  return { cmp, pairs, scoreDelta: sa + sb > 0 ? (sb - sa) / ((sa + sb) / 2) : 0 };
}
