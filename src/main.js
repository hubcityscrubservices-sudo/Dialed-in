import { GAMES, PLAYSTYLES, gameTitle, extraSetting, adsSpecs, fmtAds } from './games.js';
import { FOV, makeView, steer, newFlickTarget, flickStep, makeTrack, trackStep, newTurnTarget, turnStep } from './sim.js';
import { summarize, recommend, recommendVertical, recommendAds, turnStats, recommendTurn, driftDeadzone, settingsChanged } from './analysis.js';
import { verifyPlan, verifyCompare, ratingSummary, sideOf } from './verify.js';
import { DEEP, SCREEN, deepNext, deepAnalyze, shuffled, screenPlan, altCurve, screenAnalyze } from './deep.js';
import { emptyReach, recordReach, coverage, stickReport, outerFromReach, hardwareRecs } from './hardware.js';
import { clamp, pct } from './util.js';
import { buildExport } from './export.js';
import { DT, dailyCode, practiceCode, isCode, quantize, createChallenge, step as chStep, summary as chSummary,
  newRecording, record, encodeReplay } from './challenge.js';
import { reportCard } from './report.js';
import { DUEL, duelPlan, duelCompare } from './duel.js';

const $ = s => document.querySelector(s);
const QUICK = { flicks: 12, trackSeconds: 15 };
// Two of every five flick targets sit mostly above or below, to measure vertical aim.
const verticalSlot = i => i % 5 === 1 || i % 5 === 3;
const VERIFY = { flicks: 7, warmFlicks: 1, trackSeconds: 9, warmSeconds: 1.5 };
const DEEP_ROUND = { flicks: 8, warmFlicks: 1, trackSeconds: 8, warmSeconds: 1.5 };
const DRIFT_SECONDS = 4, ROLL_SECONDS = 10, SQUEEZE_SECONDS = 8;
const RAIL = { setup: 'Setup', drift: 'Sticks', flick: 'Flicks', track: 'Tracking', deep: 'Search', screen: 'Screen', turn: 'Turns', ads: 'ADS', verify: 'Verify', results: 'Results' };
const ADS = { flicks: 8, seconds: 8, scopedFlicks: 6, scopedSeconds: 6 };
const TURNS = 6;
const RATINGS = [
  { v: 1, label: 'Rough', key: 'dl', glyph: '←' },
  { v: 2, label: 'OK', key: 'du', glyph: '↑' },
  { v: 3, label: 'Great', key: 'dr', glyph: '→' }
];
const MODE_HINT = { quick: 'About 3 minutes', verify: 'About 5 minutes', deep: 'About 8 minutes' };

const adsDefaults = g => Object.fromEntries(adsSpecs(g).map(sp => [sp.key, sp.def]));
const boostDefaults = g => g.boost && g.boost.setting ? { boost: g.boost.setting.def, boostRamp: g.boost.rampSetting.def } : { boost: undefined, boostRamp: undefined };
const cfg = { game: 'arc', style: 'balanced', mode: 'verify', sens: GAMES.arc.sens.def, vsens: GAMES.arc.vsens.def, ads: adsDefaults(GAMES.arc), ...boostDefaults(GAMES.arc), curve: 'mid', dz: 0.10 };
let screen = 'setup';  // setup | test | results
let session = null;    // { segs, i, phase, countLeft, drift }
let result = null;     // { cfg, stats, rec, drift, verify }
const view = makeView();
let inp = { src: 'virtual', name: null, lx: 0, ly: 0, rx: 0, ry: 0, fire: false, dl: false, du: false, dr: false };
let prev = { fire: false, dl: false, du: false, dr: false };
let lastT = 0, gpBlocked = false;

const game = () => GAMES[cfg.game];
const seg = () => session && session.segs[session.i];
const settingsOf = c => ({ sens: c.sens, vsens: c.vsens, vmult: c.vmult ?? 1, curve: c.curve, dz: c.dz, outer: c.outer ?? 1, boost: c.boost, boostRamp: c.boostRamp });

/* ---------- session plans ---------- */

const STICK_CHECK = { kind: 'drift', rail: 'drift', title: 'Stick check',
  text: 'Three quick parts, about 15 seconds: hands off, roll both sticks around their edges, then squeeze the triggers. This measures drift, how far each stick reaches, and trigger travel.' };
const STICK_PART_TEXT = {
  rest: 'Set the controller down and keep your thumbs off both sticks.',
  roll: 'Push both sticks all the way out and roll them slowly around the edge. Two full circles.',
  squeeze: 'Squeeze both triggers all the way, slowly, then let go.'
};

// The look and outer deadzones the range should use once the stick check has run.
const checkedDz = () => session.drift ? session.drift.rec : cfg.dz;
const outerFor = check => check && check.reachR && extraSetting(game(), 'outer') ? outerFromReach(check.reachR.minReach) : 1;
const checkedOuter = () => outerFor(session.drift);

function quickSegments() {
  const s = settingsOf(cfg);
  return [
    STICK_CHECK,
    { kind: 'flick', rail: 'flick', tag: 'quick', n: QUICK.flicks, warm: 0, settings: s, intro: true, title: 'Flick test',
      text: 'Twelve targets appear one at a time, some above or below you. Snap to each with the right stick and fire with RT / R2. Go at the speed you would in a real fight.' },
    { kind: 'track', rail: 'track', tag: 'quick', dur: QUICK.trackSeconds, warm: 0, settings: s, intro: true, title: 'Tracking test',
      text: 'Keep the crosshair on the strafing target for 15 seconds. No need to fire.' },
    turnSegment(),
    ...adsSegments(),
    { kind: 'analyze' }
  ];
}

// Big turns at full stick, alternating sides, to tune look boost and its ramp-up.
function turnSegment() {
  return { kind: 'flick', turn: true, rail: 'turn', tag: 'turn', n: TURNS, warm: 0, settings: settingsOf(cfg), intro: true,
    title: 'Turn-around drill',
    text: `${TURNS} targets appear far to your side or behind you. Swing round fast, stop on each and fire. The arrow shows which way to turn.` };
}

function turnRec(c) {
  const s = session.segs.find(x => x.turn);
  return recommendTurn(s && s.data ? turnStats(s.data.list) : null, c, { boost: c.boost, ramp: c.boostRamp });
}

