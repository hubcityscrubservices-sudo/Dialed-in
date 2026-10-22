import { GAMES, PLAYSTYLES, gameTitle, extraSetting, adsSpecs, fmtAds, codFromOld } from './games.js';
import { makeCamera, hfov169 } from './camera.js';
import { makeView, steer, newFlickTarget, flickStep, makeTrack, trackStep, newTurnTarget, turnStep, trackAim, TRACK_V2, CURVE_K, trackScript, flickPlan } from './sim.js';
import { summarize, recommend, recommendVertical, recommendAds, turnStats, recommendTurn, driftDeadzone, settingsChanged } from './analysis.js';
import { verifyPlan, verifyCompare, ratingSummary, sideOf } from './verify.js';
import { DEEP, SCREEN, MORE, FEEL, deepNext, deepAnalyze, feelPoint, shuffled, morePlan, screenPlan, altCurve, screenAnalyze } from './deep.js';
import { emptyReach, recordReach, coverage, stickReport, outerFromReach, hardwareRecs } from './hardware.js';
import { clamp, pct } from './util.js';
import { buildExport } from './export.js';
import { DT, hashSeed, dailyCode, practiceCode, isCode, quantize, createChallenge, step as chStep, summary as chSummary,
  newRecording, record, encodeReplay, V3_FROM } from './challenge.js';
import { reportCard } from './report.js';
import { RECOIL, makeRecoil, recoilStep, recoilSummary, recommendRecoil } from './recoil.js';
import { makeWorld, paintSky, paintTerrain, paintCompass, paintDrone, paintOffscreen, trailPoint, paintTrail,
  noteFlash, paintFx, paintCrosshair, paintFigure, paintLens, paintCountdown, TRACK_BLUE } from './scenery.js';
import { DUEL, duelPlan, duelCompare } from './duel.js';
import { createMouse, CARD_CM, SWIPES, MIN_SWIPE, analyzeSwipes, resolveDpi, pollingHz, calibrationK, cm360 } from './mouse.js';
import { logEvent, boardsOn, submitScore, fetchBoard, fetchAllTime, fetchAllTimeRank, fetchTiers, addTurnSample, fetchTurnSamples, playerId, savedName, saveName } from './leaderboard.js';

const $ = s => document.querySelector(s);
// Calibration targets follow the play style: a closer fight means bigger targets that strafe across
// the screen faster, and a different mix of flicks and tracking in the Quick test. Long range keeps
// roughly the original sizes, slightly smaller. The challenge doesn't use these: it's the same mix
// for everyone.
const STYLE_RANGE = {
  tracking: { size: 1.35, speed: 1.25, flicks: 10, track: 20 },
  balanced: { size: 1.15, speed: 1.1, flicks: 12, track: 15 },
  flick: { size: 0.9, speed: 0.85, flicks: 14, track: 10 }
};
const styleRange = () => STYLE_RANGE[cfg.style] || STYLE_RANGE.balanced;
// Calibration's strafing target: scripted paths (sim.js trackScript), snappier speed changes, more up and
// down movement, and 15% smaller than the play style's base size, so settings separate more clearly.
const styleTrack = () => { const R = styleRange(); return { ...TRACK_V2, lo: TRACK_V2.lo * R.speed, span: TRACK_V2.span * R.speed, size: R.size * 0.85, accel: 7, vAmp: 4.5, vFreq: 1.6 }; };
// Each flick round's targets: the same layered mix of distances and sizes every round (sim.js flickPlan).
const flickTarget = (s, F, k) => newFlickTarget(view, Math.random, verticalSlot(k), 1 / (s.zoom || 1), true, styleRange().size, F.plan[k]);
const COUNT_WORDS = { 10: 'Ten', 12: 'Twelve', 14: 'Fourteen' };
// Two of every five flick targets sit mostly above or below, to measure vertical aim.
const verticalSlot = i => i % 5 === 1 || i % 5 === 3;
const VERIFY = { flicks: 7, warmFlicks: 1, trackSeconds: 9, warmSeconds: 1.5 };
const DEEP_ROUND = { flicks: 8, warmFlicks: 1, trackSeconds: 8, warmSeconds: 1.5 };
const DRIFT_SECONDS = 4, ROLL_SECONDS = 10, SQUEEZE_SECONDS = 8;
const RAIL = { curve: 'Curve feel', recoil: 'Recoil', setup: 'Setup', drift: 'Sticks', flick: 'Flicks', track: 'Tracking', deep: 'Search', screen: 'Screen', turn: 'Turns', ads: 'ADS', verify: 'Verify', results: 'Results' };
const ADS = { flicks: 8, seconds: 8, scopedFlicks: 6, scopedSeconds: 6 };
const TURNS = 6;
// How a round's speed felt, -2 (way too slow) to +2 (way too fast). Deep mode finds where the ratings
// cross from slow to fast; Verify and the duel show the average for each side.
const RATINGS = [
  { v: -2, label: 'Way too slow', key: 'lb', glyph: 'L1' },
  { v: -1, label: 'A bit slow', key: 'dl', glyph: 'D-pad ←' },
  { v: 0, label: 'Just right', key: 'du', glyph: 'D-pad ↑' },
  { v: 1, label: 'A bit fast', key: 'dr', glyph: 'D-pad →' },
  { v: 2, label: 'Way too fast', key: 'rb', glyph: 'R1' }
];
const MODE_HINT = { quick: 'About 4 minutes', verify: 'About 6 minutes', deep: 'About 9 minutes', full: 'About 15-18 minutes' };
// Full dial-in: Deep with about 20 rounds' worth of data in one sitting. Simulated players came out the
// same with more rounds or longer ones at equal time, so it does a bit of both: 16-18 search rounds of
// 10 targets and 10 s of tracking, the curve and vertical checks twice over (8 rounds), longer turn and
// ADS drills, and a short break every 6 rounds. FULL_OPEN is the one switch to gate it later.
const FULL = { min: 16, max: 18, round: { flicks: 11, warmFlicks: 1, trackSeconds: 10, warmSeconds: 1.5 }, screenReps: 2, breakEvery: 6, turns: 10, adsScale: 1.5 };
const FULL_OPEN = true;
const deepMode = m => m === 'deep' || (m === 'full' && FULL_OPEN);

const adsDefaults = g => Object.fromEntries(adsSpecs(g).map(sp => [sp.key, sp.def]));
const boostDefaults = g => g.boost && g.boost.setting
  ? { boost: g.boost.setting.def, boostRamp: g.boost.rampSetting.def, boostDelay: g.boost.delaySetting ? g.boost.delaySetting.def : undefined }
  : { boost: undefined, boostRamp: undefined, boostDelay: undefined };
const cfg = { game: 'arc', style: 'balanced', mode: 'verify', sens: GAMES.arc.sens.def, vsens: GAMES.arc.vsens.def, ads: adsDefaults(GAMES.arc), ...boostDefaults(GAMES.arc), curve: GAMES.arc.curve.def, dz: GAMES.arc.dz.def, aa: 1, fov: GAMES.arc.fov.def, device: 'pad', dpi: 800, cm0: 30 };
let screen = 'setup';  // setup | test | results
let session = null;    // { segs, i, phase, countLeft, drift }
let result = null;     // { cfg, stats, rec, drift, verify }
const view = makeView();
let inp = { src: 'virtual', name: null, lx: 0, ly: 0, rx: 0, ry: 0, fire: false, dl: false, du: false, dr: false, lb: false, rb: false };
let prev = { fire: false, dl: false, du: false, dr: false, lb: false, rb: false };
let lastT = 0, gpBlocked = false;

const game = () => GAMES[cfg.game];
const isMouse = () => cfg.device === 'mouse';
// The range's horizontal FOV (16:9) for a game: the player's own setting when it's the game set up,
// so turning moves the screen exactly as much as it does in their game.
const hfovFor = id => { const F = GAMES[id].fov; return hfov169(id === cfg.game && !F.fixed ? cfg.fov : F.def, F.type); };
const seg = () => session && session.segs[session.i];
// Things that belong to the player's game rather than to a setting under test, so every settings
// object takes them from cfg: the engine-2 stick rules, aim assist strength (controllers) and the
// measured turn-speed factor (left out at 1).
const turnK = () => {
  if (game().device === 'mouse') return { eng: 2 };
  return { eng: 2, ...(cfg.aa ? { aa: cfg.aa } : {}), ...(cfg.kTurn && cfg.kTurn !== 1 ? { kTurn: cfg.kTurn } : {}),
    ...(cfg.curveK && cfg.curveK !== 1 ? { curveK: cfg.curveK } : {}) };
};
const settingsOf = c => ({ sens: c.sens, vsens: c.vsens, vmult: c.vmult ?? 1, curve: c.curve, dz: c.dz, outer: c.outer ?? 1, boost: c.boost, boostRamp: c.boostRamp, boostDelay: c.boostDelay, ...turnK() });

/* ---------- session plans ---------- */

const STICK_CHECK = { kind: 'drift', rail: 'drift', title: 'Stick check',
  text: 'Three quick parts, about 15 seconds: hands off, roll both sticks around their edges, then squeeze the triggers. This measures drift, how far each stick reaches, and trigger travel.' };
const STICK_PART_TEXT = {
  rest: 'Set the controller down and keep your thumbs off both sticks.',
  roll: 'Push both sticks all the way out and roll them slowly around the edge. Two full circles.',
  squeeze: 'Squeeze both triggers all the way, slowly, then let go.'
};

const MOUSE_CHECK = { kind: 'mcheck', rail: 'drift', intro: true, title: 'Mouse check',
  text: 'Three slides along a bank card (3.37 inches), about 20 seconds. This measures your mouse\'s real DPI, whether pointer acceleration is on, and its report rate. Lay the card flat on your mouse pad, with room for the mouse beside it.' };
const SWIPE_TEXT = {
  slow: 'Put the mouse\'s left side on the card\'s left end. Hold the left button, slide slowly to the right, and let go when that same left side reaches the card\'s right end (3.37 inches).',
  fast: 'Same start and stop, but one quick slide, then let go.'
};
// The mouse check is skipped when the DPI was already measured from setup this visit.
const checkSteps = () => isMouse() ? (mouseCheck && mouseCheck.cpcm ? [] : [MOUSE_CHECK]) : [STICK_CHECK];
// Words for the current device in test briefs.
const aimWith = () => isMouse() ? 'with the mouse and click to fire' : 'with the right stick and fire with RT / R2';

// The look and outer deadzones the range should use once the stick check has run.
const checkedDz = () => session.drift ? session.drift.rec : cfg.dz;
const outerFor = check => check && check.reachR && extraSetting(game(), 'outer') ? outerFromReach(check.reachR.minReach) : 1;
const checkedOuter = () => outerFor(session.drift);

function quickSegments() {
  const s = settingsOf(cfg);
  return [
    ...checkSteps(),
    { kind: 'flick', rail: 'flick', tag: 'quick', n: styleRange().flicks, warm: 0, settings: s, intro: true, title: 'Flick test',
      text: `${COUNT_WORDS[styleRange().flicks] || styleRange().flicks} targets appear one at a time, some above or below you. Snap to each ${aimWith()}. Go at the speed you would in a real fight.` },
    { kind: 'track', rail: 'track', tag: 'quick', dur: styleRange().track, warm: 0, settings: s, intro: true, title: 'Tracking test',
      text: `Keep the crosshair on the strafing target for ${styleRange().track} seconds. No need to fire.` },
    ...turnSegments(),
    ...adsSegments(),
    ...(isMouse() ? [] : [recoilSeg()]),
    { kind: 'analyze' }
  ];
}

// A mouse has no look boost, so the drill is controller-only.
const turnSegments = (n = TURNS) => isMouse() ? [] : [turnSegment(n)];
// Big turns at full stick, alternating sides, to tune look boost and its ramp-up.
function turnSegment(n = TURNS) {
  return { kind: 'flick', turn: true, rail: 'turn', tag: 'turn', n, warm: 0, settings: settingsOf(cfg), intro: true,
    title: 'Turn-around drill',
    text: `${n} targets appear far to your side or behind you. Swing round fast, stop on each and fire. The arrow shows which way to turn.` };
}

function turnRec(c) {
  const s = session.segs.find(x => x.turn);
  return recommendTurn(s && s.data ? turnStats(s.data.list) : null, c, { boost: c.boost, ramp: c.boostRamp });
}

// Zoomed rounds at the current hip-fire settings times each ADS multiplier: a 1.5x sight, then a 4x scope
// when the game has a separate scoped setting. Targets shrink and slow by the zoom factor.
function adsSegments(scale = 1) {
  const base = settingsOf(cfg);
  return adsSpecs(game()).flatMap(spec => {
    const scoped = spec.zoom >= 3;
    const settings = { ...base, adsMult: cfg.ads[spec.key], zoomed: true };
    const title = scoped ? 'Scoped test' : 'ADS test';
    const n = Math.round((scoped ? ADS.scopedFlicks : ADS.flicks) * scale), dur = Math.round((scoped ? ADS.scopedSeconds : ADS.seconds) * scale);
    const what = scoped ? `Through a ${spec.zoom}× scope` : `Aiming down sights at ${spec.zoom}×`;
    return [
      { kind: 'flick', rail: 'ads', tag: 'ads', ads: spec.key, zoom: spec.zoom, n, warm: 0, settings, intro: true, title,
        text: `${what}: ${n} small, distant targets, then ${dur} seconds of tracking. The view is already zoomed, so there's no need to hold aim.` },
      { kind: 'track', rail: 'ads', tag: 'ads', ads: spec.key, zoom: spec.zoom, dur, warm: 1, settings, title,
        text: 'Stay on the distant target.' }
    ];
  });
}

function adsRecs(c, hSens) {
  return adsSpecs(GAMES[c.game]).map(spec => {
    const f = session.segs.find(x => x.kind === 'flick' && x.ads === spec.key);
    const t = session.segs.find(x => x.kind === 'track' && x.ads === spec.key);
    const cur = c.ads[spec.key];
    return { spec, cur, ...recommendAds(f && f.data ? f.data.list : [], t && t.data, c, hSens, spec, cur) };
  });
}

function verifySegments(A, B) {
  const plan = verifyPlan(settingsOf(A), settingsOf(B));
  const segs = [];
  plan.forEach((r, k) => {
    const title = `Round ${k + 1} of ${plan.length}`;
    segs.push({ kind: 'flick', rail: 'verify', key: r.key, counter: title, n: VERIFY.flicks, warm: VERIFY.warmFlicks, settings: r.settings, intro: true, title,
      text: k === 0
        ? `Blind test. Each round is ${VERIFY.flicks} targets, then ${VERIFY.trackSeconds} seconds of tracking. Two rounds use your old settings and two use the new ones, in a hidden order.`
        : `Same drill. The settings may have changed. ${VERIFY.flicks} targets, then tracking.` });
    segs.push({ kind: 'track', rail: 'verify', key: r.key, counter: title, dur: VERIFY.trackSeconds, warm: VERIFY.warmSeconds, settings: r.settings, title,
      text: 'Stay on the moving target.' });
    segs.push({ kind: 'rate', rail: 'verify', key: r.key, counter: title, title: `How did the speed of round ${k + 1} feel?`,
      text: 'Go with your gut. Your answer is shown next to the measurements at the end.' });
  });
  segs.push({ kind: 'verdict' });
  return segs;
}

function deepSegments() {
  return [
    ...checkSteps(),
    { kind: 'deepNext' }
  ];
}

// Saved Deep rounds, per game, so a later sitting can add to them. Only what the sensitivity fit
// reads is kept. A sitting counts only with the same curve and aim assist, which change how a speed feels.
// Version 2: rounds from the harder, evened-out drills with settle and path measures. Earlier saves were
// played on easier rounds and aren't pooled with these.
const DEEP_KEY = 'dialed-in:deep', DEEP_SITTINGS = 3, DEEP_SAVE_V = 2;
function loadDeepSaved() {
  try {
    const all = JSON.parse(localStorage.getItem(DEEP_KEY) || '{}'), e = all[cfg.game];
    if (!e || e.v !== DEEP_SAVE_V || !Array.isArray(e.rounds) || !e.rounds.length) return null;
    if (!isMouse() && (e.curve !== cfg.curve || e.aa !== (cfg.aa ?? 1))) return null;
    return e;
  } catch (err) { return null; }
}
function saveDeep(D, c) {
  const compact = h => ({ sens: h.sens, feel: h.feel ?? null, sitting: h.sitting,
    flicks: h.flicks.map(f => ({ D: f.D, W: f.W, t: +f.t.toFixed(3), hit: f.hit, shots: f.shots, lastIn: f.lastIn ?? null, path: +(f.path || 0).toFixed(2),
      first: f.first ? { along: f.first.along, t: f.first.t } : null })), chunks: h.chunks });
  const sittings = [...new Set(D.history.map(h => h.sitting))].slice(-DEEP_SITTINGS);
  try {
    const all = JSON.parse(localStorage.getItem(DEEP_KEY) || '{}');
    all[c.game] = { v: DEEP_SAVE_V, curve: c.curve, aa: c.aa ?? 1, rounds: D.history.filter(h => sittings.includes(h.sitting)).map(compact) };
    localStorage.setItem(DEEP_KEY, JSON.stringify(all));
  } catch (err) { /* storage full or blocked: the next sitting just starts fresh */ }
}
// Earlier rounds re-centred on the current sensitivity, each sitting numbered as a block for the fit.
function priorRounds(e) {
  const g = game().sens, base = g.rate(cfg.sens);
  const ids = [...new Set(e.rounds.map(r => r.sitting))];
  return e.rounds.filter(r => g.rate(r.sens) > 0).map(r => ({ ...r, x: Math.log2(g.rate(r.sens) / base), block: ids.indexOf(r.sitting) }));
}
function newDeep(pool, full = false) {
  const prior = pool ? priorRounds(pool) : [];
  const block = prior.length ? Math.max(...prior.map(h => h.block)) + 1 : 0;
  return { order: shuffled(DEEP.initial), history: prior, base: prior.length, prior: prior.length, block, sitting: Date.now(), pending: null, full };
}

