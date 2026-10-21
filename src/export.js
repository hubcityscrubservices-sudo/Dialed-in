// Raw measurements from a run, compact enough to paste into a message for tuning the thresholds.
export const EXPORT_VERSION = 1;

const r3 = v => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
function round(obj) {
  if (Array.isArray(obj)) return obj.map(round);
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, round(v)]));
  return r3(obj);
}

function segmentData(s) {
  if (s.data == null) return null;
  if (s.kind === 'flick') {
    return s.data.list.map(t => ({
      D: t.D, W: t.W, uy: t.uy, t: t.t, hit: t.hit, shots: t.shots, segs: t.segs, over: t.overshoot,
      past: t.maxProj - t.D, first: t.first,
      ...(t.turn ? { reachT: t.reachT, fullT: t.fullT, maxStint: t.maxStint } : {})
    }));
  }
  if (s.kind === 'track') {
    const { T, errSum, on, behind, ahead, near, rev, tRev, chunks } = s.data;
    return { T, errSum, on, behind, ahead, near, rev, tRev, chunks };
  }
  if (s.kind === 'rate') return s.data;
  return null;
}

// segs: every played segment, in order. Segments with no data (skipped, or analysis steps) are left out.
export function buildExport({ cfg, drift, rec, segs, pad, deep, verify, when = new Date() }) {
  const played = segs.filter(s => ['flick', 'track', 'rate'].includes(s.kind) && s.data != null);
  return round({
    v: EXPORT_VERSION,
    when: when.toISOString(),
    pad: pad || null,
    cfg,
    stickCheck: drift || null,
    rec: rec ? {
      sens: rec.sens, vsens: rec.vsens, vmult: rec.vmult, curve: rec.curve, dz: rec.dz, outer: rec.outer,
      ads: (rec.ads || []).map(a => ({ key: a.spec.key, cur: a.cur, next: a.next, rel: a.rel })),
      turn: rec.turn ? { verdict: rec.turn.verdict, boost: rec.turn.boost, ramp: rec.turn.ramp, stats: rec.turn.stats } : null,
      screen: rec.screen || null
    } : null,
    deep: deep && deep.res ? { verdict: deep.res.verdict, pMatters: deep.res.pMatters, drop: deep.res.drop, best: deep.res.best, points: deep.res.points } : null,
    verify: verify && verify.cmp ? { verdict: verify.cmp.verdict, overall: verify.cmp.overall, flick: verify.cmp.flick, track: verify.cmp.track, feelA: verify.feelA, feelB: verify.feelB } : null,
    segments: played.map(s => ({
      kind: s.kind, rail: s.rail, tag: s.tag || s.key || null, turn: !!s.turn, zoom: s.zoom || 1, warm: s.warm || 0,
      settings: s.settings || null, data: segmentData(s)
    }))
  });
}
