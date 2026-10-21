import { GAMES, PLAYSTYLES, gameTitle } from './games.js';
import { FOV, makeView, steer, newFlickTarget, flickStep, makeTrack, trackStep } from './sim.js';
import { summarize, recommend, driftDeadzone, settingsChanged } from './analysis.js';
import { verifyPlan, verifyCompare, ratingSummary } from './verify.js';
import { DEEP, deepNext, deepAnalyze, shuffled } from './deep.js';
import { clamp, pct } from './util.js';

const $ = s => document.querySelector(s);
const QUICK = { flicks: 10, trackSeconds: 15 };
const VERIFY = { flicks: 7, warmFlicks: 1, trackSeconds: 9, warmSeconds: 1.5 };
const DEEP_ROUND = { flicks: 8, warmFlicks: 1, trackSeconds: 8, warmSeconds: 1.5 };
const DRIFT_SECONDS = 4;
const RAIL = { setup: 'Setup', drift: 'Drift', flick: 'Flicks', track: 'Tracking', deep: 'Search', verify: 'Verify', results: 'Results' };
const RATINGS = [
  { v: 1, label: 'Rough', key: 'dl', glyph: '←' },
  { v: 2, label: 'OK', key: 'du', glyph: '↑' },
  { v: 3, label: 'Great', key: 'dr', glyph: '→' }
];
const MODE_HINT = { quick: 'About 2 minutes', verify: 'About 4 minutes', deep: 'About 5 minutes' };

const cfg = { game: 'arc', style: 'balanced', mode: 'verify', sens: GAMES.arc.sens.def, curve: 'mid', dz: 0.10 };
let screen = 'setup';  // setup | test | results
let session = null;    // { segs, i, phase, countLeft, drift }
let result = null;     // { cfg, stats, rec, drift, verify }
const view = makeView();
let inp = { src: 'virtual', name: null, lx: 0, ly: 0, rx: 0, ry: 0, fire: false, dl: false, du: false, dr: false };
let prev = { fire: false, dl: false, du: false, dr: false };
let lastT = 0, gpBlocked = false;

const game = () => GAMES[cfg.game];
const seg = () => session && session.segs[session.i];
const settingsOf = c => ({ sens: c.sens, curve: c.curve, dz: c.dz });

/* ---------- session plans ---------- */

function quickSegments() {
  const s = settingsOf(cfg);
  return [
    { kind: 'drift', rail: 'drift', title: 'Drift check',
      text: 'Set the controller down and keep your thumbs off both sticks for 4 seconds. This measures how far the sticks wander on their own.' },
    { kind: 'flick', rail: 'flick', tag: 'quick', n: QUICK.flicks, warm: 0, settings: s, intro: true, title: 'Flick test',
      text: 'Ten targets appear one at a time. Snap to each with the right stick and fire with RT / R2. Go at the speed you would in a real fight.' },
    { kind: 'track', rail: 'track', tag: 'quick', dur: QUICK.trackSeconds, warm: 0, settings: s, intro: true, title: 'Tracking test',
      text: 'Keep the crosshair on the strafing target for 15 seconds. No need to fire.' },
    { kind: 'analyze' }
  ];
}

function verifySegments(A, B) {
  const plan = verifyPlan(settingsOf(A), settingsOf(B));
  const segs = [];
  plan.forEach((r, k) => {
    const title = `Round ${k + 1} of ${plan.length}`;
    segs.push({ kind: 'flick', rail: 'verify', key: r.key, n: VERIFY.flicks, warm: VERIFY.warmFlicks, settings: r.settings, intro: true, title,
      text: k === 0
        ? `Blind test. Each round is ${VERIFY.flicks} targets, then ${VERIFY.trackSeconds} seconds of tracking. Two rounds use your old settings and two use the new ones, in a hidden order.`
        : `Same drill. The settings may have changed. ${VERIFY.flicks} targets, then tracking.` });
    segs.push({ kind: 'track', rail: 'verify', key: r.key, dur: VERIFY.trackSeconds, warm: VERIFY.warmSeconds, settings: r.settings, title,
      text: 'Stay on the moving target.' });
    segs.push({ kind: 'rate', rail: 'verify', key: r.key, title: `How did round ${k + 1} feel?`,
      text: 'Go with your gut. Your answer is shown next to the measurements at the end.' });
  });
  segs.push({ kind: 'verdict' });
  return segs;
}

