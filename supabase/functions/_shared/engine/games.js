import { clamp } from './util.js';

// Per-game models. Turn rates (degrees per second at full stick) are approximations.
// `assist` is the console aim assist estimate (sim.js assistTurn): win = window as a multiple of the
// target radius, slow = slowdown inside it, rot = share of a moving target's speed followed.
// `fov.type` says how the game states its field of view: 'h169' horizontal on 16:9, 'h43' horizontal
// on a 4:3 frame (Source-engine style), 'v' vertical. The range draws at the converted FOV.
// `source` says how far the menu names and scales have been checked.
export const GAMES = {
  cod: {
    name: 'Call of Duty', camera: 'first', source: 'model',
    fov: { label: 'Field of view', min: 60, max: 120, step: 1, def: 80, type: 'h169' },
    sens: { label: 'Horizontal stick sensitivity', min: 1, max: 20, step: 1, def: 6, rate: s => s * 48 },
    vsens: { label: 'Vertical stick sensitivity', min: 1, max: 20, step: 1, def: 6, rate: s => s * 38.4 },
    dz: { label: 'Right stick min (deadzone)', def: 0.10, fmt: d => String(Math.round(d * 100)) },
    moveDz: { label: 'Left stick min (deadzone)', fmt: d => String(Math.round(d * 100)) },
    outer: { label: 'Right stick max', fmt: d => String(Math.round(d * 100)) },
    trigger: { label: 'R2 / RT button deadzone', fmt: d => String(Math.round(d * 100)) },
    ads: [
      { key: 'adsLow', label: 'ADS sensitivity multiplier (low zoom)', zoom: 1.5, min: 0.5, max: 2, step: 0.01, def: 1, unit: 'x' },
      { key: 'adsHigh', label: 'ADS sensitivity multiplier (high zoom)', zoom: 4, min: 0.5, max: 2, step: 0.01, def: 1, unit: 'x' }
    ],
    curve: { label: 'Aim response curve type', def: 'mid', linear: 'Linear', mid: 'Standard', expo: 'Dynamic' },
    assist: { win: 2.0, slow: 0.35, rot: 0.35 }
  },
  fortnite: {
    name: 'Fortnite', camera: 'third', source: 'model',
    fov: { fixed: true, def: 80, type: 'h169', note: "Fortnite's field of view is fixed, so the range uses about 80 degrees." },
    sens: { label: 'Look sensitivity', min: 1, max: 100, step: 1, def: 45, rate: s => s * 6.4 },
    dz: { label: 'Right stick deadzone', def: 0.10, fmt: d => Math.round(d * 100) + '%' },
    moveDz: { label: 'Left stick deadzone', fmt: d => Math.round(d * 100) + '%' },
    curve: { label: 'Look input curve', def: 'mid', linear: 'Linear', mid: 'Exponential', expo: 'Exponential' },
    assist: { win: 2.0, slow: 0.35, rot: 0.35 }
  },
  apex: {
    name: 'Apex Legends', camera: 'first', source: 'model',
    fov: { label: 'Field of view', min: 70, max: 110, step: 1, def: 70, type: 'h43' },
    sens: {
      label: 'Look sensitivity', min: 1, max: 7, step: 1, def: 3,
      rate: s => [95, 135, 175, 220, 270, 335, 405][clamp(Math.round(s), 1, 7) - 1]
    },
    dz: { label: 'Look deadzone', def: 0.10, fmt: d => d < 0.06 ? 'None' : d < 0.13 ? 'Small' : 'Large' },
    outer: { label: 'Outer threshold', fmt: r => Math.round((1 - r) * 100) + '%' },
    curve: { label: 'Response curve', def: 'mid', linear: 'Linear', mid: 'Classic', expo: 'Steady' },
    assist: { win: 2.0, slow: 0.4, rot: 0.6 }
  },
  arc: {
    // Menu names, ranges and curve options from a player's PS5 Wireless Controller screen; defaults
    // there are that player's values. The menu has no outer or trigger deadzone. Look Boost (55) is
    // modeled as +55% turn speed at full stick (Vertical Look Boost 15 as +15%), ramping up over 1.6 s.
    // Vertical Sensitivity shares the horizontal scale. Sinusoidal is modeled as an
    // S-curve: softer than linear near center, quicker than exponential through the middle.
    name: 'ARC Raiders', camera: 'third', source: 'menu',
    // FOV range and convention from player guides (slider tops out at 80); still to check against the menu.
    fov: { label: 'Field of View', min: 50, max: 120, step: 1, def: 70, defKnown: false, type: 'h169' },
    sens: { label: 'Horizontal Sensitivity', min: 1, max: 400, step: 1, def: 80, defKnown: false, rate: s => s * 2.6 },
    vsens: { label: 'Vertical Sensitivity', min: 1, max: 400, step: 1, def: 60, defKnown: false, rate: s => s * 2.6 },
    dz: { label: 'Look Inner Deadzone', def: 0.05, fmt: d => String(Math.round(d * 100)) },
    moveDz: { label: 'Movement Inner Deadzone', def: 0.15, fmt: d => String(Math.round(d * 100)) },
    outer: null,
    trigger: null,
    curve: {
      label: 'Look Response Curve', def: 'expo', linear: 'Linear', mid: 'Sinusoidal', expo: 'Exponential',
      fn: { mid: s => (1 - Math.cos(Math.PI * s)) / 2 }
    },
    // Look Boost and Ramp-up Time are also tuned by the turn-around drill; slider tops are estimated.
    boost: {
      label: 'Horizontal Look Boost', mult: 1.55, vmult: 1.15, ramp: 1.6,
      setting: { label: 'Horizontal Look Boost', min: 0, max: 300, step: 5, def: 55 },
      rampSetting: { label: 'Look Boost Ramp-up Time', min: 0, max: 2, step: 0.1, def: 1.6 }
    },
    // Zoom Horizontal/Vertical Look Boost 55/30 with a 1.2 s ramp-up. The 200% slider top is estimated.
    zoomBoost: { label: 'Zoom Horizontal Look Boost', mult: 1.55, vmult: 1.3, ramp: 1.2 },
    // ARC's aim assist slows the aim over targets and pulls toward them; its strength isn't published.
    assist: { win: 2.0, slow: 0.4, rot: 0.4 },
    ads: [
      { key: 'zoom', label: 'Zoom Sensitivity Multiplier', zoom: 1.5, min: 0.01, max: 2, step: 0.01, def: 0.25, unit: '%', defKnown: false },
      { key: 'scoped', label: 'Scoped Zoom Sensitivity Multiplier', zoom: 4, min: 0.01, max: 2, step: 0.01, def: 0.5, unit: '%', defKnown: false }
    ]
  },
  other: {
    name: 'your game', camera: 'first', source: 'model',
    fov: { label: 'Field of view (horizontal)', min: 50, max: 130, step: 1, def: 90, type: 'h169' },
    sens: { label: 'Stick sensitivity', min: 1, max: 100, step: 1, def: 50, rate: s => s * 6 },
    dz: { label: 'Right stick deadzone', def: 0.10, fmt: d => Math.round(d * 100) + '%' },
    curve: { label: 'Response curve', def: 'mid', linear: 'Linear', mid: 'Default', expo: 'Exponential' },
    assist: { win: 2.0, slow: 0.35, rot: 0.35 }
  }
};

