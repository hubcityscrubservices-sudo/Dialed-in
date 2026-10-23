import { GAMES, PLAYSTYLES } from './games.js';
import { clamp, mean, std, pct, settingValues, ceilStep } from './util.js';

const MIN_WE = 0.5; // degrees; keeps a perfect run from dividing by zero

// Effective Fitts' throughput in bits per second (ISO 9241-9 style).
// Endpoint = where the crosshair was at the first shot (or at timeout).
// Scatter along the movement axis sets the effective target width, so spraying early costs as much as being slow.
export function flickThroughput(trials) {
  const done = trials.filter(t => t.first);
  if (done.length < 3) return null;
  const We = Math.max(4.133 * std(done.map(t => t.first.along - t.D)), MIN_WE);
  const De = Math.max(0, mean(done.map(t => t.first.along)));
  const MT = mean(done.map(t => t.first.t));
  if (!(MT > 0)) return null;
  return Math.log2(De / We + 1) / MT;
}

// Settle rate: Fitts bits per second to land on a target for good, timed to the crosshair's final entry
// onto it before the hit (circling, overshooting and corrections all push that later), plus ACQ_MISS
// seconds per missed shot. A target never hit counts its full time. Needs calibration trials (lastIn).
const ACQ_MISS = 0.25;
export function acquireRate(trials) {
  if (trials.length < 3 || trials.some(t => !('path' in t))) return null;
  return mean(trials.map(t => {
    const misses = Math.max(0, (t.shots || 0) - (t.hit ? 1 : 0));
    const time = (t.hit && t.lastIn != null ? t.lastIn : t.t) + ACQ_MISS * misses;
    return Math.log2(t.D / t.W + 1) / Math.max(0.1, time);
  }));
}
// Path efficiency: straight-line distance over the path the crosshair actually took, on hit targets (1 = direct).
export function pathEfficiency(trials) {
  const hits = trials.filter(t => t.hit && t.path > 0);
  if (hits.length < 3 || trials.some(t => !('path' in t))) return null;
  return mean(hits.map(t => Math.min(1, t.D / t.path)));
}
// A round's flick measures. Rounds and blind tests weigh first-shot throughput with settle rate and path
// efficiency when every side has them (rounds saved before these existed have throughput only).
export const FLICK_PARTS = { tp: 0.5, acq: 0.3, eff: 0.2 };
export function flickParts(trials) {
  return { tp: flickThroughput(trials), acq: acquireRate(trials), eff: pathEfficiency(trials) };
}

export function trackError(chunks) {
  return chunks.length ? mean(chunks) : null;
}

export function summarize(flicks, track) {
  const n = flicks.length || 1;
  const hits = flicks.filter(f => f.hit);
  const T = track.T || 1;
  return {
    throughput: flickThroughput(flicks),
    hitRate: hits.length / n,
    avgTime: hits.length ? mean(hits.map(f => f.t)) : null,
    over: flicks.filter(f => f.overshoot).length / n,
    under: flicks.filter(f => !f.overshoot && (!f.hit || f.segs >= 3)).length / n,
    overV: flicks.some(isVertical) ? overRate(flicks.filter(isVertical)) : null,
    underV: flicks.some(isVertical) ? underRate(flicks.filter(isVertical)) : null,
    trackErr: track.T ? track.errSum / track.T : null,
    onTarget: track.on / T,
    behind: track.behind / T,
    ahead: track.ahead / T,
    // Trailing minus leading, beyond what a perfect-speed player with normal reaction time shows.
    lean: ((track.behind - track.ahead) - ((track.refBehind || 0) - (track.refAhead || 0))) / T,
    jitter: track.near > 1 ? Math.max(0, track.rev - track.tRev) / track.near : 0
  };
}