// Zoomed rounds at the current hip-fire settings times each ADS multiplier: a 1.5x sight, then a 4x scope
// when the game has a separate scoped setting. Targets shrink and slow by the zoom factor.
function adsSegments() {
  const base = settingsOf(cfg);
  return adsSpecs(game()).flatMap(spec => {
    const scoped = spec.zoom >= 3;
    const settings = { ...base, adsMult: cfg.ads[spec.key], zoomed: true };
    const title = scoped ? 'Scoped test' : 'ADS test';
    const n = scoped ? ADS.scopedFlicks : ADS.flicks, dur = scoped ? ADS.scopedSeconds : ADS.seconds;
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
    segs.push({ kind: 'rate', rail: 'verify', key: r.key, counter: title, title: `How did round ${k + 1} feel?`,
      text: 'Go with your gut. Your answer is shown next to the measurements at the end.' });
  });
  segs.push({ kind: 'verdict' });
  return segs;
}

function deepSegments() {
  return [
    STICK_CHECK,
    { kind: 'deepNext' }
  ];
}

// Queues the next search round, or the read-out when the search is done.
function deepStep() {
  const D = session.deep;
  if (D.pending) {
    const r = D.pending, parts = session.segs.filter(x => x.round === r);
    const fl = parts.find(x => x.kind === 'flick'), tr = parts.find(x => x.kind === 'track'), ra = parts.find(x => x.kind === 'rate');
    D.history.push({ x: r.x, sens: r.sens, flicks: fl.data.list.slice(fl.warm), chunks: tr.data.chunks, track: tr.data, rating: ra.data });
    D.pending = null;
  }
  const next = deepNext(D.history, PLAYSTYLES[cfg.style], game(), cfg.sens, D.order);
  if (!next) {
    D.res = deepAnalyze(D.history, PLAYSTYLES[cfg.style], game(), cfg.sens);
    const best = D.res && D.res.verdict !== 'flat' ? D.res.best.sens : cfg.sens;
    session.segs.push(...screenSegments(D, best), turnSegment(), ...adsSegments(), { kind: 'deepDone' });
    return advance();
  }
  const k = D.history.length + 1;
  const round = { x: next.x, sens: next.sens };
  const settings = { sens: next.sens, ...verticalFor(next.sens), curve: cfg.curve, dz: checkedDz(), outer: checkedOuter() };
  // The search always plays DEEP.minRounds; it adds up to two more only when the best speed is still unclear.
  const title = k <= DEEP.minRounds ? `Round ${k} of ${DEEP.minRounds}` : `Extra round ${k - DEEP.minRounds} of up to ${DEEP.maxRounds - DEEP.minRounds}`;
  D.pending = round;
  session.segs.push(
    { kind: 'flick', rail: 'deep', round, counter: title, n: DEEP_ROUND.flicks, warm: DEEP_ROUND.warmFlicks, settings, intro: true, title,
      text: k === 1
        ? `The search runs ${DEEP.minRounds} short rounds, plus up to ${DEEP.maxRounds - DEEP.minRounds} extra if your best speed is still unclear. Each is ${DEEP_ROUND.flicks} targets, then ${DEEP_ROUND.trackSeconds} seconds of tracking, at a hidden sensitivity. Each round's speed is picked from how you did in the earlier ones.`
        : `${DEEP_ROUND.flicks} targets, then tracking. The sensitivity has probably changed. Play the way you normally would.` },
    { kind: 'track', rail: 'deep', round, counter: title, dur: DEEP_ROUND.trackSeconds, warm: DEEP_ROUND.warmSeconds, settings, title, text: 'Stay on the moving target.' },
    { kind: 'rate', rail: 'deep', round, counter: title, title: `How did round ${k} feel?`, text: 'Go with your gut. Your ratings are shown next to the scores at the end.' },
    { kind: 'deepNext' }
  );
  advance();
}

