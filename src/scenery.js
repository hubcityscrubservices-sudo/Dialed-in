// The aim range as a place: a dusk panorama generated from a seed, placed in the same angular space the
// sim uses (yaw/pitch in degrees) and drawn through a perspective camera at the game's FOV (camera.js),
// so ridges, sun and stars stay put as the view turns and the screen moves the way the game's does.
// Pure drawing: nothing here affects scoring.
import { mulberry32 } from './util.js';

const PALETTES = [
  { name: 'Ember dusk', top: '#0A1322', mid: '#2C2A4E', low: '#9A4A4E', horizon: '#F07A45', glow: '#FFB55C',
    ridges: ['#5A4467', '#33284A', '#141B28'], ground: '#0A1118', fog: 'rgba(255,140,90,0.28)', star: '#FFE9C4' },
  { name: 'Violet hour', top: '#0B1030', mid: '#352C63', low: '#8A4A7E', horizon: '#D6627E', glow: '#FFA27E',
    ridges: ['#54457E', '#2F2756', '#121529'], ground: '#0A0F1E', fog: 'rgba(230,120,150,0.26)', star: '#F2E4FF' },
  { name: 'Teal night', top: '#05101A', mid: '#0F2C40', low: '#1F5A66', horizon: '#3E9A98', glow: '#A8EEDC',
    ridges: ['#2A5466', '#183849', '#0A1822'], ground: '#061018', fog: 'rgba(120,220,200,0.20)', star: '#DDFBF4' },
  { name: 'Amber haze', top: '#14141F', mid: '#3F2E3E', low: '#9A5A3A', horizon: '#E9913A', glow: '#FFD48A',
    ridges: ['#64495A', '#3A2B3C', '#17161F'], ground: '#0F0E14', fog: 'rgba(255,190,110,0.26)', star: '#FFF1D6' }
];

const LAYERS = [ // far to near: base height and roughness, in degrees above the horizon
  { base: 5.2, amp: 3.2, harmonics: [3, 5, 8, 13] },
  { base: 2.6, amp: 2.4, harmonics: [4, 7, 11, 17] },
  { base: 0.6, amp: 1.5, harmonics: [6, 9, 14, 23] }
];

const wrap = a => ((a % 360) + 540) % 360 - 180; // signed shortest difference in degrees

export function makeWorld(seed) {
  const rng = mulberry32(seed >>> 0);
  const pal = PALETTES[Math.floor(rng() * PALETTES.length)];
  const ridges = LAYERS.map(L => ({
    ...L,
    terms: L.harmonics.map((k, i) => ({ k, w: (rng() * 0.6 + 0.4) / (i + 1), ph: rng() * Math.PI * 2 }))
  }));
  const stars = Array.from({ length: 140 }, () => ({
    yaw: rng() * 360, pitch: 10 + Math.pow(rng(), 0.7) * 55, r: rng() < 0.12 ? 1.6 : 0.9, tw: rng() * Math.PI * 2
  }));
  return { pal, ridges, stars, sunYaw: rng() * 360, sunPitch: 2 + rng() * 5, fx: [], lastFlash: null, trail: null };
}

function ridgeHeight(R, yaw) {
  const a = yaw * Math.PI / 180;
  let h = 0, wsum = 0;
  for (const t of R.terms) { h += t.w * Math.sin(t.k * a + t.ph); wsum += t.w; }
  return R.base + R.amp * (h / wsum);
}

// A world direction on screen, or null when it is behind (or nearly behind) the camera.
const onScreen = (cam, yaw, pitch) => { const q = cam.project(yaw, pitch); return q.z > 0.02 ? q : null; };
const horizonY = cam => cam.cy + cam.f * Math.tan(cam.pitch * Math.PI / 180);