// Queues the next search round, or the read-out when the search is done.
// D.more = playing extra rounds after a finished search; screening, turns and ADS are already done.
function deepStep() {
  const D = session.deep;
  if (D.pending) {
    const r = D.pending, parts = session.segs.filter(x => x.round === r);
    const fl = parts.find(x => x.kind === 'flick'), tr = parts.find(x => x.kind === 'track'), ra = parts.find(x => x.kind === 'rate');
    D.history.push({ x: r.x, sens: r.sens, flicks: fl.data.list.slice(fl.warm), chunks: tr.data.chunks, track: tr.data, rating: ra.data, feel: ra.data, block: D.block, sitting: D.sitting });
    D.pending = null;
  }
  const opts = D.more ? { base: D.base, min: MORE, max: MORE, control: -1 } : D.full ? { base: D.base, min: FULL.min, max: FULL.max } : { base: D.base };
  const R = D.full ? FULL.round : DEEP_ROUND, minR = D.full ? FULL.min : DEEP.minRounds, maxR = D.full ? FULL.max : DEEP.maxRounds;
  const next = deepNext(D.history, PLAYSTYLES[cfg.style], game(), cfg.sens, D.order, opts);
  if (!next) {
    D.res = deepAnalyze(D.history, PLAYSTYLES[cfg.style], game(), cfg.sens);
    D.feel = feelPoint(D.history, game(), cfg.sens);
    if (D.more) { session.segs.push({ kind: 'deepDone' }); return advance(); }
    const best = D.res && D.res.verdict !== 'flat' ? D.res.best.sens : cfg.sens;
    // Curve and vertical speed screening is about stick shaping; a mouse skips it.
    session.segs.push(...(isMouse() ? [] : screenSegments(D, best)), ...(D.full ? turnSegments(FULL.turns) : turnSegments()), ...adsSegments(D.full ? FULL.adsScale : 1),
      ...(isMouse() ? [] : [recoilSeg()]), { kind: 'deepDone' });
    return advance();
  }
  const k = D.history.length - D.base + 1;
  const round = { x: next.x, sens: next.sens };
  const settings = { sens: next.sens, ...verticalFor(next.sens), curve: cfg.curve, dz: checkedDz(), outer: checkedOuter(), ...turnK() };
  // The search always plays DEEP.minRounds; it adds up to two more only when the best speed is still unclear.
  const title = D.more ? `Extra round ${k} of ${MORE}`
    : k <= minR ? `Round ${k} of ${minR}` : `Extra round ${k - minR} of up to ${maxR - minR}`;
  const pooled = D.prior ? ` Your ${D.prior} rounds from before count too.` : '';
  D.pending = round;
  // Full dial-in: a short, skippable break every few rounds, since tiredness in a long session skews results.
  if (D.full && !D.more && k > 1 && (k - 1) % FULL.breakEvery === 0) session.segs.push({ kind: 'break', rail: 'deep', intro: true, counter: 'Break', title: 'Short break',
    text: `${k - 1} rounds done. Put the controller down, stretch your hands for 20 seconds or so, then carry on. Your results allow for warm-up and tiredness either way.` });
  session.segs.push(
    { kind: 'flick', rail: 'deep', round, counter: title, n: R.flicks, warm: R.warmFlicks, settings, intro: true, title,
      text: D.more && k === 1
        ? `${MORE} more rounds at and around your best guess so far, at hidden sensitivities. Then everything is refitted with all ${D.base + MORE} rounds.`
        : k === 1
        ? `The search runs ${minR} ${D.full ? '' : 'short '}rounds, plus up to ${maxR - minR} extra if your best speed is still unclear.${D.full ? ` There's a short break every ${FULL.breakEvery} rounds.` : ''} Each is ${R.flicks} targets, then ${R.trackSeconds} seconds of tracking, at a hidden sensitivity. Each round's speed is picked from how you did in the earlier ones.${pooled}`
        : `${R.flicks} targets, then tracking. The sensitivity has probably changed. Play the way you normally would.` },
    { kind: 'track', rail: 'deep', round, counter: title, dur: R.trackSeconds, warm: R.warmSeconds, settings, title, text: 'Stay on the moving target.' },
    { kind: 'rate', rail: 'deep', round, counter: title, title: `How did the speed of round ${D.history.length + 1} feel?`, text: 'Go with your gut. Where your answers turn from slow to fast is the speed that feels right to you, and it counts alongside your scores.' },
    { kind: 'deepNext' }
  );
  advance();
}

// Curve feel check: three hidden versions of the player's curve (softer, as now, quicker), a short
// flick round with each in random order, then the player picks the one that felt like their game.
// The pick reshapes the curve everywhere the range plays (sim.js shape, settings.curveK).
const CURVE_STEPS = [1.25, 1, 0.8], CURVE_FLICKS = 6;
const curveName = k => ['A', 'B', 'C'][k];
function curveSeg(k) {
  const v = session ? session.curveCheck.variants[k] : null;
  return { kind: 'flick', rail: 'curve', n: CURVE_FLICKS, warm: 0, intro: true, counter: `Version ${curveName(k)}`, title: `Version ${curveName(k)}`,
    text: `${CURVE_FLICKS} targets. Notice how small pushes and stopping on target feel, compared with your game.`, settings: v };
}
function curvePickSeg() {
  return { kind: 'curvePick', rail: 'curve', counter: 'Pick one', title: 'Which one felt like your game?',
    text: 'Go by how small pushes and stopping on target felt, not by how well you did. Play any of them again if you\'re not sure.' };
}
function startCurveCheck() {
  readSetup();
  const base = cfg.curveK || 1;
  const order = shuffled([0, 1, 2]);
  const variants = order.map(i => ({ ...settingsOf(cfg), curveK: +clamp(base * CURVE_STEPS[i], CURVE_K.min, CURVE_K.max).toFixed(2) }));
  result = null;
  session = { segs: [], i: 0, phase: 'intro', countLeft: 0, drift: null, deep: null, mouse: mouseCheck, curveCheck: { variants } };
  session.segs = [0, 1, 2].map(k => curveSeg(k));
  session.segs[0].text = `You'll play three versions of your ${GAMES[cfg.game].curve[cfg.curve]} curve, ${CURVE_FLICKS} targets each, in a hidden order. ` + session.segs[0].text;
  session.segs.push(curvePickSeg());
  calibrate();
  enter();
}
function curveReplay(k) {
  session.segs.splice(session.i + 1, 0, curveSeg(k), curvePickSeg());
  advance();
}
function curvePicked(k) {
  if (k != null) cfg.curveK = session.curveCheck.variants[k].curveK === 1 ? null : session.curveCheck.variants[k].curveK;
  cfg.curveChecked = true;
  saveSetup();
  session = null;
  mouse.unlock();
  syncSetup();
  show('setup');
}

// Recoil check: aimed in at the game's first zoom, bursts of a generic climbing rifle (recoil.js).
// The result shows in setup; on a game with a vertical setting it can be applied in one press.
let recoilResult = null;
function recoilSettings() {
  const spec = adsSpecs(game())[0];
  return { ...settingsOf(cfg), adsMult: cfg.ads[spec.key] ?? spec.def, zoomed: true };
}
function recoilSeg() {
  const spec = adsSpecs(game())[0];
  return { kind: 'recoil', rail: 'recoil', intro: true, zoom: spec.zoom, settings: recoilSettings(), counter: 'Recoil', title: 'Recoil check',
    text: `Aimed in at ${spec.zoom}× with your ${spec.generic ? 'ADS' : spec.label.toLowerCase()} setting. Hold fire on the target and the view climbs like an automatic rifle: pull down to stay on it. Each burst stops after ${RECOIL.burst} seconds. Let go, aim at the next target and fire again. ${RECOIL.bursts} bursts, the first is warm-up. It's a generic rifle, not a real gun, and there's no aim assist.` };
}
function startRecoilCheck() {
  readSetup();
  result = null;
  session = { segs: [recoilSeg()], i: 0, phase: 'intro', countLeft: 0, drift: null, deep: null, mouse: mouseCheck, recoilCheck: true };
  calibrate();
  enter();
}
// Standalone, the result goes back to setup; inside Full dial-in it is kept for the results screen.
function recoilDone(R) {
  const s = seg(), sum = recoilSummary(R);
  const out = sum ? { sum, rec: recommendRecoil(sum, game(), s.settings), game: cfg.game, vsens: cfg.vsens } : null;
  if (!session.recoilCheck) { session.recoil = out; if (out) recoilResult = out; return advance(); }
  recoilResult = out;
  session = null;
  mouse.unlock();
  syncSetup();
  show('setup');
  $('#recoil-field').scrollIntoView({ block: 'center' });
}
// One verdict sentence, then at most one tip. The pull-down percentages stay out: they read as noise.
function recoilText(r) {
  const g = game(), { sum, rec } = r, R = sum.r;
  const vName = g.vsens ? g.vsens.label : 'vertical speed';
  const off = Math.abs(sum.bias).toFixed(1) + '°';
  const to = rec.vsens != null ? `${vName} ${rec.vsens}` : `vertical speed ${rec.verdict === 'raise' ? '+' : '−'}${Math.round(Math.abs(rec.f - 1) * 100)}% while aimed in`;
  let text, lateCatch = false;
  if (rec.verdict === 'raise' && rec.need >= 1) text = `Even a full pull down can't hold the climb at this speed. Try ${to}.`;
  else if (rec.verdict === 'raise') text = `You drifted about ${off} above the target: your pull-down was too light for this speed. Try ${to}, where your natural pull holds it.`;
  else if (rec.verdict === 'lower') text = `You pulled about ${off} below the target. Try ${to}, where your natural pull lands on it.`;
  else if (sum.bias > R * 0.5) { text = `You drifted about ${off} above the target, but your pull was strong enough: start pulling down as you start firing.`; lateCatch = true; }
  else if (sum.bias < -R * 0.5) text = `You pulled about ${off} below the target. Your speed is fine, so ease off the pull a little.`;
  else text = 'You stayed on target while firing, so your vertical speed suits your recoil control.';
  const tip = !lateCatch && sum.early > R * 2 ? 'Tip: start pulling as you start firing.'
    : sum.wobble > R * 0.6 ? 'Tip: your crosshair bounced, so pull more smoothly.'
    : sum.side > R ? 'Tip: small left-right corrections help with the sideways wander.' : '';
  return tip ? `${text} ${tip}` : text;
}

// The recoil check next to the flick tests' vertical suggestion: from Full dial-in, or a standalone check
// played at the same vertical setting. Agreement backs the vertical suggestion; a conflict is shown with
// both values so the player can choose by how they fight (play style breaks the tie as a hint).
function recoilRow(g, c, r, row) {
  const rr = result.recoil || (recoilResult && recoilResult.game === c.game && recoilResult.vsens === c.vsens ? recoilResult : null);
  if (!rr) return '';
  const rec = rr.rec;
  const sgn = x => Math.abs(x) < 0.01 ? 0 : Math.sign(x);
  const flick = g.vsens ? sgn(r.vsens - c.vsens) : sgn(r.vmult - 1), rc = sgn(rec.f - 1);
  const flickVal = g.vsens ? String(r.vsens) : vRel(r.vmult), recoilVal = rec.vsens != null ? String(rec.vsens) : g.vsens ? String(c.vsens) : vRel(rec.f);
  const say = v => v === 'Same' ? 'your current speed' : v;
  const lean = c.style === 'tracking' ? ` Your ${PLAYSTYLES.tracking.label} style leans ${say(flickVal)}.` : c.style === 'flick' ? ` Your ${PLAYSTYLES.flick.label} style leans ${say(recoilVal)}.` : '';
  const choose = `Flick tests say ${say(flickVal)}: pick ${say(flickVal)} if you mostly fight from the hip, ${say(recoilVal)} if mostly aimed in.${lean}`;
  let tg, note;
  if (flick === rc) { tg = '<span class="tag">Agrees</span>'; note = 'Matches the flick tests.'; }
  else if (flick && rc) { tg = '<span class="tag down">Conflict</span>'; note = choose; }
  else { tg = '<span class="tag">Partly agrees</span>'; note = choose; }
  return row('Recoil check (aimed in)', g.vsens ? c.vsens : 'Now', recoilVal, tg, `${recoilText(rr)} ${note}`);
}

// Picks a finished Deep search back up for MORE extra rounds, keeping every round and check so far.
function deepMore() {
  const D = result.deepState;
  D.more = true; D.base = D.history.length; D.order = morePlan(D.history, PLAYSTYLES[cfg.style]);
  const segs = result.segs;
  segs.push({ kind: 'deepNext' });
  session = { segs, i: segs.length - 1, phase: 'intro', countLeft: 0, drift: result.drift, deep: D, mouse: result.mouse };
  result = null;
  calibrate();
  enter();
}

// Screening: four blind rounds at the best speed covering both curves x two vertical speeds.
function screenSegments(D, best) {
  const g = game();
  const now = D.history.filter(h => h.track);
  const base = now.filter(h => h.sens === cfg.sens);
  const from = base.length ? base : now;
  const wanted = recommend(summarize(from.flatMap(h => h.flicks), from[0].track), cfg, session.drift).curve;
  const alt = altCurve(g, cfg.curve, wanted);
  const vBase = verticalFor(best);
  const vAt = f => g.vsens ? { vsens: nearestVsens(g.vsens.rate(vBase.vsens) * f) } : { vmult: vBase.vmult * f };
  D.screen = { best, curves: [cfg.curve, alt || cfg.curve], verts: [vAt(SCREEN.vLow), vAt(SCREEN.vHigh)], vBase };
  const plan = D.full ? Array.from({ length: FULL.screenReps }, () => screenPlan()).flat() : screenPlan();
  return plan.flatMap((p, k) => {
    const settings = { sens: best, ...D.screen.verts[p.vert], curve: D.screen.curves[p.curve], dz: checkedDz(), outer: checkedOuter(), boost: cfg.boost, boostRamp: cfg.boostRamp, boostDelay: cfg.boostDelay, ...turnK() };
    const title = `Check ${k + 1} of ${plan.length}`;
    return [
      { kind: 'flick', rail: 'screen', screen: p, counter: title, n: DEEP_ROUND.flicks, warm: DEEP_ROUND.warmFlicks, settings, intro: true, title,
        text: k === 0
          ? `${plan.length === 4 ? 'Four' : plan.length} more rounds at your best speed. The response curve and vertical speed change between them, hidden, to see whether either one matters for you.`
          : `Same drill. ${DEEP_ROUND.flicks} targets, then tracking.` },
      { kind: 'track', rail: 'screen', screen: p, counter: title, dur: DEEP_ROUND.trackSeconds, warm: DEEP_ROUND.warmSeconds, settings, title, text: 'Stay on the moving target.' }
    ];
  });
}

function nearestVsens(rateTarget) {
  const v = game().vsens;
  let best = v.min, err = Infinity;
  for (let x = v.min; x <= v.max; x += v.step) {
    const e = Math.abs(v.rate(x) - rateTarget);
    if (e < err) { err = e; best = x; }
  }
  return best;
}

// Applies the screening result. A decisive verdict replaces the curve and vertical advice; a close
// one keeps the current curve and the current vertical balance.
function applyScreen(rec, c, D) {
  const S = D.screen, g = game();
  const rounds = [];
  for (const x of session.segs) {
    if (!x.screen || x.data == null) continue;
    if (x.kind === 'flick') rounds.push({ ...x.screen, flicks: x.data.list.slice(x.warm), chunks: [] });
    if (x.kind === 'track' && rounds.length) rounds[rounds.length - 1].chunks.push(...x.data.chunks);
  }
  if (!S || rounds.length < 4) return;
  const res = screenAnalyze(rounds, PLAYSTYLES[c.style]);
  const out = {};
  const odds = p => pct(p >= 0.5 ? p : 1 - p);
  if (S.curves[1] !== S.curves[0] && res.curve) {
    const cv = res.curve, [l0, l1] = S.curves.map(k => g.curve[k]);
    out.curve = { a: l0, b: l1, verdict: cv.verdict, delta: cv.overall.delta, p: cv.overall.p };
    if (cv.verdict === 'better') {
      rec.curve = S.curves[1];
      rec.curveWhy = `In blind rounds at your best speed, ${l1} beat your ${l0} by about ${pct(cv.overall.delta)} overall (${odds(cv.overall.p)} likely real). Switch to ${l1}.`;
    } else {
      rec.curve = S.curves[0];
      rec.curveWhy = cv.verdict === 'worse'
        ? `In blind rounds at your best speed, your ${l0} beat ${l1} by about ${pct(-cv.overall.delta)} overall (${odds(cv.overall.p)} likely real). Keep ${l0}.`
        : `In blind rounds at your best speed, ${l0} and ${l1} scored too close to tell apart, so the curve isn't what limits your aim. Keep ${l0}.`;
    }
  }
  if (res.vert) {
    const vt = res.vert;
    const show = lv => g.vsens ? String(lv.vsens) : vRel(lv.vmult / S.vBase.vmult);
    out.vert = { a: show(S.verts[0]), b: show(S.verts[1]), verdict: vt.verdict, delta: vt.overall.delta, p: vt.overall.p };
    const pick = vt.verdict === 'better' ? S.verts[1] : vt.verdict === 'worse' ? S.verts[0] : S.vBase;
    if (g.vsens) rec.vsens = pick.vsens; else rec.vmult = pick.vmult;
    rec.vWhy = vt.verdict === 'close'
      ? 'In blind rounds, changing vertical speed by about 15% either way made no clear difference on up-and-down targets, so keep your current balance.'
      : `In blind rounds, the ${vt.verdict === 'better' ? 'faster' : 'slower'} vertical speed scored about ${pct(Math.abs(vt.overall.delta))} better on up-and-down targets (${odds(vt.overall.p)} likely real).`;
  }
  rec.screen = out;
}

// Deep rounds keep the player's vertical-to-horizontal balance while the horizontal speed moves.
function verticalFor(sens) {
  const g = game();
  if (!g.vsens) return { vmult: cfg.vmult ?? 1 };
  const target = g.vsens.rate(cfg.vsens) * g.sens.rate(sens) / g.sens.rate(cfg.sens);
  let best = cfg.vsens, err = Infinity;
  for (let v = g.vsens.min; v <= g.vsens.max; v += g.vsens.step) {
    const e = Math.abs(g.vsens.rate(v) - target);
    if (e < err) { err = e; best = v; }
  }
  return { vsens: best };
}

function deepDone() {
  const D = session.deep;
  const c = { ...cfg };
  const res = D.res;
  // Curve and deadzone advice come from the rounds played at the current speed.
  const now = D.history.filter(h => h.track);
  const base = now.filter(h => h.sens === c.sens);
  const from = base.length ? base : now;
  const stats = summarize(from.flatMap(h => h.flicks), from[0].track);
  const rec = withHardware(recommend(stats, c, session.drift), session.drift);
  if (res) Object.assign(rec, deepPick(res, D.feel, c));
  // Every round scales vertical with horizontal, so the up/down vs side-to-side comparison holds across all of them.
  Object.assign(rec, verticalRec(now.flatMap(h => h.flicks), c, rec.sens));
  applyScreen(rec, c, D);
  rec.ads = adsRecs(c, rec.sens);
  rec.turn = turnRec(c);
  rec.boost = c.boost; rec.boostRamp = c.boostRamp; rec.boostDelay = c.boostDelay;
  result = { cfg: c, stats, rec, drift: session.drift, mouse: session.mouse, verify: null, segs: session.segs, pad: inp.name, recoil: session.recoil || null,
    deep: { res, feel: D.feel, rounds: D.history.map(h => ({ sens: h.sens, rating: h.feel ?? null })), screen: rec.screen, prior: D.prior, full: !!D.full, sittings: new Set(D.history.map(h => h.sitting)).size }, deepState: D };
  saveDeep(D, c);
  session = null;
  show('results');
}

// The sensitivity to suggest from the score fit and, when the speed ratings give one, the speed that
// felt right. Scores decide when they're clear; within the range that scores the same (or when
// sensitivity barely matters) the feel decides.
function deepPick(res, feel, c) {
  const g = GAMES[c.game];
  const [lo, hi] = [res.range[0].sens, res.range[1].sens];
  const span = lo === hi ? `${lo}` : `${lo} to ${hi}`;
  const inRange = feel && feel.x >= res.range[0].x - 0.05 && feel.x <= res.range[1].x + 0.05;
  const feelEdge = !feel || !feel.edge ? '' : ` Nearly every round felt too ${feel.edge === 'lo' ? 'fast' : 'slow'}, so that speed sits a little ${feel.edge === 'lo' ? 'below the slowest' : 'above the fastest'} one tested.`;
  const feelAt = feel ? `Your speed ratings turn from slow to fast at about ${feel.sens}.${feelEdge}` : '';
  if (res.verdict === 'matters') {
    const edge = res.edge ? ` Your best score came at the ${res.edge === 'hi' ? 'fastest' : 'slowest'} speed tested, so the true best may sit a little beyond it.` : '';
    const base = `Your score peaked at ${res.best.sens} and fell about ${pct(res.drop)} when the speed was 30% off that. Anything from ${span} is within the noise of your best.${edge}`;
    if (!feel) return { sens: res.best.sens, sensWhy: base };
    if (Math.abs(feel.x - res.best.x) <= FEEL.agree) return { sens: res.best.sens, sensWhy: `${base} It felt right too: ${feelAt[0].toLowerCase() + feelAt.slice(1)}` };
    if (inRange) return { sens: feel.sens, sensWhy: `${base} ${feelAt} That scores as well as your peak and feels right, so go with ${feel.sens}.` };
    return { sens: res.best.sens, sensWhy: `${base} ${feelAt} That's outside the range you score best in, so ${res.best.sens} may feel ${feel.x < res.best.x ? 'fast' : 'slow'} at first. Give it a few matches before you judge it.` };
  }
  if (res.verdict === 'flat') {
    const base = `Your score barely changed across the speeds tested (${pct(Math.max(0, res.drop))} at 30% off your best). Sensitivity is not what limits your aim, so go by feel.`;
    return feel
      ? { sens: feel.sens, sensWhy: `${base} ${feelAt} Go with ${feel.sens}.` }
      : { sens: c.sens, sensWhy: `${base} Your current ${c.sens} is fine. Rate each round's speed next time and the app can say which speed feels best.` };
  }
  const base = `Best guess is ${res.best.sens}, but your rounds varied too much to be sure. Anything from ${span} is reasonable in ${g.name}.`;
  if (inRange) return { sens: feel.sens, sensWhy: `${base} ${feelAt} That's inside the range, so start with ${feel.sens}. More rounds would firm it up.` };
  return { sens: res.best.sens, sensWhy: `${base}${feel ? ' ' + feelAt : ''} More rounds would narrow it down.` };
}

/* ---------- session flow ---------- */

function start(segs, drift, deep = null) {
  segs = segs.map(x => ({ ...x }));
  session = { segs, i: 0, phase: 'intro', countLeft: 0, drift, deep, mouse: result ? result.mouse : mouseCheck };
  calibrate();
  enter();
}
function enter() {
  const s = seg();
  if (s.kind === 'analyze') return analyze();
  if (s.kind === 'verdict') return verdict();
  if (s.kind === 'deepNext') return deepStep();
  if (s.kind === 'deepDone') return deepDone();
  if (s.kind === 'dpiDone') return dpiDone();
  resetView();
  s.data = null;
  if (s.kind === 'rate' || s.kind === 'curvePick') { session.phase = s.kind === 'rate' ? 'rate' : 'pick'; mouse.unlock(); } // the buttons need the cursor
  else if (s.intro || s.kind === 'drift') session.phase = 'intro';
  else { session.phase = 'count'; session.countLeft = 2; }
  show('test');
}
function advance() { session.i++; enter(); }
function resetView() { view.yaw = 0; view.pitch = 0; view.boostT = 0; }

function begin() {
  const s = seg();
  if (s.kind === 'break') return advance();
  if (s.kind === 'drift' && inp.src !== 'pad') return;
  if (isMouse()) mouse.lock();
  session.phase = 'count';
  session.countLeft = s.kind === 'drift' ? 1.5 : 3;
  resetView();
  renderBrief(true);
}
function startRun(s) {
  session.phase = 'run';
  if (s.kind === 'mcheck') { mouse.takeSwipes(); mouse.takeGaps(); s.data = { swipes: [], gaps: [], short: 0 }; }
  if (s.kind === 'drift') s.data = { part: 'rest', t: 0, r: 0, l: 0, lt: 0, rt: 0, warn: 0, reachR: emptyReach(), reachL: emptyReach(), maxLt: 0, maxRt: 0, lDown: false, rDown: false };
  // Calibration always plays engine-2 targets: true-angle hits and the calmer strafing target.
  if (s.kind === 'flick') {
    s.data = { list: [], plan: s.turn ? null : flickPlan(Math.random, s.n, s.warm || 0, verticalSlot), flash: null };
    s.data.cur = s.turn ? newTurnTarget(view, Math.random, 1, true) : flickTarget(s, s.data, 0);
  }
  if (s.kind === 'track') { s.data = makeTrack(s.warm, 1 / (s.zoom || 1), styleTrack()); s.data.script = trackScript(Math.random, (s.warm || 0) + s.dur, s.data.P); }
  // The fire press that started the round shouldn't start a burst; the first one waits for a fresh press.
  if (s.kind === 'recoil') { s.data = makeRecoil(); s.data.wait = true; }
  renderBrief(true);
}
function stop() {
  session = null;
  mouse.unlock();
  show(result ? 'results' : 'setup');
}

// The outer deadzone changes how the range turns, so it travels with the settings Verify and Deep compare.
// Games without the setting keep the stick's natural reach.
function withHardware(rec, check) {
  rec.outer = outerFor(check);
  return rec;
}

// Mouse games turn the same on both axes and mostly have no separate vertical setting.
function verticalRec(flicks, c, hSens) {
  return GAMES[c.game].device === 'mouse' ? { vmult: 1, vWhy: '' } : recommendVertical(flicks, c, hSens);
}

function analyze() {
  const fl = session.segs.find(x => x.kind === 'flick' && x.tag === 'quick').data.list;
  const tr = session.segs.find(x => x.kind === 'track' && x.tag === 'quick').data;
  const c = { ...cfg };
  const stats = summarize(fl, tr);
  const rec = withHardware(recommend(stats, c, session.drift), session.drift);
  Object.assign(rec, verticalRec(fl, c, rec.sens));
  rec.ads = adsRecs(c, rec.sens);
  rec.turn = turnRec(c);
  // Verify compares the other settings; look boost stays at the player's values on both sides.
  rec.boost = c.boost; rec.boostRamp = c.boostRamp; rec.boostDelay = c.boostDelay;
  result = { cfg: c, stats, rec, drift: session.drift, mouse: session.mouse, verify: null, segs: session.segs, pad: inp.name, recoil: session.recoil || null };
  if (c.mode === 'verify' && settingsChanged(c, rec)) {
    session.segs.push(...verifySegments(c, rec));
    return advance();
  }
  session = null;
  show('results');
}

function verdict() {
  // One round = a flick segment and the tracking segment after it, kept apart for the round-level bootstrap.
  const groups = { A: { rounds: [], ratings: [] }, B: { rounds: [], ratings: [] } };
  for (const s of session.segs) {
    if (!s.key || s.data == null) continue;
    const g = groups[s.key];
    if (s.kind === 'flick') g.rounds.push({ flicks: s.data.list.slice(s.warm), chunks: [] });
    if (s.kind === 'track' && g.rounds.length) g.rounds[g.rounds.length - 1].chunks.push(...s.data.chunks);
    if (s.kind === 'rate') g.ratings.push(s.data);
  }
  const A = sideOf(groups.A.rounds), B = sideOf(groups.B.rounds);
  if (result.segs !== session.segs) result.segs = result.segs.concat(session.segs);
  result.verify = {
    cmp: verifyCompare({ A, B }, PLAYSTYLES[result.cfg.style]),
    feelA: ratingSummary(groups.A.ratings),
    feelB: ratingSummary(groups.B.ratings),
    targets: A.flicks.length + B.flicks.length,
    seconds: A.chunks.length + B.chunks.length
  };
  session = null;
  show('results');
}

/* ---------- per-frame updates ---------- */

// The range pauses while a mouse test has lost the pointer (Esc, alt-tab); a click picks it back up.
const mousePaused = phase => isMouse() && !mouse.locked && (phase === 'count' || phase === 'run');

function tick(dt, edge) {
  const s = seg(), P = session.phase;
  // With the mouse captured there's no cursor for the Start button, so a click starts instead.
  if (P === 'intro') { if (edge.fire && (!isMouse() || mouse.locked)) begin(); return; }
  if (mousePaused(P)) return;
  if (P === 'rate') {
    const r = RATINGS.find(x => edge[x.key]);
    if (r) rate(r.v);
    return;
  }
  if (P === 'pick') {
    const k = ['dl', 'du', 'dr'].findIndex(x => edge[x]);
    if (k >= 0) curvePicked(k);
    else if (edge.lb) curvePicked(null);
    return;
  }
  if (P === 'count') {
    session.countLeft -= dt;
    if (session.countLeft <= 0) startRun(s);
    return;
  }
  if (s.kind === 'drift') tickDrift(s, dt);
  else if (s.kind === 'mcheck') tickMouseCheck(s);
  else if (s.kind === 'flick') tickFlick(s, dt, edge.fire);
  else if (s.kind === 'track') tickTrack(s, dt);
  else if (s.kind === 'recoil') tickRecoil(s, dt);
}

function rate(v) { seg().data = v; advance(); }

function tickDrift(s, dt) {
  const D = s.data;
  D.t += dt;
  if (D.part === 'rest') {
    const r = Math.hypot(inp.rx, inp.ry), l = Math.hypot(inp.lx, inp.ly);
    D.warn -= dt;
    if (r > 0.35 || l > 0.35) { Object.assign(D, { t: 0, r: 0, l: 0, lt: 0, rt: 0, warn: 1.2 }); return; }
    D.r = Math.max(D.r, r); D.l = Math.max(D.l, l);
    D.lt = Math.max(D.lt, inp.lt); D.rt = Math.max(D.rt, inp.rt);
    if (D.t >= DRIFT_SECONDS) nextStickPart(D);
  } else if (D.part === 'roll') {
    recordReach(D.reachR, inp.rx, inp.ry);
    recordReach(D.reachL, inp.lx, inp.ly);
    const done = coverage(D.reachR) >= 1 && coverage(D.reachL) >= 1 && D.t > 2;
    if (done || D.t >= ROLL_SECONDS) nextStickPart(D);
  } else {
    D.maxLt = Math.max(D.maxLt, inp.lt); D.maxRt = Math.max(D.maxRt, inp.rt);
    if (inp.lt > 0.5) D.lDown = true;
    if (inp.rt > 0.5) D.rDown = true;
    const released = D.lDown && D.rDown && inp.lt < 0.1 && inp.rt < 0.1;
    if (released || D.t >= SQUEEZE_SECONDS) nextStickPart(D);
  }
}
function nextStickPart(D) {
  D.t = 0;
  if (D.part === 'rest') D.part = 'roll';
  else if (D.part === 'roll') D.part = 'squeeze';
  else {
    session.drift = {
      r: D.r, l: D.l, rec: driftDeadzone(D.r),
      reachR: stickReport(D.reachR), reachL: stickReport(D.reachL),
      trig: D.lDown || D.rDown ? { restL: D.lt, restR: D.rt, maxL: D.maxLt, maxR: D.maxRt } : null
    };
    return advance();
  }
  renderBrief(true);
}

// Card swipes: one per SWIPES entry. A release after a short drag is a slip and is ignored.
function tickMouseCheck(s) {
  const D = s.data;
  for (const sw of mouse.takeSwipes()) {
    if (Math.hypot(sw.dx, sw.dy) < MIN_SWIPE) { D.short++; continue; }
    D.swipes.push(sw);
  }
  D.gaps.push(...mouse.takeGaps());
  if (D.swipes.length >= SWIPES.length) finishMouseCheck(D);
  else renderBrief();
}
// "Measure my DPI" in setup: just the card swipes, then back to the form with the result filled in.
$('#dpi-measure').addEventListener('click', () => {
  readSetup();
  start([{ ...MOUSE_CHECK, title: 'Measure your DPI', text: 'Three slides along a bank card (3.37 inches), about 20 seconds. Lay the card flat on your mouse pad with room for the mouse beside it, then press Start.' }, { kind: 'dpiDone' }], null);
});
function dpiDone() {
  const m = session.mouse;
  session = null;
  let note;
  if (!m || !m.cpcm) note = 'Not measured, the swipes were skipped. Enter the DPI from your mouse software, or try again.';
  else {
    const r = resolveDpi(cfg.dpi, m.cpcm, window.devicePixelRatio || 1);
    const seen = Math.round(r.dpiSeen);
    if (r.verdict === 'match') note = `Measured about ${seen}, which matches ${cfg.dpi}. Calibration will use this measurement and skip the mouse check.`;
    else if (r.verdict === 'scaled') note = `Measured about ${seen}: your browser shrinks movement by the display scale, and ${cfg.dpi} accounts for that. Calibration will skip the mouse check.`;
    else {
      // Mice step DPI in 50s or 100s; card swipes are good to a few percent, so round to the nearest 50.
      cfg.dpi = Math.max(100, Math.round(seen / 50) * 50);
      note = `Measured about ${seen}, so this is now ${cfg.dpi}. If your mouse software says otherwise, check which DPI stage is active, or measure again.`;
    }
  }
  show('setup');
  syncSetup();
  saveSetup();
  $('#dpi-help').textContent = note;
  $('#dpi').scrollIntoView({ block: 'center' });
}

function finishMouseCheck(D) {
  const sw = D.swipes.length >= SWIPES.length ? analyzeSwipes(D.swipes, mouse.raw) : null;
  mouseCheck = { cpcm: sw && sw.cpcm, accel: sw && sw.accel, spread: sw && sw.spread, raw: mouse.raw, hz: pollingHz(D.gaps) };
  session.mouse = mouseCheck;
  calibrate();
  advance();
}

function tickFlick(s, dt, fireEdge) {
  const F = s.data;
  const st = steer(view, inp, s.settings, game(), dt, 0, F.cur);
  if (F.flash) F.flash.t -= dt;
  if (s.turn) turnStep(F.cur, view, st.mag, dt);
  const out = flickStep(F.cur, view, st.push, fireEdge, dt);
  if (out === 'miss') F.flash = { yaw: view.yaw, pitch: view.pitch, t: 0.2, good: false };
  if (out === 'hit') F.flash = { yaw: F.cur.yaw, pitch: F.cur.pitch, t: 0.3, good: true };
  if (out === 'hit' || out === 'timeout') {
    F.list.push(F.cur);
    if (F.list.length >= s.n) return advance();
    F.cur = s.turn ? newTurnTarget(view, Math.random, F.list.length % 2 ? -1 : 1, true) : flickTarget(s, F, F.list.length);
  }
}

function tickRecoil(s, dt) {
  steer(view, inp, s.settings, game(), dt);
  if (recoilStep(s.data, view, !!inp.fire, inp.ry, dt) === 'done') recoilDone(s.data);
}

function tickTrack(s, dt) {
  const st = steer(view, inp, s.settings, game(), dt, 0, trackAim(s.data));
  trackStep(s.data, view, st.vy, dt);
  if (s.data.t >= s.warm + s.dur) advance();
}

/* ---------- screens ---------- */

function show(name) {
  const changed = name !== screen;
  if (name !== 'test') mouse.unlock();
  screen = name;
  $('#p-setup').hidden = name !== 'setup';
  $('#p-warm').hidden = name !== 'setup';
  $('#p-test').hidden = name !== 'test';
  $('#p-results').hidden = name !== 'results';
  $('#p-chend').hidden = name !== 'chend';
  // Focus layout while a test or challenge runs: the range fills the window and the side panels step
  // aside, except the on-screen stick for players who aim with it.
  document.body.classList.toggle('testing', name === 'test');
  document.body.classList.toggle('vpad-on', inp.src === 'virtual' && !isMouse());
  if (name !== 'test' && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  // The step rail belongs to calibration; the warm-up challenge hides it.
  $('#steps').hidden = !!chal;
  if (!chal) renderRail();
  if (name === 'setup') { renderWarmBests(); showLeader(); }
  else $('#p-leader').hidden = true;
  if (name === 'test') { if (chal) renderChalBrief(true); else renderBrief(true); }
  if (name === 'results') { renderResults(); if (result && !result.logged) { result.logged = true; logEvent('results'); } }
  if (name === 'chend') { if (chal && chal.duel) renderDuelEnd(); else renderChalEnd(); }
  if (changed) window.scrollTo({ top: 0 });
}

function railKeys() {
  if (session && session.curveCheck) return ['setup', 'curve'];
  if (session && session.recoilCheck) return ['setup', 'recoil'];
  const deep = !!((session && session.deep) || (result && result.deep) || (!session && !result && deepMode(cfg.mode)));
  let keys = deep ? ['setup', 'drift', 'deep', 'screen', 'turn', 'ads'] : ['setup', 'drift', 'flick', 'track', 'turn', 'ads'];
  if (!isMouse()) keys.push('recoil');
  // Mouse sessions have no screening, turn drill or ADS rounds, and skip the check once DPI is measured.
  if (isMouse()) keys = keys.filter(k => !['screen', 'turn', 'ads'].includes(k) && (k !== 'drift' || !(mouseCheck && mouseCheck.cpcm) || (session && session.segs.some(x => x.kind === 'mcheck'))));
  const verifying = (cfg.mode === 'verify' && !deep) || (result && result.verify) || (session && session.segs.some(s => s.rail === 'verify'));
  if (verifying) keys.push('verify');
  keys.push('results');
  return keys;
}
function renderRail() {
  const keys = railKeys();
  const now = screen === 'test' ? seg().rail : screen;
  const idx = keys.indexOf(now);
  const ol = $('#steps');
  ol.textContent = '';
  keys.forEach((k, i) => {
    const li = document.createElement('li');
    if (i < idx) li.className = 'done';
    if (i === idx) li.className = 'now';
    const n = document.createElement('span');
    n.className = 'n'; n.textContent = String(i + 1).padStart(2, '0');
    li.append(n, k === 'drift' && isMouse() ? 'Mouse' : RAIL[k]);
    ol.append(li);
  });
}

let briefKey = '';
function renderBrief(force) {
  const s = seg();
  if (!s) return;
  const noPad = inp.src !== 'pad';
  const key = session.i + session.phase + noPad + (s.data && s.data.part || '') + (s.data && s.data.swipes ? s.data.swipes.length + '/' + s.data.short : '') + mouse.locked;
  if (key === briefKey && !force) return;
  briefKey = key;
  const P = session.phase;
  $('#brief-title').textContent = s.title;
  let text = s.text;
  if (s.kind === 'mcheck' && P === 'run') {
    const k = s.data.swipes.length;
    text = `Swipe ${k + 1} of ${SWIPES.length}, ${SWIPES[k]}. ${SWIPE_TEXT[SWIPES[k]]}${s.data.short ? ' (That last one was too short to be a card length, so it was skipped.)' : ''}`;
  }
  if (s.kind === 'drift' && noPad && P === 'intro') text = 'No controller found, so there is nothing to measure. Press a button on your controller to wake it, or skip this check.';
  if (P === 'count') text = 'Get ready.';
  if (P === 'run' && s.kind === 'drift') text = STICK_PART_TEXT[s.data.part];
  $('#brief-text').textContent = text;
  $('#swipe-fig').hidden = s.kind !== 'mcheck' || P !== 'intro'; // the range draws it during the slides
  $('#chal-guide').hidden = true;

  const act = $('#brief-actions');
  act.textContent = '';
  if (P === 'intro') {
    const blocked = s.kind === 'drift' && noPad;
    if (!blocked) act.append(button(s.kind === 'drift' ? 'Start stick check' : s.kind === 'mcheck' ? 'Start mouse check' : s.kind === 'break' ? 'Continue' : 'Start', 'primary', begin));
    if (s.kind === 'drift') act.append(button('Skip', '', () => { session.drift = null; advance(); }));
    if (s.kind === 'recoil' && !session.recoilCheck) act.append(button('Skip', '', () => { session.recoil = null; advance(); }));
    if (s.kind === 'mcheck') act.append(button('Skip, use the DPI I entered', '', () => advance()));
    if (isMouse() && !blocked) act.append(hint(mouse.locked ? 'Click to start. Esc lets the mouse go.' : 'The range captures your mouse. Esc lets it go.'));
    else if (!noPad && !blocked) act.append(hint('or press A / ✕'));
  } else if (P === 'pick') {
    const row = document.createElement('div');
    row.className = 'rate';
    ['A', 'B', 'C'].forEach((n, k) => {
      const b = button(`${n} felt like my game`, '', () => curvePicked(k));
      if (!noPad) { const small = document.createElement('small'); small.textContent = ['D-pad ←', 'D-pad ↑', 'D-pad →'][k]; b.append(small); }
      row.append(b);
    });
    const none = button('None of them', 'small', () => curvePicked(null));
    if (!noPad) { const small = document.createElement('small'); small.textContent = 'L1'; none.append(small); }
    row.append(none);
    const again = document.createElement('div');
    again.className = 'rate';
    ['A', 'B', 'C'].forEach((n, k) => again.append(button(`Play ${n} again`, 'small', () => curveReplay(k))));
    act.append(row, again);
  } else if (P === 'rate') {
    const row = document.createElement('div');
    row.className = 'rate';
    for (const r of RATINGS) {
      const b = button(r.label, '', () => rate(r.v));
      if (!noPad) { const small = document.createElement('small'); small.textContent = r.glyph; b.append(small); }
      row.append(b);
    }
    row.append(button('Skip', 'small', () => { seg().data = null; advance(); }));
    act.append(row);
  } else {
    if (P === 'run' && s.kind === 'drift' && s.data.part !== 'rest') act.append(button('Skip this part', 'small', () => nextStickPart(s.data)));
    if (mousePaused(P)) act.append(button('Resume', 'primary', () => mouse.lock()));
    if (P === 'run' && s.kind === 'mcheck') act.append(button('Skip the rest', 'small', () => finishMouseCheck(s.data)));
    act.append(button('Stop', 'small', stop));
  }
}
function button(label, cls, fn) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = ('btn ' + cls).trim(); b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}
function hint(t) { const s = document.createElement('span'); s.className = 'hint'; s.textContent = t; return s; }

/* ---------- results ---------- */

const signed = d => (d >= 0 ? '+' : '−') + Math.abs(Math.round(d * 100)) + '%';
const feelLabel = v => v == null ? 'skipped' : RATINGS[clamp(Math.round(v), -2, 2) + 2].label;
const likely = (d, p) => {
  const q = d >= 0 ? p : 1 - p;
  return `${q >= 0.995 ? 'Over 99%' : pct(q)} chance it is real`;
};

function verifyBlock(v) {
  const c = v.cmp;
  if (!c) {
    return `<div class="verdict"><h3>Not enough data to compare</h3><p>Some rounds were too short to score. Run the blind test again.</p></div>`;
  }
  const head = { better: 'The new settings did better', worse: 'Your old settings did better', close: 'Too close to call' }[c.verdict];
  const p = c.overall.p;
  const body = {
    better: `${pct(p)} likely the new settings are better for you, based on ${v.targets} targets and ${v.seconds} seconds of tracking. Go with them.`,
    worse: `${pct(1 - p)} likely your old settings suit you better, based on ${v.targets} targets and ${v.seconds} seconds of tracking. Keep them. If your stick drifts, still take the deadzone change.`,
    close: `Four short rounds can only pick out a clear difference, about 15% or more, and this wasn't one. Either works, so go with whichever felt better.`
  }[c.verdict];
  return `<div class="verdict ${c.verdict}">
    <div style="display:grid;gap:4px"><p class="eyebrow">Blind test result</p><h3>${head}</h3><p>${body}</p></div>
    <div class="vgrid">
      <div class="vcell"><span>Flick throughput</span><b>${signed(c.flick.delta)}</b><small>${likely(c.flick.delta, c.flick.p)}</small></div>
      <div class="vcell"><span>Tracking accuracy</span><b>${signed(c.track.delta)}</b><small>${likely(c.track.delta, c.track.p)}</small></div>
      <div class="vcell"><span>How it felt</span><b style="font-size:16px">Old: ${feelLabel(v.feelA)}<br>New: ${feelLabel(v.feelB)}</b><small>Your ratings</small></div>
    </div>
  </div>`;
}

function deepBlock(d, g, c) {
  const res = d.res;
  if (!res) return `<div class="verdict"><h3>Not enough data to fit</h3><p>Some rounds were too short to score. Run Deep mode again.</p></div>`;
  const head = { matters: 'Sensitivity matters for you', flat: 'Sensitivity barely matters for you', unclear: 'No clear best speed yet' }[res.verdict];
  const warm = res.warmup > 0.05
    ? `<p class="fine">You improved about ${pct(res.warmup)} from the first round to the last. The fit allows for that warm-up, so later rounds don't score higher just for coming later.</p>`
    : '';
  const more = d.canMore ? `<div class="offer"><p>${res.verdict === 'unclear' ? 'Not sure yet? ' : ''}Play ${MORE} more rounds at and around your best guess (about 2 minutes). Every round so far still counts, so the answer only gets sharper. Your rounds are also saved, so a Deep run another day can add to them, which is even better.</p><button class="btn${res.verdict === 'unclear' ? ' primary' : ''}" id="deep-more" type="button">Play ${MORE} more rounds</button></div>` : '';
  const goal = deepGoal(res.points.length, d.sittings || 1);
  const rows = res.points.map((p, i) => `<tr><td class="num">${p.round}</td><td class="num">${p.sens}${p.sens === c.sens ? ' (current)' : ''}</td><td class="num">${Math.round(p.y / res.top * 100)}%</td><td>${feelLabel(d.rounds[i].rating)}</td></tr>`).join('');
  return `<div class="verdict ${res.verdict === 'matters' ? 'better' : ''}">
    <div style="display:grid;gap:4px"><p class="eyebrow">${d.full ? 'Full dial-in' : 'Deep search'} · ${res.points.length} rounds${d.prior ? ` (${d.prior} from earlier sittings)` : ''}</p><h3>${head}</h3>
      <p>Each dot is one round's score at that sensitivity. The line is the fitted trend, and the shaded band is the range that scores within the noise of your best.</p></div>
    ${goal}
    ${deepChart(res, c, g, d)}
    ${warm}
    ${screenTable(d.screen, g)}
    <div class="table-wrap"><table><thead><tr><th>Round</th><th>${g.sens.label}</th><th>Score vs best</th><th>Felt</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${more}
  </div>`;
}

// Round count goal. In simulated players the best-speed range keeps narrowing to about 20 rounds and
// barely moves after that; 15 is the least to trust it.
const DEEP_GOAL = { min: 15, solid: 20 };
function deepGoal(n, sittings) {
  const left = Math.max(0, DEEP_GOAL.solid - n);
  const head = n >= DEEP_GOAL.solid ? 'Goal reached' : n >= DEEP_GOAL.min ? `Solid enough · ${left} more for the goal` : `${left} more rounds to the goal`;
  const why = n >= DEEP_GOAL.solid
    ? 'More rounds now change the answer very little. If it still says unclear, sensitivity likely just isn\'t what limits your aim.'
    : n >= DEEP_GOAL.min
      ? `${DEEP_GOAL.min} rounds is enough to trust the best speed; ${DEEP_GOAL.solid} narrows the range a little more.`
      : `The best guess is usually close after the first search, but the range around it keeps narrowing up to about ${DEEP_GOAL.solid} rounds. ${DEEP_GOAL.min} is the least to trust it.`;
  const days = sittings > 1
    ? `This answer pools ${sittings} sittings, which is the best way to get there.`
    : 'Best spread over two or three days rather than one long sitting: you play fresher, late rounds aren\'t dragged down by tiredness, and each day is scored against its own level, so the answer reflects how you play on any day, not just today. Run Deep again another day and keep "Add to my earlier search" ticked.';
  const pct = v => Math.min(100, v / DEEP_GOAL.solid * 100).toFixed(1);
  return `<div class="goal">
    <div class="goal-head"><b>${Math.min(n, 99)} of ${DEEP_GOAL.solid} rounds</b><span>${head}</span></div>
    <div class="goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${DEEP_GOAL.solid}" aria-valuenow="${Math.min(n, DEEP_GOAL.solid)}" aria-label="Rounds toward the goal">
      <i style="width:${pct(n)}%"></i><em style="left:${pct(DEEP_GOAL.min)}%" title="${DEEP_GOAL.min} rounds: enough to trust"></em>
    </div>
    <p class="fine">${why} ${days}</p>
  </div>`;
}

function screenTable(sc, g) {
  if (!sc || (!sc.curve && !sc.vert)) return '';
  const verdictText = x => x.verdict === 'close' ? 'Too close to tell'
    : `${x.verdict === 'better' ? x.b : x.a} by about ${pct(Math.abs(x.delta))} (${pct(x.p >= 0.5 ? x.p : 1 - x.p)} likely)`;
  const rows = [
    sc.curve ? [g.curve.label, `${sc.curve.a} vs ${sc.curve.b}`, verdictText(sc.curve)] : null,
    sc.vert ? [g.vsens ? g.vsens.label : 'Vertical speed', `${sc.vert.a} vs ${sc.vert.b}`, verdictText(sc.vert)] : null
  ].filter(Boolean);
  return `<div style="display:grid;gap:8px"><h3 class="sub">Tested blind at your best speed</h3>
    <div class="table-wrap"><table><thead><tr><th>Setting</th><th>Compared</th><th>Winner</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table></div>
    <p class="fine">Four rounds can only pick out a clear difference, about 15% or more. Smaller ones read as too close to tell.</p></div>`;
}

function deepChart(res, c, g, d = {}) {
  const W = 600, H = 250, L = 46, R = 16, T = 22, B = 40;
  const pad = Math.max(0.08, (res.hi - res.lo) * 0.06);
  const x0 = res.lo - pad, x1 = res.hi + pad;
  const vals = res.points.map(p => p.y / res.top * 100).concat(res.curve.map(p => p.y / res.top * 100), [100]);
  // Round gridline steps (5, 10, 20, 25 or 50 points) so the axis reads cleanly.
  const lo = Math.min(...vals) - 3, hi = Math.max(...vals) + 3;
  const step = [5, 10, 20, 25, 50].find(st => (Math.ceil(hi / st) - Math.floor(lo / st)) <= 5) || 100;
  const y0 = Math.floor(lo / step) * step, y1 = Math.ceil(hi / step) * step;
  const sx = x => L + (x - x0) / (x1 - x0) * (W - L - R);
  const sy = v => T + (y1 - v) / (y1 - y0) * (H - T - B);
  let out = '';
  for (let v = y0; v <= y1; v += step) {
    const y = sy(v).toFixed(1);
    out += `<line class="c-grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="c-axis" x="${L - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${Math.round(v)}%</text>`;
  }
  const bx0 = sx(clamp(res.range[0].x, x0, x1)), bx1 = sx(clamp(res.range[1].x, x0, x1));
  out += `<rect class="c-band" x="${bx0.toFixed(1)}" y="${T}" width="${Math.max(2, bx1 - bx0).toFixed(1)}" height="${H - T - B}"/>`;
  const marker = (x, label, cls) => `<line class="${cls}" x1="${sx(x).toFixed(1)}" x2="${sx(x).toFixed(1)}" y1="${T}" y2="${H - B}"/><text class="c-axis" x="${sx(x).toFixed(1)}" y="${T - 8}" text-anchor="middle">${label}</text>`;
  const bestFar = Math.abs(sx(res.best.x) - sx(0)) > 46;
  out += marker(0, 'Current', 'c-mark');
  if (res.verdict !== 'flat' && bestFar) out += marker(res.best.x, 'Best', 'c-best');
  // Where the speed ratings cross from slow to fast, when they give one and it isn't on top of another marker.
  const feel = d.feel;
  if (feel && feel.x >= x0 && feel.x <= x1 && Math.abs(sx(feel.x) - sx(0)) > 46 && (res.verdict === 'flat' || !bestFar || Math.abs(sx(feel.x) - sx(res.best.x)) > 46)) out += marker(feel.x, 'Feels right', 'c-feel');
  out += `<path class="c-fit" d="${res.curve.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y / res.top * 100).toFixed(1)}`).join('')}"/>`;
  // Setting labels under the tested speeds, skipping any that would collide.
  const ticks = [...new Map(res.points.map(p => [p.sens, p.x])).entries()].sort((a, b) => a[1] - b[1]);
  let lastX = -Infinity;
  for (const [sens, x] of ticks) {
    const px = sx(x);
    if (px - lastX < 34) continue;
    lastX = px;
    out += `<text class="c-axis" x="${px.toFixed(1)}" y="${H - B + 18}" text-anchor="middle">${sens}</text>`;
  }
  out += `<text class="c-axis" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">${g.sens.label}</text>`;
  for (const p of res.points) {
    const cx = sx(p.x).toFixed(1), cy = sy(p.y / res.top * 100).toFixed(1);
    out += `<circle class="c-dot" cx="${cx}" cy="${cy}" r="5"/>`;
    out += `<circle class="c-hit" cx="${cx}" cy="${cy}" r="14" tabindex="0" data-tip="Round ${p.round} · ${p.sens} · ${Math.round(p.y / res.top * 100)}% of best"/>`;
  }
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Round scores by sensitivity with fitted trend">${out}</svg><div class="chart-tip" hidden></div></div>
    <div class="chart-key"><span><i class="k-dot"></i>Round score</span><span><i class="k-line"></i>Fitted trend</span><span><i class="k-band"></i>Best range</span></div>`;
}

function wireChart() {
  const wrap = document.querySelector('#p-results .chart');
  if (!wrap) return;
  const tip = wrap.querySelector('.chart-tip');
  const showTip = e => {
    const a = wrap.getBoundingClientRect(), b = e.target.getBoundingClientRect();
    tip.textContent = e.target.dataset.tip;
    tip.style.left = (b.left + b.width / 2 - a.left) + 'px';
    tip.style.top = (b.top + b.height / 2 - a.top) + 'px';
    tip.hidden = false;
  };
  const hideTip = () => { tip.hidden = true; };
  wrap.querySelectorAll('.c-hit').forEach(el => {
    el.addEventListener('pointerenter', showTip); el.addEventListener('focus', showTip);
    el.addEventListener('pointerleave', hideTip); el.addEventListener('blur', hideTip);
  });
}

// Relative vertical change for games without their own vertical setting.
const vRel = m => Math.abs(m - 1) < 0.01 ? 'Same' : `${m > 1 ? '+' : '−'}${Math.round(Math.abs(m - 1) * 100)}%`;

const TURN_WORD = { more: 'More', less: 'Less', sooner: 'More', keep: 'Same' };
// Look boost rows: the game's own boost and ramp-up settings, or one generic row.
function turnRows(g, c, t) {
  if (!t || !t.measured) return '';
  const tagOf = (a, b) => a > b ? '<span class="tag up">Higher</span>' : a < b ? '<span class="tag down">Lower</span>' : '<span class="tag">Keep</span>';
  const row = (title, cur, next, tg, why) =>
    `<div class="rec"><h3>${title}${tg}</h3><div class="val"><s>${cur}</s><b>${next}</b></div><p>${why}</p></div>`;
  const bs = g.boost && g.boost.setting;
  if (!bs) {
    const tg = (t.verdict === 'keep' ? '<span class="tag">Keep</span>' : '<span class="tag up">Change</span>') + '<span class="tag">If your game has it</span>';
    return row('Turn boost / extra turn speed', 'Now', TURN_WORD[t.verdict], tg, t.why);
  }
  const rs = g.boost.rampSetting;
  const sooner = t.verdict === 'sooner';
  return row(bs.label, c.boost, t.boost, tagOf(t.boost, c.boost), sooner ? 'Leave the amount. The ramp-up time is what holds it back, see below.' : t.why) +
    row(rs.label, c.boostRamp.toFixed(1) + ' s', t.ramp.toFixed(1) + ' s', tagOf(t.ramp, c.boostRamp), sooner ? t.why : 'The drill found no reason to change it.');
}

// What the mouse check found, as information rows under the sensitivity.
function mouseRows(m, dpi, c) {
  const info = (title, val, tg, why) => `<div class="rec"><h3>${title}${tg}</h3><div class="val"><b>${val}</b></div><p>${why}</p></div>`;
  const out = [];
  if (dpi.verdict === 'entered') out.push(info('Mouse DPI', c.dpi, '<span class="tag">Not measured</span>', 'Taken from setup. Run the mouse check to confirm it: a wrong DPI throws every cm/360 figure off by the same factor.'));
  else if (dpi.verdict === 'match') out.push(info('Mouse DPI', c.dpi, '<span class="tag">Checked</span>', `The card swipes measured about ${Math.round(dpi.dpiSeen)} DPI, which matches the ${c.dpi} you entered.`));
  else if (dpi.verdict === 'scaled') out.push(info('Mouse DPI', c.dpi, '<span class="tag">Checked</span>', `The browser shrinks mouse movement by your display scale (${Math.round((window.devicePixelRatio || 1) * 100)}%), so it saw about ${Math.round(dpi.dpiSeen)} DPI. Games read the mouse directly, so the range corrected for it.`));
  else out.push(info('Mouse DPI', Math.round(dpi.dpiSeen), '<span class="tag up">Check</span>', `The card swipes measured about ${Math.round(dpi.dpiSeen)} DPI, not the ${c.dpi} you entered, so the range used the measurement. Check the DPI in your mouse software; if it really is ${c.dpi}, run the mouse check again more carefully.`));
  if (m && m.raw === false) {
    out.push(m.accel != null && m.accel > 1.08
      ? info('Pointer acceleration', 'On', '<span class="tag up">Turn off</span>', `Your fast swipe went ${pct(m.accel - 1)} further than the slow ones, so movement is being accelerated. In Windows, untick Enhance pointer precision (Mouse settings, Additional mouse options, Pointer Options), and turn on raw input in your game if it has the option.`)
      : info('Pointer acceleration', 'Not seen', '<span class="tag">Keep</span>', 'This browser could not read the mouse raw, but fast and slow swipes covered the same distance, so acceleration looks off.'));
  } else if (m && m.raw) out.push(info('Raw input', 'Yes', '<span class="tag">Checked</span>', 'The range read your mouse raw, without Windows pointer speed or acceleration, the way games with raw input do.'));
  if (m && m.hz) out.push(info('Report rate', `${m.hz} Hz`, m.hz < 500 ? '<span class="tag up">Raise</span>' : '<span class="tag">Keep</span>',
    m.hz < 500 ? 'Your mouse reports fewer than 500 times a second (or the browser is dropping reports). If your mouse software offers 1000 Hz, use it: smoother tracking with no downside.' : 'Plenty for smooth aim. Browsers can deliver fewer reports than the mouse sends, so the real rate may be higher.'));
  return out.join('');
}

function renderResults() {
  const { cfg: c, stats: s, rec: r, verify: v } = result;
  const g = GAMES[c.game];
  const mouseGame = g.device === 'mouse';
  const dpi = mouseGame ? calibrate() : null;
  const cmOf = x => cm360(g, x, dpi.cpcmBrowser).toFixed(1);
  const tag = (a, b) => a > b ? '<span class="tag up">Higher</span>' : a < b ? '<span class="tag down">Lower</span>' : '<span class="tag">Keep</span>';
  const curveTag = r.curve === c.curve ? '<span class="tag">Keep</span>' : '<span class="tag up">Change</span>';
  const row = (title, cur, next, t, why) =>
    `<div class="rec"><h3>${title}${t}</h3><div class="val"><s>${cur}</s><b>${next}</b></div><p>${why}</p></div>`;
  const lines = [
    ['Flick throughput', s.throughput == null ? '–' : s.throughput.toFixed(2) + ' bits/s'],
    ['Flick hits', pct(s.hitRate)],
    ['Average time to hit', s.avgTime == null ? '–' : s.avgTime.toFixed(2) + ' s'],
    ['Overshot', pct(s.over)],
    ['Stopped short', pct(s.under)],
    ['Overshot, up and down only', s.overV == null ? '–' : pct(s.overV)],
    ['Stopped short, up and down only', s.underV == null ? '–' : pct(s.underV)],
    ['Average tracking error', s.trackErr == null ? '–' : s.trackErr.toFixed(1) + '°'],
    ['On target while tracking', pct(s.onTarget)],
    ['Trailing the target', pct(s.behind)],
    ['Ahead of the target', pct(s.ahead)],
    ['Extra corrections', s.jitter.toFixed(1) + '/s'],
    ...(r.turn && r.turn.stats ? [
      ['Big turn time, per 180°', r.turn.stats.per180 == null ? '–' : r.turn.stats.per180.toFixed(2) + ' s'],
      ['Full stick during big turns', pct(r.turn.stats.fullShare)],
      ['Blew past the target on big turns', pct(r.turn.stats.over)]
    ] : []),
    ...(r.ads || []).filter(a => a.stats).flatMap(a => [
      [`Flick throughput, zoomed ${a.spec.zoom}×`, a.stats.throughput == null ? '–' : a.stats.throughput.toFixed(2) + ' bits/s'],
      [`Average tracking error, zoomed ${a.spec.zoom}×`, a.stats.trackErr == null ? '–' : a.stats.trackErr.toFixed(2) + '°']
    ])
  ];
  const deepHtml = result.deep ? deepBlock({ ...result.deep, canMore: !!result.deepState }, g, c) : '';
  const hw = hardwareRecs(result.drift, g);
  let verifyHtml;
  const ds = duelSettings(c, r);
  const duelHtml = result.duel && result.duel.cmp
    ? `<div class="offer"><p>Settings duel: ${{ better: 'the new settings won', worse: 'your old settings won', close: 'too close to call' }[result.duel.cmp.verdict]} (${signed(result.duel.scoreDelta)} on the same targets).</p><button class="btn" id="duel" type="button">Duel again</button></div>`
    : ds.differs ? `<div class="offer"><p>Settings duel: your old settings against these on identical challenge targets. ${DUEL.runs} runs of ${DUEL.seconds} seconds, about 2½ minutes.</p><button class="btn" id="duel" type="button">Start settings duel</button></div>` : '';
  if (v) verifyHtml = verifyBlock(v);
  else if (settingsChanged(c, r)) verifyHtml = `<div class="offer"><p>Not sure about these? Run a blind test of your old hip-fire settings against the new ones. About 2 minutes.</p><button class="btn primary" id="verify" type="button">Verify these settings</button></div>`;
  else verifyHtml = `<div class="offer"><p>Your current settings already fit, so there is nothing to verify.</p></div>`;
  const sourceNote = g.source === 'guides'
    ? ` ${g.name} menu names come from player guides and have not been checked against the game yet.`
    : '';

  $('#p-results').innerHTML = `
    <div style="display:grid;gap:6px">
      <p class="eyebrow">${gameTitle(g)} · ${PLAYSTYLES[c.style].label}${mouseGame ? ' · mouse' : ''}${g.camera === 'third' ? ' · third person' : ''}</p>
      <h2>Your settings for ${g.name}</h2>
      <p class="lede">Set these in your game's ${mouseGame ? 'mouse' : 'controller'} settings, then play a private match or two before you judge them.${mouseGame ? '' : ` Tested with aim assist ${AA_ON_OFF.has(c.game) ? ((c.aa ?? 1) ? 'on' : 'off') : ({ 0: 'off', 0.6: 'on (low)', 1: 'on (medium)', 1.4: 'on (high)' })[c.aa ?? 1]}, like your game.`}${mouseGame && !g.yaw ? ` ${g.name === 'your game' ? 'This game' : g.name} has no published conversion, so the cm/360 figures scale from the ${c.cm0} cm you measured.` : ''}</p>
    </div>
    <div class="recs">
      ${mouseGame
        ? row(g.sens.label, `${c.sens} <small>${cmOf(c.sens)} cm/360</small>`, `${r.sens} <small>${cmOf(r.sens)} cm/360</small>`, tag(r.sens, c.sens), r.sensWhy) + mouseRows(result.mouse, dpi, c)
        : row(g.sens.label, c.sens, r.sens, tag(r.sens, c.sens), r.sensWhy)}
      ${mouseGame ? '' : g.vsens
        ? row(g.vsens.label, c.vsens, r.vsens, tag(r.vsens, c.vsens), r.vWhy)
        : row('Vertical sensitivity', 'Now', vRel(r.vmult), tag(Math.round(r.vmult * 100), 100) + '<span class="tag">If your game has it</span>', r.vWhy)}
      ${mouseGame ? '' : recoilRow(g, c, r, row)}
      ${(r.ads || []).map(a => a.spec.generic
        ? row('ADS sensitivity', 'Now', vRel(a.rel), tag(Math.round(a.rel * 100), 100) + '<span class="tag">If your game has it</span>', a.why)
        : row(a.spec.label, fmtAds(a.spec, a.cur), fmtAds(a.spec, a.next), tag(a.next, a.cur), a.why)).join('')}
      ${mouseGame ? '' : row(g.curve.label, g.curve[c.curve], g.curve[r.curve], curveTag, r.curveWhy)}
      ${mouseGame ? '' : row(g.dz.label, g.dz.fmt(c.dz), g.dz.fmt(r.dz), r.dzMeasured ? tag(r.dz, c.dz) : '<span class="tag">Not measured</span>', r.dzWhy)}
      ${hw.map(h => row(h.st.label, h.st.fmt(h.cur), h.st.fmt(h.next),
        (h.st.fmt(h.next) === h.st.fmt(h.cur) ? '<span class="tag">Keep</span>' : '<span class="tag up">Change</span>') + (h.st.known ? '' : '<span class="tag">If your game has it</span>'),
        h.why)).join('')}
      ${turnRows(g, c, r.turn)}
    </div>
    ${deepHtml}
    ${verifyHtml}
    ${duelHtml}
    <div style="display:grid;gap:10px">
      <h3 class="sub">What the tests measured</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Measure</th><th>${result.deep ? 'Rounds at your current speed' : 'At your current settings'}</th></tr></thead>
        <tbody>${lines.map(([label, val]) => `<tr><td>${label}</td><td class="num">${val}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="actions">
      <button class="btn" id="copy" type="button">Copy settings</button>
      <button class="btn" id="export" type="button">Copy test data</button>
      <button class="btn primary" id="use-recs" type="button">Use these settings</button>
      <button class="btn" id="restart" type="button">Start over</button>
    </div>
    <pre id="copytext" hidden></pre>
    <p class="fine">Prototype. ${mouseGame ? 'Mouse turns use each game\'s published degrees per count (or your own cm/360), so they match the game closely; how a target feels to hit still differs from a real match.' : 'Turn speeds come from a simplified model of each game, so treat these numbers as a close starting point rather than an exact match.'}${sourceNote} Flick throughput combines speed and accuracy into one score (higher is better). Copy test data puts every measurement from this run on your clipboard, to paste back for tuning.</p>`;

  const du = $('#duel');
  if (du) du.addEventListener('click', startDuel);
  const dm = $('#deep-more');
  if (dm) dm.addEventListener('click', deepMore);
  const vb = $('#verify');
  if (vb) vb.addEventListener('click', () => start(verifySegments(c, r), result.drift));
  wireChart();
  $('#use-recs').addEventListener('click', e => {
    useRecs(c, r);
    e.currentTarget.textContent = 'Saved to setup';
    e.currentTarget.disabled = true;
  });
  $('#restart').addEventListener('click', () => { result = null; session = null; syncSetup(); show('setup'); });
  $('#export').addEventListener('click', e => {
    const data = buildExport({ cfg: c, drift: result.drift, rec: r, segs: result.segs || [], pad: result.pad, deep: result.deep, verify: v });
    copyText(JSON.stringify(data), e.currentTarget);
  });
  $('#copy').addEventListener('click', e => {
    const text = mouseGame ? [`Dialed In, ${g.name} (${PLAYSTYLES[c.style].label}, mouse)`,
      `${g.sens.label}: ${r.sens} (${cmOf(r.sens)} cm/360 at ${dpi.verdict === 'wrong' ? Math.round(dpi.dpiSeen) : c.dpi} DPI)`].join('\n') : [`Dialed In, ${g.name} (${PLAYSTYLES[c.style].label})`,
      `${g.sens.label}: ${r.sens}`, g.vsens ? `${g.vsens.label}: ${r.vsens}` : `Vertical sensitivity: ${vRel(r.vmult)}`, `${g.dz.label}: ${g.dz.fmt(r.dz)}`, `${g.curve.label}: ${g.curve[r.curve]}`,
      ...(r.ads || []).map(a => a.spec.generic ? `ADS sensitivity: ${vRel(a.rel)}` : `${a.spec.label}: ${fmtAds(a.spec, a.next)}`),
      ...(r.turn && r.turn.boost != null ? [`${g.boost.setting.label}: ${r.turn.boost}`, `${g.boost.rampSetting.label}: ${r.turn.ramp.toFixed(1)}`] : []),
      ...hw.map(h => `${h.st.label}: ${h.st.fmt(h.next)}`)].join('\n');
    copyText(text, e.currentTarget);
  });
}

// Donations: a button after results (never during a test) and in the footer opens Ko-fi's own
// donation panel in a dialog, so nobody leaves the page. The panel loads only when opened.
const TIP_URL = 'https://ko-fi.com/dialedinaim';
const TIP_EMBED = TIP_URL + '/?hidefeed=true&widget=true&embed=true&preview=true';
function openTip() {
  const dlg = $('#tip-dialog'), frame = $('#tip-frame');
  if (!frame.src) frame.src = TIP_EMBED;
  if (dlg.showModal) dlg.showModal(); else window.open(TIP_URL, '_blank', 'noopener');
}
document.addEventListener('click', e => { if (e.target.closest('.tip-open')) openTip(); });
$('#tip-close').addEventListener('click', () => $('#tip-dialog').close());
$('#tip-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// Copies to the clipboard, or shows the text to select by hand when the browser refuses.
function copyText(text, btn) {
  const pre = $('#copytext');
  pre.textContent = text;
  const fallback = () => { pre.hidden = false; btn.textContent = 'Select the text below'; };
  try { navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied'; }, fallback); }
  catch (err) { fallback(); }
}

/* ---------- setup form ---------- */

// One input per ADS multiplier the game's menu has, in the menu's own units.
function renderAdsFields(g) {
  const box = $('#ads-fields');
  box.textContent = '';
  const fields = [...(g.ads || []).map(sp => ({ sp, id: 'ads-' + sp.key, pctUnit: sp.unit === '%', value: cfg.ads[sp.key] }))];
  if (g.boost && g.boost.setting) {
    fields.push({ sp: g.boost.setting, id: 'boost', value: cfg.boost, plain: true });
    fields.push({ sp: g.boost.rampSetting, id: 'boost-ramp', value: cfg.boostRamp, plain: true, unitLabel: ' (seconds)' });
    if (g.boost.delaySetting) fields.push({ sp: g.boost.delaySetting, id: 'boost-delay', value: cfg.boostDelay, plain: true, unitLabel: ' (seconds)' });
  }
  for (const { sp, id, pctUnit, value, plain, unitLabel } of fields) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = `${sp.label}${pctUnit ? ' (%)' : unitLabel || ''}`;
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', id, inputMode: 'decimal',
      min: pctUnit ? sp.min * 100 : sp.min, max: pctUnit ? sp.max * 100 : sp.max, step: pctUnit ? Math.round(sp.step * 100) : sp.step,
      value: pctUnit ? Math.round(value * 100) : plain ? value : value.toFixed(2) });
    const small = document.createElement('small');
    small.textContent = sp.defKnown === false || plain
      ? 'Enter the value from your controller menu.'
      : `${fmtAds(sp, sp.min)} to ${fmtAds(sp, sp.max)}. Default is ${fmtAds(sp, sp.def)}.`;
    wrap.append(label, input, small);
    box.append(wrap);
  }
}

// Controller games and mouse games share ids where the game is the same (arc / m-arc).
const PAD_LIST = ['arc', 'cod', 'cod-mw', 'fortnite', 'fortnite-adv', 'apex', 'apex-alc', 'other'];
const MOUSE_LIST = ['m-arc', 'm-cs2', 'm-valorant', 'm-apex', 'm-cod', 'm-ow2', 'm-fortnite', 'm-other'];
function fillGames() {
  const sel = $('#game'), ids = isMouse() ? MOUSE_LIST : PAD_LIST;
  if (sel.dataset.device === cfg.device) return;
  sel.dataset.device = cfg.device;
  sel.textContent = '';
  for (const id of ids) {
    const o = document.createElement('option');
    o.value = id; o.textContent = GAMES[id].name === 'your game' ? 'Another game' : gameTitle(GAMES[id]);
    sel.append(o);
  }
}
// Aim assist choices per game, as its menu offers them. On = the profile's estimated strength.
const AA_ON_OFF = new Set(['arc', 'apex', 'apex-alc']);
const aaOptions = g => AA_ON_OFF.has(Object.keys(GAMES).find(k => GAMES[k] === g))
  ? [[0, 'Off'], [1, 'On']]
  : [[0, 'Off'], [0.6, 'Low'], [1, 'Medium'], [1.4, 'High']];

// Picks a game: its defaults, then whatever this browser saved for it last time (unless useSaved is false).
function setGame(id, useSaved = true) {
  cfg.game = id;
  const g = game();
  cfg.sens = g.sens.def;
  cfg.vsens = g.vsens ? g.vsens.def : undefined;
  cfg.fov = g.fov.def;
  cfg.ads = adsDefaults(g);
  Object.assign(cfg, boostDefaults(g));
  cfg.curve = g.curve.def; cfg.dz = g.dz.def;
  cfg.spin = null; cfg.kTurn = 1; // a spin timing belongs to one game
  cfg.aa = 1;
  cfg.curveK = null; cfg.curveChecked = false; // a curve match belongs to one game
  if (useSaved) applySaved(g, (loadSaved().games || {})[id]);
}

/* saved settings: kept in this browser only, one set per game plus the last device, game and choices */

const SAVE_KEY = 'dialed-in:setup';
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch (e) { return {}; }
}
function saveSetup() {
  const s = loadSaved();
  s.last = { device: cfg.device, game: cfg.game, style: cfg.style, mode: cfg.mode, dpi: cfg.dpi, cm0: cfg.cm0 };
  s.games = s.games || {};
  s.games[cfg.game] = { sens: cfg.sens, vsens: cfg.vsens, fov: cfg.fov, curve: cfg.curve, dz: cfg.dz, aa: cfg.aa,
    spin: cfg.spin, ads: cfg.ads, boost: cfg.boost, boostRamp: cfg.boostRamp, boostDelay: cfg.boostDelay, curveK: cfg.curveK, curveChecked: !!cfg.curveChecked, ...(cfg.game === 'cod' ? { scale: 2 } : {}) };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (e) { /* storage blocked: settings just aren't remembered */ }
}
// A value on the menu's own steps (ARC's sensitivity sliders move in 5s), within its range.
function snapTo(x, sp) {
  const dec = (String(sp.step).split('.')[1] || '').length;
  return clamp(+(Math.round(x / sp.step) * sp.step).toFixed(dec), sp.min, sp.max);
}
// Saved values are only taken when they still fit the game's menu, so an old save can't break setup.
function applySaved(g, v) {
  if (!v) return;
  const inRange = (x, sp) => typeof x === 'number' && sp && x >= sp.min && x <= sp.max;
  // Call of Duty moved from 1-20 to 0.10-4.00; settings saved on the old scale are converted.
  if (g === GAMES.cod && v.scale !== 2) { if (typeof v.sens === 'number') v.sens = codFromOld(v.sens); if (typeof v.vsens === 'number') v.vsens = codFromOld(v.vsens); }
  if (inRange(v.sens, g.sens)) cfg.sens = snapTo(v.sens, g.sens);
  if (g.vsens && inRange(v.vsens, g.vsens)) cfg.vsens = snapTo(v.vsens, g.vsens);
  if (!g.fov.fixed && inRange(v.fov, g.fov)) cfg.fov = v.fov;
  if (['linear', 'mid', 'expo'].includes(v.curve)) cfg.curve = v.curve;
  if (typeof v.dz === 'number' && v.dz >= 0 && v.dz <= 0.3) cfg.dz = v.dz;
  if (aaOptions(g).some(([x]) => x === v.aa)) cfg.aa = v.aa;
  if (typeof v.spin === 'number' && v.spin >= 1 && v.spin <= 60) { cfg.spin = v.spin; cfg.kTurn = spinK(g, cfg.sens, cfg.spin); }
  for (const sp of adsSpecs(g)) if (v.ads && inRange(v.ads[sp.key], sp)) cfg.ads[sp.key] = sp.step ? snapTo(v.ads[sp.key], sp) : v.ads[sp.key];
  const bs = g.boost && g.boost.setting;
  if (bs && inRange(v.boost, bs)) cfg.boost = v.boost;
  if (bs && inRange(v.boostRamp, g.boost.rampSetting)) cfg.boostRamp = v.boostRamp;
  if (bs && g.boost.delaySetting && inRange(v.boostDelay, g.boost.delaySetting)) cfg.boostDelay = v.boostDelay;
  if (g.device !== 'mouse' && inRange(v.curveK, CURVE_K)) cfg.curveK = v.curveK;
  cfg.curveChecked = !!v.curveChecked;
}
function restoreSetup() {
  const last = loadSaved().last;
  if (!last || !GAMES[last.game]) return;
  cfg.device = GAMES[last.game].device === 'mouse' ? 'mouse' : 'pad';
  setGame(last.game);
  if (PLAYSTYLES[last.style]) cfg.style = last.style;
  if (['quick', 'verify', 'deep'].includes(last.mode) || (last.mode === 'full' && FULL_OPEN)) cfg.mode = last.mode;
  if (last.dpi >= 100 && last.dpi <= 32000) cfg.dpi = last.dpi;
  if (last.cm0 >= 5 && last.cm0 <= 200) cfg.cm0 = last.cm0;
}

