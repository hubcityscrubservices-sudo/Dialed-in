import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CH, TICKS, hashSeed, dailyCode, practiceCode, isCode, quantize, createChallenge, step, summary,
  hitPoints, newRecording, record, encodeReplay, decodeReplay, replay } from '../src/challenge.js';
import { mulberry32 } from '../src/util.js';

const settings = { sens: 80, vsens: 60, curve: 'linear', dz: 0.05, outer: 1, boost: 55, boostRamp: 1.6 };

// A player that steers toward the current target and fires when on it; `skill` scales its aim.
function playBot(code, skill = 1, seed = 1) {
  const st = createChallenge(code, 'arc', settings);
  const rec = newRecording();
  const rng = mulberry32(seed);
  while (!st.done) {
    if (!st.item) { record(rec, 0, 0, false); step(st, 0, 0, false); continue; } // pause between targets
    const it = st.item;
    const tgt = it.kind === 'track' ? it.TR.tgt : it.T;
    const ey = tgt.yaw - st.view.yaw, ep = tgt.pitch - st.view.pitch;
    const k = 0.06 * skill;
    const rx = quantize(Math.max(-1, Math.min(1, ey * k + (rng() - 0.5) * 0.05)));
    const ry = quantize(Math.max(-1, Math.min(1, -ep * k + (rng() - 0.5) * 0.05)));
    const r = it.kind === 'track' ? it.TR.r : it.T.r;
    const fire = it.kind !== 'track' && Math.hypot(ey, ep) < r * 0.8 && !st.prevFire;
    record(rec, rx, ry, fire);
    step(st, rx, ry, fire);
  }
  return { st, rec };
}

test('codes: daily from the date, practice random, both valid link tokens', () => {
  assert.equal(dailyCode(new Date('2026-10-21T15:00:00Z')), 'd-2026-10-21');
  const p = practiceCode(mulberry32(1));
  assert.match(p, /^p-[a-z0-9]{6}$/);
  assert.ok(isCode(p) && isCode('d-2026-10-21'));
  assert.ok(!isCode('x-1') && !isCode('d-<script>'));
  assert.notEqual(hashSeed('d-2026-10-21'), hashSeed('d-2026-10-22'));
});

test('same code, same targets; different code, different targets', () => {
  const a = createChallenge('d-2026-10-21', 'arc', settings), b = createChallenge('d-2026-10-21', 'arc', settings);
  const c = createChallenge('d-2026-10-22', 'arc', settings);
  assert.deepEqual([a.item.T.yaw, a.item.T.pitch], [b.item.T.yaw, b.item.T.pitch]);
  assert.notDeepEqual([a.item.T.yaw, a.item.T.pitch], [c.item.T.yaw, c.item.T.pitch]);
});

test('a run lasts exactly 60 seconds of ticks and mixes flicks, tracking and turns', () => {
  const { st } = playBot('d-2026-10-21');
  assert.equal(st.tick, TICKS);
  assert.ok(st.items > 15, `items ${st.items}`);
  const s = summary(st);
  assert.ok(s.hits > 10 && s.score > 0, JSON.stringify(s));
  assert.ok(s.tracking != null);
});

test('a replay reproduces the live score exactly, through encoding', () => {
  const { st, rec } = playBot('p-k3x9q2');
  const live = summary(st);
  const enc = encodeReplay(rec);
  assert.ok(enc.sticks.length < 25000);
  const again = replay('p-k3x9q2', 'arc', settings, decodeReplay(JSON.parse(JSON.stringify(enc))));
  assert.deepEqual(again, live);
});

test('a replay with edited input or settings does not match', () => {
  const { st, rec } = playBot('p-k3x9q2');
  const live = summary(st);
  assert.notEqual(replay('p-k3x9q2', 'arc', { ...settings, sens: 200 }, rec).score, live.score);
  assert.notEqual(replay('p-zzzz11', 'arc', settings, rec).score, live.score);
});

test('better aim scores more', () => {
  const good = summary(playBot('d-2026-10-21', 1.4).st).score;
  const poor = summary(playBot('d-2026-10-21', 0.35).st).score;
  assert.ok(good > poor, `good ${good} poor ${poor}`);
});