// cam = makeCamera(...) plus d (device pixel ratio)
export function paintSky(ctx, cam, world, now, still) {
  const { W, H, d, ppd } = cam, p = world.pal;
  const yH = horizonY(cam);
  ctx.fillStyle = p.top; ctx.fillRect(0, 0, W, H);
  const yTop = yH - 60 * ppd;
  const g = ctx.createLinearGradient(0, yTop, 0, yH);
  g.addColorStop(0, p.top); g.addColorStop(0.45, p.mid); g.addColorStop(0.82, p.low); g.addColorStop(1, p.horizon);
  ctx.fillStyle = g; ctx.fillRect(0, Math.min(yTop, 0), W, Math.max(0, yH - Math.min(yTop, 0)));

  // stars, fading out toward the horizon glow
  for (const s of world.stars) {
    const q = onScreen(cam, s.yaw, s.pitch);
    if (!q || q.x < -4 || q.x > W + 4 || q.y < -4 || q.y > yH) continue;
    const tw = still ? 0.8 : 0.6 + 0.4 * Math.sin(now * 0.0015 + s.tw);
    ctx.globalAlpha = tw * Math.min(1, (s.pitch - 8) / 22);
    ctx.fillStyle = p.star;
    ctx.beginPath(); ctx.arc(q.x, q.y, s.r * d, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // sun and its glow along the horizon
  const sun = onScreen(cam, world.sunYaw, world.sunPitch);
  if (!sun) return;
  const { x: sx, y: sy } = sun;
  const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, 34 * ppd);
  halo.addColorStop(0, hexA(p.glow, 0.55)); halo.addColorStop(0.25, hexA(p.horizon, 0.22)); halo.addColorStop(1, hexA(p.horizon, 0));
  ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);
  const disk = ctx.createRadialGradient(sx, sy, 0, sx, sy, 2.4 * ppd);
  disk.addColorStop(0, '#FFF6DE'); disk.addColorStop(0.55, p.glow); disk.addColorStop(1, hexA(p.glow, 0));
  ctx.fillStyle = disk; ctx.beginPath(); ctx.arc(sx, sy, 2.4 * ppd, 0, Math.PI * 2); ctx.fill();
}

// Points along a curve of world directions, broken where it passes behind the camera.
function strokePath(ctx, cam, dirs) {
  let pen = false;
  ctx.beginPath();
  for (const [yaw, pitch] of dirs) {
    const q = onScreen(cam, yaw, pitch);
    if (!q) { pen = false; continue; }
    if (pen) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); pen = true; }
  }
  ctx.stroke();
}

export function paintTerrain(ctx, cam, world) {
  const { W, H, d, ppd, fov } = cam, p = world.pal;
  const yH = horizonY(cam);
  // Ridges are sampled in yaw across the view (plus a margin) and projected, so they bend correctly at
  // wide FOVs instead of sliding across the screen like a flat backdrop.
  const span = Math.min(89, fov / 2 + 8), n = Math.max(40, Math.round(W / Math.max(3, 6 * d)));
  world.ridges.forEach((R, i) => {
    ctx.beginPath();
    ctx.moveTo(-2, H + 2);
    for (let k = 0; k <= n; k++) {
      const yaw = cam.yaw - span + (2 * span * k) / n;
      const q = onScreen(cam, yaw, ridgeHeight(R, yaw));
      if (q) ctx.lineTo(q.x, q.y);
    }
    ctx.lineTo(W + 2, H + 2); ctx.closePath();
    ctx.fillStyle = p.ridges[i]; ctx.fill();
    if (i === 0) { ctx.strokeStyle = hexA(p.glow, 0.35); ctx.lineWidth = 1.2 * d; ctx.stroke(); }
  });

  // haze where the land meets the sky
  const fog = ctx.createLinearGradient(0, yH - 4 * ppd, 0, yH + 3 * ppd);
  fog.addColorStop(0, 'rgba(0,0,0,0)'); fog.addColorStop(0.6, p.fog); fog.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = fog; ctx.fillRect(0, yH - 4 * ppd, W, 7 * ppd);

  // The range floor: a survey grid lying on the ground. Rings at a fixed distance and spokes every
  // 10 degrees of heading, both drawn in perspective so the spokes converge below the player.
  if (yH < H) {
    const gg = ctx.createLinearGradient(0, yH, 0, H);
    gg.addColorStop(0, hexA(p.ridges[2], 0.0)); gg.addColorStop(0.15, hexA(p.ground, 0.85)); gg.addColorStop(1, p.ground);
    ctx.fillStyle = gg; ctx.fillRect(0, yH, W, H - yH);
    ctx.lineWidth = d;
    const steps = Array.from({ length: 41 }, (_, k) => cam.yaw - span + (2 * span * k) / 40);
    for (const dep of [1.2, 2.5, 4.5, 7.5, 11.5, 17, 24, 33, 45]) {
      ctx.strokeStyle = hexA(p.glow, Math.min(0.22, 0.05 + dep * 0.006));
      strokePath(ctx, cam, steps.map(yaw => [yaw, -dep]));
    }
    const first = Math.ceil((cam.yaw - span) / 10) * 10;
    for (let a = first; a <= cam.yaw + span; a += 10) {
      const lg = ctx.createLinearGradient(0, yH, 0, H);
      lg.addColorStop(0, hexA(p.glow, 0)); lg.addColorStop(1, hexA(p.glow, 0.14));
      ctx.strokeStyle = lg;
      strokePath(ctx, cam, [1.2, 6, 15, 30, 50, 70, 85].map(dep => [a, -dep]));
    }
  }
}