// Fine-aim round: settle time (the crosshair's final entry onto the target), went past it (further than
// its radius beyond the centre along the way), and stopped short (missed, or three or more separate pushes).
export function fineStats(trials) {
  if (!trials || trials.length < 4) return null;
  const n = trials.length, hits = trials.filter(t => t.hit && t.lastIn != null);
  const over = trials.filter(t => t.maxProj - t.D > t.r).length / n;
  return {
    n, over,
    under: trials.filter(t => !(t.maxProj - t.D > t.r) && (!t.hit || t.segs >= 3)).length / n,
    settle: hits.length ? mean(hits.map(t => t.lastIn)) : null,
    misses: mean(trials.map(t => Math.max(0, (t.shots || 0) - (t.hit ? 1 : 0))))
  };
}
export const FINE = { over: 0.35, under: 0.4 };

// c = { game, style, sens, curve, dz }. drift = { r, l, rec } or null.
// Relative speed change the test results point to (+0.1 = 10% faster), weighted by playstyle.
// Small signals round to zero so noise doesn't move a setting.
export function speedAdjust(s, style) {
  const st = PLAYSTYLES[style];
  const flickAdj = clamp((s.under - s.over) * 0.5, -0.3, 0.3);
  const trackAdj = clamp((s.lean ?? s.behind - s.ahead) * 0.6 - (s.jitter > 2.5 ? 0.08 : 0), -0.3, 0.3);
  const adj = st.wf * flickAdj + st.wt * trackAdj;
  return Math.abs(adj) < 0.04 ? 0 : adj;
}

// fine = fineStats of the fine-aim drill, or null. When present it decides the curve: small nudges use the
// first part of the stick's travel, where curves differ; the long flicks barely touch it.
export function recommend(s, c, drift, fine = null) {
  const g = GAMES[c.game];
  const adj = speedAdjust(s, c.style);
  let sens = c.sens;
  if (adj !== 0) {
    const target = g.sens.rate(c.sens) * clamp(1 + adj, 0.7, 1.35);
    let err = Infinity;
    for (const v of settingValues(g.sens)) {
      const e = Math.abs(g.sens.rate(v) - target);
      if (e < err) { err = e; sens = v; }
    }
  }
  const measured = `You overshot ${pct(s.over)} of flicks and stopped short on ${pct(s.under)}. While tracking you trailed the target ${pct(s.behind)} of the time and ran ahead ${pct(s.ahead)}${s.lean != null ? ', judged against a player with normal reaction time' : ''}.`;
  let sensWhy;
  if (sens > c.sens) sensWhy = measured + ' You were mostly too slow, so turn it up.';
  else if (sens < c.sens) sensWhy = measured + ' You were mostly too fast, so turn it down.';
  else if (adj !== 0) sensWhy = measured + ` The change this points to is smaller than one step in ${g.name}, so keep your setting.`;
  else sensWhy = measured + ' Those errors balance out, so your current speed suits you.';

  const keepWhy = 'No strong pattern in your fine aim, so keep your current curve.';
  let curve = c.curve, curveWhy = keepWhy;
  if (s.over > 0.4 || s.jitter > 2.5) {
    curve = 'expo';
    curveWhy = s.jitter > 2.5
      ? `You made a lot of small corrections near targets (${s.jitter.toFixed(1)} extra direction changes per second). A curve with a softer center makes fine aim steadier.`
      : `You overshot ${pct(s.over)} of flicks. A curve with a softer center slows the first part of the stick's travel, so it is easier to stop on target.`;
  } else if (s.under > 0.4 && (s.lean ?? s.behind - s.ahead) > 0) {
    curve = 'linear';
    curveWhy = 'Your aim got moving late on small stick pushes. A linear curve responds sooner.';
  }
  if (fine) {
    const fineSays = `In the fine-aim test you went past ${pct(fine.over)} of the small targets and stopped short on ${pct(fine.under)}.`;
    if (fine.over >= FINE.over && fine.over > fine.under) { curve = 'expo'; curveWhy = fineSays + ' Small nudges moved too far, so a curve with a softer center gives finer control.'; }
    else if (fine.under >= FINE.under) { curve = 'linear'; curveWhy = fineSays + ' Small nudges barely moved the aim, so a curve that responds sooner near center helps.'; }
    else if (curve === c.curve || curveWhy === keepWhy) { curve = c.curve; curveWhy = fineSays + ' Your small nudges landed well, so keep your current curve.'; }
  }
  if (curve === c.curve && curveWhy !== keepWhy) {
    curveWhy += ` Your current ${g.curve[c.curve]} curve already does that, so keep it.`;
  }
  // Only suggest a change the game's menu can actually express.
  else if (curve !== c.curve && g.curve[curve] === g.curve[c.curve]) {
    curveWhy += ` ${g.name} has no option closer to that than ${g.curve[c.curve]}, so keep it.`;
    curve = c.curve;
  }

  let dz = drift ? ceilStep(drift.rec, g.dz.step) : c.dz;
  if (g.dz.fmt(dz) === g.dz.fmt(c.dz)) dz = c.dz;
  const dzWhy = !drift
    ? 'Not measured. Connect a controller and run the drift check to get a value.'
    : drift.r > 0.2
      ? `Your right stick drifts up to ${drift.r.toFixed(2)} at rest. That is high and the stick may be worn. This deadzone hides the drift but costs some fine control.`
      : `Your right stick drifts up to ${drift.r.toFixed(2)} at rest. This is the smallest deadzone that hides it, so small stick movements still register.`;
  const dzMore = fine && dz < c.dz && fine.under >= FINE.under ? ' Your small nudges were slow to start in the fine-aim test, another sign the deadzone is bigger than you need.' : '';
  return { sens, curve, dz, sensWhy, curveWhy, dzWhy: dzWhy + dzMore, dzMeasured: !!drift };
}

