import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLL, makeRollDrill, rollStep, rollSummary } from '../src/roll.js';
import { mulberry32 } from '../src/util.js';

// A bot on the clip's rhythm: on target always (snaps when allowed), fires, rolls ~0.25 s later
// (double press 0.1 s apart), fires again ~0.27 s after landing.
function play({ snap = 0.27, commit = 0.25, aimDuringRoll = true } = {}) {
  const D = makeRollDrill(mulberry32(2)), view = { yaw: 0, pitch: 0 }, dt = 1 / 60;
  let state = 'shoot', wait = 0.2, presses = 0;
  while (!D.done) {
    const inp = { fireEdge: false, rollPress: false, lx: 0, stick: aimDuringRoll ? 0.5 : 0 };
    if (!D.roll || aimDuringRoll) { view.yaw = D.T.yaw; view.pitch = D.T.pitch; }
    wait -= dt;
    if (state === 'shoot' && wait <= 0) { inp.fireEdge = true; state = 'roll'; wait = commit - 0.1; presses = 0; }
    else if (state === 'roll' && wait <= 0) { inp.rollPress = true; presses++; wait = 0.1; if (presses === 2) state = 'rolling'; }
    const ev = rollStep(D, view, inp, dt);
    if (ev === 'land') { state = 'shoot'; wait = snap; }
  }
  return rollSummary(D);
}

test('roll drill: the clip rhythm loops about once a second, and the measures read back what was played', () => {
  const s = play();
  assert.ok(s.loops >= 35, JSON.stringify(s));
  assert.ok(Math.abs(s.loop - (0.25 + ROLL.rollT + 0.27)) < 0.08, JSON.stringify(s));
  assert.ok(Math.abs(s.snap - 0.27) < 0.04 && Math.abs(s.commit - 0.25) < 0.04, JSON.stringify(s));
  assert.equal(s.firstHit, 1);
  assert.ok(s.idle < 0.05);
  const slow = play({ snap: 0.6 });
  assert.ok(slow.loop > s.loop + 0.25 && slow.loops < s.loops);
});

test('roll drill: rolling slides the target, so a thumb off the stick misses; shooting is locked mid-roll', () => {
  const D = makeRollDrill(mulberry32(1)), view = { yaw: 0, pitch: 0 };
  rollStep(D, view, { rollPress: true, lx: 1, stick: 0 }, 1 / 60);
  rollStep(D, view, { rollPress: true, lx: 1, stick: 0 }, 1 / 60);
  assert.ok(D.roll);
  assert.equal(rollStep(D, view, { fireEdge: true, lx: 0, stick: 0 }, 1 / 60), null); // locked
  for (let i = 0; i < 40 && D.roll; i++) rollStep(D, view, { lx: 0, stick: 0 }, 1 / 60);
  assert.ok(!D.roll);
  assert.ok(D.T.yaw < -5, String(D.T.yaw)); // rolled right at 10 m: the target slid about 9 degrees left
  assert.ok(rollSummary(D).idle > 0.9);
});