/* ---------- mouse ---------- */

// Mouse profiles. A mouse turns the camera by a fixed angle per count, so `sens.rate` here is
// degrees per count from the mouse (not degrees per second as for sticks). Every comparison the
// analysis makes is a ratio of rates, so the same Quick, Verify and Deep code tunes both.
// `yaw` is the game's degrees per count at sensitivity 1 (the figure sensitivity converters use).
// Games without a published one (yaw: null) are calibrated from the player's own cm/360 instead.
// `cal.k` converts the browser's counts to the game's, set from the mouse check before each session.
function mouseGame(base, yaw, sens, extra = {}) {
  const g = {
    ...base, device: 'mouse', yaw, cal: { k: 1 },
    sens: { ...sens, rate: s => s * (yaw ?? 1) * g.cal.k },
    // Sticks' shaping settings don't exist for a mouse; neutral values keep shared code paths simple.
    dz: { label: 'Deadzone', def: 0, fmt: () => 'None' },
    curve: { label: 'Response curve', def: 'linear', linear: 'Linear', mid: 'Linear', expo: 'Linear' },
    moveDz: null, outer: null, trigger: null, ads: [], ...extra
  };
  return g;
}
const SENS = (label, min, max, step, def) => ({ label, min, max, step, def, defKnown: false });
export const MOUSE_GAMES = {
  'm-cs2': mouseGame({ name: 'Counter-Strike 2', camera: 'first', source: 'model',
    fov: { fixed: true, def: 90, type: 'h43', note: "Counter-Strike 2's field of view is fixed (90 on a 4:3 scale, about 106 wide)." } },
    0.022, SENS('Sensitivity', 0.05, 8, 0.01, 1.25)),
  'm-valorant': mouseGame({ name: 'Valorant', camera: 'first', source: 'model',
    fov: { fixed: true, def: 103, type: 'h169', note: "Valorant's field of view is fixed at 103." } },
    0.07, SENS('Sensitivity', 0.01, 5, 0.001, 0.4)),
  'm-apex': mouseGame({ name: 'Apex Legends', camera: 'first', source: 'model', fov: GAMES.apex.fov },
    0.022, SENS('Mouse sensitivity', 0.1, 20, 0.1, 2.5)),
  'm-ow2': mouseGame({ name: 'Overwatch 2', camera: 'first', source: 'model',
    fov: { label: 'Field of view', min: 80, max: 103, step: 1, def: 103, type: 'h169' } },
    0.0066, SENS('Sensitivity', 0.01, 100, 0.01, 15)),
  'm-cod': mouseGame({ name: 'Call of Duty', camera: 'first', source: 'model', fov: GAMES.cod.fov },
    0.0066, SENS('Mouse sensitivity', 0.01, 100, 0.01, 5)),
  'm-fortnite': mouseGame({ name: 'Fortnite', camera: 'third', source: 'model', fov: GAMES.fortnite.fov },
    null, SENS('Mouse sensitivity', 0.1, 100, 0.1, 10)),
  'm-arc': mouseGame({ name: 'ARC Raiders', camera: 'third', source: 'model', fov: GAMES.arc.fov },
    null, SENS('Mouse sensitivity', 0.01, 400, 0.01, 50)),
  'm-other': mouseGame({ name: 'your game', camera: 'first', source: 'model', fov: GAMES.other.fov },
    null, SENS('Mouse sensitivity', 0.01, 400, 0.01, 1))
};
Object.assign(GAMES, MOUSE_GAMES);

