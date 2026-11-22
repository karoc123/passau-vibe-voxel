// The traffic's bodies near edits (src/physics/rapier/life-phys.ts, docs/plans/life-physics.md): what they cost, and
// how often a body loses its ghost, headless on the real data (the world sim alone: Traffic + LifePhysics, as
// tools/life-edit.mjs). The traffic runs WARM s round a point, then an edit there (a box marked edited, the voxels
// unchanged: the busiest case, every car near it a body on intact streets) and RUN s measured, per config:
//   bodies (avg, max), the bodies' tick (avg, p99, max ms; of which the world's steps and the colliders), the
//   colliders (chunks built, voxels, cap triangles), bodies spawned / released / put back on their ghosts (resync, with
//   the largest blend) / wrecked / held up, the cars waiting for their colliders (notReady), the whole traffic tick.
// usage (in web/): node tools/life-phys.mjs [--at X,Z] [--hour H] [--run S] [--box M] [--no-look] [-v] NEAR[:MAX] ...
//   (default: 30 60 100; MAX: the most bodies, default life-phys.ts MAX_BODIES; --box: the edited box's side, m)
import fs from 'node:fs';
import { DATA, load, nodeWorld, rawTile, readMeta } from './real-city.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (k) => { const i = argv.indexOf(k); if (i < 0) return false; argv.splice(i, 1); return true; };
const verbose = flag('-v'), look = !flag('--no-look');
const [AX, AZ] = opt('--at', '6500,2600').split(',').map(Number);
const HOUR = +opt('--hour', 17), RUN = +opt('--run', 30), BOX = +opt('--box', 8), WARM = 20;
const LP = await load('physics/rapier/life-phys.ts'), { Traffic, STEP } = await load('sim/traffic.ts'), { unpackTraffic } = await load('sim/traffic-pack.ts');
const configs = (argv.length ? argv : ['30', '60', '100']).map((a) => a.split(':').map(Number));
const meta = readMeta(), N = meta.tiles.N;
const td = unpackTraffic(JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8')));

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const f2 = (x) => x.toFixed(2);

for (const [near, max] of configs) {
  const { W } = await nodeWorld();
  const T = new Traffic(td, 7);
  T.ground = W;
  const focus = { x: AX, z: AZ };
  for (let i = 0; i < WARM / STEP; i++) T.update(STEP, HOUR, focus);
  const phys = await LP.LifePhysics.load(meta, focus, { near, maxBodies: max ?? LP.MAX_BODIES, look }, { load: async (p) => rawTile(p) });
  const want = near * 1.2 + 64;
  for (let tz = Math.floor((AZ - want) / N); tz <= Math.floor((AZ + want) / N); tz++) for (let tx = Math.floor((AX - want) / N); tx <= Math.floor((AX + want) / N); tx++) await phys.terrain.prefetch(tx * N + 1, tz * N + 1);
  T.bodies = phys;
  T.edited([AX - BOX / 2, AZ - BOX / 2, AX + BOX / 2, AZ + BOX / 2]);
  const tick = [], step = [], ter = [], nb = [], all = [];
  for (let i = 0; i < RUN / STEP; i++) {
    const t0 = performance.now();
    T.update(STEP, HOUR, focus);
    all.push(performance.now() - t0);
    const s = phys.stats;
    tick.push(s.tickMs); step.push(s.stepMs); ter.push(s.terrainMs); nb.push(s.bodies);
  }
  const s = phys.stats, ts = phys.terrain.stats;
  const row = {
    near, max: max ?? LP.MAX_BODIES, cars: T.cars.length, bodies: f2(avg(nb)), bodiesMax: Math.max(...nb),
    tickAvg: f2(avg(tick)), tickP99: f2(pct(tick, 0.99)), tickMax: f2(Math.max(...tick)), steps: f2(avg(step)), colliders: f2(avg(ter)),
    usPerBodyTick: f2(avg(tick) / Math.max(0.01, avg(nb)) * 1000), trafficTick: f2(avg(all)),
    chunks: ts.chunks, builds: ts.builds, voxels: ts.voxels, tris: ts.tris,
    spawned: s.spawned, released: s.released, resynced: s.resynced, releasePop: f2(s.releasePop), wrecked: s.lost, held: s.held, notReady: s.notReady,
  };
  console.log(Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' '));
  if (verbose) for (const l of phys.log.filter((x) => x.kind === 'resync' || x.kind === 'lost')) console.log(`  ${l.kind} car ${l.id} at t ${l.t.toFixed(1)}: ${l.why} at ${l.at.map((v) => v.toFixed(1)).join(',')} (${phys.editDist(l.at[0], l.at[2]).toFixed(0)} m from the edit)`);
  phys.dispose();
}
process.exit(0);