// Compass tape along the top edge: real heading, north at yaw 0.
export function paintCompass(ctx, cam, world) {
  const { W, d, f, cx } = cam;
  const y = 30 * d, half = Math.min(W * 0.32, f * Math.tan(60 * Math.PI / 180));
  const reach = Math.atan(half / f) * 180 / Math.PI; // degrees either side shown on the tape
  const xAt = a => cx + f * Math.tan((a - cam.yaw) * Math.PI / 180);
  ctx.save();
  const fade = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  fade.addColorStop(0, 'rgba(244,241,232,0)'); fade.addColorStop(0.2, 'rgba(244,241,232,0.65)');
  fade.addColorStop(0.8, 'rgba(244,241,232,0.65)'); fade.addColorStop(1, 'rgba(244,241,232,0)');
  ctx.strokeStyle = fade; ctx.fillStyle = fade; ctx.lineWidth = d;
  ctx.font = `600 ${10 * d}px 'Martian Mono', monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  const from = Math.ceil((cam.yaw - reach) / 5) * 5;
  for (let a = from; a <= cam.yaw + reach; a += 5) {
    const x = xAt(a), hd = ((a % 360) + 360) % 360;
    const big = hd % 45 === 0;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + (big ? 8 : 4) * d); ctx.stroke();
    if (big) ctx.fillText(names[hd], x, y - 3 * d);
  }
  ctx.fillStyle = '#FF5E3A';
  ctx.beginPath(); ctx.moveTo(cx, y + 11 * d); ctx.lineTo(cx - 5 * d, y + 18 * d); ctx.lineTo(cx + 5 * d, y + 18 * d); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// A target drone. kind: 'flick' | 'turn' | 'track'. lit = crosshair on it (tracking).
export function paintDrone(ctx, x, y, R, cam, world, now, { kind = 'flick', lit = false, still = false } = {}) {
  const { d, H } = cam;
  const core = lit ? '#6FE0A6' : '#FF6A3D';
  if (kind === 'turn') { // a light pillar so the target can be found from far away
    const pg = ctx.createLinearGradient(0, 0, 0, y);
    pg.addColorStop(0, 'rgba(255,181,71,0)'); pg.addColorStop(1, 'rgba(255,181,71,0.55)');
    ctx.fillStyle = pg; ctx.fillRect(x - 3 * d, 0, 6 * d, y);
    const pb = ctx.createLinearGradient(0, y, 0, H);
    pb.addColorStop(0, 'rgba(255,181,71,0.4)'); pb.addColorStop(1, 'rgba(255,181,71,0)');
    ctx.fillStyle = pb; ctx.fillRect(x - 1.5 * d, y, 3 * d, H - y);
  }
  const glow = ctx.createRadialGradient(x, y, R * 0.3, x, y, R * 2.1);
  glow.addColorStop(0, hexA(core, 0.45)); glow.addColorStop(1, hexA(core, 0));
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, R * 2.1, 0, Math.PI * 2); ctx.fill();

  const body = ctx.createRadialGradient(x - R * 0.25, y - R * 0.3, R * 0.05, x, y, R * 0.82);
  body.addColorStop(0, '#FFF4DA'); body.addColorStop(0.35, lit ? '#B9F5D6' : '#FFB08A'); body.addColorStop(1, core);
  ctx.fillStyle = body; ctx.beginPath(); ctx.arc(x, y, R * 0.8, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(10,8,8,0.55)'; ctx.lineWidth = 1.5 * d; ctx.stroke();

  // spinning guard ring
  const spin = still ? 0 : now * 0.0021;
  ctx.strokeStyle = hexA('#FFF1D6', 0.85); ctx.lineWidth = 2.2 * d; ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const a0 = spin + i * (Math.PI * 2 / 3);
    ctx.beginPath(); ctx.arc(x, y, R * 0.97, a0, a0 + Math.PI * 0.42); ctx.stroke(); // the ring is the hit edge
  }
  ctx.lineCap = 'butt';
  // centre pip: the precise point to aim at
  ctx.fillStyle = '#1A0904'; ctx.beginPath(); ctx.arc(x, y, Math.max(1.5 * d, R * 0.12), 0, Math.PI * 2); ctx.fill();
}

// Edge marker for a target out of view: a chevron and how far to turn.
export function paintOffscreen(ctx, ex, ey, ang, degrees, cam, color = '#FF6A3D') {
  const { d } = cam;
  ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(12 * d, 0); ctx.lineTo(-6 * d, -10 * d); ctx.lineTo(-1 * d, 0); ctx.lineTo(-6 * d, 10 * d); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.font = `600 ${10 * d}px 'Martian Mono', monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(244,241,232,0.9)';
  ctx.fillText(`${Math.round(degrees)}°`, ex - Math.cos(ang) * 26 * d, ey - Math.sin(ang) * 22 * d);
  ctx.restore();
}

