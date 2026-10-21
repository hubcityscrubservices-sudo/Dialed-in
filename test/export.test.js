import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, EXPORT_VERSION } from '../src/export.js';

test('export keeps played segments only, rounds numbers and survives JSON', () => {
  const segs = [
    { kind: 'drift', data: { part: 'squeeze' } },
    { kind: 'flick', rail: 'flick', tag: 'quick', settings: { sens: 80 }, data: { list: [
      { D: 20.123456, W: 4, uy: 0.2, t: 0.71234, hit: true, shots: 1, segs: 2, overshoot: false, maxProj: 20.5, first: { t: 0.7, along: 20.4 } },
      { D: 150, W: 6, uy: 0, t: 1.2, hit: true, shots: 1, segs: 1, overshoot: true, maxProj: 160, first: { t: 1.1, along: 158 }, turn: true, reachT: 0.9, fullT: 0.7, maxStint: 0.7 }
    ] } },
    { kind: 'track', rail: 'track', settings: { sens: 80 }, data: { T: 15, errSum: 30, on: 5, behind: 4, ahead: 3, near: 9, rev: 4, tRev: 2, chunks: [2, 2.5], tgt: {} } },
    { kind: 'rate', rail: 'verify', key: 'A', data: 3 },
    { kind: 'rate', rail: 'verify', key: 'B', data: null },
    { kind: 'analyze' }
  ];
  const out = buildExport({ cfg: { game: 'arc' }, drift: null, rec: null, segs, pad: 'DualSense', when: new Date(0) });
  assert.equal(out.v, EXPORT_VERSION);
  assert.equal(out.segments.length, 3);
  const [fl, tr, ra] = out.segments;
  assert.equal(fl.data[0].D, 20.123);
  assert.equal(fl.data[0].past, 0.377);
  assert.equal(fl.data[1].reachT, 0.9);
  assert.equal(fl.data[0].reachT, undefined);
  assert.equal(tr.data.tgt, undefined);
  assert.equal(ra.tag, 'A');
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});
