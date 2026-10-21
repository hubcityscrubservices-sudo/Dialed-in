import { flickThroughput, trackError, isVertical } from './analysis.js';
import { verifyCompare, sideOf } from './verify.js';
import { clamp, mean, resample, quantile, settingValues } from './util.js';

// Deep mode, sensitivity only. Each round plays at a hidden speed x = log2(turn rate / current turn rate).
// Score per round is fit with  score = a + b·x + c·x² + d·t  (t = round order, to absorb warm-up),
// the next round goes where the fit says the peak is, and a bootstrap says whether the peak is real.
export const DEEP = {
  initial: [-0.5, 0, 0.5], // first three rounds, played in random order
  controlAt: 4,            // round index that repeats the current setting
  minRounds: 7,
  maxRounds: 9,
  limit: 1.2,              // never test beyond 2^±1.2 (about 0.44x to 2.3x the current speed)
  stable: 0.15,            // stop early once the peak moves less than this between rounds
  off: Math.log2(1.3),     // "30% off the best speed", used to measure how much sensitivity matters
  matterDrop: 0.04         // a 4% score drop at 30% off counts as mattering
};

export function shuffled(xs, rng = Math.random) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Nearest real setting to a speed multiplier, and the multiplier that setting actually gives.
export function snap(x, game, cur) {
  const g = game.sens, base = g.rate(cur), target = base * 2 ** x;
  let best = cur, err = Infinity;
  for (const v of settingValues(g)) {
    const e = Math.abs(Math.log2(g.rate(v) / target));
    if (e < err) { err = e; best = v; }
  }
  return { sens: best, x: Math.log2(g.rate(best) / base) };
}

// Least squares via normal equations; a tiny ridge keeps near-singular designs solvable.
export function lstsq(rows, ys) {
  const k = rows[0].length;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  rows.forEach((r, n) => {
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += r[i] * r[j];
      A[i][k] += r[i] * ys[n];
    }
  });
  for (let i = 0; i < k; i++) A[i][i] += 1e-9;
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let j = col; j <= k; j++) A[r][j] -= f * A[col][j];
    }
  }
  return A.map((row, i) => row[k] / row[i]);
}

export function fitCurve(xs, ts, ys) {
  if (new Set(xs.map(x => x.toFixed(3))).size < 3) return null;
  const drift = ys.length >= 5;
  const beta = lstsq(xs.map((x, i) => drift ? [1, x, x * x, ts[i]] : [1, x, x * x]), ys);
  if (!beta) return null;
  const [a, b, c, d = 0] = beta;
  const tMid = mean(ts);
  // Predictions are taken at the middle of the session so warm-up doesn't tilt the curve.
  return { a, b, c, d, at: x => a + b * x + c * x * x + d * tMid };
}

export function peakOf(fit, lo, hi) {
  let x;
  if (fit.c < 0) x = clamp(-fit.b / (2 * fit.c), lo, hi);
  else x = fit.at(lo) >= fit.at(hi) ? lo : hi;
  const edge = x <= lo + 0.05 ? 'lo' : x >= hi - 0.05 ? 'hi' : null;
  return { x, edge };
}

// Speed and accuracy combined, each scaled to the session average so neither dominates.
export function roundScores(rounds, w) {
  const tps = rounds.map(r => flickThroughput(r.flicks));
  const errs = rounds.map(r => trackError(r.chunks));
  if (tps.some(v => v == null) || errs.some(v => v == null)) return null;
  const tpRef = mean(tps), eRef = mean(errs);
  if (!(tpRef > 0) || !(eRef > 0)) return null;
  return rounds.map((r, i) => w.wf * tps[i] / tpRef + w.wt * eRef / Math.max(errs[i], eRef * 0.05));
}

function orderTs(n) {
  return Array.from({ length: n }, (_, i) => n > 1 ? i / (n - 1) : 0);
}

function estimate(history, w) {
  const ys = roundScores(history, w);
  if (!ys) return null;
  const xs = history.map(h => h.x);
  const fit = fitCurve(xs, orderTs(history.length), ys);
  if (!fit) return null;
  return { fit, ys, lo: Math.min(...xs), hi: Math.max(...xs), peak: peakOf(fit, Math.min(...xs), Math.max(...xs)) };
}

// Picks the next round's setting, or null when the search is done.
// history = [{ x, sens, flicks, chunks }]; order = the shuffled initial design.
export function deepNext(history, w, game, cur, order) {
  const n = history.length;
  if (n < order.length) return snap(order[n], game, cur);
  if (n === DEEP.controlAt) return snap(0, game, cur);
  if (n >= DEEP.maxRounds) return null;
  const est = estimate(history, w);
  if (n >= DEEP.minRounds && est) {
    const prev = estimate(history.slice(0, -1), w);
    if (prev && Math.abs(prev.peak.x - est.peak.x) < DEEP.stable) return null;
  }
  // Settings within ~3.5% speed of each other count as the same one.
  const tested = s => history.filter(h => Math.abs(h.x - s.x) < 0.05).length;
  let x;
  if (!est) x = n % 2 ? 0.25 : -0.25;
  else if (est.peak.edge === 'hi' && est.hi < DEEP.limit) x = est.hi + 0.5;
  else if (est.peak.edge === 'lo' && est.lo > -DEEP.limit) x = est.lo - 0.5;
  else x = est.peak.x;
  let s = snap(clamp(x, -DEEP.limit, DEEP.limit), game, cur);
  // Don't play one setting more than twice; probe the less-tested neighbour instead.
  if (tested(s) >= 2) {
    const around = [snap(clamp(s.x - 0.25, -DEEP.limit, DEEP.limit), game, cur), snap(clamp(s.x + 0.25, -DEEP.limit, DEEP.limit), game, cur)];
    around.sort((p, q) => tested(p) - tested(q));
    if (tested(around[0]) < 2) s = around[0];
  }
  return s;
}