function syncSetup() {
  fillGames();
  const g = game();
  const mouseGame = g.device === 'mouse';
  $('#dpi-field').hidden = !mouseGame;
  $('#cm0-field').hidden = !mouseGame || !!g.yaw;
  if (mouseGame) {
    $('#dpi').value = cfg.dpi;
    $('#cm0').value = cfg.cm0;
    $('#cm0-help').textContent = `${g.name === 'your game' ? 'This game' : g.name} has no published sensitivity conversion, so measure it once: in the game, note where your mouse sits, turn exactly one full circle, and measure how far the mouse moved. A sensitivity calculator's cm/360 works too.`;
  }
  $('#mode-deep').parentElement.querySelector('span').textContent = mouseGame
    ? 'Hidden rounds at different sensitivities find your best speed, and how much it matters for you'
    : 'Hidden rounds find your best speed, then test curve and vertical speed blind to see which settings matter for you';
  $('#dpi-measure').textContent = mouseCheck && mouseCheck.cpcm ? 'Measure again' : 'Measure my DPI';
  // Controller menu settings the range plays with: curve, deadzone, and the optional measured turn speed.
  for (const id of ['#curve-field', '#aa-field', '#dz-field', '#spin-field', '#curvefeel-field', '#recoil-field']) $(id).hidden = mouseGame;
  const rr = recoilResult && recoilResult.game === cfg.game ? recoilResult : null;
  $('#recoil-status').textContent = !rr ? 'Not checked' : rr.rec.verdict === 'keep' ? 'Checked: keep your vertical speed' : `Checked: ${rr.rec.verdict} vertical speed`;
  $('#recoil-result').hidden = !rr;
  $('#recoil-result').textContent = rr ? recoilText(rr) : '';
  $('#recoil-use').hidden = !(rr && rr.rec.vsens != null && rr.rec.vsens !== cfg.vsens);
  if (rr && rr.rec.vsens != null) $('#recoil-use').textContent = `Use ${rr.rec.vsens}`;
  const ck = cfg.curveK || 1;
  $('#curvefeel-status').textContent = ck === 1 ? (cfg.curveChecked ? 'Matched: the standard model' : 'Not checked')
    : `Matched: ${ck > 1 ? 'softer' : 'quicker'} near center than the standard model (×${ck.toFixed(2)})`;
  $('#curvefeel-reset').hidden = ck === 1;
  // Aim assist as the game's menu has it: on/off (ARC Raiders, Apex) or a strength.
  const aaSel = $('#aa'), opts = aaOptions(g);
  aaSel.textContent = '';
  for (const [v, label] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = label; aaSel.append(o); }
  if (!opts.some(([v]) => v === cfg.aa)) cfg.aa = 1;
  aaSel.value = String(cfg.aa);
  $('#aa-help').textContent = (opts.length === 2
    ? `On or off, as in ${g.name === 'your game' ? 'your game' : g.name}. On slows your aim over targets and helps follow moving ones. `
    : 'As set in your game. It slows your aim over targets and helps follow moving ones. ')
    + 'No game publishes its strength, so the range uses an estimate. Challenge runs always have it on.';
  // Fine-tune holds whatever optional settings this game has; with none (a mouse game with a fixed
  // field of view) it isn't shown at all.
  const tune = [!mouseGame && 'turn speed check', !mouseGame && 'deadzone', !g.fov.fixed && 'field of view',
    (g.ads || []).length && 'aim-down-sights', g.boost && g.boost.setting && 'look boost'].filter(Boolean);
  $('#advanced').hidden = !tune.length;
  $('#advanced-sub').textContent = `Optional: ${tune.join(', ')}. Leave it closed and the range uses your game's defaults.`;
  if (!mouseGame) {
    $('#curve-label').textContent = g.curve.label;
    const cs = $('#curve'), seen = new Set();
    cs.textContent = '';
    for (const k of ['linear', 'mid', 'expo']) {
      if (seen.has(g.curve[k])) continue;
      seen.add(g.curve[k]);
      const o = document.createElement('option'); o.value = k; o.textContent = g.curve[k]; cs.append(o);
    }
    cs.value = [...cs.options].some(o => o.value === cfg.curve) ? cfg.curve : g.curve.def;
    $('#dz-label').textContent = g.dz.label;
    const opts = DZ_OPTIONS[cfg.game], old = $('#dz');
    let dzEl;
    if (opts) {
      dzEl = document.createElement('select');
      for (const [label, v] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = label; dzEl.append(o); }
      dzEl.value = opts.reduce((a, b) => Math.abs(b[1] - cfg.dz) < Math.abs(a[1] - cfg.dz) ? b : a)[1];
    } else {
      dzEl = document.createElement('input');
      const st = Math.round((g.dz.step || 0.01) * 100);
      Object.assign(dzEl, { type: 'number', inputMode: 'numeric', min: 0, max: 30, step: st, value: Math.round(cfg.dz * 100 / st) * st });
    }
    dzEl.id = 'dz';
    old.replaceWith(dzEl);
    $('#dz-help').textContent = opts ? 'As set in your game.' : `0 to 30${g.dz.step ? ' in steps of ' + Math.round(g.dz.step * 100) : ''}, as set in your game. Default is ${Math.round(g.dz.def * 100)}.`;
    $('#spin').value = cfg.spin || '';
    loadPool(cfg.game);
    spinHelp();
  }
  const dev = document.querySelector(`input[name="device"][value="${cfg.device}"]`);
  if (dev) dev.checked = true;
  const s = $('#sens');
  $('#sens-label').textContent = g.sens.label;
  s.min = g.sens.min; s.max = g.sens.max; s.step = g.sens.step;
  s.value = cfg.sens;
  $('#sens-range').textContent = mouseGame
    ? `Enter the value from your game's mouse settings.${g.yaw ? '' : ' The range uses it with the distance below.'}`
    : g.sens.defKnown === false
    ? `${g.sens.min} to ${g.sens.max}. Enter the value from your controller menu.`
    : `${g.sens.min} to ${g.sens.max}. Default is ${g.sens.def}. Not sure? Leave the default.`;
  const vf = $('#vsens-field');
  vf.hidden = !g.vsens;
  if (g.vsens) {
    const vs = $('#vsens');
    $('#vsens-label').textContent = g.vsens.label;
    vs.min = g.vsens.min; vs.max = g.vsens.max; vs.step = g.vsens.step;
    vs.value = cfg.vsens;
    $('#vsens-range').textContent = g.vsens.defKnown === false
      ? `${g.vsens.min} to ${g.vsens.max}. Enter the value from your controller menu.`
      : `${g.vsens.min} to ${g.vsens.max}. Default is ${g.vsens.def}.`;
  }
  const F = g.fov, ff = $('#fov-field');
  ff.hidden = !!F.fixed;
  if (!F.fixed) {
    const fi = $('#fov');
    $('#fov-label').textContent = F.label;
    fi.min = F.min; fi.max = F.max; fi.step = F.step;
    fi.value = cfg.fov;
    const real = F.type === 'h169' ? '' : ` (${F.type === 'h43' ? 'a 4:3 scale' : 'vertical'}; the range converts it)`;
    $('#fov-range').textContent = F.defKnown === false
      ? `Enter the value from your video settings${real}. The range draws at it, so turns look the way they do in your game.`
      : `${F.min} to ${F.max}. Default is ${F.def}${real}. The range draws at your FOV, so turns look the way they do in your game.`;
  }
  renderAdsFields(g);
  $('#game').value = cfg.game;
  const notes = [];
  if (g.camera === 'third') notes.push('Third-person camera.');
  if (g.fov.fixed) notes.push(g.fov.note);
  if (g.boost) notes.push('Includes look boost, which speeds up turning at full stick.');
  if (!g.ads) notes.push('ADS is tested at a zoom-matched speed and suggested as a relative change.');
  if (g.source === 'guides') notes.push('Menu names come from player guides and still need checking against the game.');
  $('#game-note').textContent = notes.join(' ');
  if (cfg.mode === 'full') $('#route-more').open = true;
  for (const name of ['style', 'mode']) {
    const radio = document.querySelector(`input[name="${name}"][value="${cfg[name]}"]`);
    if (radio) radio.checked = true;
  }
  $('#go-hint').textContent = MODE_HINT[cfg.mode];
  // Deep can add to the rounds saved from an earlier sitting with this game.
  const pool = deepMode(cfg.mode) ? loadDeepSaved() : null;
  $('#deep-pool').hidden = !pool;
  if (pool) {
    const n = pool.rounds.length, sit = new Set(pool.rounds.map(r => r.sitting)).size;
    $('#deep-pool-text').textContent = `Add to my earlier search (${n} rounds from ${sit === 1 ? 'one sitting' : sit + ' sittings'}). Untick to start fresh.`;
  }
}
$('#game').addEventListener('change', e => { setGame(e.target.value); syncSetup(); });
$('#curve').addEventListener('change', () => { readSetup(); syncSetup(); });
$('#aa').addEventListener('change', () => { readSetup(); syncSetup(); });
document.querySelectorAll('input[name="device"]').forEach(r => r.addEventListener('change', e => {
  cfg.device = e.target.value;
  const same = cfg.device === 'mouse' ? 'm-' + cfg.game.replace(/-(alc|adv|mw)$/, '') : cfg.game.replace(/^m-/, '');
  setGame(GAMES[same] && (cfg.device === 'mouse') === (GAMES[same].device === 'mouse') ? same : (cfg.device === 'mouse' ? 'm-arc' : 'arc'));
  syncSetup(); renderRail(); renderWarmBests();
}));
document.querySelectorAll('input[name="style"]').forEach(r => r.addEventListener('change', e => { cfg.style = e.target.value; }));
// readSetup first, so values typed into the form survive the redraw.
document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', e => {
  readSetup(); cfg.mode = e.target.value; syncSetup(); renderRail();
  // Deep is the thorough route, so it opens the optional settings too.
  if (deepMode(cfg.mode)) $('#advanced').open = true;
}));
// Reads the setup form into cfg (current values, not suggestions).
function readSetup() {
  const g = game();
  const v = Number($('#sens').value);
  cfg.sens = snapTo(Number.isFinite(v) ? v : g.sens.def, g.sens);
  if (g.vsens) {
    const vv = Number($('#vsens').value);
    cfg.vsens = snapTo(Number.isFinite(vv) ? vv : g.vsens.def, g.vsens);
  }
  if (!g.fov.fixed) {
    const fv = Number($('#fov').value);
    cfg.fov = clamp(Number.isFinite(fv) ? Math.round(fv) : g.fov.def, g.fov.min, g.fov.max);
  } else cfg.fov = g.fov.def;
  if (g.device === 'mouse') {
    const dpi = Number($('#dpi').value), cm0 = Number($('#cm0').value);
    cfg.dpi = clamp(Number.isFinite(dpi) && dpi > 0 ? Math.round(dpi) : 800, 100, 32000);
    cfg.cm0 = clamp(Number.isFinite(cm0) && cm0 > 0 ? cm0 : 30, 5, 200);
    const v = Number($('#sens').value);
    const dec = (String(g.sens.step).split('.')[1] || '').length;
    cfg.sens = clamp(Number.isFinite(v) && v > 0 ? +(Math.round(v / g.sens.step) * g.sens.step).toFixed(dec) : g.sens.def, g.sens.min, g.sens.max);
  }
  cfg.vmult = 1;
  cfg.ads = adsDefaults(g);
  for (const sp of g.ads || []) {
    const raw = Number($('#ads-' + sp.key).value);
    if (Number.isFinite(raw) && raw > 0) cfg.ads[sp.key] = snapTo(sp.unit === '%' ? raw / 100 : raw, sp);
  }
  Object.assign(cfg, boostDefaults(g));
  if (g.boost && g.boost.setting) {
    const b = Number($('#boost').value), rr = Number($('#boost-ramp').value);
    if (Number.isFinite(b)) cfg.boost = clamp(b, g.boost.setting.min, g.boost.setting.max);
    if (Number.isFinite(rr)) cfg.boostRamp = clamp(rr, g.boost.rampSetting.min, g.boost.rampSetting.max);
    const dl = g.boost.delaySetting && Number($('#boost-delay').value);
    if (g.boost.delaySetting && Number.isFinite(dl)) cfg.boostDelay = clamp(dl, g.boost.delaySetting.min, g.boost.delaySetting.max);
  }
  if (g.device === 'mouse') { cfg.curve = g.curve.def; cfg.dz = g.dz.def; cfg.spin = null; cfg.kTurn = 1; }
  else {
    const aa = Number($('#aa').value);
    cfg.aa = aaOptions(g).some(([v]) => v === aa) ? aa : 1;
    cfg.curve = $('#curve').value in CURVE_KEYS ? $('#curve').value : g.curve.def;
    const opts = DZ_OPTIONS[cfg.game];
    const dz = Number($('#dz').value);
    cfg.dz = opts ? (Number.isFinite(dz) ? dz : g.dz.def) : snapTo(Number.isFinite(dz) ? dz / 100 : g.dz.def, { min: 0, max: 0.3, step: g.dz.step || 0.01 });
    const spin = Number($('#spin').value);
    cfg.spin = Number.isFinite(spin) && spin > 0 ? spin : null;
    cfg.kTurn = cfg.spin ? spinK(g, cfg.sens, cfg.spin) : (pooled[cfg.game] && pooled[cfg.game].k) || 1;
  }
  cfg.outer = 1;
}