// A flick counts as vertical when most of its travel is up or down.
export const isVertical = f => Math.abs(f.uy) >= 0.7;
const overRate = fs => fs.filter(f => f.overshoot).length / fs.length;
const underRate = fs => fs.filter(f => !f.overshoot && (!f.hit || f.segs >= 3)).length / fs.length;
const MIN_VERTICAL = 3;

// Vertical speed relative to horizontal: compares error patterns on up/down targets with side-to-side ones,
// then carries the horizontal change (hSens vs c.sens) across so the ratio holds unless the data says otherwise.
// Returns { vsens } for games with their own vertical setting, otherwise { vmult } relative to now.
// Trailing minus leading on a strafer, beyond what a perfect-speed player with normal reaction time shows.
export const trackLean = TR => TR && TR.T ? ((TR.behind - TR.ahead) - ((TR.refBehind || 0) - (TR.refAhead || 0))) / TR.T : null;

// vt = { lean, hLean }: the up-and-down strafer's lean and the side-to-side one's. Tracking is a continuous
// measurement (every second counts), so when it is there it carries more weight than the few up-and-down flicks.
export function recommendVertical(flicks, c, hSens, vt = null) {
  const g = GAMES[c.game];
  const v = flicks.filter(isVertical), h = flicks.filter(f => !isVertical(f));
  const hMult = g.sens.rate(hSens) / g.sens.rate(c.sens);
  const flicked = v.length >= MIN_VERTICAL && h.length >= MIN_VERTICAL;
  const tracked = !!(vt && vt.lean != null && vt.hLean != null);
  const measured = flicked || tracked;
  let rel = 0, why;
  const parts = [];
  let relF = 0, relT = 0;
  if (flicked) {
    const [oV, uV, oH, uH] = [overRate(v), underRate(v), overRate(h), underRate(h)];
    relF = clamp(((uV - oV) - (uH - oH)) * 0.4, -0.3, 0.3);
    parts.push(`On up-and-down targets you overshot ${pct(oV)} and stopped short on ${pct(uV)}, against ${pct(oH)} and ${pct(uH)} side to side.`);
  }
  if (tracked) {
    relT = clamp((vt.lean - vt.hLean) * 0.6, -0.3, 0.3);
    const d = vt.lean - vt.hLean;
    parts.push(Math.abs(d) < 0.05 ? 'You tracked the up-and-down strafer about as well as the side-to-side one.'
      : d > 0 ? `You trailed the up-and-down strafer ${pct(d)} of the time more than the side-to-side one.`
      : `You ran ahead of the up-and-down strafer ${pct(-d)} of the time more than the side-to-side one.`);
  }
  if (measured) {
    rel = flicked && tracked ? 0.4 * relF + 0.6 * relT : flicked ? relF : relT;
    if (Math.abs(rel) < 0.05) rel = 0;
    why = parts.join(' ');
    if (rel > 0) why += ' Your vertical aim lags behind your horizontal aim, so raise it relative to horizontal.';
    else if (rel < 0) why += ' Your vertical aim runs ahead of your horizontal aim, so lower it relative to horizontal.';
    else if (flicked && tracked && Math.abs(relF) >= 0.05 && Math.abs(relT) >= 0.05 && Math.sign(relF) !== Math.sign(relT)) why += ' The flicks and the tracking point opposite ways, so keep the same balance between them.';
    else why += ' The two match, so keep the same balance between them.';
  } else {
    why = 'Too few up-and-down targets to judge, so keep the same balance between vertical and horizontal.';
  }
  const factor = hMult * (1 + rel);
  if (hMult !== 1) why += ` This also follows your horizontal change.`;
  if (!g.vsens) return { vmult: (c.vmult ?? 1) * factor, vMeasured: measured, vWhy: why };
  const target = g.vsens.rate(c.vsens) * factor;
  let vsens = c.vsens, err = Infinity;
  for (const x of settingValues(g.vsens)) {
    const e = Math.abs(g.vsens.rate(x) - target);
    if (e < err) { err = e; vsens = x; }
  }
  return { vsens, vMeasured: measured, vWhy: why };
}