test('hit points grow with difficulty, speed and streak', () => {
  const T = (D, W, t) => ({ D, W, t });
  assert.ok(hitPoints(T(30, 3, 0.5), 1) > hitPoints(T(10, 6, 0.5), 1));
  assert.ok(hitPoints(T(20, 4, 0.3), 1) > hitPoints(T(20, 4, 1.2), 1));
  assert.ok(Math.abs(hitPoints(T(20, 4, 0.5), 11) / hitPoints(T(20, 4, 0.5), 1) - (1 + CH.streakStep * CH.streakCap)) < 1e-9);
});

// Fixed scores for version-1 runs, from the engine as it was before version 2. Any change that makes
// these drift would break verification of runs already on the leaderboard.
test('version 1 rules replay exactly as before (dailies before V2_FROM)', () => {
  const s = { sens: 80, vsens: 60, vmult: 1, curve: 'expo', dz: 0.05, outer: 1, boost: 55, boostRamp: 1.6 };
  const cases = [['d-2026-10-21', 'arc', 0.15, s, 25313], ['d-2026-10-20', 'cod', 0.1, { sens: 1.65, vsens: 1.65, curve: 'mid', dz: 0.1 }, 24278],
    ['d-2026-10-19', 'apex', 0.2, { sens: 3, curve: 'mid', dz: 0.1 }, 18799]];
  for (const [code, game, k, set, want] of cases) {
    const st = createChallenge(code, game, set), rng = mulberry32(7);
    assert.equal(st.v, 1);
    while (!st.done) {
      const it = st.item, t = it.kind === 'track' ? it.TR.tgt : it.T;
      const ey = t.yaw - st.view.yaw, ep = t.pitch - st.view.pitch;
      const rx = quantize(Math.max(-1, Math.min(1, ey * k + (rng() - 0.5) * 0.1)));
      const ry = quantize(Math.max(-1, Math.min(1, -ep * k + (rng() - 0.5) * 0.1)));
      const r = it.kind === 'track' ? it.TR.r : it.T.r;
      step(st, rx, ry, it.kind !== 'track' && Math.hypot(ey, ep) < r * 0.9 && !st.prevFire);
    }
    assert.equal(summary(st).score, want, `${code} ${game}`);
  }
});

test('version 2: controller runs get aim assist and engine-2 rules; submitted values cannot change them', () => {
  const pad = createChallenge('d-2026-10-22', 'arc', { sens: 80, curve: 'expo', dz: 0.05, aa: 0, eng: 1 }, { v: 2 });
  assert.equal(pad.v, 2); assert.equal(pad.settings.aa, 1); assert.equal(pad.settings.eng, 2);
  const old = createChallenge('d-2026-10-21', 'arc', { sens: 80, curve: 'expo', dz: 0.05, aa: 1, eng: 2 });
  assert.equal(old.settings.aa, undefined); assert.equal(old.settings.eng, undefined);
  const m = createChallenge('p-abcdef', 'm-cs2', { sens: 1, curve: 'linear', dz: 0, dpc: 0.022 });
  assert.equal(m.settings.aa, undefined);
});

// Version 2 (the 2026-10-22 rules before version 3 was brought forward) must keep replaying exactly.
test('version 2 rules replay exactly as when they shipped', () => {
  const s = { sens: 80, vsens: 60, vmult: 1, curve: 'expo', dz: 0.05, outer: 1, boost: 55, boostRamp: 1.6 };
  const cases = [['arc', 0.15, s, 18326], ['cod', 0.1, { sens: 1.65, vsens: 1.65, curve: 'mid', dz: 0.1 }, 15363], ['apex', 0.2, { sens: 3, curve: 'mid', dz: 0.1 }, 18828]];
  for (const [game, k, set, want] of cases) {
    const st = createChallenge('d-2026-10-22', game, set, { v: 2 }), rng = mulberry32(7);
    assert.equal(st.v, 2);
    while (!st.done) {
      const it = st.item; if (!it) { step(st, 0, 0, false); continue; }
      const t = it.kind === 'track' ? it.TR.tgt : it.T;
      const ey = t.yaw - st.view.yaw, ep = t.pitch - st.view.pitch;
      const rx = quantize(Math.max(-1, Math.min(1, ey * k + (rng() - 0.5) * 0.1)));
      const ry = quantize(Math.max(-1, Math.min(1, -ep * k + (rng() - 0.5) * 0.1)));
      const r = it.kind === 'track' ? it.TR.r : it.T.r;
      step(st, rx, ry, it.kind !== 'track' && Math.hypot(ey, ep) < r * 0.9 && !st.prevFire);
    }
    assert.equal(summary(st).score, want, game);
  }
});