function deepSegments() {
  return [
    { kind: 'drift', rail: 'drift', title: 'Drift check',
      text: 'Set the controller down and keep your thumbs off both sticks for 4 seconds. This measures how far the sticks wander on their own.' },
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
  if (!next) { session.segs.push({ kind: 'deepDone' }); return advance(); }
  const k = D.history.length + 1;
  const round = { x: next.x, sens: next.sens };
  const settings = { sens: next.sens, curve: cfg.curve, dz: session.drift ? session.drift.rec : cfg.dz };
  const title = `Round ${k}`;
  D.pending = round;
  session.segs.push(
    { kind: 'flick', rail: 'deep', round, n: DEEP_ROUND.flicks, warm: DEEP_ROUND.warmFlicks, settings, intro: true, title,
      text: k === 1
        ? `The search runs ${DEEP.minRounds} to ${DEEP.maxRounds} short rounds. Each is ${DEEP_ROUND.flicks} targets, then ${DEEP_ROUND.trackSeconds} seconds of tracking, at a hidden sensitivity. Each round's speed is picked from how you did in the earlier ones.`
        : `${DEEP_ROUND.flicks} targets, then tracking. The sensitivity has probably changed. Play the way you normally would.` },
    { kind: 'track', rail: 'deep', round, dur: DEEP_ROUND.trackSeconds, warm: DEEP_ROUND.warmSeconds, settings, title, text: 'Stay on the moving target.' },
    { kind: 'rate', rail: 'deep', round, title: `How did round ${k} feel?`, text: 'Go with your gut. Your ratings are shown next to the scores at the end.' },
    { kind: 'deepNext' }
  );
  advance();
}

function deepDone() {
  const D = session.deep;
  const c = { ...cfg };
  const res = deepAnalyze(D.history, PLAYSTYLES[c.style], game(), c.sens);
  // Curve and deadzone advice come from the rounds played at the current speed.
  const base = D.history.filter(h => h.sens === c.sens);
  const from = base.length ? base : D.history;
  const stats = summarize(from.flatMap(h => h.flicks), from[0].track);
  const rec = recommend(stats, c, session.drift);
  if (res) {
    rec.sens = res.verdict === 'flat' ? c.sens : res.best.sens;
    rec.sensWhy = deepWhy(res, c);
  }
  result = { cfg: c, stats, rec, drift: session.drift, verify: null,
    deep: { res, rounds: D.history.map(h => ({ sens: h.sens, rating: h.rating })) } };
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
  if (s.kind === 'drift') s.data = { t: 0, r: 0, l: 0, warn: 0 };
  if (s.kind === 'flick') s.data = { list: [], cur: newFlickTarget(view), flash: null };
  if (s.kind === 'track') s.data = makeTrack(s.warm);
  renderBrief(true);
}
function stop() {
  session = null;
  show(result ? 'results' : 'setup');
}

function analyze() {
  const fl = session.segs.find(x => x.kind === 'flick' && x.tag === 'quick').data.list;
  const tr = session.segs.find(x => x.kind === 'track' && x.tag === 'quick').data;
  const c = { ...cfg };
  const stats = summarize(fl, tr);
  const rec = recommend(stats, c, session.drift);
  result = { cfg: c, stats, rec, drift: session.drift, verify: null };
  if (c.mode === 'verify' && settingsChanged(c, rec)) {
    session.segs.push(...verifySegments(c, rec));
    return advance();
  }
  session = null;
  show('results');
}

function verdict() {
  const groups = { A: { flicks: [], chunks: [], ratings: [] }, B: { flicks: [], chunks: [], ratings: [] } };
  for (const s of session.segs) {
    if (!s.key || s.data == null) continue;
    const g = groups[s.key];
    if (s.kind === 'flick') g.flicks.push(...s.data.list.slice(s.warm));
    if (s.kind === 'track') g.chunks.push(...s.data.chunks);
    if (s.kind === 'rate') g.ratings.push(s.data);
  }
  result.verify = {
    cmp: verifyCompare(groups, PLAYSTYLES[result.cfg.style]),
    feelA: ratingSummary(groups.A.ratings),
    feelB: ratingSummary(groups.B.ratings),
    targets: groups.A.flicks.length + groups.B.flicks.length,
    seconds: groups.A.chunks.length + groups.B.chunks.length
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
  const r = Math.hypot(inp.rx, inp.ry), l = Math.hypot(inp.lx, inp.ly);
  D.warn -= dt;
  if (r > 0.35 || l > 0.35) { D.t = 0; D.r = 0; D.l = 0; D.warn = 1.2; return; }
  D.t += dt; D.r = Math.max(D.r, r); D.l = Math.max(D.l, l);
  if (D.t >= DRIFT_SECONDS) {
    session.drift = { r: D.r, l: D.l, rec: driftDeadzone(D.r) };
    advance();
  }
}

function tickFlick(s, dt, fireEdge) {
  const F = s.data;
  const st = steer(view, inp, s.settings, game(), dt);
  if (F.flash) F.flash.t -= dt;
  const out = flickStep(F.cur, view, st.mag, fireEdge, dt);
  if (out === 'miss') F.flash = { yaw: view.yaw, pitch: view.pitch, t: 0.2, good: false };
  if (out === 'hit') F.flash = { yaw: F.cur.yaw, pitch: F.cur.pitch, t: 0.3, good: true };
  if (out === 'hit' || out === 'timeout') {
    F.list.push(F.cur);
    if (F.list.length >= s.n) return advance();
    F.cur = newFlickTarget(view);
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
  $('#p-test').hidden = name !== 'test';
  $('#p-results').hidden = name !== 'results';
  renderRail();
  if (name === 'test') renderBrief(true);
  if (name === 'results') renderResults();
  if (changed) window.scrollTo({ top: 0 });
}

function railKeys() {
  const deep = !!((session && session.deep) || (result && result.deep) || (!session && !result && cfg.mode === 'deep'));
  const keys = deep ? ['setup', 'drift', 'deep'] : ['setup', 'drift', 'flick', 'track'];
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
  const key = session.i + session.phase + noPad;
  if (key === briefKey && !force) return;
  briefKey = key;
  const P = session.phase;
  $('#brief-title').textContent = s.title;
  let text = s.text;
  if (s.kind === 'drift' && noPad && P === 'intro') text = 'No controller found, so there is nothing to measure. Press a button on your controller to wake it, or skip this check.';
  if (P === 'count') text = 'Get ready.';
  if (P === 'run' && s.kind === 'drift') text = 'Hands off the sticks.';
  $('#brief-text').textContent = text;

  const act = $('#brief-actions');
  act.textContent = '';
  if (P === 'intro') {
    const blocked = s.kind === 'drift' && noPad;
    if (!blocked) act.append(button(s.kind === 'drift' ? 'Start drift check' : 'Start', 'primary', begin));
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
    close: `The difference was smaller than the round-to-round noise, so either works. Go with whichever felt better.`
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
    <div class="table-wrap"><table><thead><tr><th>Round</th><th>${g.sens.label}</th><th>Score vs best</th><th>Felt</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
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
    ['Average tracking error', s.trackErr == null ? '–' : s.trackErr.toFixed(1) + '°'],
    ['On target while tracking', pct(s.onTarget)],
    ['Trailing the target', pct(s.behind)],
    ['Ahead of the target', pct(s.ahead)],
    ['Extra corrections', s.jitter.toFixed(1) + '/s']
  ];
  const deepHtml = result.deep ? deepBlock(result.deep, g, c) : '';
  let verifyHtml;
  if (v) verifyHtml = verifyBlock(v);
  else if (settingsChanged(c, r)) verifyHtml = `<div class="offer"><p>Not sure about these? Run a blind test of your old settings against the new ones. About 2 minutes.</p><button class="btn primary" id="verify" type="button">Verify these settings</button></div>`;
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
      ${row(g.dz.label, g.dz.fmt(c.dz), g.dz.fmt(r.dz), r.dzMeasured ? tag(r.dz, c.dz) : '<span class="tag">Not measured</span>', r.dzWhy)}
      ${row(g.curve.label, g.curve[c.curve], g.curve[r.curve], curveTag, r.curveWhy)}
    </div>
    ${deepHtml}
    ${verifyHtml}
    <div style="display:grid;gap:10px">
      <h3 style="font-size:16px">What the tests measured</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Measure</th><th>${result.deep ? 'Rounds at your current speed' : 'At your current settings'}</th></tr></thead>
        <tbody>${lines.map(([label, val]) => `<tr><td>${label}</td><td class="num">${val}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="actions">
      <button class="btn" id="copy" type="button">Copy settings</button>
      <button class="btn" id="restart" type="button">Start over</button>
    </div>
    <pre id="copytext" hidden></pre>
    <p class="fine">Prototype. Turn speeds come from a simplified model of each game, so treat these numbers as a close starting point rather than an exact match.${sourceNote} Flick throughput combines speed and accuracy into one score (higher is better).</p>`;

  const vb = $('#verify');
  if (vb) vb.addEventListener('click', () => start(verifySegments(c, r), result.drift));
  wireChart();
  $('#restart').addEventListener('click', () => { result = null; session = null; syncSetup(); show('setup'); });
  $('#copy').addEventListener('click', e => {
    const text = [`Dialed In, ${g.name} (${PLAYSTYLES[c.style].label})`,
      `${g.sens.label}: ${r.sens}`, `${g.dz.label}: ${g.dz.fmt(r.dz)}`, `${g.curve.label}: ${g.curve[r.curve]}`].join('\n');
    const pre = $('#copytext');
    pre.textContent = text;
    const btn = e.currentTarget;
    const fallback = () => { pre.hidden = false; btn.textContent = 'Select the text below'; };
    try { navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied'; }, fallback); }
    catch (err) { fallback(); }
  });
}

/* ---------- setup form ---------- */

function syncSetup() {
  const g = game();
  const s = $('#sens');
  $('#sens-label').textContent = g.sens.label;
  s.min = g.sens.min; s.max = g.sens.max; s.step = g.sens.step;
  s.value = cfg.sens;
  $('#sens-range').textContent = `${g.sens.min} to ${g.sens.max}. Default is ${g.sens.def}. Not sure? Leave the default.`;
  $('#game').value = cfg.game;
  const notes = [];
  if (g.camera === 'third') notes.push('Third-person camera.');
  if (g.boost) notes.push('Includes look boost, which speeds up turning at full stick.');
  if (g.source === 'guides') notes.push('Menu names come from player guides and still need checking against the game.');
  $('#game-note').textContent = notes.join(' ');
  for (const name of ['style', 'mode']) {
    const radio = document.querySelector(`input[name="${name}"][value="${cfg[name]}"]`);
    if (radio) radio.checked = true;
  }
  $('#go-hint').textContent = MODE_HINT[cfg.mode];
}
$('#game').addEventListener('change', e => { cfg.game = e.target.value; cfg.sens = game().sens.def; syncSetup(); });
document.querySelectorAll('input[name="style"]').forEach(r => r.addEventListener('change', e => { cfg.style = e.target.value; }));
document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', e => { cfg.mode = e.target.value; syncSetup(); renderRail(); }));
$('#go').addEventListener('click', () => {
  const g = game();
  const v = Number($('#sens').value);
  cfg.sens = clamp(Number.isFinite(v) ? Math.round(v) : g.sens.def, g.sens.min, g.sens.max);
  cfg.curve = g.curve.def;
  cfg.dz = g.dz.def;
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
      fire: pressed(7) || pressed(0) || pressed(5), dl: pressed(14), du: pressed(12), dr: pressed(15) };
  }
  let x = vpad.x, y = vpad.y;
  if (!vpad.drag) {
    x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    y = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    x *= 0.6; y *= 0.6;
  }
  return { src: 'virtual', name: null, lx: 0, ly: 0, rx: x, ry: y, fire: vpad.fire || keys.fire, dl: false, du: false, dr: false };
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
const inTest = () => screen === 'test' && session && (session.phase === 'count' || session.phase === 'run');
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
  const s = seg(), P = session.phase;
  const ctx = c.getContext('2d'), W = c.width, H = c.height, d = window.devicePixelRatio || 1;
  const ppd = W / FOV, cx = W / 2, cy = H / 2;
  const toX = yaw => cx + (yaw - view.yaw) * ppd, toY = pitch => cy - (pitch - view.pitch) * ppd;
  ctx.fillStyle = tok('--arena'); ctx.fillRect(0, 0, W, H);

  ctx.lineWidth = d;
  const halfV = H / 2 / ppd;
  for (let a = Math.ceil((view.yaw - FOV / 2) / 5) * 5; a <= view.yaw + FOV / 2; a += 5) {
    ctx.strokeStyle = ((a % 30) + 30) % 30 === 0 ? tok('--arena-major') : tok('--arena-grid');
    const x = Math.round(toX(a)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let a = Math.ceil((view.pitch - halfV) / 5) * 5; a <= view.pitch + halfV; a += 5) {
    ctx.strokeStyle = a === 0 ? tok('--arena-major') : tok('--arena-grid');
    ctx.lineWidth = a === 0 ? 2 * d : d;
    const y = Math.round(toY(a)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const running = P === 'run';
  const drawTarget = (t, r, lit) => {
    const x = toX(t.yaw), y = toY(t.pitch), R = r * ppd;
    if (x < -R || x > W + R || y < -R || y > H + R) {
      // Off screen: an arrow on the edge pointing toward it.
      const ang = Math.atan2(y - cy, x - cx);
      const ex = clamp(x, 24 * d, W - 24 * d), ey = clamp(y, 24 * d, H - 24 * d);
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
      ctx.fillStyle = tok('--target');
      ctx.beginPath(); ctx.moveTo(10 * d, 0); ctx.lineTo(-8 * d, -8 * d); ctx.lineTo(-8 * d, 8 * d); ctx.closePath(); ctx.fill();
      ctx.restore();
      return;
    }
    ctx.fillStyle = tok('--target');
    ctx.globalAlpha = lit ? 1 : 0.85;
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = tok('--arena-ink'); ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.arc(x, y, R * 0.45, 0, Math.PI * 2); ctx.stroke();
  };
  if (running && s.kind === 'flick') {
    const F = s.data;
    drawTarget(F.cur, F.cur.r, false);
    if (F.flash && F.flash.t > 0) {
      ctx.strokeStyle = F.flash.good ? tok('--good') : tok('--arena-ink');
      ctx.globalAlpha = clamp(F.flash.t / 0.3, 0, 1);
      ctx.lineWidth = 2 * d;
      ctx.beginPath(); ctx.arc(toX(F.flash.yaw), toY(F.flash.pitch), (F.flash.good ? 4 : 1.2) * ppd * (1.4 - F.flash.t), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  if (running && s.kind === 'track') drawTarget(s.data.tgt, s.data.r, s.data.tgt.on);

  // Third-person games: the character sits left of the crosshair and blocks part of the view.
  if (game().camera === 'third' && s.kind !== 'drift') {
    const fx = cx - W * 0.17;
    ctx.fillStyle = tok('--arena-figure');
    ctx.strokeStyle = tok('--arena-major'); ctx.lineWidth = d;
    ctx.beginPath(); ctx.ellipse(fx, H * 1.02, W * 0.11, H * 0.26, 0, Math.PI, 0); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(fx + W * 0.01, H * 0.7, H * 0.085, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  const onT = running && s.kind === 'track' && s.data.tgt.on;
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
    ctx.fillText(String(Math.ceil(session.countLeft)), cx, cy - H * 0.22);
  } else if (s.kind === 'drift') {
    const D = s.data;
    ctx.fillStyle = tok('--arena'); ctx.globalAlpha = 0.6; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
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
    if (screen === 'test') renderBrief(true);
  }
  let l = '', r = '';
  const s = seg();
  if (screen === 'test' && session.phase === 'run') {
    if (s.kind === 'flick') {
      l = `Target ${Math.min(s.data.list.length + 1, s.n)} / ${s.n}`;
      r = `${s.data.list.filter(x => x.hit).length} hits${s.round ? ' · ' + s.title : ''}`;
    } else if (s.kind === 'track') {
      const TR = s.data;
      l = TR.t < TR.warm ? 'Settle in' : `On target ${pct(TR.T ? TR.on / TR.T : 0)}`;
      r = `${Math.max(0, s.warm + s.dur - TR.t).toFixed(1)} s`;
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
  if (screen === 'test' && session) tick(dt, edge);
  updateStatus();
  drawSticks();
  drawArena();
  requestAnimationFrame(frame);
}

syncSetup();
show('setup');
requestAnimationFrame(frame);
