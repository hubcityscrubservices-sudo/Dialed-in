import { clamp, mean, ceilStep } from './util.js';
import { driftDeadzone } from './analysis.js';
import { extraSetting } from './games.js';

// Controller check: drift at rest, how far each stick reaches around its edge, and trigger travel.
export const SECTORS = 16;
const EDGE = 0.7;      // a push counts toward the edge test once it passes this
const FULL = 0.97;     // reaching this everywhere means the stick needs no outer deadzone

export function emptyReach() {
  return new Array(SECTORS).fill(0);
}

export function sectorOf(x, y) {
  const a = (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
  return Math.floor(a / (2 * Math.PI) * SECTORS) % SECTORS;
}

export function recordReach(reach, x, y) {
  const m = Math.hypot(x, y);
  if (m < EDGE) return;
  const s = sectorOf(x, y);
  reach[s] = Math.max(reach[s], m);
}

export function coverage(reach) {
  return reach.filter(r => r >= EDGE).length / SECTORS;
}

const DIRS = ['right', 'lower right', 'down', 'lower left', 'left', 'upper left', 'up', 'upper right'];

// minReach: the weakest direction's full push. squareness > 1.05 means a square gate (diagonals read past 1).
export function stickReport(reach) {
  const seen = reach.map((r, i) => ({ r, i })).filter(s => s.r >= EDGE);
  if (seen.length < SECTORS * 0.75) return null;
  const worst = seen.reduce((a, b) => (b.r < a.r ? b : a));
  const cardinal = [0, 4, 8, 12].map(i => reach[i]).filter(r => r >= EDGE);
  const diagonal = [2, 6, 10, 14].map(i => reach[i]).filter(r => r >= EDGE);
  return {
    minReach: worst.r,
    worstDir: DIRS[Math.round(worst.i / 2) % 8],
    squareness: cardinal.length && diagonal.length ? mean(diagonal) / mean(cardinal) : 1
  };
}

// Output reaches full speed at this push. 1 = no outer deadzone needed.
export function outerFromReach(minReach) {
  if (minReach >= FULL) return 1;
  return clamp(Math.floor((minReach - 0.02) * 100) / 100, 0.75, 0.99);
}

// Smallest trigger deadzone that ignores the trigger's resting noise.
export function triggerDeadzone(rest) {
  return clamp(Math.ceil((rest * 1.15 + 0.03) * 100) / 100, 0.03, 0.3);
}

// Suggested values for the settings the controller check measures, beyond the look deadzone.
// check = { l, reachR, trig } from the stick check; any part may be missing.
// Settings the game is known not to have are left out.
export function hardwareRecs(check, g) {
  const rows = [];
  if (!check) return rows;
  const moveDz = extraSetting(g, 'moveDz'), outer = extraSetting(g, 'outer'), trigger = extraSetting(g, 'trigger');
  if (check.l != null && moveDz) {
    const next = ceilStep(driftDeadzone(check.l), moveDz.step);
    rows.push({ key: 'moveDz', st: moveDz, cur: moveDz.def, next,
      why: `Your left stick drifts up to ${check.l.toFixed(2)} at rest. This is the smallest movement deadzone that stops your character creeping, so small pushes still register.` });
  }
  if (check.reachR && outer) {
    const { minReach, worstDir, squareness } = check.reachR;
    const next = outerFromReach(minReach);
    const name = outer.label.charAt(0).toLowerCase() + outer.label.slice(1);
    let why = next === 1
      ? 'Your right stick reaches full push in every direction, so no outer deadzone is needed.'
      : `Pushed all the way ${worstDir}, your right stick only reads ${minReach.toFixed(2)}. Set ${name} to ${outer.fmt(next)} so full turn speed kicks in before the stick runs out of travel.`;
    if (squareness > 1.05) why += ' The stick reads stronger on diagonals than straight pushes, which is normal for a square gate.';
    rows.push({ key: 'outer', st: outer, cur: outer.def, next, why });
  }
  if (check.trig && trigger) {
    const { restR, maxR } = check.trig;
    const next = triggerDeadzone(restR);
    let why = `Your fire trigger rests at ${restR.toFixed(2)}. This is the lightest press that still can't misfire.`;
    if (maxR < 0.9) why += ` It only travels to ${maxR.toFixed(2)} when squeezed, so avoid any setting that needs a full pull.`;
    rows.push({ key: 'trigger', st: trigger, cur: trigger.def, next, why });
  }
  return rows;
}
