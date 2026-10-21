import { clamp } from './util.js';

// Per-game models. Turn rates (degrees per second at full stick) are approximations.
// `source` says how far the menu names and scales have been checked.
export const GAMES = {
  cod: {
    name: 'Call of Duty', camera: 'first', source: 'model',
    sens: { label: 'Horizontal stick sensitivity', min: 1, max: 20, step: 1, def: 6, rate: s => s * 48 },
    dz: { label: 'Right stick min (deadzone)', def: 0.10, fmt: d => String(Math.round(d * 100)) },
    moveDz: { label: 'Left stick min (deadzone)', fmt: d => String(Math.round(d * 100)) },
    outer: { label: 'Right stick max', fmt: d => String(Math.round(d * 100)) },
    trigger: { label: 'R2 / RT button deadzone', fmt: d => String(Math.round(d * 100)) },
    curve: { label: 'Aim response curve type', def: 'mid', linear: 'Linear', mid: 'Standard', expo: 'Dynamic' }
  },
  fortnite: {
    name: 'Fortnite', camera: 'third', source: 'model',
    sens: { label: 'Look sensitivity', min: 1, max: 100, step: 1, def: 45, rate: s => s * 6.4 },
    dz: { label: 'Right stick deadzone', def: 0.10, fmt: d => Math.round(d * 100) + '%' },
    moveDz: { label: 'Left stick deadzone', fmt: d => Math.round(d * 100) + '%' },
    curve: { label: 'Look input curve', def: 'mid', linear: 'Linear', mid: 'Exponential', expo: 'Exponential' }
  },
  apex: {
    name: 'Apex Legends', camera: 'first', source: 'model',
    sens: {
      label: 'Look sensitivity', min: 1, max: 7, step: 1, def: 3,
      rate: s => [95, 135, 175, 220, 270, 335, 405][clamp(Math.round(s), 1, 7) - 1]
    },
    dz: { label: 'Look deadzone', def: 0.10, fmt: d => d < 0.06 ? 'None' : d < 0.13 ? 'Small' : 'Large' },
    outer: { label: 'Outer threshold', fmt: r => Math.round((1 - r) * 100) + '%' },
    curve: { label: 'Response curve', def: 'mid', linear: 'Linear', mid: 'Classic', expo: 'Steady' }
  },
  arc: {
    // Menu names, ranges and curve options from a player's PS5 Wireless Controller screen; defaults
    // there are that player's values. The menu has no outer or trigger deadzone. Look Boost (55) is
    // modeled as +55% turn speed at full stick, ramping up over 1.6 s. Sinusoidal is modeled as an
    // S-curve: softer than linear near center, quicker than exponential through the middle.
    name: 'ARC Raiders', camera: 'third', source: 'menu',
    sens: { label: 'Horizontal Sensitivity', min: 1, max: 400, step: 1, def: 80, defKnown: false, rate: s => s * 2.6 },
    dz: { label: 'Look Inner Deadzone', def: 0.05, fmt: d => String(Math.round(d * 100)) },
    moveDz: { label: 'Movement Inner Deadzone', def: 0.15, fmt: d => String(Math.round(d * 100)) },
    outer: null,
    trigger: null,
    curve: {
      label: 'Look Response Curve', def: 'expo', linear: 'Linear', mid: 'Sinusoidal', expo: 'Exponential',
      fn: { mid: s => (1 - Math.cos(Math.PI * s)) / 2 }
    },
    boost: { label: 'Horizontal Look Boost', mult: 1.55, ramp: 1.6 }
  },
  other: {
    name: 'your game', camera: 'first', source: 'model',
    sens: { label: 'Stick sensitivity', min: 1, max: 100, step: 1, def: 50, rate: s => s * 6 },
    dz: { label: 'Right stick deadzone', def: 0.10, fmt: d => Math.round(d * 100) + '%' },
    curve: { label: 'Response curve', def: 'mid', linear: 'Linear', mid: 'Default', expo: 'Exponential' }
  }
};

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

export function gameTitle(g) {
  return g.name === 'your game' ? 'Other game' : g.name;
}
