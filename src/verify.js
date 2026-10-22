import { flickParts, FLICK_PARTS, trackError } from './analysis.js';
import { mean, resample, quantile } from './util.js';

// Blind A/B check: A = the player's current settings, B = the suggested ones.
// ABBA or BAAB, picked at random, so warm-up and fatigue hit both sides equally.
export function verifyPlan(A, B, rng = Math.random) {
  const order = rng() < 0.5 ? ['A', 'B', 'B', 'A'] : ['B', 'A', 'A', 'B'];
  return order.map(key => ({ key, settings: key === 'A' ? A : B }));
}

// A winner needs 90% odds and at least a 15% overall difference. Checked against simulated players
// with round-to-round swings: with no real difference this calls a winner about 10-13% of the time,
// and it catches a 30% difference about 85% of the time. Smaller differences mostly read as close.
const BETTER = 0.9, WORSE = 0.1, MIN_DELTA = 0.15;

// Pools rounds into one side, keeping the rounds so the bootstrap can resample them.
export function sideOf(rounds) {
  return { rounds, flicks: rounds.flatMap(r => r.flicks), chunks: rounds.flatMap(r => r.chunks) };
}

// Two-level bootstrap: whole rounds first, then targets and tracking seconds inside each, so
// round-to-round swings (warm-up, a lapse in focus) count as noise rather than as a difference.
function resampleSide(side, rng) {
  if (side.rounds && side.rounds.length > 1) {
    const rs = resample(side.rounds, rng);
    return { flicks: rs.flatMap(r => resample(r.flicks, rng)), chunks: rs.flatMap(r => resample(r.chunks, rng)) };
  }
  return { flicks: resample(side.flicks, rng), chunks: resample(side.chunks, rng) };
}

// data = { A: side, B: side } where a side is sideOf(rounds) or plain { flicks, chunks };
// weights = { wf, wt } from the playstyle. Estimates how likely B beats A.
// opts: thresholds for the verdict. A winner needs p >= better (or <= worse) and an overall difference
// of at least minDelta, because a handful of rounds can't tell small differences from a good round.
export function verifyCompare(data, weights, rng = Math.random, iters = 2000, opts = {}) {
  const { better = BETTER, worse = WORSE, minDelta = MIN_DELTA } = opts;
  const point = scoreDelta(data.A, data.B, weights);
  if (!point) return null;
  let n = 0, fWin = 0, tWin = 0, oWin = 0;
  const overall = [];
  for (let i = 0; i < iters; i++) {
    const a = resampleSide(data.A, rng), b = resampleSide(data.B, rng);
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
    verdict: p >= better && point.overall >= minDelta ? 'better' : p <= worse && point.overall <= -minDelta ? 'worse' : 'close'
  };
}

// Symmetric percent difference: stays defined when one side scores zero.
const relDiff = (better, worse) => (better + worse) > 0 ? (better - worse) / ((better + worse) / 2) : 0;

// Relative improvement of B over A; positive is better for B.
function scoreDelta(a, b, w) {
  const fa = flickParts(a.flicks), fb = flickParts(b.flicks);
  const eA = trackError(a.chunks), eB = trackError(b.chunks);
  if (fa.tp == null || fb.tp == null || eA == null || eB == null) return null;
  // First-shot throughput, with settle rate and path efficiency when both sides have them.
  const P = FLICK_PARTS, all = [fa, fb].every(f => f.acq != null && f.eff != null);
  const flick = all ? P.tp * relDiff(fb.tp, fa.tp) + P.acq * relDiff(fb.acq, fa.acq) + P.eff * relDiff(fb.eff, fa.eff) : relDiff(fb.tp, fa.tp);
  const track = relDiff(eA, eB); // lower error is better
  return { flick, track, overall: w.wf * flick + w.wt * track };
}

export function ratingSummary(ratings) {
  return ratings.length ? mean(ratings) : null;
}
