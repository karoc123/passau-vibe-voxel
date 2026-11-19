// Rapier car scenarios (src/physics/rapier/scenarios.ts), headless in node.
// usage: node tools/rapier-car.mjs [--spike] [--json] [scenario ...]
//          synthetic voxel terrain; exit code 1 if a scenario fails
//        node tools/rapier-car.mjs [--spike] --real X,Z,HEADING_DEG,KMH,SECONDS[,STEER[,V0]]
//          the real city (public/data/tiles on disk): the car dropped at (X, Z) heading HEADING_DEG (0: +z, 90: +x),
//          held at KMH (STEER -1..1 held; starting at V0 km/h, default KMH) for SECONDS; prints its path every 0.5 s and what happened
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

const real = args.indexOf('--real');
if (real >= 0) {
  const [x, z, deg, kmh, secs, steer = 0, v0 = kmh] = args[real + 1].split(",").map(Number);
  const T = await load('physics/rapier/terrain.ts'), TD = await load('tile-data.ts');
  const R = (await import('@dimforge/rapier3d-compat')).default;
  await R.init();
  const meta = JSON.parse(fs.readFileSync(`${root}public/data/meta.json`, 'utf8'));
  const N = meta.tiles.N, pal = T.terrainPalette(meta.palette);
  const read = (p) => zlib.gunzipSync(fs.readFileSync(`${root}public/data/tiles/${p}`)).buffer;
  const tiles = [];
  const reach = Math.ceil((kmh / 3.6 * secs + 64) / N);
  for (let tz = Math.floor(z / N) - reach; tz <= Math.floor(z / N) + reach; tz++) for (let tx = Math.floor(x / N) - reach; tx <= Math.floor(x / N) + reach; tx++) {
    const k = `${tx}_${tz}`;
    if (!fs.existsSync(`${root}public/data/tiles/1/${k}.bin`)) continue;
    tiles.push({ tx, tz, tile: T.terrainTile(N, TD.decodeTile(read(`1/${k}.bin`), N), TD.decodeTile(read(`1f/${k}.bin`), N), pal) });
  }
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
  console.log('status', s.car.status, 'steps (ms) avg', (s.log.reduce((q, l) => q + l.stepMs, 0) / s.log.length).toFixed(3), 'max', Math.max(...s.log.map((l) => l.stepMs)).toFixed(2));
  process.exit(0);
}

const ids = args.filter((a) => !a.startsWith('--'));
const out = await sc.runScenarios(ids.length ? ids : undefined);
if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const o of out) console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${o.name.padEnd(22)} ${Object.entries(o.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
process.exit(out.every((o) => o.pass) ? 0 : 1);
