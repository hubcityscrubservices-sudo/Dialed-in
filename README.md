# Dialed In

Controller aim tuning in the browser. A player answers a few questions, runs short aim tests with
a PlayStation or Xbox controller, and gets suggested sensitivity, deadzone and response-curve
settings for their game, each with the measurements behind it.

## Warm-up challenge

60 seconds of flicks (about 2 in 5 above or below), 4-second tracking bursts and turn-arounds, at
the player's own settings from the setup form. Scoring (`src/challenge.js`):

- a hit scores `30 × ID × speed × streak`, where ID is the Fitts index of difficulty
  (`log2(D/W + 1)`), speed runs from ×0.5 to ×2 against an expected time for that difficulty, and
  each consecutive hit adds +10% up to +100%
- time on a moving target scores 60 points per second
- a missed shot costs 25 points and ends the streak; a target left for 3 s ends the streak

Codes pick the targets: `d-YYYY-MM-DD` is the daily challenge (same for everyone that day, UTC),
`p-xxxxxx` is a random practice run, and any code can be shared and typed in, or opened as a
`#code` link once the site is on GitHub Pages. Personal bests are kept in the browser.

The challenge runs in fixed 1/60 s ticks with stick input rounded to 1/1000 and all randomness from
the code, and every run is recorded (about 15 KB). Replaying the recording reproduces the score
exactly, and edited input or settings do not, so a server can check leaderboard entries.

Simulated players over 10 daily codes: casual about 2,500, decent about 9,300, sharp about 15,100.

## Report card and settings duel

After every challenge run, the end screen splits the score by kind of target (sideways flicks,
up-and-down flicks, turn-arounds, moving targets) with hit rate and pace against the expected time
for each target's difficulty (`src/report.js`). Hints appear only for big gaps with enough targets:
up-and-down targets 30% slower or 20 points less accurate than sideways ones (vertical sensitivity),
the turn drill's rules on turn-arounds (look boost), trailing or leading moving targets more than 25%
of the time, and the speed rule across flicks (sensitivity).

The settings duel (`src/duel.js`) plays the challenge four times for 30 seconds: old settings against
suggested ones, including the turn drill's boost advice, in a hidden ABBA or BAAB order. Runs 1–2
share one code and runs 3–4 another, so each setting plays both target sets. The verdict uses the
same blind-test rule as Verify; the results also show both scores on each target set and how each
side felt. It starts from the calibration results page.

## Modes

| Mode | Time | What it does |
|---|---|---|
| Quick | ~3 min | Stick check, flick test (12 targets, some above or below), tracking test, turn-around drill, zoomed ADS rounds, then suggested settings with reasons. |
| Verify | ~5 min | Quick, then a blind ABBA/BAAB test of old vs suggested settings. Reports how likely the new settings are better (bootstrap over targets and tracking seconds), next to the player's own feel ratings. |
| Deep | ~8 min | Stick check, then 7–9 short blind rounds at different sensitivities. The first three bracket the current speed, round five repeats it as a control, and the rest go where the fitted curve says the best speed is. Reports the best setting, the range within noise of it, and whether sensitivity matters for this player at all. |

## Games

Call of Duty, Fortnite, Apex Legends, ARC Raiders, and a generic profile. Profiles live in
`src/games.js`. Turn rates are modeled approximations.

ARC Raiders menu names, the sensitivity range (1–400) and the three response curves (Linear,
Sinusoidal, Exponential) come from the PS5 Wireless Controller screen. The game has no outer or
trigger deadzone, so those rows don't appear for it. The range models a third-person camera, Look
Boost (+55% turn speed at full stick, ramping up over 1.6 s, an assumption about what 55 means) and
Sinusoidal as an S-curve. A game can give each curve slot its own shape (`curve.fn`).

## Mouse mode

Pick Mouse under "Aiming with". The range captures the pointer with raw input (Pointer Lock with
`unadjustedMovement`, in Chrome and Edge), so Windows pointer speed and acceleration don't apply, just as in
games with raw input. A mouse turns the camera by a fixed angle per count, so a mouse profile's turn
"rate" is degrees per count, and the same Quick, Verify and Deep code tunes it (every comparison is a ratio
of rates). The turn drill, ADS rounds and curve/vertical screening are controller-only.

