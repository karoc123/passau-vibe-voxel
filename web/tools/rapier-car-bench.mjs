// Rapier terrain: the cost of building colliders around a car crossing the real city, headless in node (the tiles from
// public/data/tiles on disk). A car-sized kinematic body moves along a line at a speed, 60 frames a second; each frame
// the terrain is updated (builds within its budget) and the world stepped. Prints per-frame build and step times.
// usage: node tools/rapier-car-bench.mjs [--budget MS] [--speed KMH] [--chunk-lead] [--no-couple] [x0 z0 x1 z1]
import { runnerImport } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import zlib from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return +v; };
const flag = (k) => { const i = argv.indexOf(k); if (i < 0) return false; argv.splice(i, 1); return true; };
const budget = opt('--budget', 2), kmh = opt('--speed', 80), noCouple = flag('--no-couple');
const [x0, z0, x1, z1] = argv.length >= 4 ? argv.map(Number) : [1500, 700, 2300, 760];

const { module: T } = await runnerImport(`${root}src/physics/rapier/terrain.ts`, { root, logLevel: 'error' });
const { module: TD } = await runnerImport(`${root}src/tile-data.ts`, { root, logLevel: 'error' });
const R = (await import('@dimforge/rapier3d-compat')).default;
await R.init();
const meta = JSON.parse(fs.readFileSync(`${root}public/data/meta.json`, 'utf8'));
const N = meta.tiles.N;
const world = new R.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 60;
const origin = { x: Math.floor(x0 / 16) * 16, z: Math.floor(z0 / 16) * 16 };
const terrain = new T.RapierTerrain(R, world, meta, origin, { budgetMs: budget, couple: !noCouple });
// the tiles along the way, decoded up front (the page loads them as it goes; here only the build costs count)
const pal = T.terrainPalette(meta.palette);
const read = (p) => zlib.gunzipSync(fs.readFileSync(`${root}public/data/tiles/${p}`)).buffer;
const seen = new Set(), decodeMs = [];
const len = Math.hypot(x1 - x0, z1 - z0);
for (let s = 0; s <= len; s += 16) for (const dx of [-64, 0, 64]) for (const dz of [-64, 0, 64]) {
  const x = x0 + (x1 - x0) * s / len + dx, z = z0 + (z1 - z0) * s / len + dz;
  const tx = Math.floor(x / N), tz = Math.floor(z / N), k = `${tx}_${tz}`;
  if (seen.has(k) || tx < 0 || tz < 0) continue;
  seen.add(k);
  let a, b;
  try { a = read(`1/${k}.bin`); b = read(`1f/${k}.bin`); } catch { continue; /* off the map */ }
  const t0 = performance.now();
  terrain.setTile(tx, tz, T.terrainTile(N, TD.decodeTile(a, N), TD.decodeTile(b, N), pal));
  decodeMs.push(performance.now() - t0);
}
// the body: kinematic, the car's size, at the ground's height + 1 m
const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
world.createCollider(R.ColliderDesc.cuboid(0.9, 0.45, 2.1), body);
const v = kmh / 3.6, dir = { x: (x1 - x0) / len, z: (z1 - z0) / len };
const frames = Math.round(len / v * 60);
const upd = [], stp = [], tot = [], start = [];
let frozen = 0;
for (let f = 0; f < frames; f++) {
  const x = x0 + dir.x * v * f / 60, z = z0 + dir.z * v * f / 60;
  const g = terrain.groundAt(x, z, 400) ?? 0;
  body.setNextKinematicTranslation({ x: x - origin.x, y: g + 1, z: z - origin.z });
  const t0 = performance.now();
  const [ready] = terrain.update([{ x, z, vx: dir.x * v, vz: dir.z * v }], f * 1000 / 60);
  const t1 = performance.now();
  if (!ready) frozen++;
  world.step();
  const t2 = performance.now();
  // (the first second: the start's ~25 chunks at once and the wasm's warm-up; reported apart)
  if (f < 60) { start.push(t2 - t0); continue; }
  upd.push(t1 - t0); stp.push(t2 - t1); tot.push(t2 - t0);
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const fmt = (a) => `avg ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3)} p99 ${pct(a, 0.99).toFixed(2)} max ${Math.max(...a).toFixed(2)}`;
const st = terrain.stats;
console.log(JSON.stringify({ route: [x0, z0, x1, z1], kmh, budget, couple: !noCouple, frames, frozen }));
console.log(`tile decode (the collision form of a 128 m tile, on the main thread in the page): ${decodeMs.length} tiles, avg ${(decodeMs.slice(1).reduce((x, y) => x + y, 0) / (decodeMs.length - 1)).toFixed(1)} ms after the first (${decodeMs[0].toFixed(1)}), max ${Math.max(...decodeMs.slice(1)).toFixed(1)}`);
console.log(`start (1st s) total ${start.reduce((a, b) => a + b, 0).toFixed(0)} ms, max frame ${Math.max(...start).toFixed(1)}`);
console.log(`update ${fmt(upd)}\nstep   ${fmt(stp)}\nframe  ${fmt(tot)}  frames>8ms ${tot.filter((t) => t > 8).length}  >16ms ${tot.filter((t) => t > 16).length}`);
console.log(`builds ${st.builds} avg ${(st.buildMsTotal / st.builds).toFixed(2)} ms (js ${(st.buildJsMsTotal / st.builds).toFixed(2)}) max ${st.buildMsMax.toFixed(2)} ms; chunks ${st.chunks} voxels ${st.voxels} tris ${st.tris}\nslowest build ${JSON.stringify(st.slowest, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v)}`);