export function driftDeadzone(maxRight) {
  return clamp(Math.ceil((maxRight * 1.15 + 0.02) * 100) / 100, 0.03, 0.25);
}

export function settingsChanged(a, b) {
  return a.sens !== b.sens || a.curve !== b.curve || a.dz !== b.dz || (a.outer ?? 1) !== (b.outer ?? 1) ||
    a.vsens !== b.vsens || Math.abs((a.vmult ?? 1) - (b.vmult ?? 1)) > 0.01;
}

// ADS: the zoomed rounds measure how aiming down sights feels at the current multiplier. The new
// multiplier keeps the zoomed speed the test points to even when hip-fire speed changes (hSens),
// so a faster hip-fire suggestion doesn't also speed up ADS by accident.
// spec = one entry from adsSpecs(); cur = current multiplier. Generic specs return a relative change.
export function recommendAds(flicks, track, c, hSens, spec, cur) {
  const g = GAMES[c.game];
  const hMult = g.sens.rate(hSens) / g.sens.rate(c.sens);
  const where = spec.zoom >= 3 ? `Through the ${spec.zoom}× scope` : `Aiming down sights at ${spec.zoom}×`;
  if (!flicks || flicks.length < 3 || !track || !track.T) {
    const why = 'Not measured, so it stays where it is' + (hMult !== 1 ? ', adjusted to offset your hip-fire change.' : '.');
    return { next: snapAds(cur / hMult, spec), rel: 1 / hMult, measured: false, why };
  }
  const s = summarize(flicks, track);
  const adj = speedAdjust(s, c.style);
  const rel = (1 + clamp(adj, -0.3, 0.35)) / hMult;
  let why = `${where}, you overshot ${pct(s.over)} of flicks and stopped short on ${pct(s.under)}, and trailed the target ${pct(s.behind)} of the time while running ahead ${pct(s.ahead)}.`;
  why += adj > 0 ? ` Zoomed in you were mostly too slow, so ADS should turn about ${pct(adj)} faster.`
    : adj < 0 ? ` Zoomed in you were mostly too fast, so ADS should turn about ${pct(-adj)} slower.`
    : ' Those balance out, so your zoomed speed suits you.';
  if (hMult !== 1) {
    const dir = rel > 1.005 ? 'goes up' : rel < 0.995 ? 'comes down' : 'stays put';
    why += ` Your hip-fire change alone would make ADS ${pct(Math.abs(hMult - 1))} ${hMult > 1 ? 'faster' : 'slower'}, so the multiplier ${dir} to land on that speed.`;
  }
  return { next: snapAds(cur * rel, spec), rel, measured: true, why, stats: s };
}

