import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChallenge, step, summary, quantize, newRecording, record, encodeReplay } from '../src/challenge.js';
import { handleSubmit, cleanName, cleanSettings, codeAllowed } from '../supabase/functions/_shared/submit.js';
import { mulberry32 } from '../src/util.js';

const ENGINE = ['challenge.js', 'sim.js', 'games.js', 'util.js'];
const settings = { sens: 80, vsens: 60, vmult: 1, curve: 'expo', dz: 0.05, outer: 1, boost: 55, boostRamp: 1.6 };
const NOW = new Date('2026-10-21T12:00:00Z');
const PLAYER = '6f1c2e9a-3b4d-4c5e-8f70-112233445566';

// The Exponential curve needs firm stick pushes, so the default gain is high.
function run(code, k = 0.15, seed = 1) {
  const st = createChallenge(code, 'arc', settings);
  const rec = newRecording(), rng = mulberry32(seed);
  while (!st.done) {
    const it = st.item, tgt = it.kind === 'track' ? it.TR.tgt : it.T;
    const ey = tgt.yaw - st.view.yaw, ep = tgt.pitch - st.view.pitch;
    const rx = quantize(Math.max(-1, Math.min(1, ey * k + (rng() - 0.5) * 0.05)));
    const ry = quantize(Math.max(-1, Math.min(1, -ep * k + (rng() - 0.5) * 0.05)));
    const r = it.kind === 'track' ? it.TR.r : it.T.r;
    const fire = it.kind !== 'track' && Math.hypot(ey, ep) < r * 0.8 && !st.prevFire;
    record(rec, rx, ry, fire); step(st, rx, ry, fire);
  }
  const score = summary(st).score;
  assert.ok(score > 0, `test player scored ${score}`);
  return { score, replay: encodeReplay(rec) };
}

// The browser serializes settings with JSON, so the server sees exactly what JSON keeps.
const body = (code, r, extra = {}) => JSON.stringify({
  code, game: 'arc', input: 'pad', playerId: PLAYER, name: 'Raider One', settings, score: r.score, replay: r.replay, ...extra
});

function memoryDb() {
  const rows = new Map();
  return {
    rows,
    async getBest(code, p, input) { return rows.get(`${code}|${p}|${input}`) || null; },
    async save(row) { rows.set(`${row.code}|${row.player_id}|${row.input}`, row); },
    async rank(code, input, score) {
      const board = [...rows.values()].filter(r => r.code === code && (input == null || r.input === input));
      return { rank: board.filter(r => r.score > score).length + 1, total: board.length };
    }
  };
}

test('the server engine is an exact copy of the app engine', () => {
  for (const f of ENGINE) {
    assert.equal(readFileSync(`supabase/functions/_shared/engine/${f}`, 'utf8'), readFileSync(`src/${f}`, 'utf8'), `${f} drifted; run npm run sync:engine`);
  }
});

test('a genuine run is verified, saved and ranked', async () => {
  const db = memoryDb(), r = run('d-2026-10-21');
  const res = await handleSubmit(body('d-2026-10-21', r), db, NOW);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.verified, res.body.saved, res.body.rank, res.body.total], [r.score, true, 1, 1]);
  assert.equal([...db.rows.values()][0].name, 'Raider One');
});

test('an edited score is refused', async () => {
  const r = run('d-2026-10-21');
  const res = await handleSubmit(body('d-2026-10-21', { ...r, score: r.score + 500 }), memoryDb(), NOW);
  assert.equal(res.status, 422);
  assert.match(res.body.error, /replay scored/);
});

test('edited settings or a different code do not verify', async () => {
  const r = run('d-2026-10-21');
  assert.equal((await handleSubmit(body('d-2026-10-21', r, { settings: { ...settings, sens: 120 } }), memoryDb(), NOW)).status, 422);
  assert.equal((await handleSubmit(body('d-2026-10-20', r), memoryDb(), NOW)).status, 422);
});

test("keeps each player's best and ranks against others", async () => {
  const db = memoryDb();
  const good = run('p-share1', 0.15, 2), weak = run('p-share1', 0.06, 3);
  assert.ok(good.score > weak.score);
  await handleSubmit(body('p-share1', good), db, NOW);
  const again = await handleSubmit(body('p-share1', weak), db, NOW);
  assert.deepEqual([again.body.saved, again.body.best], [false, good.score]);
  const rival = await handleSubmit(body('p-share1', weak, { playerId: '00000000-0000-4000-8000-000000000001', name: 'Rival' }), db, NOW);
  assert.deepEqual([rival.body.rank, rival.body.total], [2, 2]);
});