// Turn speed check: 5 full spins at full stick (boost off) in the player's own game. Returns the factor
// that scales the profile's estimated turn speed to the measured one (1 when not measured).
const CURVE_KEYS = { linear: 1, mid: 1, expo: 1 };
const spinRate = secs => 1800 / secs;
function spinK(g, sens, secs) {
  if (!secs) return 1;
  return +clamp(spinRate(secs) / g.sens.rate(sens), 0.25, 4).toFixed(4);
}
// Everyone's timings pooled per game: once POOL_MIN players have timed a game, the median of their
// measured-to-estimated ratios replaces the built-in estimate for players who haven't timed it.
const POOL_MIN = 3;
const pooled = {}, poolAsked = new Set();
function loadPool(id) {
  const g = GAMES[id];
  if (!boardsOn() || g.device === 'mouse' || poolAsked.has(id)) return;
  poolAsked.add(id);
  fetchTurnSamples(id).then(rows => {
    const ks = rows.map(r => spinRate(r.seconds) / g.sens.rate(r.sens)).filter(k => k >= 0.25 && k <= 4).sort((a, b) => a - b);
    if (ks.length < POOL_MIN) return;
    const n = ks.length, mid = n % 2 ? ks[(n - 1) / 2] : (ks[n / 2 - 1] + ks[n / 2]) / 2;
    pooled[id] = { k: +mid.toFixed(4), n };
    if (cfg.game === id) { if (!cfg.spin) cfg.kTurn = pooled[id].k; spinHelp(); }
  }).catch(() => { poolAsked.delete(id); });
}
// Sends this player's timing to the pool once per game, sensitivity and value.
let poolSent = '';
function sharePoolSample() {
  const key = `${cfg.game}|${cfg.sens}|${cfg.spin}`;
  if (!cfg.spin || !boardsOn() || game().device === 'mouse' || key === poolSent) return;
  poolSent = key;
  addTurnSample(cfg.game, cfg.sens, cfg.spin).catch(() => { poolSent = ''; });
}

