export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const pct = v => Math.round(v * 100) + '%';

export function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// Sample standard deviation.
export function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

// Small seeded PRNG so tests and replays are deterministic.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function resample(xs, rng) {
  const out = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rng() * xs.length)];
  return out;
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = clamp((sorted.length - 1) * q, 0, sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// Rounds a deadzone up to the menu's step (ARC's move in 0.05s), so it still covers the drift.
export const ceilStep = (x, step) => step ? +(Math.ceil(x / step - 1e-9) * step).toFixed(2) : x;

// Every value a menu setting can take ({ min, max, step }), rounded to the step so fractional
// steps (0.01, 0.001) don't pick up floating-point dust.
export function* settingValues(sp) {
  const dec = (String(sp.step).split('.')[1] || '').length;
  const n = Math.round((sp.max - sp.min) / sp.step);
  for (let i = 0; i <= n; i++) yield +(sp.min + i * sp.step).toFixed(dec);
}
