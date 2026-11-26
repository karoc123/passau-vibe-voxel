// knip (node_modules/.bin/knip, the gate `knip`): unused files, exports and dependencies of web/.
// The node tools load TypeScript through vite's runner by a string, imp('src/...') of tools/lib.mjs or
// load('...') of tools/real-city.mjs (src/ implied), which knip cannot follow: those literals are read from the tools
// here and made entries, so a module only a tool loads is not reported unused (its exports count as used).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.dirname(fileURLToPath(import.meta.url));
const tools = path.join(web, 'tools');
const loaded = new Set();
for (const f of fs.readdirSync(tools).filter((f) => f.endsWith('.mjs'))) {
  const text = fs.readFileSync(path.join(tools, f), 'utf8');
  for (const m of text.matchAll(/\bimp\(\s*'([^']+\.ts)'\s*\)/g)) loaded.add(m[1]);
  // load(...) means src/ only where it is real-city's (other tools have a load of their own, for raw files)
  if (f === 'real-city.mjs' || /import\s*\{[^}]*\bload\b[^}]*\}\s*from\s*'\.\/real-city\.mjs'/.test(text)) {
    for (const m of text.matchAll(/\bload\(\s*'([^']+\.ts)'\s*\)/g)) loaded.add(`src/${m[1]}`);
  }
}

export default {
  entry: [
    'src/mesher.worker.ts', 'src/host/sim.worker.ts', // workers (new Worker(new URL(...)))
    'tools/*.mjs', // run by hand or by tools/gates.mjs
    ...[...loaded].sort(),
  ],
  project: ['src/**/*.ts', 'checks/**/*.ts', 'tools/**/*.mjs'],
  ignoreBinaries: ['uv'], // tile-roundtrip runs the pipeline's Python through uv, a tool on PATH, not a package
};