// Games whose deadzone menu is a list rather than a number.
const DZ_OPTIONS = { apex: [['None', 0.04], ['Small', 0.10], ['Large', 0.16]] };
function spinHelp() {
  const g = game(), el = $('#spin-help');
  const how = 'How long 5 full spins take in your game at full stick, timed on your phone. Optional: it makes the range turn exactly as fast as your game.';
  $('#spin-step-boost').textContent = g.boost && g.boost.setting
    ? `Set ${g.boost.setting.label} to 0 for now, so the turn speed stays steady.`
    : 'Turn off any turning boost or look acceleration for now, so the turn speed stays steady.';
  const secs = Number($('#spin').value), sens = Number($('#sens').value) || cfg.sens;
  const pool = pooled[cfg.game];
  if (!(secs > 0)) {
    el.textContent = pool
      ? `${pool.n} players have timed ${g.name}, so the range already turns at their measured speed: about ${Math.round(g.sens.rate(sens) * pool.k)}°/s at sensitivity ${sens}. Time it yourself to use your own.`
      : how;
    return;
  }
  const k = spinRate(secs) / g.sens.rate(sens);
  el.textContent = k < 0.25 || k > 4
    ? `That's ${Math.round(spinRate(secs))}°/s, far from what sensitivity ${sens} should give. Check the count of spins and the sensitivity above.`
    : `Your game turns about ${Math.round(spinRate(secs))}°/s at full stick. The ${pool ? `pooled estimate from ${pool.n} players` : 'built-in estimate'} was ${Math.round(g.sens.rate(sens) * (pool ? pool.k : 1))}°/s, so the range will use yours. Your timing is shared anonymously to improve the estimate for others.`;
}
$('#spin').addEventListener('input', spinHelp);
$('#curvefeel-go').addEventListener('click', startCurveCheck);
$('#recoil-go').addEventListener('click', startRecoilCheck);
$('#recoil-use').addEventListener('click', () => { cfg.vsens = recoilResult.rec.vsens; $('#vsens').value = cfg.vsens; saveSetup(); syncSetup(); });
$('#curvefeel-reset').addEventListener('click', () => { cfg.curveK = null; cfg.curveChecked = false; saveSetup(); syncSetup(); });
$('#spin-how').addEventListener('click', e => {
  const guide = $('#spin-guide'), open = guide.hidden;
  guide.hidden = !open;
  e.currentTarget.setAttribute('aria-expanded', String(open));
  e.currentTarget.textContent = open ? 'Hide the steps' : 'How do I measure this?';
});
$('#sens').addEventListener('input', spinHelp);

$('#go').addEventListener('click', () => {
  logEvent('calibrate');
  readSetup();
  sharePoolSample();
  result = null;
  syncSetup();
  if (deepMode(cfg.mode)) start(deepSegments(), null, newDeep($('#deep-add').checked && !$('#deep-pool').hidden ? loadDeepSaved() : null, cfg.mode === 'full'));
  else start(quickSegments(), null);
});

/* ---------- input ---------- */

// Mouse: the range canvas takes the pointer during mouse tests. mouseCheck = the last mouse check's
// measurements (kept for the page's life, so a second session needn't repeat it).
const mouse = createMouse($('#arena'), () => { if (screen === 'test') { if (chal) renderChalBrief(true); else if (session) renderBrief(true); } });
let mouseCheck = null;
$('#arena').addEventListener('click', () => { if (isMouse() && screen === 'test' && !mouse.locked) mouse.lock(); });

// Points the active mouse profile at this player's mouse: DPI entered, as measured, and (for games
// without a published conversion) their cm per full turn. Returns the resolved DPI facts.
function calibrate() {
  const g = game();
  if (g.device !== 'mouse') return null;
  const m = (session && session.mouse) || mouseCheck;
  const r = resolveDpi(cfg.dpi, m && m.cpcm, window.devicePixelRatio || 1);
  g.cal.k = 1;
  g.cal.k = calibrationK(g, { ...r, sens0: cfg.sens, cm0: cfg.cm0 });
  return r;
}

const vpad = { x: 0, y: 0, drag: false, fire: false };
const keys = { left: false, right: false, up: false, down: false, fire: false };

function readPad() {
  let pads = [];
  try { pads = navigator.getGamepads ? navigator.getGamepads() : []; }
  catch (e) { gpBlocked = true; pads = []; }
  for (const p of pads || []) if (p && p.connected && p.axes.length >= 4) return p;
  return null;
}
function poll() {
  if (isMouse()) {
    const { mx, my } = mouse.take();
    const fire = mouse.fire() || keys.fire;
    return { src: 'mouse', name: null, lx: 0, ly: 0, rx: 0, ry: 0, mx, my, fire, dl: false, du: false, dr: false, lt: 0, rt: 0 };
  }
  const p = readPad();
  if (p) {
    const b = p.buttons;
    const pressed = i => !!b[i] && (b[i].pressed || b[i].value > 0.5);
    return { src: 'pad', name: p.id, lx: p.axes[0], ly: p.axes[1], rx: p.axes[2], ry: p.axes[3],
      fire: pressed(7) || pressed(0) || pressed(5), dl: pressed(14), du: pressed(12), dr: pressed(15), lb: pressed(4), rb: pressed(5),
      lt: b[6] ? b[6].value : 0, rt: b[7] ? b[7].value : 0 };
  }
  let x = vpad.x, y = vpad.y;
  if (!vpad.drag) {
    x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    y = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    x *= 0.6; y *= 0.6;
  }
  return { src: 'virtual', name: null, lx: 0, ly: 0, rx: x, ry: y, fire: vpad.fire || keys.fire, dl: false, du: false, dr: false, lt: 0, rt: 0 };
}

