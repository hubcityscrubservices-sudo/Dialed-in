import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hfov169, zoomedFov, makeCamera } from '../src/camera.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test('FOV conventions convert to horizontal 16:9', () => {
  near(hfov169(103, 'h169'), 103);
  near(hfov169(90, 'h43'), 106.2602, 1e-3);   // CS: 90 on 4:3 is about 106.26 on 16:9
  near(hfov169(70, 'h43'), 86.06, 0.05);       // 70 on a 4:3 scale
  near(hfov169(59, 'v'), 90.34, 0.05);         // vertical 59 is about 90.3 horizontal
});

test('zooming divides tan(FOV/2)', () => {
  near(zoomedFov(90, 1), 90);
  near(Math.tan(zoomedFov(100, 4) * Math.PI / 360), Math.tan(50 * Math.PI / 180) / 4);
});

test('projection: centre, edges, and the slower-in-the-middle effect', () => {
  const cam = makeCamera({ yaw: 30, pitch: 0 }, 1600, 900, 100);
  const c = cam.project(30, 0);
  near(c.x, 800); near(c.y, 450);
  near(cam.project(80, 0).x, 1600, 1e-6);       // half the FOV to the right lands on the edge
  near(cam.project(-20, 0).x, 0, 1e-6);
  assert.ok(cam.project(31, 0).x - 800 < 1600 / 100); // 1 degree at the centre is less than W/FOV pixels at 100 FOV
  near(cam.project(30, 10).y, 450 - cam.f * Math.tan(10 * Math.PI / 180));
  assert.ok(cam.project(210, 0).z < 0);          // straight behind
});

test('looking up moves the horizon down by f * tan(pitch)', () => {
  const cam = makeCamera({ yaw: 0, pitch: 12 }, 1600, 900, 90);
  near(cam.project(0, 0).y, 450 + cam.f * Math.tan(12 * Math.PI / 180));
  near(cam.project(45, 0).y, cam.project(-45, 0).y); // horizon stays level (no roll)
});

test('a canvas wider than 16:9 keeps the vertical FOV and shows more to the sides', () => {
  const a = makeCamera({ yaw: 0, pitch: 0 }, 1600, 900, 90), b = makeCamera({ yaw: 0, pitch: 0 }, 2100, 900, 90);
  near(a.f, b.f); near(a.fov, 90);
  assert.ok(b.fov > 90);
});