// Score lost 30% away from the peak, looking only at speeds that were actually tested
// (a peak at the edge has just one side to compare against).
export function dropOf(fit, px, lo, hi) {
  const top = fit.at(px);
  if (!(top > 0)) return 0;
  const sides = [px - DEEP.off, px + DEEP.off].map(x => clamp(x, lo, hi)).filter(x => Math.abs(x - px) > 0.05);
  if (!sides.length) return 0;
  return (top - mean(sides.map(x => fit.at(x)))) / top;
}

// Final read-out. verdict: 'matters' | 'flat' | 'unclear'.
export function deepAnalyze(history, w, game, cur, rng = Math.random, iters = 400) {
  const est = estimate(history, w);
  if (!est) return null;
  const { fit, ys, lo, hi, peak } = est;
  const drop = dropOf(fit, peak.x, lo, hi);
  const peaks = [];
  let matter = 0, n = 0;
  for (let i = 0; i < iters; i++) {
    const sample = history.map(h => ({ ...h, flicks: resample(h.flicks, rng), chunks: resample(h.chunks, rng) }));
    const e = estimate(sample, w);
    if (!e) continue;
    n++;
    peaks.push(e.peak.x);
    if (dropOf(e.fit, e.peak.x, e.lo, e.hi) > DEEP.matterDrop) matter++;
  }
  if (!n) return null;
  peaks.sort((p, q) => p - q);
  const pMatters = matter / n;
  const tMid = mean(orderTs(history.length));
  const ts = orderTs(history.length);
  return {
    verdict: pMatters >= 0.8 ? 'matters' : pMatters <= 0.3 ? 'flat' : 'unclear',
    pMatters, drop,
    best: snap(peak.x, game, cur),
    edge: peak.edge,
    range: [snap(quantile(peaks, 0.05), game, cur), snap(quantile(peaks, 0.95), game, cur)],
    warmup: fit.d / fit.at(peak.x), // score change from first to last round, as a share of the best score
    lo, hi,
    curve: Array.from({ length: 41 }, (_, i) => { const x = lo + (hi - lo) * i / 40; return { x, y: fit.at(x) }; }),
    top: fit.at(peak.x),
    // Raw scores with the warm-up trend removed, so they sit on the same scale as the curve.
    points: history.map((h, i) => ({ x: h.x, sens: h.sens, y: ys[i] - fit.d * (ts[i] - tMid), round: i + 1 }))
  };
}

/* ---------- screening: which other settings matter ---------- */

// After the sensitivity search, four rounds at the best speed cover every pairing of two curves and
// two vertical speeds (a 2x2 full factorial) in random order. Each factor is then judged by pooling
// the two rounds at each of its levels, so every round counts toward both answers.
export const SCREEN = { vLow: 0.87, vHigh: 1.15 };

export function screenPlan(rng = Math.random) {
  return shuffled([[0, 0], [0, 1], [1, 0], [1, 1]], rng).map(([curve, vert]) => ({ curve, vert }));
}

// The curve to test against the current one: the one the quick read-out leans to, if the menu shows
// it differently, else the nearest slot with a different menu name.
export function altCurve(game, cur, wanted) {
  const label = k => game.curve[k];
  if (wanted && wanted !== cur && label(wanted) !== label(cur)) return wanted;
  const order = ['linear', 'mid', 'expo'], i = order.indexOf(cur);
  for (const k of [order[i - 1], order[i + 1], ...order]) if (k && label(k) !== label(cur)) return k;
  return null;
}

// rounds = [{ curve: 0|1, vert: 0|1, flicks, chunks }]. Curve uses the playstyle's mix of flicks and
// tracking; vertical speed is judged on up/down targets only.
export function screenAnalyze(rounds, w, rng = Math.random, iters = 1000) {
  const pool = pred => sideOf(rounds.filter(pred));
  const vpool = pred => sideOf(rounds.filter(pred).map(r => ({ flicks: r.flicks.filter(isVertical), chunks: r.chunks })));
  return {
    curve: verifyCompare({ A: pool(r => r.curve === 0), B: pool(r => r.curve === 1) }, w, rng, iters),
    vert: verifyCompare({ A: vpool(r => r.vert === 0), B: vpool(r => r.vert === 1) }, { wf: 1, wt: 0 }, rng, iters)
  };
}
