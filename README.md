# Dialed In

Controller aim tuning in the browser. A player answers a few questions, runs short aim tests with
a PlayStation or Xbox controller, and gets suggested sensitivity, deadzone and response-curve
settings for their game, each with the measurements behind it.

## Modes

| Mode | Time | What it does |
|---|---|---|
| Quick | ~2 min | Stick check, flick test (12 targets, some above or below), tracking test, then suggested settings with reasons. |
| Verify | ~4 min | Quick, then a blind ABBA/BAAB test of old vs suggested settings. Reports how likely the new settings are better (bootstrap over targets and tracking seconds), next to the player's own feel ratings. |
| Deep | ~5 min | Stick check, then 7–9 short blind rounds at different sensitivities. The first three bracket the current speed, round five repeats it as a control, and the rest go where the fitted curve says the best speed is. Reports the best setting, the range within noise of it, and whether sensitivity matters for this player at all. |

## Games

Call of Duty, Fortnite, Apex Legends, ARC Raiders, and a generic profile. Profiles live in
`src/games.js`. Turn rates are modeled approximations.

ARC Raiders menu names, the sensitivity range (1–400) and the three response curves (Linear,
Sinusoidal, Exponential) come from the PS5 Wireless Controller screen. The game has no outer or
trigger deadzone, so those rows don't appear for it. The range models a third-person camera, Look
Boost (+55% turn speed at full stick, ramping up over 1.6 s, an assumption about what 55 means) and
Sinusoidal as an S-curve. A game can give each curve slot its own shape (`curve.fn`).

## Vertical sensitivity

Two of every five flick targets sit mostly above or below (within 25° of vertical); the rest stay
within 50° of horizontal, so the two groups never mix. Comparing overshoot and stopping short on
up/down targets against side-to-side ones gives a vertical-to-horizontal adjustment, which is then
carried along with any horizontal change. Games with their own vertical setting (ARC Raiders, Call
of Duty) get a value for it, and setup asks for the current one. Other games get a relative
suggestion marked "If your game has it". Deep mode keeps the player's vertical-to-horizontal balance
while it moves the horizontal speed, and scores vertical across all rounds.

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

## Hosting

`.github/workflows/pages.yml` tests, builds and publishes `dist/index.html` to GitHub Pages on
every push to `main`. On the free plan this needs the repo to be public, with
Settings → Pages → Source set to "GitHub Actions".

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
- `src/hardware.js`: stick check measurements and the settings they suggest (pure)
- `src/main.js`: UI, input polling, drawing, session flow
- `src/page.html`, `src/styles.css`: page shell
- `scripts/build.mjs`: bundles everything into one HTML file

## Roadmap

1. ~~Fitts' throughput scoring~~
2. ~~Verify mode~~
3. ~~ARC Raiders profile with third-person camera~~
4. ~~Deep mode, sensitivity only (adaptive search)~~
5. ~~Stick check: movement, outer and trigger deadzones~~
6. ~~Vertical sensitivity~~
7. ADS / zoom test
8. Turn-around drill for look boost and ramp-up
9. Deep mode, multi-factor screening
