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
