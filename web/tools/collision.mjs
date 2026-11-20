// The FPV drone's collision (src/nav/voxel-collision.ts) headless: src/nav/collision-checks.ts (a synthetic world
// served as real node files; sweeps of the drone's cube, surfaces).
// usage: node tools/collision.mjs [--json]; exit code 1 if a check fails
import { runnerImport } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { module: m } = await runnerImport(`${root}src/nav/collision-checks.ts`, { root, logLevel: 'error' });
const out = await m.runCollisionChecks();
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(22)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