test('version 3: moving targets score only while firing on them, and firing off target costs nothing', () => {
  // Hold-fire tracking is in every version from 3. With precision scoring: dailies and Standard (6), Warm-up (8), Hard (7).
  assert.equal(createChallenge('d-2026-10-23', 'arc', settings).v, 6);
  assert.equal(createChallenge('d-2026-10-22', 'arc', settings).v, 6); // brought forward to the 22nd
  assert.equal(createChallenge('p-k3x9q2', 'arc', settings).v, 6);
  assert.equal(createChallenge('w-k3x9q2', 'arc', settings).v, 8);
  assert.equal(createChallenge('h-k3x9q2', 'arc', settings).v, 7);
  // Follow every moving target perfectly, once without firing and once holding fire the whole time.
  const play = holdFire => {
    const st = createChallenge('d-2026-10-23', 'arc', settings);
    let trackPts = 0;
    while (!st.done) {
      const it = st.item;
      if (!it) { step(st, 0, 0, false); continue; }
      const t = it.kind === 'track' ? it.TR.tgt : it.T;
      const ey = t.yaw - st.view.yaw, ep = t.pitch - st.view.pitch;
      const rx = quantize(Math.max(-1, Math.min(1, ey * 0.15))), ry = quantize(Math.max(-1, Math.min(1, -ep * 0.15)));
      const before = st.score;
      if (it.kind === 'track') { step(st, rx, ry, holdFire); trackPts += st.score - before; }
      else step(st, rx, ry, Math.hypot(ey, ep) < it.T.r * 0.8 && !st.prevFire);
    }
    return { st, trackPts, sum: summary(st) };
  };
  const quiet = play(false), firing = play(true);
  assert.equal(quiet.trackPts, 0);
  assert.equal(quiet.sum.trackAcc, null);
  assert.ok(firing.trackPts > 0);
  assert.ok(firing.sum.trackAcc > 0 && firing.sum.trackAcc <= 1);
  // Holding fire while off target never takes points away.
  assert.ok(firing.sum.score >= quiet.sum.score);
});

test('version 4 spreads standing targets out; Hard spreads them further and makes them smaller', () => {
  const stats = code => {
    const D = [], R = [];
    for (let k = 0; k < 6; k++) {
      const st = createChallenge(code + k, 'arc', settings);
      let seen = null;
      while (!st.done) {
        const it = st.item;
        if (it && it !== seen) { seen = it; if (it.kind === 'flick' && Math.abs(it.T.uy) < 0.7) { D.push(it.T.D); R.push(it.T.r); } }
        if (it && it.kind !== 'track') { st.view.yaw = it.T.yaw; st.view.pitch = it.T.pitch; step(st, 0, 0, !st.prevFire); } else step(st, 0, 0, false);
      }
    }
    const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
    return { d: med(D), far: D.filter(d => d > 40).length / D.length, r: med(R) };
  };
  const w = stats('w-sprd0'), s4 = stats('p-sprd0'), h = stats('h-sprd0');
  assert.ok(w.far === 0 && s4.far > 0.1 && h.far > s4.far, JSON.stringify({ w, s4, h }));
  assert.ok(s4.d > w.d && h.d > s4.d);
  assert.ok(h.r < s4.r && s4.r < w.r);
});

test('precision versions pay more for hits near the centre; older versions have no zones', () => {
  const play = (off, opts) => {
    const st = createChallenge('d-2026-10-23', 'arc', settings, opts);
    while (!st.done) {
      const it = st.item;
      if (it && it.kind !== 'track') { st.view.yaw = it.T.yaw + off * it.T.r; st.view.pitch = it.T.pitch; step(st, 0, 0, !st.prevFire); } else step(st, 0, 0, false);
    }
    return summary(st);
  };
  const centre = play(0), edge = play(0.8);
  assert.equal(centre.zones.bull, centre.hits);
  assert.ok(edge.zones.edge > edge.hits * 0.8, JSON.stringify(edge.zones));
  assert.ok(centre.score > edge.score * 1.3, `${centre.score} vs ${edge.score}`);
  assert.equal(play(0, { v: 4 }).zones, null);
});
