// Bundles src/ into one self-contained page:
//   dist/artifact.html   page body for publishing (the host adds the document wrapper)
//   dist/index.html      standalone file that opens straight from disk
//   dist/version.json    the build id, which an open page checks to notice a newer deploy
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Build id: a hash of every source file, so it changes whenever the page does.
const h = createHash('sha256');
for (const f of readdirSync('src').sort()) h.update(f).update(readFileSync('src/' + f));
const BUILD = h.digest('hex').slice(0, 12);

const out = await build({
  entryPoints: ['src/main.js'], bundle: true, format: 'iife', target: 'es2020', write: false,
  define: { __BUILD__: JSON.stringify(BUILD) }
});
const js = out.outputFiles[0].text;
const css = readFileSync('src/styles.css', 'utf8');
// split/join instead of replace() so `$` sequences in the code are left alone
const page = readFileSync('src/page.html', 'utf8').split('/*CSS*/').join(css).split('/*JS*/').join(js);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/artifact.html', page);
writeFileSync('dist/version.json', JSON.stringify({ build: BUILD }) + '\n');
writeFileSync('dist/index.html',
  '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' + page);
console.log(`built dist/ (${(page.length / 1024).toFixed(1)} KB, build ${BUILD})`);
