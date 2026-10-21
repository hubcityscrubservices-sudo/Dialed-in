// Copies the challenge engine into the Supabase function so the server replays runs with exactly
// the code the browser played them with. test/server.test.js fails if the copies drift.
import { copyFileSync } from 'node:fs';

export const ENGINE_FILES = ['challenge.js', 'sim.js', 'games.js', 'util.js'];
for (const f of ENGINE_FILES) copyFileSync(`src/${f}`, `supabase/functions/_shared/engine/${f}`);
console.log(`synced ${ENGINE_FILES.length} engine files to supabase/functions/_shared/engine`);
