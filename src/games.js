import { clamp } from './util.js';

// Per-game models. Turn rates (degrees per second at full stick) are approximations.
// `source` says how far the menu names and scales have been checked.
export const GAMES = {
  cod: {
    name: 'Call of Duty', camera: 'first', source: 'model',
    sens: { label: 'Horizontal stick sensitivity', min: 1, max: 20, step: 1, def: 6, rate: s => s * 48 },
    dz: { label: 'Right stick min (deadzone)', def: 0.10, fmt: d => String(Math.round(d * 100)) },
    curve: { label: 'Aim response curve type', def: 'mid', linear: 'Linear', mid: 'Standard', expo: 'Dynamic' }
  },
  fortnite: {
    name: 'Fortnite', camera: 'third', source: 'model',
    sens: { label: 'Look sensitivity', min: 1, max: 100, step: 1, def: 45, rate: s => s * 6.4 },
    dz: { label: 'Right stick deadzone', def: 0.10, fmt: d => Math.round(d * 100) + '%' },
    curve: { label: 'Look input curve', def: 'mid', linear: 'Linear', mid: 'Exponential', expo: 'Exponential' }
  },
  apex: {
    name: 'Apex Legends', camera: 'first', source: 'model',
    sens: {
      label: 'Look sensitivity', min: 1, max: 7, step: 1, def: 3,
      rate: s => [95, 135, 175, 220, 270, 335, 405][clamp(Math.round(s), 1, 7) - 1]
    },
    dz: { label: 'Look deadzone', def: 0.10, fmt: d => d < 0.06 ? 'None' : d < 0.13 ? 'Small' : 'Large' },
    curve: { label: 'Response curve', def: 'mid', linear: 'Linear', mid: 'Classic', expo: 'Steady' }
  },
  arc: {
    // Menu names come from player guides (Dexerto, SCUF, The Controller People), not from the game.
    // Look Boost speeds up turning once the stick is pushed to the edge.
    name: 'ARC Raiders', camera: 'third', source: 'guides',
    sens: { label: 'Horizontal look sensitivity', min: 1, max: 200, step: 1, def: 100, rate: s => s * 2.6 },
    dz: { label: 'Look inner deadzone', def: 0.10, fmt: d => String(Math.round(d * 100)) },
    curve: { label: 'Look response curve', def: 'mid', linear: 'Linear', mid: 'Default', expo: 'Default' },
    boost: { label: 'Horizontal look boost', mult: 1.5 }
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

export function gameTitle(g) {
  return g.name === 'your game' ? 'Other game' : g.name;
}