const vs = $('#vstick'), knob = $('#vknob');
let vsId = null;
function vsMove(e) {
  const r = vs.getBoundingClientRect(), R = r.width / 2, reach = R * 0.7;
  let x = (e.clientX - r.left - R) / reach, y = (e.clientY - r.top - R) / reach;
  const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
  vpad.x = x; vpad.y = y;
  knob.style.transform = `translate(calc(-50% + ${x * reach}px), calc(-50% + ${y * reach}px))`;
}
vs.addEventListener('pointerdown', e => { vsId = e.pointerId; vpad.drag = true; vs.setPointerCapture(e.pointerId); vsMove(e); e.preventDefault(); });
vs.addEventListener('pointermove', e => { if (e.pointerId === vsId) vsMove(e); });
const vsEnd = e => { if (e.pointerId !== vsId) return; vsId = null; vpad.drag = false; vpad.x = vpad.y = 0; knob.style.transform = 'translate(-50%, -50%)'; };
vs.addEventListener('pointerup', vsEnd);
vs.addEventListener('pointercancel', vsEnd);
const vf = $('#vfire');
vf.addEventListener('pointerdown', e => { vpad.fire = true; e.preventDefault(); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => vf.addEventListener(t, () => { vpad.fire = false; }));

const KEYMAP = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down', Space: 'fire' };
const inTest = () => screen === 'test' && ((session && (session.phase === 'count' || session.phase === 'run')) || (chal && chal.phase !== 'intro'));
window.addEventListener('keydown', e => {
  const k = KEYMAP[e.code];
  if (!k || !inTest()) return;
  keys[k] = true; e.preventDefault();
});
window.addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) keys[k] = false; });
window.addEventListener('blur', () => { Object.keys(keys).forEach(k => { keys[k] = false; }); });

/* ---------- drawing ---------- */

let css = null;
const tok = n => css.getPropertyValue(n).trim();
// Canvas pixels per CSS pixel: the screen's pixel ratio, capped so a canvas never holds more than
// MAX_CANVAS_PX pixels. A big range on a high-resolution display otherwise redraws ~4 million pixels a
// frame, which can push a graphics driver into resetting the whole browser window (a white flash).
// Lighter graphics (a toggle, and switched on by itself if the browser loses the canvas to a driver
// reset): about 0.8 million pixels and 60 frames a second, a fraction of the work.
const MAX_CANVAS_PX = 2.2e6, LITE_CANVAS_PX = 0.8e6;
const LITE_KEY = 'dialed-in:lite';
let lite = false;
try { lite = localStorage.getItem(LITE_KEY) === '1'; } catch (e) { /* storage blocked: full graphics */ }
function setLite(on, why) {
  lite = on;
  try { localStorage.setItem(LITE_KEY, on ? '1' : '0'); } catch (e) { /* not remembered */ }
  const box = $('#lite'); if (box) box.checked = on;
  const note = $('#lite-note'); if (note) { note.hidden = !why; note.textContent = why || ''; }
}
function fit(c) {
  const r = c.getBoundingClientRect(), cap = lite ? LITE_CANVAS_PX : MAX_CANVAS_PX;
  let d = window.devicePixelRatio || 1;
  if (r.width * r.height * d * d > cap) d = Math.sqrt(cap / (r.width * r.height));
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (w && h && (c.width !== w || c.height !== h)) { c.width = w; c.height = h; }
  c.dataset.px = String(r.width ? w / r.width : 1);
  return w > 0 && h > 0;
}
const pxRatio = c => Number(c.dataset.px) || window.devicePixelRatio || 1;

function drawArena() {
  const c = $('#arena');
  if (screen !== 'test' || !fit(c)) return;
  if (chal) return drawScene(c, chalScene());
  const s = seg(), P = session.phase;
  drawScene(c, {
    view, zoom: s.zoom || 1, phase: P, countLeft: session.countLeft, worldKey: 'range-' + cfg.game, gameId: cfg.game,
    hfov: hfovFor(cfg.game),
    flick: P === 'run' && s.kind === 'flick' ? s.data : P === 'run' && s.kind === 'recoil' ? { cur: s.data.T, flash: null } : null,
    track: P === 'run' && s.kind === 'track' ? s.data : null,
    figure: s.kind !== 'drift' && s.kind !== 'mcheck',
    overlay: mousePaused(P) ? drawPaused
      : P === 'run' && s.kind === 'drift' ? (ctx, W, H, d) => drawDrift(ctx, s.data, W, H, d)
      : P === 'run' && s.kind === 'mcheck' ? (ctx, W, H, d) => drawMouseCheck(ctx, s.data, W, H, d)
      : P === 'run' && s.kind === 'recoil' ? (ctx, W, H) => drawRecoilCue(ctx, s.data, W, H) : null
  });
}

// The range's world (sky, ridges, sun) is generated from a key: one per game for calibration, one per
// challenge code, so every daily range looks different.
let world = null, worldKey = '';
function worldFor(key) {
  if (key !== worldKey) { worldKey = key; world = makeWorld(hashSeed(key)); }
  return world;
}
const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// One frame of the aim range. sc = { view, zoom, phase, countLeft, worldKey, gameId, flick: { cur, flash }?, track?,
// figure, overlay?, hud? }.
// The sky, sun, hills and ground grid are soft gradients and fills that cover the whole screen several
// layers deep, the bulk of each frame's work. They're drawn at reduced resolution on a canvas of their
// own and scaled up (BG_SCALE, lower with lighter graphics); targets, effects and the HUD stay sharp on top.
const BG_SCALE = 0.5, BG_SCALE_LITE = 0.35;
let bgCanvas = null;
function paintBackground(ctx, sc, view, W, H, d, zoom, w, now, calm) {
  const k = W * H < 600000 ? 1 : lite ? BG_SCALE_LITE : BG_SCALE;
  const bw = Math.max(1, Math.round(W * k)), bh = Math.max(1, Math.round(H * k));
  if (!bgCanvas) bgCanvas = document.createElement('canvas');
  if (bgCanvas.width !== bw || bgCanvas.height !== bh) { bgCanvas.width = bw; bgCanvas.height = bh; }
  const bctx = bgCanvas.getContext('2d', { alpha: false });
  const bcam = makeCamera(view, bw, bh, sc.hfov, zoom);
  bcam.d = d * k;
  paintSky(bctx, bcam, w, now, calm);
  paintTerrain(bctx, bcam, w);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bgCanvas, 0, 0, W, H);
}

function drawScene(c, sc) {
  const view = sc.view, P = sc.phase, now = performance.now(), calm = reducedMotion();
  const ctx = c.getContext('2d'), W = c.width, H = c.height, d = pxRatio(c);
  const zoom = sc.zoom;
  const cam = makeCamera(view, W, H, sc.hfov, zoom);
  cam.d = d;
  const { cx, cy, ppd } = cam;
  const w = worldFor(sc.worldKey);
  paintBackground(ctx, sc, view, W, H, d, zoom, w, now, calm);

  const running = P === 'run';
  const scopeR = zoom >= 3 ? Math.min(W, H) * 0.46 : 0;
  const clipScope = () => { if (scopeR) { ctx.beginPath(); ctx.arc(cx, cy, scopeR, 0, Math.PI * 2); ctx.clip(); } };
  const arrows = [];
  const drawTarget = (t, r, opts) => {
    const q = cam.project(t.yaw, t.pitch);
    const R = q.z > 0.02 ? r * ppd / q.z : 0;
    const { x, y } = q;
    const outside = !R || (scopeR ? Math.hypot(x - cx, y - cy) > scopeR + R : x < -R || x > W + R || y < -R || y > H + R);
    if (outside) {
      // Out of view (or behind): a chevron on the edge (or the scope's rim) pointing the way to turn,
      // with how far. The camera-space direction works even for targets behind the player.
      const ang = Math.atan2(-q.v, q.u || 1e-9);
      const reach = scopeR ? scopeR - 18 * d
        : Math.min((W / 2 - 28 * d) / Math.max(1e-6, Math.abs(Math.cos(ang))), (H / 2 - 28 * d) / Math.max(1e-6, Math.abs(Math.sin(ang))));
      arrows.push([cx + Math.cos(ang) * reach, cy + Math.sin(ang) * reach, ang, Math.hypot(t.yaw - view.yaw, t.pitch - view.pitch), opts.kind === 'track' ? TRACK_BLUE : undefined]);
      return;
    }
    ctx.save(); clipScope();
    paintDrone(ctx, x, y, R, cam, w, now, { ...opts, still: calm });
    ctx.restore();
  };
  if (running && sc.flick) {
    noteFlash(w, sc.flick.flash, now);
    if (sc.flick.cur) drawTarget(sc.flick.cur, sc.flick.cur.r, { kind: sc.flick.cur.turn ? 'turn' : 'flick' });
  }
  if (running && sc.track) {
    const pts = trailPoint(w, sc.track.tgt);
    ctx.save(); clipScope(); paintTrail(ctx, pts, sc.track.r * ppd, cam, sc.track.tgt.on); ctx.restore();
    drawTarget(sc.track.tgt, sc.track.r, { kind: 'track', lit: sc.track.tgt.on, hold: !!sc.hold });
  }
  ctx.save(); clipScope(); paintFx(ctx, cam, w, now, calm); ctx.restore();

  // Third-person games: the character sits left of the crosshair and blocks part of the view.
  if (GAMES[sc.gameId].camera === 'third' && sc.figure && zoom === 1) paintFigure(ctx, cam, w);
  paintLens(ctx, cam, zoom);
  for (const [ex, ey, ang, deg, col] of arrows) paintOffscreen(ctx, ex, ey, ang, deg, cam, col);
  if (zoom === 1 && P !== 'intro') paintCompass(ctx, cam, w);
  paintCrosshair(ctx, cam, running && sc.track && sc.track.tgt.on);
  if (sc.hud && running) paintChalHud(ctx, cam, sc.hud);

  if (P === 'intro' || P === 'rate') {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(5,10,16,0.35)'); g.addColorStop(1, 'rgba(5,10,16,0.7)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  } else if (P === 'count') {
    paintCountdown(ctx, cam, Math.ceil(sc.countLeft), 1 - (sc.countLeft - Math.floor(sc.countLeft)), calm);
  } else if (sc.overlay) {
    sc.overlay(ctx, W, H, d);
  }
}