- **Conversions.** Counter-Strike 2 and Apex (0.022 degrees per count at sensitivity 1), Valorant (0.07),
  Overwatch 2 and Call of Duty (0.0066) use the published figures. ARC Raiders, Fortnite and "another game"
  take your cm per full turn at your current sensitivity (measure once in the game with a ruler, or take it
  from a sensitivity calculator) and scale from there.
- **Mouse check.** "Measure my DPI" under the DPI field runs it on its own and fills the field in; otherwise it
  runs as the first calibration step. Three slides along a bank card (3.37 in, 8.56 cm), with the same side of the mouse lined up with each end of the card (a diagram shows it): the real DPI as the browser sees it (a wrong DPI
  in setup, or the browser's display-scale shrink, is caught and corrected), pointer acceleration when raw
  input isn't available (a fast swipe travels further than slow ones), and the report rate from coalesced
  pointer events.
- **Results** give the sensitivity in the game's own units with cm/360 beside it.
- **Challenge.** Mouse runs record raw counts per tick and carry their degrees per count, so the
  server replays them exactly and they go on the leaderboard like controller runs.

## Controller feel

- Setup asks for the response curve and deadzone you actually use, in the game's own terms, instead
  of assuming the defaults.
- **Turn speed check** (optional): with turning boost off, time 5 full spins at full stick in your game.
  The range then turns at your measured speed rather than the built-in estimate (`kTurn`, a multiple of
  the profile's rate, carried in challenge settings and range-checked by the server).
- The challenge draws the camera between its 60 Hz steps, so turns don't stutter on displays that
  aren't exactly 60 Hz, and a quick tap of fire between steps still counts. Drawing only; replays are unchanged.
- The third-person character is drawn see-through so it can't hide a target.

## Field of view

The range draws through a true perspective camera at the FOV you enter (src/camera.js), so a turn moves
the picture across the screen the same way it does in your game. Sensitivity is a turn rate in degrees per
second, which FOV does not change, but FOV changes how fast that rate *looks*: at 120 the world slides
past slower near the crosshair than at 70. Matching it removes that "different feel".

Games state FOV differently, so each profile names its convention and the range converts it: Call of Duty
is horizontal on 16:9, Apex uses a 4:3 scale (90 there is about 106 on a 16:9 screen), Fortnite's is fixed.
ARC Raiders' FOV range and convention come from player guides and still need checking against the menu.
A range that isn't 16:9 keeps the vertical FOV and shows more or less to the sides, as games do.

## Vertical sensitivity

Two of every five flick targets sit mostly above or below (within 25° of vertical); the rest stay
within 50° of horizontal, so the two groups never mix. Comparing overshoot and stopping short on
up/down targets against side-to-side ones gives a vertical-to-horizontal adjustment, which is then
carried along with any horizontal change. Games with their own vertical setting (ARC Raiders, Call
of Duty) get a value for it, and setup asks for the current one. Other games get a relative
suggestion marked "If your game has it". Deep mode keeps the player's vertical-to-horizontal balance
while it moves the horizontal speed, and scores vertical across all rounds.

## Turn-around drill

Six targets 90–170° to alternating sides, so each turn needs full stick. For each it records time
to get within 10° (scaled to a 180° turn), share of that time at full stick, the longest unbroken
full push, and how far the crosshair ran past the target. Blowing past 40% or more of targets by
more than 8° means less boost. Slow (over 0.85 s per 180°) while holding full stick at least 60% of
the time means more boost, or a shorter ramp-up when the longest full push is shorter than the
current ramp-up. Slow without pushing all the way leaves boost alone. ARC Raiders gets Horizontal
Look Boost (±15) and Look Boost Ramp-up Time (−0.4 s) rows, with setup fields for the current
values. Other games get a generic "turn boost" row. Verify keeps look boost at the player's values.

## ADS / zoom

After the hip-fire tests come zoomed rounds: 8 targets and 8 seconds of tracking through a 1.5×
sight, then 6 and 6 through a 4× scope when the game has a separate scoped setting. The view
narrows by the zoom factor and targets shrink and slow by the same factor, like enemies at range.
Turn speed is hip-fire speed times the ADS multiplier, with the game's zoom look boost if it has
one. The same speed rules as hip-fire give a change in zoomed speed; the new multiplier lands on
that speed even if hip-fire sensitivity also changes. ARC Raiders (Zoom / Scoped Zoom Sensitivity
Multiplier) and Call of Duty (low / high zoom) get values in their menu's units; other games get one
generic round and a relative change. Verify still compares hip-fire settings only.

## Stick check

The first step, about 15 seconds, in three parts:

1. **Hands off:** drift on both sticks and both triggers at rest. This sets the look and movement
   deadzones.
2. **Roll the sticks around the edge:** the full-push reading in 16 directions. A stick that tops
   out below 0.97 in any direction gets an outer deadzone (max input) just under its weakest
   direction, so full turn speed is always reachable. Square gates are noted.
3. **Squeeze the triggers:** resting value and full travel, which set the trigger deadzone.

A game with no menu entry for one of these gets a generic row marked "If your game has it". A game
known not to have the setting (`null` in its profile) gets no row.

## Scoring

- **Flick throughput** (bits/s): effective Fitts' throughput, ISO 9241-9 style. The endpoint is
  the crosshair position at the first shot. Scatter along the movement axis sets the effective
  target width, so firing early and wide costs as much as being slow.
- **Tracking error**: mean angular distance from the target, scored in one-second chunks.
- Overshoot, stopping short, trailing/leading and extra corrections drive the direction of each
  suggestion (`src/analysis.js`).

## Deep mode

Each round is scored as speed and accuracy combined (flick throughput and tracking error, each
scaled to the session average and weighted by playstyle). The scores are fit with
`score = a + b·x + c·x² + d·t`, where `x` is log2 of the turn-speed multiplier and `t` is round
order, so warm-up doesn't tilt the result. Bootstrapping the trials inside each round gives the
range of plausible best speeds and how often a 30% speed change costs more than 4% of the score:
at least 80% of the time means sensitivity matters, at most 30% means it doesn't, anything else
is unclear.

Checked against simulated players (`test/deep.test.js`, plus a 40-player sweep): a clear best
speed inside the tested range is found within about 5% in 7 rounds. When the best speed is far
from the current one, the estimate leans about 9% toward the current speed and the verdict is
more often "unclear". Players with no real preference are called "matters" about 5% of the time.

## Deep mode: other settings, tested blind

After the sensitivity search, four rounds at the best speed cover every pairing of two response
curves (the current one and the one the quick read-out leans to, or the nearest other option) and
two vertical speeds (13% slower and 15% faster than the current balance): a 2×2 full factorial in
random order. Each setting is judged by pooling the two rounds at each level, curve on the
playstyle's mix of flicks and tracking, vertical speed on up/down targets only. A clear winner
replaces the read-out's advice; otherwise the current setting stays and the results say the
setting didn't make a measurable difference.

## How sure the blind tests are

Verify and screening share one comparison. It resamples whole rounds and then the targets inside
them, so a good or bad round counts as noise, and it only names a winner at 90% odds with at least a
15% overall difference. Against simulated players with round-to-round swings, that calls a winner
10–13% of the time when there is no real difference, and catches a 30% difference 85–88% of the
time. Differences around 15% are caught about 40% of the time; the results say so. (The earlier
rule, 80% odds with no minimum, called a winner in about 45% of no-difference runs.)

## Test data

"Copy test data" on the results page copies every measurement from the run (stick check, every
target and tracking second, ratings, settings used, results) as JSON, for tuning thresholds
against real play. Built by `src/export.js`.

## Leaderboards

- `supabase/migrations/20261021000000_scores.sql`: one `scores` row per player, code and input type
  (controller, mouse or on-screen stick; mouse added in `20261022000000_scores_mouse.sql`), holding their
  best verified run. The end screen shows the board for your input or all inputs together, with each
  row's input marked; the warm-up panel's top three is the combined board.
- `supabase/migrations/20261023000000_all_time_board.sql`: `all_time_board(p_input, p_limit)`, each
  player's best daily score ever (practice runs excluded), read by the main page's All time tab. A
  security-definer function, so it can group by player id without exposing it. Row-level security lets anyone
  read the board columns; recordings, settings and player ids are not readable, and there are no
  write policies.
- `supabase/functions/submit-score`: checks the code (no future dailies), name, settings (within the
  game's menu) and that the run is a full 60 seconds, replays the recording with the same engine the
  browser used, and stores the replayed score only if it matches the claimed one. Keeps each
  player's best and returns their rank on their input's board and across all inputs. Input must
  match the game (mouse games only with a mouse), and mouse runs must carry their degrees per count.
- `supabase/functions/_shared/engine/` is a copy of the engine made by `npm run sync:engine` (part of
  `npm run build`); a test fails if it drifts from `src/`.
- `src/config.js` holds the project URL and public key; empty means leaderboards are off. The
  claude.ai preview blocks outside connections, so boards only work on the website build.

Replays stop edited scores, not aim bots that play a real run; stored recordings let the top of a
board be reviewed.

### Deploy (once, from a clone of this repo)

```sh
supabase login
supabase link --project-ref <project-ref>        # the id in the project URL
supabase db push                                 # scores table, mouse runs, all-time board
supabase functions deploy submit-score --no-verify-jwt
```

Then put the project URL and public (anon or publishable) key in `src/config.js` and push.

## Hosting

`.github/workflows/pages.yml` tests, builds and publishes `dist/index.html` to GitHub Pages on
every push to `main`. On the free plan this needs the repo to be public, with
Settings → Pages → Source set to "GitHub Actions".

## Look and feel

A proving ground at dusk, as one committed dark look: Big Shoulders (stencil and condensed) for
display type, Hanken Grotesk for reading, Martian Mono for numbers; ember for actions, amber for
best values, mint for anything good. Plates have cut corners over a topographic contour sky, and
the step rail is a trail of waypoints.

The aim range (`src/scenery.js`) is drawn in the sim's own angular space, so everything in it
stays fixed in the world as the camera turns: one of four dusk palettes, a sun, stars and three
ridgelines generated from a seed (each challenge code gets its own range), haze at the horizon, a
survey grid on the ground, a compass tape with real headings, drone targets with spinning guard
rings, light beacons on turn-around targets, light trails on moving targets, hit sparks and
shockwaves, chevrons with the angle to off-screen targets, and a scope lens with mil marks. The
challenge HUD (rolling score, streak pips with the multiplier, a ring for time left) is drawn in
the canvas. With reduced motion on, the rings, sparks and twinkle hold still. Nothing visual
touches scoring.

## Develop

```sh
npm install
npm test        # node:test, logic only (src/sim.js, analysis.js, verify.js)
npm run build   # dist/index.html (standalone) and dist/artifact.html (for publishing)
```

Open `dist/index.html` in Chrome or Edge with a controller connected. No server needed.

## Layout

- `src/games.js`: per-game profiles and playstyle weights
- `src/sim.js`: stick shaping, look boost, flick and tracking trials (pure)
- `src/analysis.js`: throughput, summaries, recommendations (pure)
- `src/verify.js`: blind test plan and bootstrap comparison (pure)
- `src/deep.js`: Deep mode search, curve fit and read-out (pure)
- `src/challenge.js`: warm-up challenge engine, scoring, seeds and replays (pure)
- `src/report.js`: challenge report card (pure)
- `src/duel.js`: settings duel plan and comparison (pure)
- `src/leaderboard.js`, `src/config.js`: leaderboard client and project settings
- `supabase/`: scores table, submit-score function, shared submission logic
- `src/export.js`: test data export
- `src/hardware.js`: stick check measurements and the settings they suggest (pure)
- `src/main.js`: UI, input polling, scene assembly, session flow
- `src/scenery.js`: the aim range's world, targets, effects and lens (drawing only)
- `src/page.html`, `src/styles.css`: page shell
- `scripts/build.mjs`: bundles everything into one HTML file

## Roadmap

1. ~~Fitts' throughput scoring~~
2. ~~Verify mode~~
3. ~~ARC Raiders profile with third-person camera~~
4. ~~Deep mode, sensitivity only (adaptive search)~~
5. ~~Stick check: movement, outer and trigger deadzones~~
6. ~~Vertical sensitivity~~
7. ~~ADS / zoom test~~
8. ~~Turn-around drill for look boost and ramp-up~~
9. ~~Deep mode, multi-factor screening~~ (curve and vertical speed)
10. ~~Warm-up challenge with seeded codes and replays~~
11. ~~Report card and settings duel~~
12. ~~Leaderboards on Supabase (replay-verified)~~ (needs deploy + keys)
13. Tune thresholds from real runs (Copy test data)
