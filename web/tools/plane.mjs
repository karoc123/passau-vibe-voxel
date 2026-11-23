// The plane's flight (src/nav/plane-flight.ts) headless: src/nav/plane-checks.ts on a synthetic world of boxes (level
// flight, throttle range, stall and recovery, climbing costs speed, turn, the map's wall, the ceiling, water landing,
// taxi and takeoff, crashes on land and on water, respawn, skim, loading, fuzz, pitch_smooth: no snap on W/S). Then, on the real data (public/data)
// if it is there, through the real VoxelCollision (node files read from disk) and its water: the Danube flown from
// the west edge to the Altstadt 60 m over its water by a simple follower (no crash), and a landing on it, a taxi and a
// takeoff.
// The jet (PLANE's core with JET's numbers and the aerobatic law: nav/jet-checks.ts): top speed, stall, roll rate, loop,
// inverted, turn, smooth pitch, the map's wall, crash and respawn, fuzz; on the real data a low pass over the Danube
// and the Altstadt at ~400 km/h, the collision tiles fetched as the viewer fetches them (no wait once under way).
// usage (in web/): node tools/plane.mjs [--type floatplane|jet] [--json] [--set KEY=VALUE ...] (--set: the types run);
// exit code 1 if a check fails
import fs from 'node:fs';
import { imp, serveTiles } from './lib.mjs';
import { web } from './data-dir.mjs';

const PF = await imp('src/nav/plane-flight.ts');
const PC = await imp('checks/plane-checks.ts');
const JC = await imp('checks/jet-checks.ts');
const args = process.argv.slice(2);
const type = args.includes('--type') ? args[args.indexOf('--type') + 1] : 'all';
if (!['all', 'floatplane', 'jet'].includes(type)) throw new Error(`--type floatplane | jet, not ${type}`);
const cfg = { ...PF.PLANE }, jet = { ...PF.JET };
for (let i = 0; i < args.length; i++) if (args[i] === '--set') {
  const [k, v] = args[++i].split('=');
  if (!(k in cfg)) throw new Error(`no PLANE.${k}`);
  if (type !== 'jet') cfg[k] = +v;
  if (type !== 'floatplane') jet[k] = +v;
}
const t0 = performance.now();
const out = [...(type !== 'jet' ? PC.runPlaneChecks(cfg) : []), ...(type !== 'floatplane' ? JC.runJetChecks(jet) : [])];
const D = `${web}/public/data/`;
if (fs.existsSync(`${D}meta.json`) && fs.existsSync(`${D}tiles/1`)) {
  const RC = await imp('checks/plane-real.ts');
  serveTiles(D); // the node files from disk at the paths VoxelCollision fetches
  const meta = JSON.parse(fs.readFileSync(`${D}meta.json`, 'utf8'));
  if (type !== 'jet') out.push(...await RC.runRealChecks(meta, cfg));
  if (type !== 'floatplane') out.push(...await RC.runJetRealChecks(meta, jet));
} else console.log('skip  real data (no public/data)');
if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(18)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