// Challenge HUD drawn into the range: rolling score, streak pips with the multiplier, a ring for time left.
function paintChalHud(ctx, cam, h) {
  const { W, d } = cam, pad = 18 * d;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8 * d;
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = '#FFB547';
  ctx.font = `900 ${40 * d}px 'Big Shoulders Stencil Display', 'Big Shoulders Display', sans-serif`;
  ctx.fillText(Math.round(h.shown).toLocaleString('en-US'), pad, pad + 34 * d);
  ctx.fillStyle = 'rgba(244,241,232,0.75)';
  ctx.font = `600 ${9 * d}px 'Martian Mono', monospace`;
  ctx.fillText('POINTS', pad + 2 * d, pad + 48 * d);
  ctx.shadowBlur = 0;
  const pips = 10, pw = 11 * d, ph = 7 * d, filled = Math.min(Math.max(h.streak - 1, 0), pips);
  for (let i = 0; i < pips; i++) {
    const x = pad + i * (pw + 3 * d), y = pad + 56 * d;
    ctx.fillStyle = i < filled ? '#FF5E3A' : 'rgba(244,241,232,0.18)';
    ctx.beginPath(); ctx.moveTo(x + 3 * d, y); ctx.lineTo(x + pw, y); ctx.lineTo(x + pw - 3 * d, y + ph); ctx.lineTo(x, y + ph); ctx.closePath(); ctx.fill();
  }
  if (h.streak > 1) {
    ctx.fillStyle = '#FF8A64'; ctx.font = `800 ${14 * d}px 'Big Shoulders Display', sans-serif`;
    ctx.fillText(`×${(1 + 0.1 * Math.min(h.streak - 1, 10)).toFixed(1)}`, pad + pips * (pw + 3 * d) + 6 * d, pad + 63 * d);
  }
  const rx = W - pad - 24 * d, ry = pad + 24 * d, rr = 22 * d, frac = Math.max(0, h.left / h.total);
  ctx.lineWidth = 4 * d;
  ctx.strokeStyle = 'rgba(244,241,232,0.18)'; ctx.beginPath(); ctx.arc(rx, ry, rr, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = h.left < 10 ? '#FF5E3A' : '#F4F1E8';
  ctx.beginPath(); ctx.arc(rx, ry, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke();
  ctx.fillStyle = '#F4F1E8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `800 ${18 * d}px 'Big Shoulders Display', sans-serif`;
  ctx.fillText(String(Math.ceil(h.left)), rx, ry + d);
  if (h.label) {
    ctx.font = `600 ${9 * d}px 'Martian Mono', monospace`; ctx.fillStyle = 'rgba(244,241,232,0.75)';
    ctx.fillText(h.label, rx, ry + rr + 14 * d);
  }
  ctx.restore();
}

// Stick check overlay: hands-off readout, then the edge roll and trigger parts.
function drawDrift(ctx, D, W, H, d) {
  const cx = W / 2, cy = H / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = tok('--arena'); ctx.globalAlpha = 0.6; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
  if (D.part !== 'rest') { drawStickPart(ctx, D, W, H, d); return; }
  ctx.fillStyle = D.warn > 0 ? tok('--target') : tok('--arena-ink');
  ctx.font = `600 ${Math.round(H * 0.07)}px ${tok('--display')}`;
  ctx.fillText(D.warn > 0 ? 'Stick moved. Starting over.' : 'Hands off the sticks', cx, cy - H * 0.12);
  ctx.fillStyle = tok('--arena-ink');
  ctx.font = `500 ${Math.round(H * 0.05)}px ${tok('--mono')}`;
  ctx.fillText(`right ${D.r.toFixed(3)}   left ${D.l.toFixed(3)}`, cx, cy + H * 0.02);
  const bw = W * 0.4, bh = 6 * d, bx = cx - bw / 2, by = cy + H * 0.12;
  ctx.fillStyle = tok('--arena-major'); ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = tok('--target'); ctx.fillRect(bx, by, bw * clamp(D.t / DRIFT_SECONDS, 0, 1), bh);
}

// Recoil check cue: what to do now and which burst this is.
function drawRecoilCue(ctx, R, W, H) {
  const n = Math.min(R.bursts.length + 1, R.P.bursts);
  const text = R.cur ? 'PULL DOWN' : R.wait ? 'LET GO' : 'AIM, THEN HOLD FIRE';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = `800 ${Math.round(H * 0.045)}px ${tok('--display')}`;
  ctx.fillStyle = R.cur ? '#FFD34D' : '#F4F1E8';
  ctx.fillText(text, W / 2, H * 0.08);
  ctx.font = `500 ${Math.round(H * 0.03)}px ${tok('--mono')}`;
  ctx.fillStyle = '#F4F1E8';
  ctx.fillText(`Burst ${n} of ${R.P.bursts}${n <= R.P.warm ? ' (warm-up)' : ''}`, W / 2, H * 0.08 + H * 0.06);
  if (R.cur) { ctx.fillStyle = '#FFD34D'; ctx.fillRect(W * 0.35, H * 0.2, W * 0.3 * Math.min(1, R.cur.t / R.P.burst), Math.max(3, H * 0.006)); }
}

function drawPaused(ctx, W, H, d) {
  ctx.fillStyle = 'rgba(5,10,16,0.62)'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#F4F1E8';
  ctx.font = `800 ${Math.round(H * 0.08)}px ${tok('--display')}`;
  ctx.fillText('PAUSED', W / 2, H * 0.45);
  ctx.font = `500 ${Math.round(H * 0.038)}px ${tok('--mono')}`;
  ctx.fillText('Click the range to pick the mouse back up', W / 2, H * 0.56);
}

// The mouse check as a picture: the card, START and STOP lines at its ends, and a mouse outline that
// slides with the real swipe (scaled to a card length at the DPI entered, so only a rough guide), its left side marked.
function drawMouseCheck(ctx, D, W, H, d) {
  ctx.fillStyle = tok('--arena'); ctx.globalAlpha = 0.78; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
  const k = Math.min(D.swipes.length, SWIPES.length - 1), speed = SWIPES[k];
  const cw = Math.min(W * 0.34, H * 0.42), ch = cw * 54 / 85.6;
  const mw = cw * 0.44, mh = cw * 0.64;
  const x0 = W / 2 - (cw + mw) / 2;                       // card's left end = START line
  const my = H * 0.2, cy0 = my + mh + 10 * d;              // mouse row, then the card under it
  const sw = mouse.swipe;
  const prog = sw ? Math.hypot(sw.dx, sw.dy) / (cfg.dpi / 2.54 * CARD_CM) : 0;
  const ink = '#EDF1EA', ember = '#FF5E3A', sun = '#FFB547';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;
  ctx.font = `800 ${Math.round(H * 0.055)}px ${tok('--display')}`;
  ctx.fillText(`SLIDE ${k + 1} OF ${SWIPES.length} · ${speed.toUpperCase()}`, W / 2, H * 0.07);

  // START / STOP guides
  ctx.setLineDash([6 * d, 5 * d]); ctx.strokeStyle = ember; ctx.lineWidth = 2 * d;
  for (const x of [x0, x0 + cw]) { ctx.beginPath(); ctx.moveTo(x, my - 8 * d); ctx.lineTo(x, cy0 + ch + 8 * d); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.font = `600 ${Math.round(H * 0.032)}px ${tok('--mono')}`;
  ctx.fillText('START', x0, my - 20 * d);
  ctx.fillText('STOP', x0 + cw, my - 20 * d);

  const mouseAt = (x, ghost) => {
    ctx.save();
    ctx.globalAlpha = ghost ? 0.45 : 1;
    if (ghost) ctx.setLineDash([7 * d, 6 * d]);
    ctx.beginPath(); ctx.roundRect(x, my, mw, mh, mw / 2);
    if (!ghost) { ctx.fillStyle = 'rgba(244,241,232,0.12)'; ctx.fill(); }
    ctx.strokeStyle = ink; ctx.lineWidth = 2.5 * d; ctx.stroke();
    ctx.setLineDash([]);
    if (!ghost) {
      ctx.globalAlpha = 0.6; ctx.lineWidth = 1.5 * d;
      ctx.beginPath(); ctx.moveTo(x + mw / 2, my); ctx.lineTo(x + mw / 2, my + mh * 0.38); ctx.moveTo(x, my + mh * 0.38); ctx.lineTo(x + mw, my + mh * 0.38); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = ember; ctx.beginPath(); ctx.roundRect(x - 3 * d, my + mh * 0.33, 6 * d, mh * 0.36, 3 * d); ctx.fill(); // its left side
    ctx.restore();
  };
  mouseAt(x0 + cw, true);
  const mx = x0 + cw * Math.min(prog, 1.25);
  mouseAt(mx, false);

  // the card, beside the mouse's path
  const g = ctx.createLinearGradient(x0, cy0, x0 + cw, cy0 + ch);
  g.addColorStop(0, 'rgba(255,181,71,0.24)'); g.addColorStop(1, 'rgba(255,94,58,0.10)');
  ctx.fillStyle = g; ctx.strokeStyle = 'rgba(244,241,232,0.75)'; ctx.lineWidth = 2 * d;
  ctx.beginPath(); ctx.roundRect(x0, cy0, cw, ch, 8 * d); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,181,71,0.6)'; ctx.fillRect(x0 + cw * 0.09, cy0 + ch * 0.28, cw * 0.16, ch * 0.24);
  ctx.fillStyle = 'rgba(237,241,234,0.7)'; ctx.font = `500 ${Math.round(H * 0.03)}px ${tok('--body')}`;
  ctx.fillText('bank card', x0 + cw / 2, cy0 + ch * 0.62);
  ctx.fillStyle = ink; ctx.font = `600 ${Math.round(H * 0.032)}px ${tok('--mono')}`;
  ctx.fillText('3.37 in · 8.56 cm', x0 + cw / 2, cy0 + ch + 18 * d);

  ctx.font = `500 ${Math.round(H * 0.034)}px ${tok('--mono')}`;
  ctx.fillStyle = 'rgba(237,241,234,0.75)';
  const done = D.swipes.map(x => Math.round(Math.hypot(x.dx, x.dy) / CARD_CM * 2.54) + ' DPI').join('   ·   ');
  // The picture moves at the DPI typed in setup, which is what's being checked, so the real card decides.
  ctx.fillText(sw ? 'Watch the real card, not this picture. Let go at its right end.' : 'Hold the left button and slide right', W / 2, H * 0.89);
  if (done) { ctx.fillStyle = sun; ctx.fillText(done, W / 2, H * 0.95); }
}

// Edge roll: lit wedges show the directions already pushed to the edge. Squeeze: trigger travel bars.
function drawStickPart(ctx, D, W, H, d) {
  const cy = H * 0.52, R = Math.min(H * 0.28, W * 0.16);
  const centers = [W * 0.32, W * 0.68];
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (D.part === 'roll') {
    [[D.reachL, inp.lx, inp.ly, 'LEFT'], [D.reachR, inp.rx, inp.ry, 'RIGHT']].forEach(([reach, x, y, label], k) => {
      const cx = centers[k];
      reach.forEach((r, i) => {
        const a0 = i / reach.length * Math.PI * 2, a1 = (i + 1) / reach.length * Math.PI * 2;
        ctx.fillStyle = r >= 0.7 ? tok('--target') : tok('--arena-major');
        ctx.globalAlpha = r >= 0.7 ? 0.85 : 0.6;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0 + 0.02, a1 - 0.02); ctx.closePath(); ctx.fill();
      });
      ctx.globalAlpha = 1;
      ctx.fillStyle = tok('--arena');
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = tok('--arena-ink');
      ctx.beginPath(); ctx.arc(cx + clamp(x, -1, 1) * R, cy + clamp(y, -1, 1) * R, 6 * d, 0, Math.PI * 2); ctx.fill();
      ctx.font = `500 ${Math.round(H * 0.045)}px ${tok('--mono')}`;
      ctx.fillText(`${label} ${pct(coverage(reach))}`, cx, cy + R + H * 0.08);
    });
    ctx.font = `600 ${Math.round(H * 0.06)}px ${tok('--display')}`;
    ctx.fillText('Roll both sticks around the edge', W / 2, H * 0.12);
  } else {
    [[inp.lt, D.maxLt, 'LT / L2'], [inp.rt, D.maxRt, 'RT / R2']].forEach(([v, max, label], k) => {
      const cx = centers[k], bw = W * 0.06, bh = H * 0.5, bx = cx - bw / 2, by = cy - bh / 2;
      ctx.fillStyle = tok('--arena-major'); ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = tok('--target'); ctx.fillRect(bx, by + bh * (1 - v), bw, bh * v);
      ctx.fillStyle = tok('--arena-ink'); ctx.fillRect(bx - 6 * d, by + bh * (1 - max) - d, bw + 12 * d, 2 * d);
      ctx.font = `500 ${Math.round(H * 0.045)}px ${tok('--mono')}`;
      ctx.fillText(`${label} ${max.toFixed(2)}`, cx, by + bh + H * 0.08);
    });
    ctx.font = `600 ${Math.round(H * 0.06)}px ${tok('--display')}`;
    ctx.fillText('Squeeze both triggers, then let go', W / 2, H * 0.12);
  }
}

function drawSticks() {
  const c = $('#sticks');
  if (!fit(c)) return;
  const ctx = c.getContext('2d'), W = c.width, H = c.height, d = pxRatio(c);
  ctx.clearRect(0, 0, W, H);
  const R = Math.min(H * 0.38, W * 0.2);
  const one = (cx, x, y, label, dzRing) => {
    const cy = H * 0.46;
    ctx.strokeStyle = tok('--line'); ctx.lineWidth = d;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    if (dzRing) {
      ctx.setLineDash([3 * d, 3 * d]); ctx.strokeStyle = tok('--accent');
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(2 * d, R * dzRing), 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = tok('--ink');
    ctx.beginPath(); ctx.arc(cx + clamp(x, -1, 1) * R, cy + clamp(y, -1, 1) * R, 5 * d, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = tok('--muted'); ctx.font = `500 ${9.5 * d}px ${tok('--mono')}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, cx, H - 2 * d);
  };
  const s = seg();
  const dz = s && s.settings ? s.settings.dz : session && session.drift ? session.drift.rec : cfg.dz;
  one(W * 0.27, inp.lx, inp.ly, 'LEFT', 0);
  one(W * 0.73, inp.rx, inp.ry, 'RIGHT · DZ ' + dz.toFixed(2), inp.src === 'pad' ? dz : 0);
}

/* ---------- warm-up challenge ---------- */

let chal = null; // { st, rec, code, kind, phase, countLeft, acc, flash, pop, src }
const CH_KIND = { daily: 'Daily challenge', practice: 'Practice', code: 'Shared challenge' };
// Practice levels by code prefix (challenge.js versionOf).
const LEVEL_NAME = { p: 'Standard', h: 'Hard', w: 'Warm-up' };
const kindLabel = c => c.kind === 'daily' ? CH_KIND.daily : `${CH_KIND[c.kind]}${c.code[0] !== 'd' ? ' · ' + LEVEL_NAME[c.code[0]] : ''}`;

// opts: { settings, seconds, duel } for duel runs; otherwise the run uses the setup form.
function startChallenge(code, kind, opts = {}) {
  if (kind === 'daily' || kind === 'practice') logEvent(kind);
  checkVersion();
  if (!opts.settings) { readSetup(); syncSetup(); sharePoolSample(); }
  session = null;
  calibrate();
  let settings = opts.settings || settingsOf(cfg);
  const game = opts.game || cfg.game;
  loadTiers(GAMES[game].device === 'mouse');
  // Mouse runs carry their degrees per count, so the replay doesn't depend on this browser's calibration.
  if (GAMES[game].device === 'mouse') settings = { ...settings, dpc: GAMES[game].sens.rate(settings.sens) };
  chal = { st: createChallenge(code, game, settings, { seconds: opts.seconds }), rec: newRecording(), code, kind, phase: 'intro',
    countLeft: 0, acc: 0, flash: null, pop: null, src: inp.src, used: {}, settings, game, duel: opts.duel || null };
  view.yaw = 0; view.pitch = 0;
  show('test');
}

function chalTick(dt, edge) {
  const c = chal;
  if (c.phase === 'intro') { if (edge.fire && (!isMouse() || mouse.locked)) { c.phase = 'count'; c.countLeft = 3; renderChalBrief(true); } return; }
  if (mousePaused(c.phase)) return;
  if (c.phase === 'rate') { const r = RATINGS.find(x => edge[x.key]); if (r) duelRate(r.v); return; }
  if (c.phase === 'count') {
    c.countLeft -= dt;
    if (c.countLeft <= 0) { c.phase = 'run'; renderChalBrief(true); }
    return;
  }
  if (c.flash) c.flash.t -= dt;
  if (c.pop) c.pop.t -= dt;
  // Fixed ticks: the same rounded input the replay will use.
  c.acc += dt;
  // A mouse's counts go to the next tick (Int16 slots in the recording); counts from a frame too
  // short for a tick wait for the next one.
  c.mx = (c.mx || 0) + (inp.mx || 0); c.my = (c.my || 0) + (inp.my || 0);
  const i16 = v => clamp(Math.round(v), -32767, 32767);
  // A press seen on a frame that runs no tick still reaches the next tick, so quick taps aren't lost.
  c.fireSeen = c.fireSeen || !!inp.fire;
  while (c.acc >= DT && !c.st.done) {
    const mouseRun = inp.src === 'mouse';
    const rx = mouseRun ? i16(c.mx) : quantize(inp.rx), ry = mouseRun ? i16(c.my) : quantize(inp.ry), fire = !!inp.fire || c.fireSeen;
    c.fireSeen = false;
    c.prevView = { yaw: c.st.view.yaw, pitch: c.st.view.pitch };
    if (mouseRun) { c.mx -= rx; c.my -= ry; }
    // Which input actually drove the run, tick by tick (see endChallenge).
    if (rx || ry || fire) c.used[inp.src] = (c.used[inp.src] || 0) + 1;
    record(c.rec, rx, ry, fire);
    chStep(c.st, rx, ry, fire);
    c.acc -= DT;
  }
  for (const ev of c.st.events) {
    if (ev.type === 'hit') { c.flash = { yaw: ev.yaw, pitch: ev.pitch, t: 0.3, good: true }; c.pop = { text: '+' + Math.round(ev.pts) + (ev.zone === 'bull' ? '  BULLSEYE' : ev.zone === 'inner' ? '  INNER' : ''), t: ev.zone === 'bull' ? 0.9 : 0.7 }; }
    if (ev.type === 'miss') { c.flash = { yaw: ev.yaw, pitch: ev.pitch, t: 0.2, good: false }; c.pop = { text: '−' + Math.round(ev.lost ?? c.st.P.missPenalty), t: 0.5 }; }
  }
  c.st.events.length = 0;
  if (c.st.done) endChallenge();
}

// The challenge steps at a fixed 60 Hz, which rarely lines up with the display's frames; drawing the
// camera between the last two ticks keeps turns smooth instead of freezing and double-jumping.
// Drawing only: the run itself (and its replay) is untouched.
function smoothView(c) {
  const v = c.st.view, p = c.prevView;
  if (!p || c.phase !== 'run' || c.st.done) return v;
  const a = clamp(c.acc / DT, 0, 1);
  return { yaw: p.yaw + (v.yaw - p.yaw) * a, pitch: p.pitch + (v.pitch - p.pitch) * a };
}

function chalScene() {
  const c = chal, it = c.st.item, st = c.st;
  const now = performance.now(), dt = c.lastDraw ? Math.min(0.1, (now - c.lastDraw) / 1000) : 0;
  c.lastDraw = now;
  c.shown = (c.shown || 0) + (st.score - (c.shown || 0)) * Math.min(1, dt * 9);
  return {
    view: smoothView(c), zoom: 1, phase: c.phase === 'run' ? 'run' : c.phase, countLeft: c.countLeft, figure: true,
    worldKey: c.code, gameId: c.game, hfov: hfovFor(c.game),
    hud: { shown: c.shown, streak: st.streak, left: (st.ticks - st.tick) * DT, total: st.ticks * DT,
      label: c.duel ? `RUN ${c.duel.i + 1}/${DUEL.runs}` : null },
    // Between targets (version 2) nothing is drawn, but the last hit's sparks still play.
    flick: !it ? { cur: null, flash: c.flash } : it.kind !== 'track' ? { cur: it.T, flash: c.flash } : null,
    track: it && it.kind === 'track' ? it.TR : null,
    hold: !!st.P.holdFire,
    // Points for the last hit or miss rise from beside the score counter, keeping the aim area clear.
    overlay: mousePaused(c.phase) ? drawPaused : c.pop && c.pop.t > 0 ? (ctx, W, H, d) => {
      ctx.globalAlpha = clamp(c.pop.t / 0.3, 0, 1);
      ctx.fillStyle = c.pop.text.startsWith('+') ? '#FFE7B0' : '#FF8A64';
      ctx.font = `900 ${Math.round(26 * d)}px 'Big Shoulders Stencil Display', 'Big Shoulders Display', sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8 * d;
      ctx.fillText(c.pop.text, 18 * d + 150 * d, 18 * d + 34 * d - (0.7 - c.pop.t) * 18 * d);
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    } : null
  };
}

let chalBriefKey = '';
// The scoring guide on the challenge start screen: open the first time, then folded into
// "How it scores". Hidden once the run starts and for settings-duel runs after the first.
const GUIDE_KEY = 'dialed-in:guide-seen';
function showChalGuide(c) {
  const el = $('#chal-guide');
  const show = c.phase === 'intro' && (!c.duel || c.duel.i === 0);
  el.hidden = !show;
  if (!show) return;
  let seen = false;
  try { seen = localStorage.getItem(GUIDE_KEY) === '1'; localStorage.setItem(GUIDE_KEY, '1'); } catch (e) { /* storage blocked: show it open */ }
  if (!el.dataset.ready) { el.open = !seen; el.dataset.ready = '1'; }
  const P = c.st.P, mouse = c.st.mouse, fire = mouse ? 'click' : 'fire';
  $('#cg-flick').textContent = `One ${mouse ? 'click' : 'shot'}. Faster = more points`;
  $('#cg-track').textContent = P.holdFire ? `Hold ${fire} while you stay on it` : 'Keep the crosshair on it';
  const level = c.code[0] === 'h' ? 'Hard: standing targets sit farther out and are smaller, the strafer is quicker, each target gives you 2.8 seconds, and a near miss ends the streak.'
    : c.code[0] === 'w' ? 'Warm-up: standing targets sit closer to the crosshair and are a little bigger.'
    : P.spread ? 'Standing targets can appear anywhere from close in to the edge of the screen. Wider ones are worth more.' : null;
  const rules = [
    ...(level ? [level] : []),
    `60 seconds. Each hit in a row adds 10% to the next, up to double points.`,
    ...(P.even ? ['Every run deals the same mix of targets (near and far, big and small, strafers and turn-arounds) in a new order, so no day is luckier than another.'] : []),
    ...(P.precision ? ['Hits near the centre score more: bullseye ×1.5, inner ring ×1.2, edge ×1.'] : []),
    `A miss costs ${P.missPenalty} points${P.nearMiss ? '. Your first near miss on a target keeps the streak' : ' and ends the streak'}.`,
    P.holdFire ? `Moving targets score only while you're on them and ${mouse ? 'holding the button' : 'holding fire'}. Firing off them costs nothing.` : 'Moving targets score for every second you stay on them.',
    ...(c.st.v >= 2 && !mouse ? ['Aim assist is on (medium), like your game.'] : [])
  ];
  const ul = $('#cg-rules');
  ul.textContent = '';
  for (const r of rules) { const li = document.createElement('li'); li.textContent = r; ul.append(li); }
}

function renderChalBrief(force) {
  const c = chal, key = c.phase + inp.src + mouse.locked;
  if (key === chalBriefKey && !force) return;
  chalBriefKey = key;
  const di = c.duel ? c.duel.i : 0;
  $('#swipe-fig').hidden = true;
  showChalGuide(c);
  $('#brief-title').textContent = c.duel ? (c.phase === 'rate' ? `How did the speed of run ${di + 1} feel?` : `Settings duel · run ${di + 1} of ${DUEL.runs}`)
    : c.kind === 'daily' ? `Daily challenge · ${c.code.slice(2)}` : c.kind === 'practice' ? 'Practice challenge' : `Challenge ${c.code}`;
  $('#brief-text').textContent = c.phase === 'rate' ? 'Go with your gut. You can skip this.'
    : c.phase !== 'intro' ? (c.phase === 'count' ? 'Get ready.' : 'Go.')
    : !c.duel ? '60 seconds of standing, moving and behind-you targets, the same for everyone who plays this code. How it scores is below.'
    : di === 0 ? `${DUEL.runs} challenge runs of ${DUEL.seconds} seconds. Two use your old settings and two use the suggested ones, in a hidden order, and each pair plays the same targets.`
    : `Run ${di + 1} of ${DUEL.runs}. Same drill. The settings may have changed.`;
  const act = $('#brief-actions');
  act.textContent = '';
  if (c.phase === 'rate') {
    const row = document.createElement('div');
    row.className = 'rate';
    for (const r of RATINGS) {
      const b = button(r.label, '', () => duelRate(r.v));
      if (inp.src === 'pad') { const small = document.createElement('small'); small.textContent = r.glyph; b.append(small); }
      row.append(b);
    }
    row.append(button('Skip', 'small', () => duelRate(null)));
    act.append(row);
    return;
  }
  if (c.phase === 'intro') {
    act.append(button('Start', 'primary', () => { if (isMouse()) mouse.lock(); c.phase = 'count'; c.countLeft = 3; renderChalBrief(true); }));
    act.append(button('Back', '', leaveChallenge));
    if (isMouse()) act.append(hint(mouse.locked ? 'Click to start. Esc lets the mouse go.' : 'The range captures your mouse. Esc lets it go.'));
    else if (inp.src === 'pad') act.append(hint('or press A / ✕'));
  } else {
    if (mousePaused(c.phase)) act.append(button('Resume', 'primary', () => mouse.lock()));
    act.append(button('Stop', 'small', leaveChallenge));
  }
}

function leaveChallenge() { chal = null; mouse.unlock(); show(result ? 'results' : 'setup'); }

/* settings duel */

// A = the player's current settings, B = the suggested ones, including the turn drill's boost advice.
// Copies the suggested settings into setup and saves them, so the daily range and the next session
// play with them. The game's own menu still has to be changed by hand.
function useRecs(c, r) {
  const B = duelSettings(c, r).B;
  for (const k of ['sens', 'vsens', 'vmult', 'curve', 'dz', 'outer', 'boost', 'boostRamp']) if (B[k] !== undefined) cfg[k] = B[k];
  for (const a of r.ads || []) if (!a.spec.generic && a.next != null) cfg.ads[a.spec.key] = a.next;
  // A spin timing belongs to the sensitivity it was timed at. Carry it to the new one (the same turn
  // speed multiplier, so the time scales with the speed) rather than lose the player's measurement.
  const g = GAMES[c.game];
  if (cfg.spin && r.sens !== c.sens) cfg.spin = +(cfg.spin * g.sens.rate(c.sens) / g.sens.rate(r.sens)).toFixed(2);
  saveSetup();
  syncSetup();
}

function duelSettings(c, r) {
  const A = settingsOf(c);
  const B = { ...settingsOf(r),
    boost: r.turn && r.turn.boost != null ? r.turn.boost : c.boost,
    boostRamp: r.turn && r.turn.ramp != null ? r.turn.ramp : c.boostRamp };
  return { A, B, differs: JSON.stringify(A) !== JSON.stringify(B) };
}

function startDuel() {
  const { A, B } = duelSettings(result.cfg, result.rec);
  const duel = { plan: duelPlan(), i: 0, runs: [], A, B, game: result.cfg.game, style: result.cfg.style };
  startDuelRun(duel);
}
function startDuelRun(duel) {
  const run = duel.plan[duel.i];
  startChallenge(run.code, 'duel', { settings: run.key === 'A' ? duel.A : duel.B, game: duel.game, seconds: DUEL.seconds, duel });
}
function duelRate(v) {
  const duel = chal.duel;
  duel.runs[duel.runs.length - 1].rating = v;
  duel.i++;
  if (duel.i < DUEL.runs) return startDuelRun(duel);
  duel.result = duelCompare(duel.runs, PLAYSTYLES[duel.style]);
  if (result) result.duel = duel.result;
  show('chend');
}

function renderDuelEnd() {
  const duel = chal.duel, { cmp, pairs, scoreDelta } = duel.result;
  const feel = k => ratingSummary(duel.runs.filter(r => r.key === k && r.rating != null).map(r => r.rating));
  const head = !cmp ? 'Not enough targets to compare'
    : { better: 'The new settings won', worse: 'Your old settings won', close: 'Too close to call' }[cmp.verdict];
  const body = !cmp ? 'Some runs ended with too few targets to score. Try the duel again.'
    : cmp.verdict === 'close'
      ? `On the same targets the new settings scored ${signed(scoreDelta)} overall. Four short runs can only pick out a clear difference, about 15% or more, so either works. Go with whichever felt better.`
      : `On the same targets the new settings scored ${signed(scoreDelta)} overall, ${pct(cmp.verdict === 'better' ? cmp.overall.p : 1 - cmp.overall.p)} likely a real difference. ${cmp.verdict === 'better' ? 'Go with the new settings.' : 'Keep your old settings.'}`;
  $('#p-chend').innerHTML = `
    <div class="verdict ${cmp ? cmp.verdict : ''}">
      <div style="display:grid;gap:4px"><p class="eyebrow">Settings duel · ${DUEL.runs} runs of ${DUEL.seconds} s</p><h3>${head}</h3><p>${body}</p></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Targets</th><th>Old settings</th><th>New settings</th></tr></thead>
        <tbody>${pairs.map((p, i) => `<tr><td>Set ${i + 1} <span class="hint">${p.code}</span></td><td class="num">${p.a.toLocaleString('en-US')}</td><td class="num">${p.b.toLocaleString('en-US')}</td></tr>`).join('')}
          <tr><td>How it felt</td><td>${feelLabel(feel('A'))}</td><td>${feelLabel(feel('B'))}</td></tr></tbody>
      </table></div>
    </div>
    <div class="actions">
      ${result ? '<button class="btn primary" id="duel-back" type="button">Back to your settings</button>' : ''}
      <button class="btn" id="ch-back" type="button">Back to setup</button>
    </div>
    <p class="fine">The verdict uses the same rule as Verify: speed and accuracy on every target, resampled by run, with a winner only at 90% odds and a 15% difference.</p>`;
  const db = $('#duel-back');
  if (db) db.addEventListener('click', () => { chal = null; show('results'); });
  $('#ch-back').addEventListener('click', () => { chal = null; result = null; show('setup'); });
}

/* personal bests, kept in this browser only */
const BEST_KEY = 'dialed-in:bests';
function loadBests() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY)) || {}; } catch (e) { return {}; }
}
// Mouse bests are kept apart from controller ones (a 'mouse:' prefix), as the boards will be.
const bestKey = (key, src) => src === 'mouse' ? 'mouse:' + key : key;
function saveBest(code, kind, score, src) {
  const b = loadBests();
  b.codes = b.codes || {};
  const k = bestKey(code, src), pk = bestKey('practice', src);
  const prev = kind === 'practice' ? (src === 'mouse' ? b.codes[pk] : b.practice) : b.codes[k];
  const isBest = prev == null || score > prev;
  if (isBest) {
    if (kind === 'practice') { if (src === 'mouse') b.codes[pk] = score; else b.practice = score; }
    else b.codes[k] = score;
    try { localStorage.setItem(BEST_KEY, JSON.stringify(b)); } catch (e) { /* storage blocked: best just isn't kept */ }
  }
  return { isBest, prev };
}
// Time left until the next daily range (codes roll over at midnight UTC).
function tickWarmClock() {
  const el = $('#warm-clock');
  if (!el) return;
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const left = Math.max(0, Math.floor((next - now.getTime()) / 1000));
  const two = n => String(n).padStart(2, '0');
  el.textContent = `${two(Math.floor(left / 3600))}:${two(Math.floor(left / 60) % 60)}:${two(left % 60)}`;
}
tickWarmClock();
setInterval(tickWarmClock, 1000);

function renderWarmBests() {
  const b = loadBests(), today = dailyCode(), codes = b.codes || {}, m = isMouse();
  const rows = [['Today', codes[bestKey(today, m ? 'mouse' : 'pad')]], ['Practice best', m ? codes['mouse:practice'] : b.practice]].filter(r => r[1] != null);
  const dl = $('#warm-best');
  dl.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v.toLocaleString('en-US');
    dl.append(dt, dd);
  }
}

function endChallenge() {
  const c = chal;
  const sum = chSummary(c.st);
  if (c.duel) {
    const run = c.duel.plan[c.duel.i];
    c.duel.runs.push({ ...run, score: sum.score, log: c.st.log, rating: null });
    c.phase = 'rate';
    mouse.unlock();
    renderChalBrief(true);
    return;
  }
  // The board comes from the input that did most of the playing, not from what was connected at the
  // start: a browser hides a controller until a button is pressed, so a run can begin before it shows up.
  const used = Object.entries(c.used).sort((a, b) => b[1] - a[1]);
  if (used.length) c.src = used[0][0];
  c.result = { sum, best: saveBest(c.code, c.kind, sum.score, c.src), replay: encodeReplay(c.rec) };
  mouse.unlock();
  show('chend');
}

// Shared links point at the public site: the custom domain, or the github.io address before it.
const shareLink = code => /(^|\.)dialedinaim\.com$|\.github\.io$/.test(location.hostname) ? `${location.origin}${location.pathname}#${code}` : null;

function renderChalEnd() {
  const c = chal, { sum, best } = c.result, g = GAMES[c.game];
  const what = c.kind === 'daily' ? `the Dialed In daily challenge (${c.code.slice(2)})` : `Dialed In challenge ${c.code}`;
  const link = shareLink(c.code);
  const shareText = `I scored ${sum.score.toLocaleString('en-US')} on ${what} with ${pct(sum.accuracy)} accuracy. Code: ${c.code}${link ? ' ' + link : ''}`;
  const stat = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  $('#p-chend').innerHTML = `
    <div style="display:grid;gap:6px">
      <p class="eyebrow">${kindLabel(c)} · ${c.code} · ${gameTitle(g)}${c.src === 'pad' ? '' : c.src === 'mouse' ? ' · mouse' : ' · on-screen stick'}</p>
      <div class="score-hero"><b>${sum.score.toLocaleString('en-US')}</b><span>points</span>${best.isBest && best.prev != null ? '<span class="pb">New personal best</span>' : ''}</div>
      <p class="lede">${best.prev == null ? 'Your first score on this ' + (c.kind === 'practice' ? 'practice board.' : 'challenge.')
        : best.isBest ? `Up from ${best.prev.toLocaleString('en-US')}.` : `Your best here is ${best.prev.toLocaleString('en-US')}.`}</p>
    </div>
    ${medalHtml(sum.score, c.src === 'mouse')}
    <div class="ch-stats">
      ${stat('Accuracy', pct(sum.accuracy))}
      ${stat('Hits', sum.hits)}
      ${stat('Time per hit', sum.avgTime == null ? '–' : sum.avgTime.toFixed(2) + ' s')}
      ${stat('Best streak', sum.bestStreak)}
      ${sum.zones && sum.hits ? stat('Bullseyes', pct(sum.zones.bull / sum.hits)) : ''}
      ${c.st.P.holdFire
        ? stat('Moving targets hit', sum.trackAcc == null ? '–' : pct(sum.trackAcc))
        : stat('On moving targets', sum.tracking == null ? '–' : pct(sum.tracking))}
    </div>
    ${sum.zones && sum.hits ? `<p class="hint">Where your hits landed: Bullseye ${pct(sum.zones.bull / sum.hits)} · Inner ${pct(sum.zones.inner / sum.hits)} · Edge ${pct(sum.zones.edge / sum.hits)}</p>` : ''}
    ${reportHtml(reportCard(c.st.log, { game: c.game, style: cfg.style, v: c.st.v, mouse: c.st.mouse }))}
    <div class="share">
      <p>Share the code and anyone can play the exact same targets: <code>${c.code}</code></p>
      <pre id="copytext" hidden></pre>
    </div>
    <div class="actions">
      <button class="btn primary" id="ch-again" type="button">${c.kind === 'practice' ? 'New practice run' : 'Try again'}</button>
      <button class="btn" id="ch-share" type="button">Copy result</button>
      <button class="btn" id="ch-back" type="button">Back to setup</button>
    </div>
    ${boardsOn() ? `<div class="board" id="board">
      <div style="display:grid;gap:4px"><h3 class="sub">Leaderboard · ${c.code}</h3>
        <p class="fine">You played with ${c.src === 'pad' ? 'a controller' : c.src === 'mouse' ? 'a mouse' : 'the on-screen stick'}, so your run goes on the <b>${INPUT_LABEL[c.src].toLowerCase()}</b> board and the combined one. The board is set by what you played with; the tabs below only change which board you're looking at. Every run is replayed on the server before it counts.</p></div>
      <div class="board-tabs" role="tablist" aria-label="Which board">
        ${['all', 'pad', 'mouse', ...(c.src === 'virtual' ? ['virtual'] : [])].map(k =>
          `<button type="button" role="tab" data-board="${k}" aria-selected="${k === c.src}">${k === 'all' ? 'All inputs' : INPUT_LABEL[k]}${k === c.src ? ' (yours)' : ''}</button>`).join('')}
      </div>
      <div class="actions">
        <label for="board-name" class="sr-only">Name on the leaderboard</label>
        <input id="board-name" type="text" maxlength="20" autocomplete="nickname" placeholder="Your name" value="">
        <button class="btn primary" id="board-submit" type="button">Submit score</button>
      </div>
      <p class="hint" id="board-status" role="status"></p>
      <div class="table-wrap board-table"><p class="fine">Loading the board…</p></div>
    </div>` : '<p class="fine">Scores are kept in this browser for now. Every run is recorded so its score can be checked once leaderboards open.</p>'}`;
  $('#ch-again').addEventListener('click', () => startChallenge(c.kind === 'practice' ? practiceCode(Math.random, c.code[0]) : c.code, c.kind));
  if (boardsOn()) wireBoard(c, sum);
  $('#ch-share').addEventListener('click', e => copyText(shareText, e.currentTarget));
  $('#ch-back').addEventListener('click', leaveChallenge);
}

