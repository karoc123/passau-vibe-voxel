// Rapier car scenarios (src/physics/rapier/scenarios.ts), headless in node.
// usage: node tools/rapier-car.mjs [--spike] [--json] [scenario ...]
//          synthetic voxel terrain; exit code 1 if a scenario fails
//        node tools/rapier-car.mjs [--spike] --real X,Z,HEADING_DEG,KMH,SECONDS[,STEER[,V0]]
//          the real city (public/data/tiles on disk): the car dropped at (X, Z) heading HEADING_DEG (0: +z, 90: +x),
//          held at KMH (STEER -1..1 held; starting at V0 km/h, default KMH) for SECONDS; prints its path every 0.5 s and what happened
//        node tools/rapier-car.mjs --road I[,KMH[,REV]] [--road ...]
//          the real city: the car follows road I of public/data/traffic.json (REV 1: from its far end) at KMH (default
//          30), steering by pure pursuit; prints how much it wobbled (scenarios.ts wobble) and what happened
//        node tools/rapier-car.mjs --roads [KMH]: the steepest roads (the wobble benchmark), one line each
//   --spike: the spike's car (no step wedges, wall glancing, air assist) for comparison
import { runnerImport } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
const load = (p) => runnerImport(`${root}src/${p}`, { root, logLevel: 'error' }).then((m) => m.module);
const sc = await load('physics/rapier/scenarios.ts');
const car = await load('physics/rapier/car.ts');
if (args.includes('--spike')) sc.scenarioTuning.tuning = car.SPIKE;

// the real city's tiles within `reach` m of the points (x, z)
async function realMap(points, reach) {
  const T = await load('physics/rapier/terrain.ts'), TD = await load('tile-data.ts');
  const R = (await import('@dimforge/rapier3d-compat')).default;
  await R.init();
  const meta = JSON.parse(fs.readFileSync(`${root}public/data/meta.json`, 'utf8'));
  const N = meta.tiles.N, pal = T.terrainPalette(meta.palette);
  const read = (p) => zlib.gunzipSync(fs.readFileSync(`${root}public/data/tiles/${p}`)).buffer;
  const want = new Set();
  for (const [x, z] of points) for (let tz = Math.floor((z - reach) / N); tz <= Math.floor((z + reach) / N); tz++) for (let tx = Math.floor((x - reach) / N); tx <= Math.floor((x + reach) / N); tx++) want.add(`${tx}_${tz}`);
  const tiles = [];
  for (const k of want) {
    if (!fs.existsSync(`${root}public/data/tiles/1/${k}.bin`)) continue;
    const [tx, tz] = k.split('_').map(Number);
    tiles.push({ tx, tz, tile: T.terrainTile(N, TD.decodeTile(read(`1/${k}.bin`), N), TD.decodeTile(read(`1f/${k}.bin`), N), pal) });
  }
  return { meta, tiles };
}

