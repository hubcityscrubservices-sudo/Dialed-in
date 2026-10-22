import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAMES } from '../src/games.js';
import { steer } from '../src/sim.js';
import { mulberry32 } from '../src/util.js';
import { RECOIL, makeRecoil, recoilStep, recoilSummary, recommendRecoil } from '../src/recoil.js';

const g = GAMES.arc;
const base = { sens: 75, vsens: 55, curve: 'expo', dz: 0.05, outer: 1, adsMult: 0.3, zoomed: true };

// A bot that holds a fixed pull plus a correction toward the target, snapping onto each new target.
function play(s, pull, gain = 0.25) {
  const R = makeRecoil(mulberry32(7)), view = { yaw: 0, pitch: 0, boostT: 0 };
  let fire = true;
  for (let i = 0; i < 60 * 60; i++) {
    const ev = view.pitch - R.T.pitch;
    const ry = fire && R.cur ? Math.max(-1, Math.min(1, pull + gain * ev)) : 0;
    steer(view, { rx: 0, ry }, s, g, 1 / 60);
    const out = recoilStep(R, view, fire, ry, 1 / 60);
    if (out === 'done') break;
    if (out === 'burst') { fire = false; view.yaw = R.T.yaw; view.pitch = R.T.pitch; }
    else if (!fire) fire = true;
  }
  return recoilSummary(R);
}

test('recoil: an exact pull-down keeps the setting; an under-pull asks for more vertical speed', () => {
  const r0 = recommendRecoil({ bias: 0, wobble: 0, side: 0, early: 0, pull: 0, r: RECOIL.r }, g, base);
  const exact = base.dz + r0.need * (1 - base.dz);
  const good = play(base, exact);
  assert.equal(good.n, RECOIL.bursts - RECOIL.warm);
  assert.ok(Math.abs(good.bias) < RECOIL.r * 0.5, JSON.stringify(good));
  assert.equal(recommendRecoil(good, g, base).verdict, 'keep');
  const weak = play(base, exact * 0.85, 0);
  assert.ok(weak.bias > RECOIL.r * 0.5, JSON.stringify(weak));
  const rec = recommendRecoil(weak, g, base);
  assert.equal(rec.verdict, 'raise');
  assert.ok(rec.vsens > base.vsens && rec.vsens % 5 === 0, JSON.stringify(rec));
});

test('recoil: a vertical speed too slow to cancel the climb at full pull is raised', () => {
  const slow = { ...base, vsens: 10, adsMult: 0.05 };
  const rec = recommendRecoil(play(slow, 1), g, slow);
  assert.equal(rec.need, 1);
  assert.equal(rec.verdict, 'raise');
});