// Light trail behind a moving target, kept in world angles so it lies along the path.
export function trailPoint(world, tgt) {
  if (!world.trail || world.trail.tgt !== tgt) world.trail = { tgt, pts: [] };
  const pts = world.trail.pts, last = pts[pts.length - 1];
  if (!last || Math.hypot(last.yaw - tgt.yaw, last.pitch - tgt.pitch) > 0.15) pts.push({ yaw: tgt.yaw, pitch: tgt.pitch });
  if (pts.length > 26) pts.shift();
  return pts;
}
export function paintTrail(ctx, pts, R, cam, lit) {
  if (pts.length < 2) return;
  const col = lit ? '#6FE0A6' : '#FF6A3D';
  for (let i = 1; i < pts.length; i++) {
    const t = i / pts.length;
    const a = onScreen(cam, pts[i - 1].yaw, pts[i - 1].pitch), b = onScreen(cam, pts[i].yaw, pts[i].pitch);
    if (!a || !b) continue;
    ctx.strokeStyle = hexA(col, 0.5 * t); ctx.lineWidth = R * 0.9 * t; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

// Hit and miss effects, spawned once per flash and anchored in the world.
export function noteFlash(world, flash, now) {
  if (!flash || flash === world.lastFlash) return;
  world.lastFlash = flash;
  const n = flash.good ? 16 : 6;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = flash.good ? 6 + Math.random() * 10 : 2 + Math.random() * 3;
    world.fx.push({ kind: 'spark', yaw: flash.yaw, pitch: flash.pitch, vy: Math.cos(a) * sp, vp: Math.sin(a) * sp,
      born: now, life: flash.good ? 520 + Math.random() * 260 : 360, good: flash.good });
  }
  world.fx.push({ kind: 'ring', yaw: flash.yaw, pitch: flash.pitch, born: now, life: flash.good ? 520 : 300, good: flash.good });
}
export function paintFx(ctx, cam, world, now, still) {
  const { d, ppd } = cam;
  world.fx = world.fx.filter(f => now - f.born < f.life);
  for (const f of world.fx) {
    const t = (now - f.born) / f.life, s = (now - f.born) / 1000;
    if (f.kind === 'ring') {
      ctx.strokeStyle = f.good ? hexA('#FFE7B0', 0.9 * (1 - t)) : hexA('#F4F1E8', 0.6 * (1 - t));
      ctx.lineWidth = (f.good ? 3 : 1.5) * d * (1 - t) + d;
      const q = onScreen(cam, f.yaw, f.pitch);
      if (!q) continue;
      ctx.beginPath(); ctx.arc(q.x, q.y, (f.good ? 1.5 + t * 5 : 0.6 + t * 1.6) * ppd / q.z, 0, Math.PI * 2); ctx.stroke();
    } else {
      const k = still ? 0 : s;
      const q = onScreen(cam, f.yaw + f.vy * k, f.pitch + f.vp * k - (still ? 0 : 6 * k * k));
      if (!q) continue;
      const { x, y } = q;
      ctx.fillStyle = f.good ? hexA(t < 0.4 ? '#FFF1D0' : '#FFB547', 1 - t) : hexA('#93A7AC', 0.7 * (1 - t));
      ctx.beginPath(); ctx.arc(x, y, (f.good ? 2.4 : 1.6) * d * (1 - t * 0.6), 0, Math.PI * 2); ctx.fill();
    }
  }
}

export function paintCrosshair(ctx, cam, on) {
  const { cx, cy, d } = cam;
  const col = on ? '#6FE0A6' : '#F4F1E8';
  ctx.save();
  ctx.shadowColor = on ? 'rgba(111,224,166,0.8)' : 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 6 * d;
  ctx.strokeStyle = col; ctx.lineWidth = 2 * d; ctx.lineCap = 'round';
  const gap = 6 * d, len = 10 * d;
  ctx.beginPath();
  ctx.moveTo(cx - gap - len, cy); ctx.lineTo(cx - gap, cy); ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + len, cy);
  ctx.moveTo(cx, cy - gap - len); ctx.lineTo(cx, cy - gap); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + len);
  ctx.stroke();
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, 1.6 * d, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Over-the-shoulder silhouette for third-person games, rim-lit by the sun. Drawn see-through.
export function paintFigure(ctx, cam, world) {
  const { W, H, d } = cam, p = world.pal;
  const fx = cam.cx - W * 0.17, base = H * 1.02;
  ctx.save();
  ctx.globalAlpha = 0.55; // see-through, so a target behind the character can still be found
  ctx.fillStyle = '#060B10';
  ctx.beginPath();
  ctx.moveTo(fx - W * 0.13, base);
  ctx.bezierCurveTo(fx - W * 0.12, H * 0.84, fx - W * 0.08, H * 0.78, fx - W * 0.02, H * 0.775);
  ctx.lineTo(fx + W * 0.035, H * 0.775);
  ctx.bezierCurveTo(fx + W * 0.09, H * 0.78, fx + W * 0.115, H * 0.84, fx + W * 0.12, base);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.ellipse(fx + W * 0.008, H * 0.705, H * 0.07, H * 0.082, 0, 0, Math.PI * 2); ctx.fill();
  // rim light along the right shoulder and head
  ctx.strokeStyle = hexA(p.glow, 0.55); ctx.lineWidth = 2 * d;
  ctx.beginPath(); ctx.ellipse(fx + W * 0.008, H * 0.705, H * 0.07, H * 0.082, 0, -1.3, 0.2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(fx + W * 0.035, H * 0.776); ctx.bezierCurveTo(fx + W * 0.09, H * 0.782, fx + W * 0.112, H * 0.84, fx + W * 0.118, H * 0.95); ctx.stroke();
  ctx.restore();
}

// Scope glass at 4x, a soft vignette at 1.5x. Returns the scope radius (0 when not scoped).
export function paintLens(ctx, cam, zoom) {
  const { W, H, cx, cy, d } = cam;
  if (zoom >= 3) {
    const r = Math.min(W, H) * 0.46;
    const v = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,10,20,0.55)');
    ctx.fillStyle = v; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#04080C';
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.arc(cx, cy, r, 0, Math.PI * 2, true); ctx.fill();
    ctx.strokeStyle = 'rgba(244,241,232,0.35)'; ctx.lineWidth = d;
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
    for (let i = 1; i <= 4; i++) {
      const o = i * r * 0.16;
      ctx.beginPath(); ctx.moveTo(cx + o, cy - 4 * d); ctx.lineTo(cx + o, cy + 4 * d); ctx.moveTo(cx - o, cy - 4 * d); ctx.lineTo(cx - o, cy + 4 * d);
      ctx.moveTo(cx - 4 * d, cy + o); ctx.lineTo(cx + 4 * d, cy + o); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,181,71,0.5)'; ctx.lineWidth = 3 * d;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    return r;
  }
  if (zoom > 1) {
    const v = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.35, cx, cy, Math.hypot(W, H) * 0.55);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(2,6,10,0.75)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }
  return 0;
}

// Countdown numeral with a sweep for the fraction of the current second.
export function paintCountdown(ctx, cam, n, frac, still) {
  const { W, H, cx, cy, d } = cam;
  ctx.fillStyle = 'rgba(5,10,16,0.45)'; ctx.fillRect(0, 0, W, H);
  const r = H * 0.2;
  ctx.strokeStyle = 'rgba(244,241,232,0.15)'; ctx.lineWidth = 6 * d;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#FF5E3A';
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (still ? 1 : frac)); ctx.stroke();
  ctx.fillStyle = '#F4F1E8';
  ctx.font = `900 ${Math.round(H * 0.26)}px 'Big Shoulders Stencil Display', 'Big Shoulders Display', sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(n), cx, cy + H * 0.012);
}

export function hexA(hex, a) {
  if (hex.startsWith('rgba')) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
