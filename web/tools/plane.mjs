// The plane's flight (src/nav/plane-flight.ts) headless: src/nav/plane-checks.ts on a synthetic world of boxes (level
// flight, throttle range, stall and recovery, climbing costs speed, turn, the map's wall, the ceiling, water landing,
// taxi and takeoff, crashes on land and on water, respawn, skim, loading, fuzz, pitch_smooth: no snap on W/S). Then, on the real data (public/data)
// if it is there, through the real VoxelCollision (node files read from disk) and its water: the Danube flown from
// the west edge to the Altstadt 60 m over its water by a simple follower (no crash), and a landing on it, a taxi and a
// takeoff.
// usage (in web/): node tools/plane.mjs [--json] [--set KEY=VALUE ...]; exit code 1 if a check fails
import { runnerImport } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = async (p) => (await runnerImport(`${root}src/${p}`, { root, logLevel: 'error' })).module;
const PF = await load('nav/plane-flight.ts');
const PC = await load('nav/plane-checks.ts');
const args = process.argv.slice(2);
const cfg = { ...PF.PLANE };
for (let i = 0; i < args.length; i++) if (args[i] === '--set') { const [k, v] = args[++i].split('='); if (!(k in cfg)) throw new Error(`no PLANE.${k}`); cfg[k] = +v; }
const t0 = performance.now();
const out = PC.runPlaneChecks(cfg);
const D = `${root}public/data/`;
if (fs.existsSync(`${D}meta.json`) && fs.existsSync(`${D}tiles/1`)) {
  const RC = await load('nav/plane-real.ts');
  // the node files from disk at the paths VoxelCollision fetches
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input), m = /data\/(tiles\/.*)$/.exec(url);
    if (!m) return realFetch(input, init);
    const f = `${D}${m[1]}`;
    return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response(null, { status: 404 });
  };
  const meta = JSON.parse(fs.readFileSync(`${D}meta.json`, 'utf8'));
  out.push(...await RC.runRealChecks(meta, cfg));
} else console.log('skip  real data (no public/data)');
if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(18)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