// How much each test counts toward the sensitivity call.
export const PLAYSTYLES = {
  tracking: { label: 'Close range', wf: 0.35, wt: 0.65 },
  balanced: { label: 'Balanced', wf: 0.5, wt: 0.5 },
  flick: { label: 'Long range', wf: 0.65, wt: 0.35 }
};

// Settings found by the controller check. A game without a known menu entry gets the generic
// name, shown with "if your game has it" rather than a guessed menu label. A profile sets the key
// to null when the game is known not to have that setting.
const GENERIC = {
  moveDz: { label: 'Movement (left stick) deadzone', fmt: d => Math.round(d * 100) + '%' },
  outer: { label: 'Outer deadzone / max input', fmt: r => Math.round(r * 100) + '%' },
  trigger: { label: 'Fire trigger deadzone', fmt: d => Math.round(d * 100) + '%' }
};
const EXTRA_DEF = { moveDz: 0.10, outer: 1, trigger: 0 };

// null when the game is known not to have the setting.
export function extraSetting(g, key) {
  const own = g[key];
  if (own === null) return null;
  return { ...(own || GENERIC[key]), def: own && own.def != null ? own.def : EXTRA_DEF[key], known: !!own };
}

// ADS settings to test. Games without a known ADS menu get one generic 1.5x round, simulated at a
// zoom-matched multiplier and reported as a relative change.
const GENERIC_ADS = [{ key: 'ads', label: 'ADS sensitivity', zoom: 1.5, def: 1 / 1.5, generic: true }];
export function adsSpecs(g) {
  return g.ads || GENERIC_ADS;
}
export function fmtAds(spec, v) {
  return spec.unit === '%' ? Math.round(v * 100) + '%' : v.toFixed(2);
}

export function gameTitle(g) {
  return g.name === 'your game' ? 'Other game' : g.name;
}