// Medal tiers for a 60-second run. Once enough real daily scores exist for an input type (TIER_MIN),
// the cutoffs are their percentiles: Bronze beats 40% of daily scores, Silver 65%, Gold 85%, Ace 95%.
// Before that, fixed provisional cutoffs (first set from simulated players) are used.
const TIERS = [
  { key: 'bronze', name: 'Bronze', min: 3000 },
  { key: 'silver', name: 'Silver', min: 7000 },
  { key: 'gold', name: 'Gold', min: 11000 },
  { key: 'ace', name: 'Ace', min: 15000 }
];
const TIER_MIN = 30;
const liveTiers = {};
function loadTiers(mouse) {
  const k = mouse ? 'mouse' : 'pad';
  if (!boardsOn() || liveTiers[k] !== undefined) return;
  liveTiers[k] = null;
  fetchTiers(mouse).then(t => {
    if (!t || t.n < TIER_MIN) { liveTiers[k] = t ? { n: t.n } : null; return; }
    // Rounded to 50, and kept at least 50 apart so every tier stays reachable.
    let last = 0;
    liveTiers[k] = { n: t.n, list: TIERS.map(x => { last = Math.max(last + 50, Math.round(t[x.key] / 50) * 50); return { ...x, min: last }; }) };
  }).catch(() => { liveTiers[k] = undefined; });
}
function tiersFor(mouse) {
  const t = liveTiers[mouse ? 'mouse' : 'pad'];
  return t && t.list ? t.list : TIERS;
}
function tierNote(mouse) {
  const t = liveTiers[mouse ? 'mouse' : 'pad'], who = mouse ? 'mouse' : 'controller';
  if (t && t.list) return `Medals come from ${t.n} ${who} daily scores: Bronze beats 40% of them, Silver 65%, Gold 85%, Ace 95%.`;
  const n = t ? t.n : 0;
  return `Provisional medals. Once ${TIER_MIN} ${who} daily scores are in${n ? ` (${n} so far)` : ''}, they're set from real players: Bronze beats 40%, Silver 65%, Gold 85%, Ace 95%.`;
}
function medalHtml(score, mouse = false) {
  const tiers = tiersFor(mouse);
  const got = [...tiers].reverse().find(t => score >= t.min);
  const next = tiers.find(t => score < t.min);
  const from = got ? got.min : 0;
  const fill = next ? clamp((score - from) / (next.min - from), 0, 1) : 1;
  return `<div class="medal-row">
    <div class="medal ${got ? got.key : ''}" aria-hidden="true"><span>${got ? got.name : '–'}</span></div>
    <div class="tier">
      <b>${got ? `${got.name} range` : 'Unranked'}</b>
      <div class="bar" role="img" aria-label="${pct(fill)} of the way to ${next ? next.name : 'the top'}"><i style="width:${(fill * 100).toFixed(1)}%"></i></div>
      <small>${next ? `${(next.min - score).toLocaleString('en-US')} points to ${next.name} (${next.min.toLocaleString('en-US')}).` : 'Top tier. Share the code and see who can match it.'}</small>
      <small class="fine">${tierNote(mouse)}</small>
    </div>
  </div>`;
}

function reportHtml({ rows, hints }) {
  const rate = v => v == null ? '–' : pct(v);
  const pace = v => v == null ? '–' : v <= 1 ? 'On pace' : `${pct(v - 1)} slow`;
  const most = Math.max(1, ...['side', 'vert', 'turn', 'track'].map(k => rows[k].pts));
  const bar = v => `<span class="pts-bar" style="width:${Math.max(2, 90 * Math.max(0, v) / most).toFixed(0)}px"></span>`;
  const row = (label, r, extra) => r.n ? `<tr><td>${label}</td><td class="num">${r.n}</td><td class="num">${bar(r.pts)}${Math.round(r.pts).toLocaleString('en-US')}</td><td class="num">${extra}</td></tr>` : '';
  return `<div style="display:grid;gap:10px">
    <h3 class="sub">Report card</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Targets</th><th>Count</th><th>Points</th><th>Hit rate · pace</th></tr></thead>
      <tbody>
        ${row('Sideways flicks', rows.side, `${rate(rows.side.hitRate)} · ${pace(rows.side.pace)}`)}
        ${row('Up-and-down flicks', rows.vert, `${rate(rows.vert.hitRate)} · ${pace(rows.vert.pace)}`)}
        ${row('Turn-arounds', rows.turn, `${rate(rows.turn.hitRate)} · ${pace(rows.turn.pace)}`)}
        ${row('Moving targets', rows.track, rows.track.fired ? `${rate(rows.track.fireAcc)} of firing on target` : `${rate(rows.track.on)} on target`)}
      </tbody>
    </table></div>
    ${hints.length
      ? `<ul class="hints">${hints.map(h => `<li>${h.text}</li>`).join('')}</ul><p class="fine">One run is noisy. If a hint shows up run after run, a full calibration will confirm it.</p>`
      : '<p class="fine">No settings hints from this run. Only big gaps show up after a single run.</p>'}
  </div>`;
}

const BOARD_BLOCKED = 'Couldn\'t reach the leaderboard. The claude.ai preview blocks outside connections, so use the website version for leaderboards.';

const INPUT_LABEL = { pad: 'Controller', mouse: 'Mouse', virtual: 'On-screen stick' };
// input: one input type, or 'all' (the combined board, with an Input column). root holds the
// board's tabs and its .board-table: the end screen's board or the setup screen's leaderboard.
// code ALL_TIME reads the all-time board (best daily score per player), with a Day column.
const ALL_TIME = 'all-time';
// Boards show the top BOARD_PAGE; the button expands to the top BOARD_MAX and back.
const BOARD_PAGE = 10, BOARD_MAX = 25;
async function loadBoard(code, input, root, limit = BOARD_PAGE) {
  const box = root.querySelector('.board-table'), req = root.boardReq = (root.boardReq || 0) + 1;
  root.querySelectorAll('.board-tabs [data-board]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.board === input)));
  try {
    const ever = code === ALL_TIME;
    const rows = ever ? await fetchAllTime(input, limit) : await fetchBoard(code, input, limit);
    if (!root.isConnected || req !== root.boardReq) return;
    const all = input === 'all';
    box.innerHTML = rows.length
      ? `<table><thead><tr><th>#</th><th>Name</th>${all ? '<th>Input</th>' : ''}<th>Score</th><th>Accuracy</th><th>Streak</th><th>Game</th>${ever ? '<th>Day</th>' : ''}</tr></thead><tbody>${rows.map((r, i) =>
        `<tr><td class="num">${i + 1}</td><td>${esc(r.name)}</td>${all ? `<td><span class="input-tag ${esc(r.input)}">${esc(INPUT_LABEL[r.input] || r.input)}</span></td>` : ''}<td class="num">${r.score.toLocaleString('en-US')}</td><td class="num">${r.accuracy == null ? '–' : pct(r.accuracy)}</td><td class="num">${r.best_streak ?? '–'}</td><td>${esc(GAMES[r.game] ? gameTitle(GAMES[r.game]) : r.game)}</td>${ever ? `<td class="num">${esc(String(r.code).slice(2))}</td>` : ''}</tr>`).join('')}</tbody></table>`
      : ever && dailyCode() < 'd-' + V3_FROM
        ? `<p class="fine">The all-time board opens with the ${fmtDay(V3_FROM)} daily, the first on the current rules. Today's scores stay on today's board.</p>`
        : `<p class="fine">No ${all ? '' : INPUT_LABEL[input].toLowerCase() + ' '}scores yet. Be the first.</p>`;
    // Expand when the top 10 is full (there may be more); collapse again from the top 25.
    const expanded = limit >= BOARD_MAX;
    if (expanded || rows.length >= limit) {
      const more = button(expanded ? 'Show top 10' : 'Show top 25', 'small board-more', () => {
        more.disabled = true; more.textContent = 'Loading…';
        loadBoard(code, input, root, expanded ? BOARD_PAGE : BOARD_MAX);
      });
      box.append(more);
    }
  } catch (e) {
    box.innerHTML = `<p class="fine">${BOARD_BLOCKED}</p>`;
  }
}

function wireBoard(c, sum) {
  const nameEl = $('#board-name');
  nameEl.value = savedName();
  let shown = c.src;
  const root = $('#board');
  loadBoard(c.code, shown, root);
  root.querySelectorAll('.board-tabs [data-board]').forEach(b => b.addEventListener('click', () => { shown = b.dataset.board; loadBoard(c.code, shown, root); }));
  $('#board-submit').addEventListener('click', async e => {
    const btn = e.currentTarget, status = $('#board-status');
    const name = nameEl.value.trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9 _.\-]{2,20}$/.test(name)) { status.textContent = 'Names are 2 to 20 letters, numbers, spaces, dots, dashes or underscores.'; return; }
    saveName(name);
    btn.disabled = true; status.textContent = 'Checking your run…';
    try {
      const res = await submitScore({ code: c.code, game: c.game, input: c.src, playerId: playerId(), name,
        settings: c.settings, score: sum.score, replay: c.result.replay });
      if (!res.ok) {
        // A replay mismatch almost always means the page is older than the server's rules.
        status.textContent = (res.error || 'The score was not saved.') + (/replay scored/.test(res.error || '')
          ? ' This usually means the site was updated while this page was open. Refresh the page and play the run again.' : '');
        btn.disabled = false; checkVersion(); return;
      }
      const where = `#${res.rank} of ${res.total} on the ${INPUT_LABEL[c.src].toLowerCase()} board${res.rankAll ? `, #${res.rankAll} of ${res.totalAll} across all inputs` : ''}`;
      status.textContent = res.saved
        ? `Verified and saved. You're ${where}.`
        : `Verified. Your best here is still ${res.best.toLocaleString('en-US')}: ${where}.`;
      btn.textContent = 'Submitted';
      loadBoard(c.code, shown, root);
      showAllTimeStanding(c, sum.score, status);
    } catch (err) {
      status.textContent = BOARD_BLOCKED;
      btn.disabled = false;
    }
  });
}

// After a daily submit: where the score stands all time, with a call-out for a new record.
async function showAllTimeStanding(c, score, status) {
  let el = $('#board-ever');
  if (!el) { el = document.createElement('p'); el.id = 'board-ever'; el.className = 'board-ever'; status.after(el); }
  el.className = 'board-ever';
  if (!c.code.startsWith('d-')) { el.textContent = ''; return; }
  if (c.code < 'd-' + V3_FROM) { el.textContent = `All time starts with the ${fmtDay(V3_FROM)} daily, when the current rules began, so this one counts for today only.`; return; }
  const board = INPUT_LABEL[c.src].toLowerCase();
  try {
    const [mine, all] = await Promise.all([fetchAllTimeRank(c.src, score), fetchAllTimeRank(null, score)]);
    if (!mine) return;
    const n = v => v.toLocaleString('en-US');
    const ownBetter = mine.own_best != null && mine.own_best > score;
    const recordHere = !ownBetter && (mine.others_best == null || score > mine.others_best);
    const recordAll = recordHere && all && (all.others_best == null || score > all.others_best);
    if (recordHere) {
      el.className = 'board-ever record';
      el.textContent = mine.total <= 1
        ? `New all-time record: the first ${board} score on the all-time board.`
        : `New all-time record on the ${board} board${recordAll ? ', and the best across all inputs' : ''}!`;
      return;
    }
    const where = `#${mine.rank} of ${mine.total} all time on the ${board} board${all ? `, #${all.rank} of ${all.total} across all inputs` : ''}`;
    el.textContent = ownBetter
      ? `This run places ${where}. Your all-time best is ${n(mine.own_best)}.`
      : `New personal all-time best: ${where}.${mine.others_best != null ? ` The record is ${n(mine.others_best)}.` : ''}`;
  } catch (e) { el.textContent = ''; }
}

// The setup screen's leaderboard: today's daily range or all time, on the tabs last picked.
let leaderTab = 'all', leaderPeriod = 'today';
const fmtDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function showLeader() {
  const root = $('#p-leader');
  root.hidden = !boardsOn();
  if (root.hidden) return;
  const ever = leaderPeriod === 'ever';
  $('#leader-title').textContent = ever ? 'All time' : `Today's daily range · ${dailyCode().slice(2)}`;
  $('#leader-note').textContent = ever
    ? `Each player's best daily range score ever, one row per player and input. Daily targets change every day but are built the same way, so scores compare fairly. It counts dailies from ${fmtDay(V3_FROM)}, when the current rules began (hold fire on moving targets); ${dailyCode() < 'd-' + V3_FROM ? "today's daily is on the old rules, so it shows under Today only" : 'earlier ones played differently'}. Practice runs don't count.`
    : 'Play the daily range above and press Submit score on the results screen to get on it. Practice runs get a fresh code each time, so their boards are only shared by passing the code along.';
  root.querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.period === leaderPeriod)));
  loadBoard(ever ? ALL_TIME : dailyCode(), leaderTab, root);
}
$('#p-leader').querySelectorAll('.board-tabs [data-board]').forEach(b => b.addEventListener('click', () => { leaderTab = b.dataset.board; showLeader(); }));
$('#p-leader').querySelectorAll('[data-period]').forEach(b => b.addEventListener('click', () => { leaderPeriod = b.dataset.period; showLeader(); }));

const esc = t => String(t).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function startCodeFromInput() {
  const code = $('#ch-code').value.trim().toLowerCase();
  if (!isCode(code)) { $('#ch-note').textContent = 'That code doesn\'t look right. Codes look like d-2026-10-21 or p-k3x9q2 (h- for Hard, w- for Warm-up).'; return; }
  startChallenge(code, code === dailyCode() ? 'daily' : 'code');
}
$('#ch-daily').addEventListener('click', () => startChallenge(dailyCode(), 'daily'));
const LEVEL_KEY = 'dialed-in:level';
try { const lv = localStorage.getItem(LEVEL_KEY); if (LEVEL_NAME[lv]) $('#ch-level').value = lv; } catch (e) { /* storage blocked: Standard */ }
// Full screen: the test panel (brief, range and buttons) takes the whole display. F toggles it too.
function toggleFullscreen() {
  const el = $('#p-test');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}
$('#fs-btn').addEventListener('click', toggleFullscreen);
$('#lite').checked = lite;
$('#lite').addEventListener('change', e => setLite(e.target.checked, ''));
// A graphics driver reset takes the canvas with it; the browser rebuilds it, and the range drops to
// lighter graphics so it is less likely to happen again.
$('#arena').addEventListener('contextlost', () => setLite(true, 'Your graphics driver reset, so the range switched to lighter graphics. Untick it to go back.'));
$('#arena').addEventListener('contextrestored', () => { lastDraw = 0; });
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  $('#fs-btn').setAttribute('aria-pressed', String(on));
  $('#fs-btn').textContent = on ? '⛶ Exit full screen' : '⛶ Full screen';
});
window.addEventListener('keydown', e => { if (e.key === 'f' && screen === 'test' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) toggleFullscreen(); });
$('#ch-level').addEventListener('change', e => { try { localStorage.setItem(LEVEL_KEY, e.target.value); } catch (err) { /* not remembered */ } });
$('#ch-practice').addEventListener('click', () => startChallenge(practiceCode(Math.random, $('#ch-level').value), 'practice'));
$('#ch-code-go').addEventListener('click', startCodeFromInput);
$('#ch-code').addEventListener('keydown', e => { if (e.key === 'Enter') startCodeFromInput(); });
{
  // A shared link (#d-2026-10-21) fills in its code.
  const h = location.hash.slice(1).toLowerCase();
  if (isCode(h)) { $('#ch-code').value = h; $('#ch-note').textContent = `Shared challenge ${h} is ready. Press Play code.`; }
}

let lastStatus = '';
function updateStatus() {
  const f = n => (n >= 0 ? ' ' : '') + n.toFixed(2);
  $('#ro-r').textContent = f(inp.rx) + ',' + f(inp.ry);
  $('#ro-l').textContent = f(inp.lx) + ',' + f(inp.ly);
  $('#ro-f').textContent = inp.fire ? 'held' : 'released';
  const m = mouseCheck;
  const status = inp.src + '|' + inp.name + '|' + gpBlocked + '|' + mouse.locked + '|' + mouse.raw + '|' + (m && m.cpcm);
  if (status !== lastStatus) {
    lastStatus = status;
    const mo = inp.src === 'mouse';
    $('#pad-panel').hidden = mo;
    $('#mouse-panel').hidden = !mo;
    if (mo) {
      $('#mo-lock').textContent = mouse.locked ? 'captured' : 'released';
      $('#mo-raw').textContent = mouse.raw == null ? 'not checked' : mouse.raw ? 'yes' : 'no (OS settings apply)';
      $('#mo-hz').textContent = m && m.hz ? `about ${m.hz} Hz` : 'not checked';
      $('#mo-dpi').textContent = m && m.cpcm ? `about ${Math.round(m.cpcm * 2.54)} (entered ${cfg.dpi})` : `${cfg.dpi} entered`;
    }
    $('#pill').classList.toggle('on', inp.src === 'pad' || mo);
    $('#pill-text').textContent = mo ? (mouse.locked ? 'Mouse captured' : 'Mouse') : inp.src === 'pad'
      ? inp.name.replace(/\s*\(.*$/, '') || 'Controller connected'
      : 'No controller. Press any button to connect.';
    const note = $('#pad-note');
    note.classList.toggle('warn', gpBlocked);
    note.textContent = gpBlocked
      ? 'This view blocks controller access. Open the standalone copy of this page in Chrome or Edge to use a controller.'
      : inp.src === 'pad'
        ? 'Controller connected. The dashed ring shows the deadzone the range is using.'
        : 'Plug in or pair a PlayStation or Xbox controller, then press any button. Chrome and Edge work best.';
    $('#vpad-panel').hidden = inp.src === 'pad' || mo;
    if (screen === 'test') { if (chal) renderChalBrief(true); else renderBrief(true); }
  }
  let l = '', r = '';
  const s = seg();
  if (chal && screen === 'test' && chal.phase === 'run') {
    const st = chal.st;
    l = `${Math.round(st.score).toLocaleString('en-US')} pts`;
    r = `${Math.max(0, (st.ticks - st.tick) * DT).toFixed(1)} s${st.streak > 1 ? ' · streak ' + st.streak : ''}${chal.duel ? ' · run ' + (chal.duel.i + 1) + ' of ' + DUEL.runs : ''}`;
  }
  if (screen === 'test' && session && session.phase === 'run') {
    if (s.kind === 'flick') {
      l = `Target ${Math.min(s.data.list.length + 1, s.n)} / ${s.n}`;
      r = `${s.data.list.filter(x => x.hit).length} hits${s.counter ? ' · ' + s.counter : ''}`;
    } else if (s.kind === 'track') {
      const TR = s.data;
      l = TR.t < TR.warm ? 'Settle in' : `On target ${pct(TR.T ? TR.on / TR.T : 0)}`;
      r = `${Math.max(0, s.warm + s.dur - TR.t).toFixed(1)} s${s.counter ? ' · ' + s.counter : ''}`;
    }
  }
  $('#hud').classList.toggle('off', !!chal);
  $('#hud-l').textContent = l; $('#hud-r').textContent = r;
}

// Drawing is capped at 120 frames a second (60 with lighter graphics): high-refresh monitors would
// otherwise redraw the range 144-240 times a second for no visible gain. Input and timing still run every frame.
let lastDraw = 0, styleAge = 0;
const drawStats = []; // ms per drawn frame, for the debug hook
// A computer that can't keep up gets lighter graphics on its own: after 2 seconds of a test, if the
// median frame took over 14 ms to draw. Never overrides a choice the player made with the checkbox.
let autoChecked = false;
function autoLite() {
  if (autoChecked || lite || screen !== 'test' || drawStats.length < 120) return;
  let chosen = null;
  try { chosen = localStorage.getItem(LITE_KEY); } catch (e) { /* no stored choice */ }
  autoChecked = true;
  if (chosen === '0') return;
  const last = drawStats.slice(-120).sort((a, b) => a - b);
  if (last[60] > 14) setLite(true, 'Your computer was working hard to draw the range, so it switched to lighter graphics for smoother aiming. Untick it to go back.');
}
function frame(ts) {
  const dt = lastT ? Math.min(0.05, (ts - lastT) / 1000) : 0;
  lastT = ts;
  if (!css || ++styleAge > 30) { css = getComputedStyle(document.documentElement); styleAge = 0; }
  inp = poll();
  const edge = {};
  for (const k of ['fire', 'dl', 'du', 'dr', 'lb', 'rb']) { edge[k] = inp[k] && !prev[k]; prev[k] = inp[k]; }
  if (screen === 'test' && chal) chalTick(dt, edge);
  else if (screen === 'test' && session) tick(dt, edge);
  updateStatus();
  if (ts - lastDraw >= 1000 / (lite ? 60 : 120) - 2) {
    lastDraw = ts;
    const t0 = performance.now();
    drawSticks();
    drawArena();
    drawStats.push(performance.now() - t0); if (drawStats.length > 600) drawStats.shift();
    autoLite();
  }
  requestAnimationFrame(frame);
}

/* ---------- staying current ---------- */

// The website build checks version.json (written next to the page at deploy) for a newer build. A page
// left open across a deploy would otherwise play challenges under old rules that the server no
// longer replays the same way. Only on the website: the file and the claude.ai preview have no version.json.
const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
let outdated = false;
async function checkVersion() {
  if (!/^https?:$/.test(location.protocol) || outdated) return;
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { build } = await res.json();
    if (build && build !== BUILD) { outdated = true; $('#update-bar').hidden = false; }
  } catch (e) { /* offline or blocked: keep going */ }
}
$('#update-reload').addEventListener('click', () => location.reload());
checkVersion();
setInterval(checkVersion, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });

// Read-only hook for automated browser tests (page opened with ?debug); not used by the app.
if (new URLSearchParams(location.search).has('debug')) window.dialedInDebug = { drawStats: () => drawStats.slice(), chal: () => chal, session: () => session, view: () => view, game: () => game() };

restoreSetup();
syncSetup();
show('setup');
// Any edit to the setup form is saved as it happens.
$('#p-setup').addEventListener('change', () => { readSetup(); saveSetup(); });
$('#setup-reset').addEventListener('click', () => {
  const s = loadSaved();
  if (s.games) delete s.games[cfg.game];
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (e) { /* nothing saved anyway */ }
  setGame(cfg.game, false);
  syncSetup();
  saveSetup();
});
requestAnimationFrame(frame);

logEvent('visit');
