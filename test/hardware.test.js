import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECTORS, emptyReach, sectorOf, recordReach, coverage, stickReport, outerFromReach, triggerDeadzone, hardwareRecs } from '../src/hardware.js';
import { shape } from '../src/sim.js';
import { GAMES } from '../src/games.js';

function roll(maxAt) {
  const reach = emptyReach();
  for (let i = 0; i < 720; i++) {
    const a = i / 720 * 4 * Math.PI;
    const m = maxAt(a);
    recordReach(reach, Math.cos(a) * m, Math.sin(a) * m);
  }
  return reach;
}

test('sectors cover the circle', () => {
  assert.equal(sectorOf(1, 0), 0);
  assert.equal(sectorOf(0, 1), SECTORS / 4);
  assert.equal(sectorOf(-1, -0.0001), SECTORS / 2);
  assert.equal(sectorOf(1, -0.0001), SECTORS - 1);
  const r = emptyReach();
  recordReach(r, 0.5, 0); // too gentle to count
  assert.equal(coverage(r), 0);
});

test('a healthy stick needs no outer deadzone', () => {
  const rep = stickReport(roll(() => 1));
  assert.ok(rep.minReach >= 0.99);
  assert.equal(outerFromReach(rep.minReach), 1);
});

test('a worn stick gets an outer deadzone below its weakest direction', () => {
  // Weak toward the lower left (angles around 135 deg in screen space, y down).
  const rep = stickReport(roll(a => (Math.abs(a % (2 * Math.PI) - 2.36) < 0.4 ? 0.86 : 1)));
  assert.ok(Math.abs(rep.minReach - 0.86) < 1e-9);
  assert.equal(rep.worstDir, 'lower left');
  assert.equal(outerFromReach(rep.minReach), 0.84);
});

test('a square gate is detected', () => {
  const rep = stickReport(roll(a => 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a))) * 0.95));
  assert.ok(rep.squareness > 1.05);
});

test('a partial roll is not enough to judge', () => {
  assert.equal(stickReport(roll(a => (a % (2 * Math.PI) < Math.PI ? 1 : 0))), null);
});

test('trigger deadzone sits just above resting noise', () => {
  assert.equal(triggerDeadzone(0), 0.03);
  assert.equal(triggerDeadzone(0.1), 0.15);
  assert.equal(triggerDeadzone(0.9), 0.3);
});

test('outer deadzone lets a weak push reach full output', () => {
  assert.ok(shape(0.84, 0, 0.1, 1, 1)[2] < 1);
  assert.equal(shape(0.84, 0, 0.1, 1, 0.84)[2], 1);
});

test('hardwareRecs uses real menu names where known and generic ones elsewhere', () => {
  const check = { l: 0.05, reachR: { minReach: 0.86, worstDir: 'left', squareness: 1 }, trig: { restR: 0.01, maxR: 1 } };
  const cod = hardwareRecs(check, GAMES.cod);
  assert.deepEqual(cod.map(r => r.key), ['moveDz', 'outer', 'trigger']);
  assert.ok(cod.every(r => r.st.known));
  assert.equal(cod[1].st.fmt(cod[1].next), '84');
  // ARC Raiders has a movement deadzone but no outer or trigger deadzone, so only one row.
  const arc = hardwareRecs(check, GAMES.arc);
  assert.deepEqual(arc.map(r => r.key), ['moveDz']);
  assert.equal(arc[0].st.label, 'Movement Inner Deadzone');
  assert.equal(arc[0].cur, 0.15);
  // A game with no profile entry gets the generic name.
  const fort = hardwareRecs(check, GAMES.fortnite);
  assert.equal(fort[1].st.known, false);
  assert.equal(GAMES.apex.outer.fmt(0.84), '16%');
  assert.deepEqual(hardwareRecs(null, GAMES.cod), []);
});
