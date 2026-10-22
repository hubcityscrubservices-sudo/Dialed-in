import { isVertical, summarize, speedAdjust, turnStats, recommendTurn } from './analysis.js';
import { mean, pct } from './util.js';
import { parTime } from './challenge.js';

// Report card for one challenge run: the score split by kind of target, plus settings hints. One
// run is noisy, so a hint only appears when the gap is large and there were enough targets of that
// kind to judge.
export const REPORT = { minItems: 3, minHits: 4, slowRatio: 1.3, hitGap: 0.2, trackLean: 0.25, speedAdj: 0.1 };

const sumPts = items => items.reduce((a, i) => a + i.pts, 0);

// expected(T) = seconds a hit "should" take, the same yardstick the challenge scored against.
function flickRow(items, expected) {
  const n = items.length, hits = items.filter(i => i.T.hit);
  return {
    n, pts: sumPts(items),
    hitRate: n ? hits.length / n : null,
    pace: hits.length ? mean(hits.map(i => i.T.t / expected(i.T))) : null, // 1 = on par, 1.3 = 30% slow
    over: n ? items.filter(i => i.T.overshoot).length / n : null
  };
}

function mergedTrack(items) {
  const m = { T: 0, errSum: 0, on: 0, behind: 0, ahead: 0, near: 0, rev: 0, tRev: 0, chunks: [] };
  for (const { TR } of items) {
    for (const k of ['T', 'errSum', 'on', 'behind', 'ahead', 'near', 'rev', 'tRev']) m[k] += TR[k];
    m.chunks.push(...TR.chunks);
  }
  return m;
}

// log = challenge st.log; c = { game, style }.
// c = { game, style, v (rule version, default 1), mouse }
export function reportCard(log, c) {
  const expected = T => parTime(T, c.v ?? 1, !!c.mouse);
  const side = [], vert = [], turn = [], track = [];
  for (const it of log) {
    if (it.kind === 'track') track.push(it);
    else if (it.kind === 'turn') turn.push(it);
    else (isVertical(it.T) ? vert : side).push(it);
  }
  const tr = mergedTrack(track);
  const rows = {
    side: flickRow(side, expected), vert: flickRow(vert, expected), turn: flickRow(turn, expected),
    track: { n: track.length, pts: sumPts(track), on: tr.T ? tr.on / tr.T : null }
  };
  const hints = [];

  const hitsOf = items => items.filter(i => i.T.hit).length;
  if (side.length >= REPORT.minItems && vert.length >= REPORT.minItems && hitsOf(side) >= REPORT.minHits) {
    const s = rows.side, v = rows.vert;
    const slower = s.pace && v.pace ? v.pace / s.pace : null;
    const gap = s.hitRate - v.hitRate;
    if ((slower && slower > REPORT.slowRatio) || gap > REPORT.hitGap) {
      const lead = slower && slower > REPORT.slowRatio
        ? `Up-and-down targets took ${pct(slower - 1)} longer than sideways ones`
        : `You hit ${pct(gap)} fewer up-and-down targets than sideways ones`;
      hints.push({ area: 'vertical', text: v.over > s.over + 0.15
        ? `${lead}, and you overshot more of them. Your vertical sensitivity may be too high.`
        : `${lead}. Your vertical sensitivity may be too low.` });
    }
  }

  if (turn.length >= 2) {
    const t = recommendTurn(turnStats(turn.map(i => i.T)), c);
    const text = {
      less: `You ran past ${pct(t.stats.over)} of the turn-around targets. Your look boost may be too strong.`,
      more: 'Big turns were slow even with the stick pushed all the way. More look boost may help.',
      sooner: 'Your full-stick pushes ended before look boost ramped up. A shorter ramp-up time may help.'
    }[t.verdict];
    if (text) hints.push({ area: 'turn', text });
  }

  if (track.length >= 2 && tr.T) {
    const lean = (tr.behind - tr.ahead) / tr.T;
    if (lean > REPORT.trackLean) hints.push({ area: 'track', text: `You trailed the moving targets ${pct(tr.behind / tr.T)} of the time and rarely got ahead. Your sensitivity may be a little low.` });
    else if (lean < -REPORT.trackLean) hints.push({ area: 'track', text: `You ran ahead of the moving targets ${pct(tr.ahead / tr.T)} of the time. Your sensitivity may be a little high.` });
  }

  const flicks = [...side, ...vert].map(i => i.T);
  if (flicks.length >= 5 && flicks.filter(t => t.hit).length >= REPORT.minHits) {
    const adj = speedAdjust(summarize(flicks, tr), c.style);
    if (adj >= REPORT.speedAdj) hints.push({ area: 'speed', text: 'Across flicks you stopped short more often than you overshot. Your sensitivity may be too low.' });
    else if (adj <= -REPORT.speedAdj) hints.push({ area: 'speed', text: 'Across flicks you overshot more often than you stopped short. Your sensitivity may be too high.' });
  }
  return { rows, hints };
}