test("refuses tomorrow's daily, short runs, bad names and junk", async () => {
  const r = run('d-2026-10-22');
  assert.equal((await handleSubmit(body('d-2026-10-22', r), memoryDb(), NOW)).status, 400);
  assert.ok(codeAllowed('d-2026-10-21', NOW) && codeAllowed('d-2026-01-01', NOW) && codeAllowed('p-abc123', NOW));
  const short = { ...run('d-2026-10-21'), replay: { n: 100, sticks: '', fire: '' } };
  assert.equal((await handleSubmit(body('d-2026-10-21', short), memoryDb(), NOW)).status, 400);
  assert.equal(cleanName('  Ace   Raider '), 'Ace Raider');
  assert.equal(cleanName('x'), null);
  assert.equal(cleanName('<script>'), null);
  assert.equal(cleanName('F.u.c.k'), null);
  assert.equal((await handleSubmit('{not json', memoryDb(), NOW)).status, 400);
  assert.equal((await handleSubmit('x'.repeat(70000), memoryDb(), NOW)).status, 413);
});

test("settings outside the game's menu are refused", () => {
  assert.ok(cleanSettings('arc', settings));
  assert.equal(cleanSettings('arc', { ...settings, sens: 900 }), null);
  assert.equal(cleanSettings('arc', { ...settings, curve: 'wild' }), null);
  assert.equal(cleanSettings('fortnite', { ...settings, boost: 55 }), null);
  const fort = cleanSettings('fortnite', { sens: 45, vmult: 1, curve: 'mid', dz: 0.1, outer: 1 });
  assert.deepEqual(fort, { sens: 45, vmult: 1, curve: 'mid', dz: 0.1, outer: 1 });
});

// A mouse player: counts toward the target each tick, at a carried degrees per count.
function mouseRun(code, dpc = 0.033) {
  const ms = { sens: 1.5, vmult: 1, curve: 'linear', dz: 0, outer: 1, dpc };
  const st = createChallenge(code, 'm-cs2', ms), rec = newRecording();
  while (!st.done) {
    const it = st.item, tgt = it.kind === 'track' ? it.TR.tgt : it.T;
    const ey = tgt.yaw - st.view.yaw, ep = tgt.pitch - st.view.pitch;
    const mx = Math.round(ey / dpc * 0.2), my = Math.round(-ep / dpc * 0.2);
    const r = it.kind === 'track' ? it.TR.r : it.T.r;
    const fire = it.kind !== 'track' && Math.hypot(ey, ep) < r * 0.8 && !st.prevFire;
    record(rec, mx, my, fire); step(st, mx, my, fire);
  }
  return { settings: ms, score: summary(st).score, replay: encodeReplay(rec) };
}

test('mouse runs are verified with their own degrees per count, on their own and the combined board', async () => {
  const db = memoryDb(), code = 'd-2026-10-21';
  const pad = run(code);
  await handleSubmit(body(code, pad), db, NOW);
  const m = mouseRun(code);
  const res = await handleSubmit(body(code, m, { game: 'm-cs2', input: 'mouse', settings: m.settings, playerId: '7f1c2e9a-3b4d-4c5e-8f70-112233445566' }), db, NOW);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.verified, m.score);
  assert.deepEqual([res.body.rank, res.body.total, res.body.totalAll], [1, 1, 2]);
  // A different degrees per count replays to a different score, so it can't be swapped after the fact.
  const lie = await handleSubmit(body(code, m, { game: 'm-cs2', input: 'mouse', settings: { ...m.settings, dpc: 0.05 } }), db, NOW);
  assert.equal(lie.status, 422);
});

test('input type must match the game, and mouse runs need their degrees per count', async () => {
  const db = memoryDb(), code = 'd-2026-10-21', m = mouseRun(code);
  const asPad = await handleSubmit(body(code, m, { game: 'm-cs2', input: 'pad', settings: m.settings }), db, NOW);
  assert.equal(asPad.status, 400);
  const { dpc, ...noDpc } = m.settings;
  const missing = await handleSubmit(body(code, m, { game: 'm-cs2', input: 'mouse', settings: noDpc }), db, NOW);
  assert.equal(missing.status, 400);
  const padRun = run(code);
  const padWithDpc = await handleSubmit(body(code, padRun, { settings: { ...settings, dpc: 0.02 } }), db, NOW);
  assert.equal(padWithDpc.status, 400);
});