function snapAds(v, spec) {
  if (spec.generic) return v;
  const n = Math.round(clamp(v, spec.min, spec.max) / spec.step) * spec.step;
  return Number(n.toFixed(4));
}

// Turn-around drill. per180: seconds to get within reach of the target, scaled to a 180-degree turn.
const median = xs => { const a = xs.slice().sort((p, q) => p - q); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
export const TURN = { slowPer180: 0.85, overDeg: 8, overShare: 0.4, fullShare: 0.6 };

export function turnStats(trials) {
  if (!trials.length) return null;
  const reached = trials.filter(t => t.reachT != null);
  return {
    per180: reached.length ? median(reached.map(t => t.reachT * 180 / t.D)) : null,
    reached: reached.length / trials.length,
    over: trials.filter(t => t.maxProj - t.D > TURN.overDeg).length / trials.length,
    fullShare: reached.length ? mean(reached.map(t => t.fullT / t.reachT)) : 0,
    stint: median(trials.map(t => t.maxStint)),
    n: trials.length
  };
}

// cur = { boost, ramp } for games with a boost setting. Returns rows for the results page:
// { verdict: 'less' | 'more' | 'sooner' | 'keep', why, boost?, ramp? }.
export function recommendTurn(st, c, cur = {}) {
  const g = GAMES[c.game];
  const bs = g.boost && g.boost.setting, rs = g.boost && g.boost.rampSetting;
  if (!st) return { verdict: 'keep', measured: false, why: 'Not measured.', boost: cur.boost, ramp: cur.ramp };
  const slow = st.per180 == null || st.per180 > TURN.slowPer180 || st.reached < 0.8;
  const ramp = cur.ramp ?? (g.boost ? g.boost.ramp : null);
  let verdict = 'keep';
  if (st.over >= TURN.overShare) verdict = 'less';
  else if (slow && st.fullShare >= TURN.fullShare && ramp != null && st.stint < ramp) verdict = 'sooner';
  else if (slow && st.fullShare >= TURN.fullShare) verdict = 'more';
  let why = `Big turns took ${st.per180 == null ? 'too long to finish' : st.per180.toFixed(2) + ' s per 180°'}, you held the stick all the way over for ${pct(st.fullShare)} of each turn, and you blew past ${pct(st.over)} of the targets.`;
  if (verdict === 'less') why += ' You turn faster than you can stop, so ease off the boost.';
  else if (verdict === 'more') why += ' You push all the way and still arrive late, so more boost would help.';
  else if (verdict === 'sooner') why += ` Your longest full push lasted ${st.stint.toFixed(1)} s, shorter than the ${ramp.toFixed(1)} s the boost takes to ramp up, so it rarely kicks in. A shorter ramp-up gets you the speed sooner.`;
  else why += slow ? " You were slow but rarely pushed all the way, so the boost isn't the limit." : ' Your big turns are quick and controlled, so leave it.';
  const out = { verdict, measured: true, why, stats: st };
  if (bs) {
    const step = bs.adj ?? 15, d = verdict === 'less' ? -step : verdict === 'more' ? step : 0;
    out.boost = clamp(cur.boost + d, bs.min, bs.max);
    out.ramp = verdict === 'sooner' ? Number(clamp(ramp - 0.4, rs.min, rs.max).toFixed(1)) : cur.ramp;
  }
  return out;
}
