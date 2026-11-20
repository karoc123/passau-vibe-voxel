// Rapier car scenarios (src/physics/rapier/scenarios.ts) and the drive mode's (drive-scenarios.ts: a traffic car
// knocked out, a person hit, the river and back, a crash landing, through nav/drive-session.ts), headless in node.
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
const ds = await load('physics/rapier/drive-scenarios.ts');
const car = await load('physics/rapier/car.ts');
if (args.includes('--spike')) sc.scenarioTuning.tuning = car.SPIKE;
// --set key=value,...: the ride's numbers (car.ts RIDE) and the car's surface (terrain.ts DRIVE) changed for this run
const setAt = args.indexOf('--set');
if (setAt >= 0) {
  for (const kv of args[setAt + 1].split(',')) {
    const [k, v] = kv.split('=');
    const o = k in sc.RIDE ? sc.RIDE : k in sc.DRIVE ? sc.DRIVE : null;
    if (!o) throw new Error(`--set: no ${k} in RIDE (${Object.keys(sc.RIDE)}) or DRIVE (${Object.keys(sc.DRIVE)})`);
    o[k] = +v;
  }
}

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
  const KEYS = ['pitchJit', 'rollJit', 'liftPct', 'lifts', 'vyErr', 'heave', 'lightPct', 'airPct'];
  const tot = { n: 0 };
  for (const k of KEYS) tot[k] = 0;
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
    // (up to where it leaves the map, if it does: off the map edge it falls for ever)
    const off = s.log.findIndex((l) => l.x < 0 || l.z < 0 || l.x > map.meta.W || l.z > map.meta.D);
    const log = s.log.slice(0, off < 0 ? s.log.length : off).filter((l) => Math.hypot(l.x - end[0], l.z - end[1]) > 8);
    const w = sc.feel(log), last = s.log[s.log.length - 1];
    const ev = s.events.filter((e) => e.kind !== 'impact' || e.speed > 2).map((e) => `${e.kind}${e.crash ? '!' : ''}`);
    const left = Math.hypot(last.x - end[0], last.z - end[1]);
    console.log(`road ${String(i).padEnd(4)} ${rev ? 'rev' : 'fwd'} ${kmh} km/h ${L.toFixed(0).padStart(4)} m  ${fmt(w)} minUp=${Math.min(...log.map((l) => l.up)).toFixed(2)} left=${left.toFixed(0)}m ${s.car.status} ${ev.length ? ev.join(',') : ''}`);
    for (const k of KEYS) tot[k] += w[k];
    tot.n++;
    if (args.includes('-v')) for (let k = 0; k < s.log.length; k += 15) { const l = s.log[k]; console.log(`  t ${l.t.toFixed(2)} ${l.x.toFixed(1)},${l.y.toFixed(2)},${l.z.toFixed(1)} ${l.kmh.toFixed(0)} km/h up ${l.up.toFixed(2)} wheels ${l.wheels} pr ${l.pr.toFixed(2)} rr ${l.rr.toFixed(2)}`); }
    s.dispose();
  }
  if (tot.n > 1) console.log(`mean over ${tot.n}: ${KEYS.map((k) => `${k}=${(tot[k] / tot.n).toFixed(k.endsWith('Jit') || k === 'vyErr' ? 3 : 2)}`).join(' ')}`);
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
  console.log('feel', fmt(sc.feel(s.log)));
  console.log('status', s.car.status, 'steps (ms) avg', (s.log.reduce((q, l) => q + l.stepMs, 0) / s.log.length).toFixed(3), 'max', Math.max(...s.log.map((l) => l.stepMs)).toFixed(2));
  process.exit(0);
}

// The real city (public/data on disk): across the Schanzlbrücke at 50 km/h, south to north along its carriageway (traffic
// roads 186, 570, 149, 660, 111), off the street onto the deck over the Danube and back onto the street. The deck is a
// slab over the river in whole metres (18 -> 19 -> 18 -> 17 m along it): a voxel staircase the car bumped over, unless
// its top is ramped as a street's (ramps.ts). Judged by the body's vertical acceleration (max |dvy/dt|), the pitch
// rate's peak and the share of samples with a wheel off the deck. Skipped when the data are not there.
const SCHANZL = [[1202, 459], [1205, 471], [1211, 489], [1215, 503], [1218, 515], [1223, 535], [1226, 549], [1229, 561], [1232, 576],
  [1235, 590], [1238, 602], [1242, 620], [1246, 634], [1247, 642], [1249, 651], [1252, 666], [1254, 678], [1257, 692], [1259, 702]];
async function schanzlBridge() {
  if (!fs.existsSync(`${root}public/data/meta.json`)) return null;
  const pts = [];
  for (let k = 0; k < SCHANZL.length - 1; k++) {
    const [a, b] = [SCHANZL[k], SCHANZL[k + 1]], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
    for (let i = 0; i < n; i++) pts.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
  }
  pts.push(SCHANZL[SCHANZL.length - 1]);
  const map = await realMap(pts, 48);
  const h = Math.atan2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  const s = new sc.Sim(map, { x: pts[0][0], y: 20, z: pts[0][1] }, h, 50 / 3.6);
  s.run(17, sc.follow(pts, 50));
  // (on the bridge and its approaches: from 10 m past the start to 15 m before the end)
  const L = s.log.filter((l) => l.z > 470 && l.z < 690);
  let acc = 0, pr = 0, lift = 0;
  for (let i = 1; i < L.length; i++) acc = Math.max(acc, Math.abs(L[i].vy - L[i - 1].vy) * 60);
  for (const l of L) { pr = Math.max(pr, Math.abs(l.pr)); if (l.wheels < 4) lift++; }
  if (process.env.SCHANZL_DEBUG) for (const l of L) if (Math.abs(l.pr) > 0.4 || l.wheels < 4) console.log(l.x.toFixed(1), l.z.toFixed(1), l.y.toFixed(2), l.road.toFixed(2), 'pr', l.pr.toFixed(2), 'w', l.wheels);
  const end = s.log[s.log.length - 1], r2 = (x) => Math.round(x * 100) / 100;
  const detail = { zEnd: r2(end.z), minKmh: r2(Math.min(...L.map((l) => l.kmh))), maxVertAccel: r2(acc), pitchRateMax: r2(pr), liftPct: r2(100 * lift / Math.max(1, L.length)),
    minUp: r2(Math.min(...L.map((l) => l.up))), status: s.car.status };
  s.dispose();
  return { name: 'schanzl_bridge', pass: end.z > 690 && detail.minUp > 0.9 && acc < 25 && pr < 0.6 && detail.liftPct < 2, detail };
}

const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--set');
const out = [...await sc.runScenarios(ids.length ? ids : undefined), ...await ds.runDriveScenarios(ids.length ? ids : undefined)];
if (!ids.length || ids.includes('schanzl_bridge')) { const o = await schanzlBridge(); if (o) out.push(o); }
if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(22)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