// Screening: four blind rounds at the best speed covering both curves x two vertical speeds.
function screenSegments(D, best) {
  const g = game();
  const base = D.history.filter(h => h.sens === cfg.sens);
  const from = base.length ? base : D.history;
  const wanted = recommend(summarize(from.flatMap(h => h.flicks), from[0].track), cfg, session.drift).curve;
  const alt = altCurve(g, cfg.curve, wanted);
  const vBase = verticalFor(best);
  const vAt = f => g.vsens ? { vsens: nearestVsens(g.vsens.rate(vBase.vsens) * f) } : { vmult: vBase.vmult * f };
  D.screen = { best, curves: [cfg.curve, alt || cfg.curve], verts: [vAt(SCREEN.vLow), vAt(SCREEN.vHigh)], vBase };
  return screenPlan().flatMap((p, k) => {
    const settings = { sens: best, ...D.screen.verts[p.vert], curve: D.screen.curves[p.curve], dz: checkedDz(), outer: checkedOuter(), boost: cfg.boost, boostRamp: cfg.boostRamp };
    const title = `Check ${k + 1} of 4`;
    return [
      { kind: 'flick', rail: 'screen', screen: p, counter: title, n: DEEP_ROUND.flicks, warm: DEEP_ROUND.warmFlicks, settings, intro: true, title,
        text: k === 0
          ? `Four more rounds at your best speed. The response curve and vertical speed change between them, hidden, to see whether either one matters for you.`
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
  const base = D.history.filter(h => h.sens === c.sens);
  const from = base.length ? base : D.history;
  const stats = summarize(from.flatMap(h => h.flicks), from[0].track);
  const rec = withHardware(recommend(stats, c, session.drift), session.drift);
  if (res) {
    rec.sens = res.verdict === 'flat' ? c.sens : res.best.sens;
    rec.sensWhy = deepWhy(res, c);
  }
  // Every round scales vertical with horizontal, so the up/down vs side-to-side comparison holds across all of them.
  Object.assign(rec, recommendVertical(D.history.flatMap(h => h.flicks), c, rec.sens));
  applyScreen(rec, c, D);
  rec.ads = adsRecs(c, rec.sens);
  rec.turn = turnRec(c);
  rec.boost = c.boost; rec.boostRamp = c.boostRamp;
  result = { cfg: c, stats, rec, drift: session.drift, verify: null, segs: session.segs, pad: inp.name,
    deep: { res, rounds: D.history.map(h => ({ sens: h.sens, rating: h.rating })), screen: rec.screen } };
  session = null;
  show('results');
}

function deepWhy(res, c) {
  const g = GAMES[c.game];
  const [lo, hi] = [res.range[0].sens, res.range[1].sens];
  const span = lo === hi ? `${lo}` : `${lo} to ${hi}`;
  if (res.verdict === 'matters') {
    const edge = res.edge ? ` Your best score came at the ${res.edge === 'hi' ? 'fastest' : 'slowest'} speed tested, so the true best may sit a little beyond it.` : '';
    return `Your score peaked at ${res.best.sens} and fell about ${pct(res.drop)} when the speed was 30% off that. Anything from ${span} is within the noise of your best.${edge}`;
  }
  if (res.verdict === 'flat') {
    return `Your score barely changed across the speeds tested (${pct(Math.max(0, res.drop))} at 30% off your best). Sensitivity is not what limits your aim, so keep whatever feels best. Your current ${c.sens} is fine.`;
  }
  return `Best guess is ${res.best.sens}, but your rounds varied too much to be sure. Anything from ${span} is reasonable in ${g.name}. Running the search again would narrow it down.`;
}

/* ---------- session flow ---------- */

function start(segs, drift, deep = null) {
  segs = segs.map(x => ({ ...x }));
  session = { segs, i: 0, phase: 'intro', countLeft: 0, drift, deep };
  enter();
}
function enter() {
  const s = seg();
  if (s.kind === 'analyze') return analyze();
  if (s.kind === 'verdict') return verdict();
  if (s.kind === 'deepNext') return deepStep();
  if (s.kind === 'deepDone') return deepDone();
  resetView();
  s.data = null;
  if (s.kind === 'rate') session.phase = 'rate';
  else if (s.intro || s.kind === 'drift') session.phase = 'intro';
  else { session.phase = 'count'; session.countLeft = 2; }
  show('test');
}
function advance() { session.i++; enter(); }
function resetView() { view.yaw = 0; view.pitch = 0; view.boostT = 0; }

function begin() {
  const s = seg();
  if (s.kind === 'drift' && inp.src !== 'pad') return;
  session.phase = 'count';
  session.countLeft = s.kind === 'drift' ? 1.5 : 3;
  resetView();
  renderBrief(true);
}
function startRun(s) {
  session.phase = 'run';
  if (s.kind === 'drift') s.data = { part: 'rest', t: 0, r: 0, l: 0, lt: 0, rt: 0, warn: 0, reachR: emptyReach(), reachL: emptyReach(), maxLt: 0, maxRt: 0, lDown: false, rDown: false };
  if (s.kind === 'flick') s.data = { list: [], cur: s.turn ? newTurnTarget(view, Math.random, 1) : newFlickTarget(view, Math.random, verticalSlot(0), 1 / (s.zoom || 1)), flash: null };
  if (s.kind === 'track') s.data = makeTrack(s.warm, 1 / (s.zoom || 1));
  renderBrief(true);
}
function stop() {
  session = null;
  show(result ? 'results' : 'setup');
}

// The outer deadzone changes how the range turns, so it travels with the settings Verify and Deep compare.
// Games without the setting keep the stick's natural reach.
function withHardware(rec, check) {
  rec.outer = outerFor(check);
  return rec;
}

function analyze() {
  const fl = session.segs.find(x => x.kind === 'flick' && x.tag === 'quick').data.list;
  const tr = session.segs.find(x => x.kind === 'track' && x.tag === 'quick').data;
  const c = { ...cfg };
  const stats = summarize(fl, tr);
  const rec = withHardware(recommend(stats, c, session.drift), session.drift);
  Object.assign(rec, recommendVertical(fl, c, rec.sens));
  rec.ads = adsRecs(c, rec.sens);
  rec.turn = turnRec(c);
  // Verify compares the other settings; look boost stays at the player's values on both sides.
  rec.boost = c.boost; rec.boostRamp = c.boostRamp;
  result = { cfg: c, stats, rec, drift: session.drift, verify: null, segs: session.segs, pad: inp.name };
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

function tick(dt, edge) {
  const s = seg(), P = session.phase;
  if (P === 'intro') { if (edge.fire) begin(); return; }
  if (P === 'rate') {
    const r = RATINGS.find(x => edge[x.key]);
    if (r) rate(r.v);
    return;
  }
  if (P === 'count') {
    session.countLeft -= dt;
    if (session.countLeft <= 0) startRun(s);
    return;
  }
  if (s.kind === 'drift') tickDrift(s, dt);
  else if (s.kind === 'flick') tickFlick(s, dt, edge.fire);
  else if (s.kind === 'track') tickTrack(s, dt);
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

function tickFlick(s, dt, fireEdge) {
  const F = s.data;
  const st = steer(view, inp, s.settings, game(), dt);
  if (F.flash) F.flash.t -= dt;
  if (s.turn) turnStep(F.cur, view, st.mag, dt);
  const out = flickStep(F.cur, view, st.mag, fireEdge, dt);
  if (out === 'miss') F.flash = { yaw: view.yaw, pitch: view.pitch, t: 0.2, good: false };
  if (out === 'hit') F.flash = { yaw: F.cur.yaw, pitch: F.cur.pitch, t: 0.3, good: true };
  if (out === 'hit' || out === 'timeout') {
    F.list.push(F.cur);
    if (F.list.length >= s.n) return advance();
    F.cur = s.turn ? newTurnTarget(view, Math.random, F.list.length % 2 ? -1 : 1) : newFlickTarget(view, Math.random, verticalSlot(F.list.length), 1 / (s.zoom || 1));
  }
}

function tickTrack(s, dt) {
  const st = steer(view, inp, s.settings, game(), dt);
  trackStep(s.data, view, st.vy, dt);
  if (s.data.t >= s.warm + s.dur) advance();
}

/* ---------- screens ---------- */

function show(name) {
  const changed = name !== screen;
  screen = name;
  $('#p-setup').hidden = name !== 'setup';
  $('#p-warm').hidden = name !== 'setup';
  $('#p-test').hidden = name !== 'test';
  $('#p-results').hidden = name !== 'results';
  $('#p-chend').hidden = name !== 'chend';
  // The step rail belongs to calibration; the warm-up challenge hides it.
  $('#steps').hidden = !!chal;
  if (!chal) renderRail();
  if (name === 'setup') renderWarmBests();
  if (name === 'test') { if (chal) renderChalBrief(true); else renderBrief(true); }
  if (name === 'results') renderResults();
  if (name === 'chend') { if (chal && chal.duel) renderDuelEnd(); else renderChalEnd(); }
  if (changed) window.scrollTo({ top: 0 });
}

function railKeys() {
  const deep = !!((session && session.deep) || (result && result.deep) || (!session && !result && cfg.mode === 'deep'));
  const keys = deep ? ['setup', 'drift', 'deep', 'screen', 'turn', 'ads'] : ['setup', 'drift', 'flick', 'track', 'turn', 'ads'];
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
    n.className = 'n'; n.textContent = String(i + 1);
    li.append(n, RAIL[k]);
    ol.append(li);
  });
}

let briefKey = '';
function renderBrief(force) {
  const s = seg();
  if (!s) return;
  const noPad = inp.src !== 'pad';
  const key = session.i + session.phase + noPad + (s.data && s.data.part || '');
  if (key === briefKey && !force) return;
  briefKey = key;
  const P = session.phase;
  $('#brief-title').textContent = s.title;
  let text = s.text;
  if (s.kind === 'drift' && noPad && P === 'intro') text = 'No controller found, so there is nothing to measure. Press a button on your controller to wake it, or skip this check.';
  if (P === 'count') text = 'Get ready.';
  if (P === 'run' && s.kind === 'drift') text = STICK_PART_TEXT[s.data.part];
  $('#brief-text').textContent = text;

  const act = $('#brief-actions');
  act.textContent = '';
  if (P === 'intro') {
    const blocked = s.kind === 'drift' && noPad;
    if (!blocked) act.append(button(s.kind === 'drift' ? 'Start stick check' : 'Start', 'primary', begin));
    if (s.kind === 'drift') act.append(button('Skip', '', () => { session.drift = null; advance(); }));
    if (!noPad && !blocked) act.append(hint('or press A / ✕'));
  } else if (P === 'rate') {
    const row = document.createElement('div');
    row.className = 'rate';
    for (const r of RATINGS) {
      const b = button(r.label, '', () => rate(r.v));
      if (!noPad) { const small = document.createElement('small'); small.textContent = 'D-pad ' + r.glyph; b.append(small); }
      row.append(b);
    }
    row.append(button('Skip', 'small', () => { seg().data = null; advance(); }));
    act.append(row);
  } else {
    if (P === 'run' && s.kind === 'drift' && s.data.part !== 'rest') act.append(button('Skip this part', 'small', () => nextStickPart(s.data)));
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
const feelLabel = v => v == null ? 'skipped' : RATINGS[clamp(Math.round(v), 1, 3) - 1].label;
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
  const rows = res.points.map((p, i) => `<tr><td class="num">${p.round}</td><td class="num">${p.sens}${p.sens === c.sens ? ' (current)' : ''}</td><td class="num">${Math.round(p.y / res.top * 100)}%</td><td>${feelLabel(d.rounds[i].rating)}</td></tr>`).join('');
  return `<div class="verdict ${res.verdict === 'matters' ? 'better' : ''}">
    <div style="display:grid;gap:4px"><p class="eyebrow">Deep search · ${res.points.length} rounds</p><h3>${head}</h3>
      <p>Each dot is one round's score at that sensitivity. The line is the fitted trend, and the shaded band is the range that scores within the noise of your best.</p></div>
    ${deepChart(res, c, g)}
    ${warm}
    ${screenTable(d.screen, g)}
    <div class="table-wrap"><table><thead><tr><th>Round</th><th>${g.sens.label}</th><th>Score vs best</th><th>Felt</th></tr></thead><tbody>${rows}</tbody></table></div>
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
  return `<div style="display:grid;gap:8px"><h3 style="font-size:16px">Tested blind at your best speed</h3>
    <div class="table-wrap"><table><thead><tr><th>Setting</th><th>Compared</th><th>Winner</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table></div>
    <p class="fine">Four rounds can only pick out a clear difference, about 15% or more. Smaller ones read as too close to tell.</p></div>`;
}

function deepChart(res, c, g) {
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

function renderResults() {
  const { cfg: c, stats: s, rec: r, verify: v } = result;
  const g = GAMES[c.game];
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
  const deepHtml = result.deep ? deepBlock(result.deep, g, c) : '';
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
      <p class="eyebrow">${gameTitle(g)} · ${PLAYSTYLES[c.style].label}${g.camera === 'third' ? ' · third person' : ''}</p>
      <h2>Your settings for ${g.name}</h2>
      <p class="lede">Set these in your game's controller menu, then play a private match or two before you judge them.</p>
    </div>
    <div class="recs">
      ${row(g.sens.label, c.sens, r.sens, tag(r.sens, c.sens), r.sensWhy)}
      ${g.vsens
        ? row(g.vsens.label, c.vsens, r.vsens, tag(r.vsens, c.vsens), r.vWhy)
        : row('Vertical sensitivity', 'Now', vRel(r.vmult), tag(Math.round(r.vmult * 100), 100) + '<span class="tag">If your game has it</span>', r.vWhy)}
      ${(r.ads || []).map(a => a.spec.generic
        ? row('ADS sensitivity', 'Now', vRel(a.rel), tag(Math.round(a.rel * 100), 100) + '<span class="tag">If your game has it</span>', a.why)
        : row(a.spec.label, fmtAds(a.spec, a.cur), fmtAds(a.spec, a.next), tag(a.next, a.cur), a.why)).join('')}
      ${turnRows(g, c, r.turn)}
      ${row(g.dz.label, g.dz.fmt(c.dz), g.dz.fmt(r.dz), r.dzMeasured ? tag(r.dz, c.dz) : '<span class="tag">Not measured</span>', r.dzWhy)}
      ${row(g.curve.label, g.curve[c.curve], g.curve[r.curve], curveTag, r.curveWhy)}
      ${hw.map(h => row(h.st.label, h.st.fmt(h.cur), h.st.fmt(h.next),
        (h.st.fmt(h.next) === h.st.fmt(h.cur) ? '<span class="tag">Keep</span>' : '<span class="tag up">Change</span>') + (h.st.known ? '' : '<span class="tag">If your game has it</span>'),
        h.why)).join('')}
    </div>
    ${deepHtml}
    ${verifyHtml}
    ${duelHtml}
    <div style="display:grid;gap:10px">
      <h3 style="font-size:16px">What the tests measured</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Measure</th><th>${result.deep ? 'Rounds at your current speed' : 'At your current settings'}</th></tr></thead>
        <tbody>${lines.map(([label, val]) => `<tr><td>${label}</td><td class="num">${val}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="actions">
      <button class="btn" id="copy" type="button">Copy settings</button>
      <button class="btn" id="export" type="button">Copy test data</button>
      <button class="btn" id="restart" type="button">Start over</button>
    </div>
    <pre id="copytext" hidden></pre>
    <p class="fine">Prototype. Turn speeds come from a simplified model of each game, so treat these numbers as a close starting point rather than an exact match.${sourceNote} Flick throughput combines speed and accuracy into one score (higher is better). Copy test data puts every measurement from this run on your clipboard, to paste back for tuning.</p>`;

  const du = $('#duel');
  if (du) du.addEventListener('click', startDuel);
  const vb = $('#verify');
  if (vb) vb.addEventListener('click', () => start(verifySegments(c, r), result.drift));
  wireChart();
  $('#restart').addEventListener('click', () => { result = null; session = null; syncSetup(); show('setup'); });
  $('#export').addEventListener('click', e => {
    const data = buildExport({ cfg: c, drift: result.drift, rec: r, segs: result.segs || [], pad: result.pad, deep: result.deep, verify: v });
    copyText(JSON.stringify(data), e.currentTarget);
  });
  $('#copy').addEventListener('click', e => {
    const text = [`Dialed In, ${g.name} (${PLAYSTYLES[c.style].label})`,
      `${g.sens.label}: ${r.sens}`, g.vsens ? `${g.vsens.label}: ${r.vsens}` : `Vertical sensitivity: ${vRel(r.vmult)}`, `${g.dz.label}: ${g.dz.fmt(r.dz)}`, `${g.curve.label}: ${g.curve[r.curve]}`,
      ...(r.ads || []).map(a => a.spec.generic ? `ADS sensitivity: ${vRel(a.rel)}` : `${a.spec.label}: ${fmtAds(a.spec, a.next)}`),
      ...(r.turn && r.turn.boost != null ? [`${g.boost.setting.label}: ${r.turn.boost}`, `${g.boost.rampSetting.label}: ${r.turn.ramp.toFixed(1)}`] : []),
      ...hw.map(h => `${h.st.label}: ${h.st.fmt(h.next)}`)].join('\n');
    copyText(text, e.currentTarget);
  });
}

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
  }
  for (const { sp, id, pctUnit, value, plain, unitLabel } of fields) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = `${sp.label}, current value${pctUnit ? ' (%)' : unitLabel || ''}`;
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', id, inputMode: 'decimal',
      min: pctUnit ? sp.min * 100 : sp.min, max: pctUnit ? sp.max * 100 : sp.max, step: pctUnit ? 1 : sp.step,
      value: pctUnit ? Math.round(value * 100) : plain ? value : value.toFixed(2) });
    const small = document.createElement('small');
    small.textContent = sp.defKnown === false || plain
      ? 'Enter the value from your controller menu.'
      : `${fmtAds(sp, sp.min)} to ${fmtAds(sp, sp.max)}. Default is ${fmtAds(sp, sp.def)}.`;
    wrap.append(label, input, small);
    box.append(wrap);
  }
}

function syncSetup() {
  const g = game();
  const s = $('#sens');
  $('#sens-label').textContent = g.sens.label;
  s.min = g.sens.min; s.max = g.sens.max; s.step = g.sens.step;
  s.value = cfg.sens;
  $('#sens-range').textContent = g.sens.defKnown === false
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
  renderAdsFields(g);
  $('#game').value = cfg.game;
  const notes = [];
  if (g.camera === 'third') notes.push('Third-person camera.');
  if (g.boost) notes.push('Includes look boost, which speeds up turning at full stick.');
  if (!g.ads) notes.push('ADS is tested at a zoom-matched speed and suggested as a relative change.');
  if (g.source === 'guides') notes.push('Menu names come from player guides and still need checking against the game.');
  $('#game-note').textContent = notes.join(' ');
  for (const name of ['style', 'mode']) {
    const radio = document.querySelector(`input[name="${name}"][value="${cfg[name]}"]`);
    if (radio) radio.checked = true;
  }
  $('#go-hint').textContent = MODE_HINT[cfg.mode];
}
$('#game').addEventListener('change', e => {
  cfg.game = e.target.value;
  cfg.sens = game().sens.def;
  cfg.vsens = game().vsens ? game().vsens.def : undefined;
  cfg.ads = adsDefaults(game());
  Object.assign(cfg, boostDefaults(game()));
  syncSetup();
});
document.querySelectorAll('input[name="style"]').forEach(r => r.addEventListener('change', e => { cfg.style = e.target.value; }));
document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', e => { cfg.mode = e.target.value; syncSetup(); renderRail(); }));
// Reads the setup form into cfg (current values, not suggestions).
function readSetup() {
  const g = game();
  const v = Number($('#sens').value);
  cfg.sens = clamp(Number.isFinite(v) ? Math.round(v) : g.sens.def, g.sens.min, g.sens.max);
  if (g.vsens) {
    const vv = Number($('#vsens').value);
    cfg.vsens = clamp(Number.isFinite(vv) ? Math.round(vv) : g.vsens.def, g.vsens.min, g.vsens.max);
  }
  cfg.vmult = 1;
  cfg.ads = adsDefaults(g);
  for (const sp of g.ads || []) {
    const raw = Number($('#ads-' + sp.key).value);
    if (Number.isFinite(raw) && raw > 0) cfg.ads[sp.key] = clamp(sp.unit === '%' ? raw / 100 : raw, sp.min, sp.max);
  }
  Object.assign(cfg, boostDefaults(g));
  if (g.boost && g.boost.setting) {
    const b = Number($('#boost').value), rr = Number($('#boost-ramp').value);
    if (Number.isFinite(b)) cfg.boost = clamp(b, g.boost.setting.min, g.boost.setting.max);
    if (Number.isFinite(rr)) cfg.boostRamp = clamp(rr, g.boost.rampSetting.min, g.boost.rampSetting.max);
  }
  cfg.curve = g.curve.def;
  cfg.dz = g.dz.def;
  cfg.outer = 1;
}

$('#go').addEventListener('click', () => {
  readSetup();
  result = null;
  syncSetup();
  if (cfg.mode === 'deep') start(deepSegments(), null, { order: shuffled(DEEP.initial), history: [], pending: null });
  else start(quickSegments(), null);
});

/* ---------- input ---------- */

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
  const p = readPad();
  if (p) {
    const b = p.buttons;
    const pressed = i => !!b[i] && (b[i].pressed || b[i].value > 0.5);
    return { src: 'pad', name: p.id, lx: p.axes[0], ly: p.axes[1], rx: p.axes[2], ry: p.axes[3],
      fire: pressed(7) || pressed(0) || pressed(5), dl: pressed(14), du: pressed(12), dr: pressed(15),
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
function fit(c) {
  const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (w && h && (c.width !== w || c.height !== h)) { c.width = w; c.height = h; }
  return w > 0 && h > 0;
}

function drawArena() {
  const c = $('#arena');
  if (screen !== 'test' || !fit(c)) return;
  if (chal) return drawScene(c, chalScene());
  const s = seg(), P = session.phase;
  drawScene(c, {
    view, zoom: s.zoom || 1, phase: P, countLeft: session.countLeft,
    flick: P === 'run' && s.kind === 'flick' ? s.data : null,
    track: P === 'run' && s.kind === 'track' ? s.data : null,
    figure: s.kind !== 'drift',
    overlay: P === 'run' && s.kind === 'drift' ? (ctx, W, H, d) => drawDrift(ctx, s.data, W, H, d) : null
  });
}

// One frame of the aim range. sc = { view, zoom, phase, countLeft, flick: { cur, flash }?, track?, figure, overlay? }.
function drawScene(c, sc) {
  const view = sc.view, P = sc.phase;
  const ctx = c.getContext('2d'), W = c.width, H = c.height, d = window.devicePixelRatio || 1;
  const zoom = sc.zoom, fov = FOV / zoom;
  const ppd = W / fov, cx = W / 2, cy = H / 2;
  const step = zoom >= 3 ? 1 : zoom > 1 ? 2.5 : 5, major = step * 6;
  const toX = yaw => cx + (yaw - view.yaw) * ppd, toY = pitch => cy - (pitch - view.pitch) * ppd;
  ctx.fillStyle = tok('--arena'); ctx.fillRect(0, 0, W, H);

  ctx.lineWidth = d;
  const halfV = H / 2 / ppd;
  for (let a = Math.ceil((view.yaw - fov / 2) / step) * step; a <= view.yaw + fov / 2; a += step) {
    ctx.strokeStyle = Math.abs(a / major - Math.round(a / major)) < 1e-6 ? tok('--arena-major') : tok('--arena-grid');
    const x = Math.round(toX(a)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let a = Math.ceil((view.pitch - halfV) / step) * step; a <= view.pitch + halfV; a += step) {
    const horizon = Math.abs(a) < 1e-6;
    ctx.strokeStyle = horizon ? tok('--arena-major') : tok('--arena-grid');
    ctx.lineWidth = horizon ? 2 * d : d;
    const y = Math.round(toY(a)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Aiming down sights: a darkened frame at 1.5x, a round scope mask at 4x.
  // Drawn before the targets so the off-screen arrow stays on top; targets are clipped to the scope.
  const scopeR = zoom >= 3 ? Math.min(W, H) * 0.46 : 0;
  if (scopeR) {
    ctx.fillStyle = tok('--arena-figure');
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.arc(cx, cy, scopeR, 0, Math.PI * 2, true); ctx.fill();
  } else if (zoom > 1) {
    ctx.fillStyle = tok('--arena-figure'); ctx.globalAlpha = 0.45;
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(W * 0.08, H * 0.08, W * 0.84, H * 0.84); ctx.fill('evenodd');
    ctx.globalAlpha = 1;
  }

  const running = P === 'run';
  const drawTarget = (t, r, lit) => {
    const x = toX(t.yaw), y = toY(t.pitch), R = r * ppd;
    const outside = scopeR ? Math.hypot(x - cx, y - cy) > scopeR + R : x < -R || x > W + R || y < -R || y > H + R;
    if (outside) {
      // Out of view: an arrow on the edge (or the scope's rim) pointing toward it.
      const ang = Math.atan2(y - cy, x - cx);
      const ex = scopeR ? cx + Math.cos(ang) * (scopeR - 16 * d) : clamp(x, 24 * d, W - 24 * d);
      const ey = scopeR ? cy + Math.sin(ang) * (scopeR - 16 * d) : clamp(y, 24 * d, H - 24 * d);
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
      ctx.fillStyle = tok('--target');
      ctx.beginPath(); ctx.moveTo(10 * d, 0); ctx.lineTo(-8 * d, -8 * d); ctx.lineTo(-8 * d, 8 * d); ctx.closePath(); ctx.fill();
      ctx.restore();
      return;
    }
    ctx.save();
    if (scopeR) { ctx.beginPath(); ctx.arc(cx, cy, scopeR, 0, Math.PI * 2); ctx.clip(); }
    ctx.fillStyle = tok('--target');
    ctx.globalAlpha = lit ? 1 : 0.85;
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = tok('--arena-ink'); ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.arc(x, y, R * 0.45, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  };
  if (running && sc.flick) {
    const F = sc.flick;
    drawTarget(F.cur, F.cur.r, false);
    if (F.flash && F.flash.t > 0) {
      ctx.strokeStyle = F.flash.good ? tok('--good') : tok('--arena-ink');
      ctx.globalAlpha = clamp(F.flash.t / 0.3, 0, 1);
      ctx.lineWidth = 2 * d;
      ctx.beginPath(); ctx.arc(toX(F.flash.yaw), toY(F.flash.pitch), (F.flash.good ? 4 : 1.2) * ppd * (1.4 - F.flash.t), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  if (running && sc.track) drawTarget(sc.track.tgt, sc.track.r, sc.track.tgt.on);

  // Third-person games: the character sits left of the crosshair and blocks part of the view.
  if (game().camera === 'third' && sc.figure && zoom === 1) {
    const fx = cx - W * 0.17;
    ctx.fillStyle = tok('--arena-figure');
    ctx.strokeStyle = tok('--arena-major'); ctx.lineWidth = d;
    ctx.beginPath(); ctx.ellipse(fx, H * 1.02, W * 0.11, H * 0.26, 0, Math.PI, 0); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(fx + W * 0.01, H * 0.7, H * 0.085, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  const onT = running && sc.track && sc.track.tgt.on;
  ctx.strokeStyle = onT ? tok('--good') : tok('--arena-ink');
  ctx.lineWidth = 2 * d;
  const gap = 5 * d, len = 11 * d;
  ctx.beginPath();
  ctx.moveTo(cx - gap - len, cy); ctx.lineTo(cx - gap, cy); ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + len, cy);
  ctx.moveTo(cx, cy - gap - len); ctx.lineTo(cx, cy - gap); ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + len);
  ctx.stroke();

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (P === 'intro' || P === 'rate') {
    ctx.fillStyle = tok('--arena'); ctx.globalAlpha = 0.55; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
  } else if (P === 'count') {
    ctx.fillStyle = tok('--arena-ink');
    ctx.font = `600 ${Math.round(H * 0.22)}px ${tok('--mono')}`;
    ctx.fillText(String(Math.ceil(sc.countLeft)), cx, cy - H * 0.22);
  } else if (sc.overlay) {
    sc.overlay(ctx, W, H, d);
  }
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
  const ctx = c.getContext('2d'), W = c.width, H = c.height, d = window.devicePixelRatio || 1;
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
    ctx.fillStyle = tok('--muted'); ctx.font = `500 ${11 * d}px ${tok('--mono')}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, cx, H - 2 * d);
  };
  const s = seg();
  const dz = s && s.settings ? s.settings.dz : session && session.drift ? session.drift.rec : cfg.dz;
  one(W * 0.27, inp.lx, inp.ly, 'LEFT', 0);
  one(W * 0.73, inp.rx, inp.ry, 'RIGHT · deadzone ' + dz.toFixed(2), inp.src === 'pad' ? dz : 0);
}

/* ---------- warm-up challenge ---------- */

let chal = null; // { st, rec, code, kind, phase, countLeft, acc, flash, pop, src }
const CH_KIND = { daily: 'Daily challenge', practice: 'Practice', code: 'Shared challenge' };

// opts: { settings, seconds, duel } for duel runs; otherwise the run uses the setup form.
function startChallenge(code, kind, opts = {}) {
  if (!opts.settings) { readSetup(); syncSetup(); }
  session = null;
  const settings = opts.settings || settingsOf(cfg), game = opts.game || cfg.game;
  chal = { st: createChallenge(code, game, settings, { seconds: opts.seconds }), rec: newRecording(), code, kind, phase: 'intro',
    countLeft: 0, acc: 0, flash: null, pop: null, src: inp.src, settings, game, duel: opts.duel || null };
  view.yaw = 0; view.pitch = 0;
  show('test');
}

function chalTick(dt, edge) {
  const c = chal;
  if (c.phase === 'intro') { if (edge.fire) { c.phase = 'count'; c.countLeft = 3; renderChalBrief(true); } return; }
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
  while (c.acc >= DT && !c.st.done) {
    const rx = quantize(inp.rx), ry = quantize(inp.ry), fire = !!inp.fire;
    record(c.rec, rx, ry, fire);
    chStep(c.st, rx, ry, fire);
    c.acc -= DT;
  }
  for (const ev of c.st.events) {
    if (ev.type === 'hit') { c.flash = { yaw: ev.yaw, pitch: ev.pitch, t: 0.3, good: true }; c.pop = { text: '+' + Math.round(ev.pts), t: 0.7 }; }
    if (ev.type === 'miss') { c.flash = { yaw: ev.yaw, pitch: ev.pitch, t: 0.2, good: false }; c.pop = { text: '−25', t: 0.5 }; }
  }
  c.st.events.length = 0;
  if (c.st.done) endChallenge();
}

function chalScene() {
  const c = chal, it = c.st.item;
  return {
    view: c.st.view, zoom: 1, phase: c.phase === 'run' ? 'run' : c.phase, countLeft: c.countLeft, figure: true,
    flick: it.kind !== 'track' ? { cur: it.T, flash: c.flash } : null,
    track: it.kind === 'track' ? it.TR : null,
    overlay: c.pop && c.pop.t > 0 ? (ctx, W, H) => {
      ctx.globalAlpha = clamp(c.pop.t / 0.3, 0, 1);
      ctx.fillStyle = c.pop.text.startsWith('+') ? tok('--good') : tok('--target');
      ctx.font = `600 ${Math.round(H * 0.06)}px ${tok('--mono')}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(c.pop.text, W / 2, H / 2 - H * 0.12 - (0.7 - c.pop.t) * H * 0.08);
      ctx.globalAlpha = 1;
    } : null
  };
}

let chalBriefKey = '';
function renderChalBrief(force) {
  const c = chal, key = c.phase + inp.src;
  if (key === chalBriefKey && !force) return;
  chalBriefKey = key;
  const di = c.duel ? c.duel.i : 0;
  $('#brief-title').textContent = c.duel ? (c.phase === 'rate' ? `How did run ${di + 1} feel?` : `Settings duel · run ${di + 1} of ${DUEL.runs}`)
    : c.kind === 'daily' ? `Daily challenge · ${c.code.slice(2)}` : c.kind === 'practice' ? 'Practice challenge' : `Challenge ${c.code}`;
  $('#brief-text').textContent = c.phase === 'rate' ? 'Go with your gut. You can skip this.'
    : c.phase !== 'intro' ? (c.phase === 'count' ? 'Get ready.' : 'Go.')
    : !c.duel ? '60 seconds. Hit each target fast for more points, and keep a streak going for a bonus. Missed shots cost points. Stay on the moving targets, no need to fire at those.'
    : di === 0 ? `${DUEL.runs} challenge runs of ${DUEL.seconds} seconds. Two use your old settings and two use the suggested ones, in a hidden order, and each pair plays the same targets.`
    : `Run ${di + 1} of ${DUEL.runs}. Same drill. The settings may have changed.`;
  const act = $('#brief-actions');
  act.textContent = '';
  if (c.phase === 'rate') {
    const row = document.createElement('div');
    row.className = 'rate';
    for (const r of RATINGS) {
      const b = button(r.label, '', () => duelRate(r.v));
      if (inp.src === 'pad') { const small = document.createElement('small'); small.textContent = 'D-pad ' + r.glyph; b.append(small); }
      row.append(b);
    }
    row.append(button('Skip', 'small', () => duelRate(null)));
    act.append(row);
    return;
  }
  if (c.phase === 'intro') {
    act.append(button('Start', 'primary', () => { c.phase = 'count'; c.countLeft = 3; renderChalBrief(true); }));
    act.append(button('Back', '', leaveChallenge));
    if (inp.src === 'pad') act.append(hint('or press A / ✕'));
  } else {
    act.append(button('Stop', 'small', leaveChallenge));
  }
}

function leaveChallenge() { chal = null; show(result ? 'results' : 'setup'); }

/* settings duel */

// A = the player's current settings, B = the suggested ones, including the turn drill's boost advice.
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
function saveBest(code, kind, score) {
  const b = loadBests();
  const prev = kind === 'practice' ? b.practice : (b.codes || {})[code];
  const isBest = prev == null || score > prev;
  if (isBest) {
    if (kind === 'practice') b.practice = score;
    else { b.codes = b.codes || {}; b.codes[code] = score; }
    try { localStorage.setItem(BEST_KEY, JSON.stringify(b)); } catch (e) { /* storage blocked: best just isn't kept */ }
  }
  return { isBest, prev };
}
function renderWarmBests() {
  const b = loadBests(), today = dailyCode();
  const rows = [['Today', (b.codes || {})[today]], ['Practice best', b.practice]].filter(r => r[1] != null);
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
    renderChalBrief(true);
    return;
  }
  c.result = { sum, best: saveBest(c.code, c.kind, sum.score), replay: encodeReplay(c.rec) };
  show('chend');
}

const shareLink = code => /\.github\.io$/.test(location.hostname) ? `${location.origin}${location.pathname}#${code}` : null;

function renderChalEnd() {
  const c = chal, { sum, best } = c.result, g = GAMES[c.game];
  const what = c.kind === 'daily' ? `the Dialed In daily challenge (${c.code.slice(2)})` : `Dialed In challenge ${c.code}`;
  const link = shareLink(c.code);
  const shareText = `I scored ${sum.score.toLocaleString('en-US')} on ${what} with ${pct(sum.accuracy)} accuracy. Code: ${c.code}${link ? ' ' + link : ''}`;
  const stat = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  $('#p-chend').innerHTML = `
    <div style="display:grid;gap:6px">
      <p class="eyebrow">${CH_KIND[c.kind]} · ${c.code} · ${gameTitle(g)}${c.src === 'pad' ? '' : ' · on-screen stick'}</p>
      <div class="score-hero"><b>${sum.score.toLocaleString('en-US')}</b><span>points</span>${best.isBest && best.prev != null ? '<span class="pb">New personal best</span>' : ''}</div>
      <p class="lede">${best.prev == null ? 'Your first score on this ' + (c.kind === 'practice' ? 'practice board.' : 'challenge.')
        : best.isBest ? `Up from ${best.prev.toLocaleString('en-US')}.` : `Your best here is ${best.prev.toLocaleString('en-US')}.`}</p>
    </div>
    <div class="ch-stats">
      ${stat('Accuracy', pct(sum.accuracy))}
      ${stat('Hits', sum.hits)}
      ${stat('Time per hit', sum.avgTime == null ? '–' : sum.avgTime.toFixed(2) + ' s')}
      ${stat('Best streak', sum.bestStreak)}
      ${stat('On moving targets', sum.tracking == null ? '–' : pct(sum.tracking))}
    </div>
    ${reportHtml(reportCard(c.st.log, { game: c.game, style: cfg.style }))}
    <div class="share">
      <p>Share the code and anyone can play the exact same targets: <code>${c.code}</code></p>
      <pre id="copytext" hidden></pre>
    </div>
    <div class="actions">
      <button class="btn primary" id="ch-again" type="button">${c.kind === 'practice' ? 'New practice run' : 'Try again'}</button>
      <button class="btn" id="ch-share" type="button">Copy result</button>
      <button class="btn" id="ch-back" type="button">Back to setup</button>
    </div>
    <p class="fine">Scores are kept in this browser for now. Leaderboards are next, and every run is recorded so its score can be checked when they open.</p>`;
  $('#ch-again').addEventListener('click', () => startChallenge(c.kind === 'practice' ? practiceCode() : c.code, c.kind));
  $('#ch-share').addEventListener('click', e => copyText(shareText, e.currentTarget));
  $('#ch-back').addEventListener('click', leaveChallenge);
}

function reportHtml({ rows, hints }) {
  const rate = v => v == null ? '–' : pct(v);
  const pace = v => v == null ? '–' : v <= 1 ? 'On pace' : `${pct(v - 1)} slow`;
  const row = (label, r, extra) => r.n ? `<tr><td>${label}</td><td class="num">${r.n}</td><td class="num">${Math.round(r.pts).toLocaleString('en-US')}</td><td class="num">${extra}</td></tr>` : '';
  return `<div style="display:grid;gap:10px">
    <h3 style="font-size:16px">Report card</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Targets</th><th>Count</th><th>Points</th><th>Hit rate · pace</th></tr></thead>
      <tbody>
        ${row('Sideways flicks', rows.side, `${rate(rows.side.hitRate)} · ${pace(rows.side.pace)}`)}
        ${row('Up-and-down flicks', rows.vert, `${rate(rows.vert.hitRate)} · ${pace(rows.vert.pace)}`)}
        ${row('Turn-arounds', rows.turn, `${rate(rows.turn.hitRate)} · ${pace(rows.turn.pace)}`)}
        ${row('Moving targets', rows.track, `${rate(rows.track.on)} on target`)}
      </tbody>
    </table></div>
    ${hints.length
      ? `<ul class="hints">${hints.map(h => `<li>${h.text}</li>`).join('')}</ul><p class="fine">One run is noisy. If a hint shows up run after run, a full calibration will confirm it.</p>`
      : '<p class="fine">No settings hints from this run. Only big gaps show up after a single run.</p>'}
  </div>`;
}

function startCodeFromInput() {
  const code = $('#ch-code').value.trim().toLowerCase();
  if (!isCode(code)) { $('#ch-note').textContent = 'That code doesn\'t look right. Codes look like d-2026-10-21 or p-k3x9q2.'; return; }
  startChallenge(code, code === dailyCode() ? 'daily' : 'code');
}
$('#ch-daily').addEventListener('click', () => startChallenge(dailyCode(), 'daily'));
$('#ch-practice').addEventListener('click', () => startChallenge(practiceCode(), 'practice'));
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
  const status = inp.src + '|' + inp.name + '|' + gpBlocked;
  if (status !== lastStatus) {
    lastStatus = status;
    $('#pill').classList.toggle('on', inp.src === 'pad');
    $('#pill-text').textContent = inp.src === 'pad'
      ? inp.name.replace(/\s*\(.*$/, '') || 'Controller connected'
      : 'No controller. Press any button to connect.';
    const note = $('#pad-note');
    note.classList.toggle('warn', gpBlocked);
    note.textContent = gpBlocked
      ? 'This view blocks controller access. Open the standalone copy of this page in Chrome or Edge to use a controller.'
      : inp.src === 'pad'
        ? 'Controller connected. The dashed ring shows the deadzone the range is using.'
        : 'Plug in or pair a PlayStation or Xbox controller, then press any button. Chrome and Edge work best.';
    $('#vpad-panel').hidden = inp.src === 'pad';
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
  $('#hud-l').textContent = l; $('#hud-r').textContent = r;
}

function frame(ts) {
  const dt = lastT ? Math.min(0.05, (ts - lastT) / 1000) : 0;
  lastT = ts;
  css = getComputedStyle(document.documentElement);
  inp = poll();
  const edge = {};
  for (const k of ['fire', 'dl', 'du', 'dr']) { edge[k] = inp[k] && !prev[k]; prev[k] = inp[k]; }
  if (screen === 'test' && chal) chalTick(dt, edge);
  else if (screen === 'test' && session) tick(dt, edge);
  updateStatus();
  drawSticks();
  drawArena();
  requestAnimationFrame(frame);
}

syncSetup();
show('setup');
requestAnimationFrame(frame);
