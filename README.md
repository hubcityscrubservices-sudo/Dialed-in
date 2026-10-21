# Dialed In

Controller aim tuning in the browser. A player answers a few questions, runs short aim tests with
a PlayStation or Xbox controller, and gets suggested sensitivity, deadzone and response-curve
settings for their game, each with the measurements behind it.

## Modes

| Mode | Time | What it does |
|---|---|---|
| Quick | ~2 min | Drift check, flick test, tracking test, then suggested settings with reasons. |
| Verify | ~4 min | Quick, then a blind ABBA/BAAB test of old vs suggested settings. Reports how likely the new settings are better (bootstrap over targets and tracking seconds), next to the player's own feel ratings. |
| Deep | next build | Screening rounds that change settings between blocks to find which ones matter for this player, then an adaptive search on those. |

## Games

Call of Duty, Fortnite, Apex Legends, ARC Raiders, and a generic profile. Profiles live in
`src/games.js`. Turn rates are modeled approximations. ARC Raiders menu names come from player
guides (Dexerto, SCUF, The Controller People) and still need checking in the game. It models a
third-person camera and Look Boost (extra turn speed at full stick).

## Scoring

- **Flick throughput** (bits/s): effective Fitts' throughput, ISO 9241-9 style. The endpoint is
  the crosshair position at the first shot. Scatter along the movement axis sets the effective
  target width, so firing early and wide costs as much as being slow.
- **Tracking error**: mean angular distance from the target, scored in one-second chunks.
- Overshoot, stopping short, trailing/leading and extra corrections drive the direction of each
  suggestion (`src/analysis.js`).

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
- `src/main.js`: UI, input polling, drawing, session flow
- `src/page.html`, `src/styles.css`: page shell
- `scripts/build.mjs`: bundles everything into one HTML file

## Roadmap

1. ~~Fitts' throughput scoring~~
2. ~~Verify mode~~
3. ~~ARC Raiders profile with third-person camera~~
4. Deep mode, sensitivity only (adaptive search)
5. Deep mode, multi-factor screening (sensitivity, deadzone, curve, ADS)
