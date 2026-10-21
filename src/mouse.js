// Mouse input for the range: pointer lock with raw (unaccelerated) movement where the browser allows it,
// counts gathered between frames, and the measurements behind the mouse check. The pure functions at
// the bottom are tested in Node; createMouse needs a browser.
import { clamp } from './util.js';

export const CARD_CM = 8.56;          // long edge of a bank card (ISO/IEC 7810 ID-1)
export const SWIPES = ['slow', 'fast', 'slow'];
const POLL_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

// el: the element to lock (the range canvas). onLock(locked) runs whenever the lock changes.
export function createMouse(el, onLock = () => {}) {
  const M = {
    locked: false, raw: null, dx: 0, dy: 0, down: false, pressed: false,
    swipe: null, swipes: [], gaps: [], lastT: 0, lockWanted: false,
    // Raw movement skips the OS pointer speed and acceleration, which is what games read.
    // Browsers without it lock anyway, and the check reports that acceleration may be in play.
    async lock() {
      if (M.locked || !el.requestPointerLock) return;
      M.lockWanted = true;
      try { await el.requestPointerLock({ unadjustedMovement: true }); M.raw = true; }
      catch (e) {
        try { await el.requestPointerLock(); M.raw = false; } catch (e2) { M.lockWanted = false; }
      }
    },
    unlock() { M.lockWanted = false; if (document.pointerLockElement === el) document.exitPointerLock(); },
    // Counts since the last call.
    take() { const out = { mx: M.dx, my: M.dy }; M.dx = 0; M.dy = 0; return out; },
    // Fire held now, or clicked and released since the last call.
    fire() { const f = M.down || M.pressed; M.pressed = false; return f; },
    takeSwipes() { const s = M.swipes; M.swipes = []; return s; },
    takeGaps() { const g = M.gaps; M.gaps = []; return g; }
  };
  const move = e => {
    if (!M.locked) return;
    M.dx += e.movementX; M.dy += e.movementY;
    if (M.swipe) { M.swipe.dx += e.movementX; M.swipe.dy += e.movementY; }
    // Time between reports while the mouse is moving, for the polling-rate estimate. Coalesced
    // events hold every report the browser merged into this one.
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    for (const c of evs) {
      if (M.lastT && c.timeStamp > M.lastT && c.timeStamp - M.lastT < 20 && (c.movementX || c.movementY)) M.gaps.push(c.timeStamp - M.lastT);
      M.lastT = c.timeStamp;
    }
    if (M.gaps.length > 4000) M.gaps.splice(0, 2000);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('mousedown', e => {
    if (!M.locked || e.button !== 0) return;
    M.down = true; M.pressed = true;
    M.swipe = { dx: 0, dy: 0, t0: e.timeStamp };
  });
  document.addEventListener('mouseup', e => {
    if (e.button !== 0) return;
    M.down = false;
    if (M.swipe) { M.swipes.push({ ...M.swipe, ms: e.timeStamp - M.swipe.t0 }); M.swipe = null; }
  });
  document.addEventListener('pointerlockchange', () => {
    M.locked = document.pointerLockElement === el;
    if (!M.locked) { M.down = false; M.swipe = null; M.dx = M.dy = 0; }
    onLock(M.locked);
  });
  return M;
}

/* ---------- pure: the mouse check ---------- */

const median = xs => { const a = xs.slice().sort((p, q) => p - q), n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; };

// Swipes across a bank card: [{ dx, dy, ms }] in the order of SWIPES. Returns counts per cm as the
// browser sees them and, without raw input, how much more a fast swipe travelled than a slow one
// (pointer acceleration). Slow swipes set the distance, since acceleration barely touches them.
export function analyzeSwipes(swipes, raw) {
  const len = swipes.map(s => Math.hypot(s.dx, s.dy));
  const slow = len.filter((_, i) => SWIPES[i] === 'slow'), fast = len.filter((_, i) => SWIPES[i] === 'fast');
  if (!slow.length) return null;
  const counts = raw ? median(len) : slow.reduce((a, b) => a + b, 0) / slow.length;
  const accel = !raw && fast.length ? median(fast) / (slow.reduce((a, b) => a + b, 0) / slow.length) : null;
  const spread = len.length > 1 ? (Math.max(...len) - Math.min(...len)) / median(len) : 0;
  return { cpcm: counts / CARD_CM, accel, spread };
}

// A swipe shorter than this (in counts) was a slip, not a card length; 100 DPI would give ~340.
export const MIN_SWIPE = 150;

// Reconciles the DPI the player entered with the counts per cm measured in the browser.
// Returns { cpcmBrowser, cpcmGame, dpiSeen, verdict }:
//   'match'   the two agree (within 12%),
//   'scaled'  they differ by the display scale: the browser divides movement by it, the game won't,
//   'wrong'   neither: the entered DPI is probably not what the mouse is set to, so trust the measurement,
//   'entered' nothing was measured.
export function resolveDpi(dpi, cpcm, dpr = 1) {
  const entered = dpi > 0 ? dpi / 2.54 : null;
  if (!cpcm) return { cpcmBrowser: entered, cpcmGame: entered, dpiSeen: null, verdict: 'entered' };
  const dpiSeen = cpcm * 2.54;
  if (!entered) return { cpcmBrowser: cpcm, cpcmGame: cpcm, dpiSeen, verdict: 'wrong' };
  const r = cpcm / entered;
  if (Math.abs(r - 1) < 0.12) return { cpcmBrowser: cpcm, cpcmGame: entered, dpiSeen, verdict: 'match' };
  if (dpr !== 1 && Math.abs(r * dpr - 1) < 0.12) return { cpcmBrowser: cpcm, cpcmGame: entered, dpiSeen, verdict: 'scaled' };
  return { cpcmBrowser: cpcm, cpcmGame: cpcm, dpiSeen, verdict: 'wrong' };
}

// Report rate from the gaps between movement reports (ms), snapped to a standard rate when close.
// Browsers can deliver fewer reports than the mouse sends, so this is a floor.
export function pollingHz(gaps) {
  if (gaps.length < 40) return null;
  const hz = 1000 / median(gaps);
  const near = POLL_RATES.reduce((a, b) => Math.abs(Math.log(b / hz)) < Math.abs(Math.log(a / hz)) ? b : a);
  return Math.abs(Math.log(near / hz)) < 0.25 ? near : Math.round(hz);
}

// The calibration factor for a mouse profile (games.js): degrees per browser count = sens x yaw x k.
// Known-yaw games convert browser counts to the counts the game reads. Games without a published
// yaw use the player's cm/360 at their current sensitivity (cm0 at sens0).
export function calibrationK(g, { cpcmBrowser, cpcmGame, sens0, cm0 }) {
  if (g.yaw) return cpcmGame && cpcmBrowser ? cpcmGame / cpcmBrowser : 1;
  return 360 / (clamp(cm0, 1, 500) * sens0 * cpcmBrowser);
}

// cm of mouse travel for a full turn at sensitivity s, once the profile is calibrated.
export function cm360(g, s, cpcmBrowser) {
  return 360 / (g.sens.rate(s) * cpcmBrowser);
}
