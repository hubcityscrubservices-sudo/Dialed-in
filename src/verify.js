import { flickThroughput, trackError } from './analysis.js';
import { mean, resample, quantile } from './util.js';

// Blind A/B check: A = the player's current settings, B = the suggested ones.
// ABBA or BAAB, picked at random, so warm-up and fatigue hit both sides equally.
export function verifyPlan(A, B, rng = Math.random) {
  const order = rng() < 0.5 ? ['A', 'B', 'B', 'A'] : ['B', 'A', 'A', 'B'];
  return order.map(key => ({ key, settings: key === 'A' ? A : B }));
}

const BETTER = 0.8, WORSE = 0.2;

// data = { A: { flicks, chunks }, B: { flicks, chunks } }; weights = { wf, wt } from the playstyle.
// Bootstraps trials and tracking seconds to estimate how likely B beats A.
export function verifyCompare(data, weights, rng = Math.random, iters = 2000) {
  const point = scoreDelta(data.A, data.B, weights);
  if (!point) return null;
  let n = 0, fWin = 0, tWin = 0, oWin = 0;
  const overall = [];
  for (let i = 0; i < iters; i++) {
    const a = { flicks: resample(data.A.flicks, rng), chunks: resample(data.A.chunks, rng) };
    const b = { flicks: resample(data.B.flicks, rng), chunks: resample(data.B.chunks, rng) };
    const d = scoreDelta(a, b, weights);
    if (!d) continue;
    n++;
    if (d.flick > 0) fWin++;
    if (d.track > 0) tWin++;
    if (d.overall > 0) oWin++;
    overall.push(d.overall);
  }
  if (!n) return null;
  overall.sort((x, y) => x - y);
  const p = oWin / n;
  return {
    flick: { delta: point.flick, p: fWin / n },
    track: { delta: point.track, p: tWin / n },
    overall: { delta: point.overall, p, lo: quantile(overall, 0.1), hi: quantile(overall, 0.9) },
    verdict: p >= BETTER ? 'better' : p <= WORSE ? 'worse' : 'close'
  };
}

// Symmetric percent difference: stays defined when one side scores zero.
const relDiff = (better, worse) => (better + worse) > 0 ? (better - worse) / ((better + worse) / 2) : 0;

// Relative improvement of B over A; positive is better for B.
function scoreDelta(a, b, w) {
  const tpA = flickThroughput(a.flicks), tpB = flickThroughput(b.flicks);
  const eA = trackError(a.chunks), eB = trackError(b.chunks);
  if (tpA == null || tpB == null || eA == null || eB == null) return null;
  const flick = relDiff(tpB, tpA);
  const track = relDiff(eA, eB); // lower error is better
  return { flick, track, overall: w.wf * flick + w.wt * track };
}

export function ratingSummary(ratings) {
  return ratings.length ? mean(ratings) : null;
}
