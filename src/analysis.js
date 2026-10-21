import { GAMES, PLAYSTYLES } from './games.js';
import { clamp, mean, std, pct } from './util.js';

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
    trackErr: track.T ? track.errSum / track.T : null,
    onTarget: track.on / T,
    behind: track.behind / T,
    ahead: track.ahead / T,
    jitter: track.near > 1 ? Math.max(0, track.rev - track.tRev) / track.near : 0
  };
}

// c = { game, style, sens, curve, dz }. drift = { r, l, rec } or null.
export function recommend(s, c, drift) {
  const g = GAMES[c.game], st = PLAYSTYLES[c.style];
  const flickAdj = clamp((s.under - s.over) * 0.5, -0.3, 0.3);
  const trackAdj = clamp((s.behind - s.ahead) * 0.6 - (s.jitter > 2.5 ? 0.08 : 0), -0.3, 0.3);
  let adj = st.wf * flickAdj + st.wt * trackAdj;
  if (Math.abs(adj) < 0.04) adj = 0;
  let sens = c.sens;
  if (adj !== 0) {
    const target = g.sens.rate(c.sens) * clamp(1 + adj, 0.7, 1.35);
    let err = Infinity;
    for (let v = g.sens.min; v <= g.sens.max; v += g.sens.step) {
      const e = Math.abs(g.sens.rate(v) - target);
      if (e < err) { err = e; sens = v; }
    }
  }
  const measured = `You overshot ${pct(s.over)} of flicks and stopped short on ${pct(s.under)}. While tracking you trailed the target ${pct(s.behind)} of the time and ran ahead ${pct(s.ahead)}.`;
  let sensWhy;
  if (sens > c.sens) sensWhy = measured + ' You were mostly too slow, so turn it up.';
  else if (sens < c.sens) sensWhy = measured + ' You were mostly too fast, so turn it down.';
  else if (adj !== 0) sensWhy = measured + ` The change this points to is smaller than one step in ${g.name}, so keep your setting.`;
  else sensWhy = measured + ' Those errors balance out, so your current speed suits you.';

  let curve = 'mid', curveWhy = 'No strong pattern in your fine aim. The standard curve fits.';
  if (s.over > 0.4 || s.jitter > 2.5) {
    curve = 'expo';
    curveWhy = s.jitter > 2.5
      ? `You made a lot of small corrections near targets (${s.jitter.toFixed(1)} extra direction changes per second). A curve with a softer center makes fine aim steadier.`
      : `You overshot ${pct(s.over)} of flicks. A curve with a softer center slows the first part of the stick's travel, so it is easier to stop on target.`;
  } else if (s.under > 0.4 && s.behind > s.ahead) {
    curve = 'linear';
    curveWhy = 'Your aim got moving late on small stick pushes. A linear curve responds sooner.';
  }
  // Only suggest a change the game's menu can actually express.
  if (curve !== c.curve && g.curve[curve] === g.curve[c.curve]) {
    curveWhy += ` ${g.name} has no option closer to that than ${g.curve[c.curve]}, so keep it.`;
    curve = c.curve;
  }

  let dz = drift ? drift.rec : c.dz;
  if (g.dz.fmt(dz) === g.dz.fmt(c.dz)) dz = c.dz;
  const dzWhy = !drift
    ? 'Not measured. Connect a controller and run the drift check to get a value.'
    : drift.r > 0.2
      ? `Your right stick drifts up to ${drift.r.toFixed(2)} at rest. That is high and the stick may be worn. This deadzone hides the drift but costs some fine control.`
      : `Your right stick drifts up to ${drift.r.toFixed(2)} at rest. This is the smallest deadzone that hides it, so small stick movements still register.`;
  return { sens, curve, dz, sensWhy, curveWhy, dzWhy, dzMeasured: !!drift };
}

export function driftDeadzone(maxRight) {
  return clamp(Math.ceil((maxRight * 1.15 + 0.02) * 100) / 100, 0.03, 0.25);
}

export function settingsChanged(a, b) {
  return a.sens !== b.sens || a.curve !== b.curve || a.dz !== b.dz;
}
