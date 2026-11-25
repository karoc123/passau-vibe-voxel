// The map's edge at a block not built (scripts/map.json `blocks`, meta.json `built`, src/core/built.ts) headless:
// checks/edge-checks.ts -- what is built; the drone's sweep, the boat's water and the walker's world against such a
// block; the Rapier car driven into one (stopped at the edge, on the map); the plane flown at one (EDGE kept).
// usage (in web/): node tools/edge.mjs [--json]; exit code 1 if a check fails
import { imp } from './lib.mjs';

const t0 = performance.now();
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
await RAPIER.init();
const m = await imp('checks/edge-checks.ts');
const out = await m.runEdgeChecks();
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(18)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
