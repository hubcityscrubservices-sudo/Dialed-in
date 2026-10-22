import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAMES } from '../src/games.js';
import { steer, makeView } from '../src/sim.js';
import { analyzeSwipes, resolveDpi, pollingHz, calibrationK, cm360, CARD_CM } from '../src/mouse.js';
import { recommend } from '../src/analysis.js';
import { createChallenge, step, newRecording, record, encodeReplay, decodeReplay, replay, summary } from '../src/challenge.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
const cpcm800 = 800 / 2.54;

test('known-yaw games turn sens x yaw degrees per count, same on both axes', () => {
  const g = GAMES['m-cs2'];
  g.cal.k = 1;
  const v = makeView();
  steer(v, { mx: 1000, my: -500 }, { sens: 2 }, g, 1 / 60);
  near(v.yaw, 1000 * 2 * 0.022);
  near(v.pitch, 500 * 2 * 0.022);
});

test('cm/360 matches the converters: CS2 at 800 DPI, sens 1 is about 52 cm', () => {
  const g = GAMES['m-cs2'];
  g.cal.k = 1;
  near(cm360(g, 1, cpcm800), 51.95, 0.01);
  near(cm360(GAMES['m-valorant'], 0.314, cpcm800), 51.95 * 0.022 / (0.07 * 0.314), 0.01);
});

test('games without a published yaw calibrate from the player\'s cm/360', () => {
  const g = GAMES['m-arc'];
  g.cal.k = calibrationK(g, { cpcmBrowser: cpcm800, cpcmGame: cpcm800, sens0: 50, cm0: 30 });
  near(cm360(g, 50, cpcm800), 30);
  near(cm360(g, 25, cpcm800), 60);              // half the sensitivity, twice the distance
});

test('browser display scaling is undone for known-yaw games', () => {
  const g = GAMES['m-valorant'];
  const r = resolveDpi(800, cpcm800 / 1.5, 1.5);
  assert.equal(r.verdict, 'scaled');
  g.cal.k = calibrationK(g, r);
  near(g.sens.rate(0.4) * r.cpcmBrowser, 0.4 * 0.07 * cpcm800); // degrees per cm as the game turns
});

test('a DPI that doesn\'t match the card is reported, and the measurement wins', () => {
  assert.equal(resolveDpi(800, cpcm800 * 1.02).verdict, 'match');
  const r = resolveDpi(800, 1600 / 2.54);
  assert.equal(r.verdict, 'wrong'); near(r.dpiSeen, 1600, 1e-6); near(r.cpcmGame, 1600 / 2.54);
  assert.equal(resolveDpi(800, null).verdict, 'entered');
});

test('card swipes: counts per cm, and acceleration shows as fast swipes going further', () => {
  const c = cpcm800 * CARD_CM;
  const raw = analyzeSwipes([{ dx: c, dy: 0 }, { dx: c * 1.3, dy: 0 }, { dx: c * 1.02, dy: 0 }], true);
  near(raw.cpcm, cpcm800 * 1.02, 1e-6); assert.equal(raw.accel, null);
  const acc = analyzeSwipes([{ dx: c, dy: 0 }, { dx: c * 1.3, dy: 0 }, { dx: c, dy: 0 }], false);
  near(acc.cpcm, cpcm800); near(acc.accel, 1.3);
});

test('polling rate snaps to a standard rate', () => {
  assert.equal(pollingHz(Array(100).fill(1.02)), 1000);
  assert.equal(pollingHz(Array(100).fill(8)), 125);
  assert.equal(pollingHz([1, 2]), null);
});

test('recommendations land on the menu\'s own steps', () => {
  const g = GAMES['m-valorant'];
  g.cal.k = 1;
  const s = { under: 0.6, over: 0.05, behind: 0.5, ahead: 0.1, jitter: 0, hitRate: 0.8 };
  const r = recommend(s, { game: 'm-valorant', style: 'balanced', sens: 0.4, curve: 'linear', dz: 0 }, null);
  assert.ok(r.sens > 0.4);
  assert.equal(r.sens, +r.sens.toFixed(3));
});

test('a mouse challenge run replays to the same score', () => {
  GAMES['m-cs2'].cal.k = 1;
  const settings = { sens: 1.5, curve: 'linear', dz: 0 };
  const st = createChallenge('p-mouse1', 'm-cs2', settings), rec = newRecording();
  let i = 0;
  while (!st.done) {
    if (!st.item) { record(rec, 0, 0, false); step(st, 0, 0, false); continue; } // pause between targets
    const T = st.item.T || st.item.TR.tgt;
    const mx = Math.round((T.yaw - st.view.yaw) / (1.5 * 0.022) * 0.2), my = Math.round(-(T.pitch - st.view.pitch) / (1.5 * 0.022) * 0.2);
    const fire = i++ % 9 === 0;
    record(rec, mx, my, fire); step(st, mx, my, fire);
  }
  const live = summary(st);
  assert.ok(live.hits > 10);
  assert.deepEqual(replay('p-mouse1', 'm-cs2', settings, decodeReplay(encodeReplay(rec))), live);
});