const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');
const roadArgs = args.flatMap((a, i) => (a === '--road' ? [args[i + 1]] : []));
const roadsAt = args.indexOf('--roads');
if (roadArgs.length || roadsAt >= 0) {
  const traffic = JSON.parse(fs.readFileSync(`${root}public/data/traffic.json`, 'utf8'));
  // the benchmark: the steepest roads of Passau (each with ~40 m at 15-25 %), both ways
  const bench = [435, 451, 533, 54, 139, 293, 358, 1, 421, 355];
  const kmhAll = roadsAt >= 0 && args[roadsAt + 1] && !args[roadsAt + 1].startsWith('--') ? +args[roadsAt + 1] : 30;
  const runs = roadArgs.length ? roadArgs.map((r) => r.split(',').map(Number)) : bench.flatMap((i) => [[i, kmhAll, 0], [i, kmhAll, 1]]);
  const tot = { pitchJit: 0, rollJit: 0, liftPct: 0, lifts: 0, n: 0 };
  for (const [i, kmh = 30, rev = 0] of runs) {
    const pts = traffic.roads[i].p.map((q) => [q[0], q[1]]);
    if (rev) pts.reverse();
    const map = await realMap(pts, 48);
    const a = Math.atan2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    const p0 = traffic.roads[i].p[rev ? traffic.roads[i].p.length - 1 : 0];
    const s = new sc.Sim(map, { x: pts[0][0], y: p0[2] + 1.5, z: pts[0][1] }, a, kmh / 3.6);
    let L = 0;
    for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const f = sc.follow(pts, kmh);
    const end = pts[pts.length - 1];
    // (until near the road's end, or stuck)
    s.run(L / (kmh / 3.6) * 1.6 + 2, (sim) => f(sim));
    const log = s.log.filter((l) => Math.hypot(l.x - end[0], l.z - end[1]) > 8);
    const w = sc.wobble(log), last = s.log[s.log.length - 1];
    const ev = s.events.filter((e) => e.kind !== 'impact' || e.speed > 2).map((e) => `${e.kind}${e.crash ? '!' : ''}`);
    const left = Math.hypot(last.x - end[0], last.z - end[1]);
    console.log(`road ${String(i).padEnd(4)} ${rev ? 'rev' : 'fwd'} ${kmh} km/h ${L.toFixed(0).padStart(4)} m  ${fmt(w)} minUp=${Math.min(...s.log.map((l) => l.up)).toFixed(2)} left=${left.toFixed(0)}m ${s.car.status} ${ev.length ? ev.join(',') : ''}`);
    for (const k of ['pitchJit', 'rollJit', 'liftPct', 'lifts']) tot[k] += w[k];
    tot.n++;
    if (args.includes('-v')) for (let k = 0; k < s.log.length; k += 15) { const l = s.log[k]; console.log(`  t ${l.t.toFixed(2)} ${l.x.toFixed(1)},${l.y.toFixed(2)},${l.z.toFixed(1)} ${l.kmh.toFixed(0)} km/h up ${l.up.toFixed(2)} wheels ${l.wheels} pr ${l.pr.toFixed(2)} rr ${l.rr.toFixed(2)}`); }
    s.dispose();
  }
  if (tot.n > 1) console.log(`mean over ${tot.n}: pitchJit=${(tot.pitchJit / tot.n).toFixed(3)} rollJit=${(tot.rollJit / tot.n).toFixed(3)} liftPct=${(tot.liftPct / tot.n).toFixed(2)} lifts=${(tot.lifts / tot.n).toFixed(1)}`);
  process.exit(0);
}

const real = args.indexOf('--real');
if (real >= 0) {
  const [x, z, deg, kmh, secs, steer = 0, v0 = kmh] = args[real + 1].split(",").map(Number);
  const map = await realMap([[x, z]], kmh / 3.6 * secs + 64);
  const { meta, tiles } = map;
  const a = deg * Math.PI / 180;
  const s = new sc.Sim({ meta, tiles }, { x, z }, a, v0 / 3.6);
  const cr = sc.cruise(kmh);
  s.run(secs, (sim) => ({ ...cr(sim), steer }));
  for (let i = 0; i < s.log.length; i += 30) {
    const l = s.log[i];
    console.log(`t ${l.t.toFixed(1)}  ${l.x.toFixed(1)},${l.y.toFixed(2)},${l.z.toFixed(1)}  ${l.kmh.toFixed(0)} km/h  up ${l.up.toFixed(2)}  wheels ${l.wheels}`);
  }
  const ev = s.events.filter((e) => e.kind !== 'impact' || e.speed > 2);
  console.log('events', JSON.stringify(ev.map((e) => `${e.kind} ${e.speed.toFixed(1)}${e.crash ? ' CRASH' : ''}`)));
  console.log('wobble', fmt(sc.wobble(s.log)));
  console.log('status', s.car.status, 'steps (ms) avg', (s.log.reduce((q, l) => q + l.stepMs, 0) / s.log.length).toFixed(3), 'max', Math.max(...s.log.map((l) => l.stepMs)).toFixed(2));
  process.exit(0);
}

const ids = args.filter((a) => !a.startsWith('--'));
const out = await sc.runScenarios(ids.length ? ids : undefined);
if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(22)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
