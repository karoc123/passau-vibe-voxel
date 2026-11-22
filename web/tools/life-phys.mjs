// EXPERIMENT (docs/plans/life-physics.md): the street life's cars near the viewer as Rapier bodies
// (physics/rapier/life-phys.ts), headless on the real data. The life (sim/life.ts over the World of the level-1 node
// files, as tools/life-edit.mjs) runs round a point; after WARM s the bodies are on, then RUN s at 60 fps are measured:
// the physics' time per frame (world step, the cars' own work, the colliders' streaming), the bodies, how far they are
// from their ghosts (across / along the path), pairs touching, ghosts lost (wrecks), the release's pop, memory.
// usage (in web/): node tools/life-phys.mjs [--at X,Z] [--hour H] [--run S] [--model car|box] [--no-assists]
//          [--reach M] [--contacts] [--det] [--assists] [--guide G] [--no-look] [-v] R:MAX [R:MAX ...]
//   --assists: the player's controller (car.ts step: wedges, wall glancing, air) instead of the lean AI one
//   --lost resync: a body lost away from edits is put back on its ghost (else a wreck); --only edits [--near M]: bodies
//   only for cars within M m of an edit (the hybrid)
//   --guide G: a bounded push towards the ghost across the way (at most G g); --no-look: no shape cast ahead
//        node tools/life-phys.mjs --dig [--model car|box] [--at X,Z] [-v]   the destruction case (see dig())
//        node tools/life-phys.mjs --block [--model car|box] [-v]          a wall placed across a lane (see block())
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { DATA, load, readMeta } from './real-city.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (k) => { const i = argv.indexOf(k); if (i < 0) return false; argv.splice(i, 1); return true; };
const verbose = flag('-v'), contacts = flag('--contacts'), det = flag('--det'), digMode = flag('--dig'), blockMode = flag('--block');
const model = opt('--model', 'car'), assists = flag('--assists'), reach = +opt('--reach', 24), guide = +opt('--guide', 0), look = !flag('--no-look');
const lostPolicy = opt('--lost', 'wreck'), only = opt('--only', 'all'), near = +opt('--near', 60);
const [AX, AZ] = opt('--at', digMode || blockMode ? '4381,2697' : '4381,2697').split(',').map(Number);
const HOUR = +opt('--hour', 17), WARM = 20, RUN = +opt('--run', 30), FPS = 60;
const configs = argv.length ? argv.map((a) => a.split(':').map(Number)) : [[100, 100], [200, 100], [300, 100]];

let seed = 11;
const seedRandom = (s) => { seed = s; };
Math.random = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const meta = readMeta(), N = meta.tiles.N, S = N + 2;
const { World } = await load('world.ts'), TD = await load('tile-data.ts'), CO = await load('core/columns.ts');
const { StreetLife } = await load('sim/life.ts'), { unpackTraffic } = await load('sim/traffic-pack.ts');
const LP = await load('physics/rapier/life-phys.ts');
const td = unpackTraffic(JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8')));
const raw = (p) => { const b = zlib.gunzipSync(fs.readFileSync(`${DATA}tiles/${p}`)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

// the level-1 nodes as the streamer holds them (stream.ts setData), read when first asked for (tools/life-edit.mjs)
const colData = (tx, ty, c) => {
  const off = new Uint32Array(S * S + 1);
  for (let i = 0; i < S * S; i++) off[i + 1] = off[i] + c.counts[i];
  return { ...c, s: 1, x0: tx * N, y0: ty * N, S, off, roomOff: c.rooms ? TD.roomOffsets(c.rooms, S * S) : null };
};
function makeWorld() {
  const nodes = new Map();
  const src = { N, levels: [1], version: 0, nodes, columns(key) {
    if (!nodes.has(key)) {
      const t = key.split('/')[1], [tx, ty] = t.split('_').map(Number);
      let d;
      if (fs.existsSync(`${DATA}tiles/1/${t}.bin`)) d = colData(tx, ty, TD.decodeTile(raw(`1/${t}.bin`), N));
      nodes.set(key, d);
    }
    return nodes.get(key);
  } };
  return { W: new World(src, meta), src };
}

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const f2 = (x) => x.toFixed(2), f3 = (x) => x.toFixed(3);

async function setup(R, MAX, opts = {}) {
  seedRandom(11);
  const { W, src } = makeWorld();
  const life = new StreetLife(new THREE.Scene(), td);
  life.world = W;
  const focus = { x: AX, z: AZ }, dt = 1 / FPS;
  for (let f = 0; f < WARM * FPS; f++) life.update(dt, HOUR, 0, focus);
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const phys = await LP.LifePhysics.load(meta, focus, { radius: R, maxBodies: MAX, model, assists, reach, contacts, guide, look, lost: lostPolicy, only, near, ...opts },
    { load: async (p) => raw(p), budgetMs: det ? 1e9 : 2 });
  // (the tiles under the radius decoded up front: the page has them from the drive's warm-up and the streaming)
  const want = R + reach + 64;
  for (let tz = Math.floor((AZ - want) / N); tz <= Math.floor((AZ + want) / N); tz++) for (let tx = Math.floor((AX - want) / N); tx <= Math.floor((AX + want) / N); tx++) await phys.terrain.prefetch(tx * N + 1, tz * N + 1);
  const prefetchMs = performance.now() - t0;
  phys.viewer = focus;
  life.bodies = phys;
  return { life, phys, W, src, focus, dt, rss0, prefetchMs };
}

async function bench(R, MAX) {
  const { life, phys, focus, dt, rss0, prefetchMs } = await setup(R, MAX);
  const fr = [], stp = [], ctl = [], ter = [], nb = [], cp = [], perBody = [];
  const startBuild = { builds: 0 };
  let lat = 0, along = 0, ns = 0, latMax = 0;
  const trace = new Map();
  for (let f = 0; f < RUN * FPS; f++) {
    life.update(dt, HOUR, 0, focus);
    const s = phys.stats;
    if (verbose) for (const b of phys.bodies.values()) {
      if (b.state !== 'track') continue;
      const c = b.car, tr = trace.get(c.id) ?? [];
      const bp = (b.rc?.body ?? b.box).translation();
      tr.push(`t ${(f / FPS).toFixed(2)} e ${c.e} s ${c.s.toFixed(1)}/${life.roads?.[c.e]?.L?.toFixed(0) ?? '?'} v ${c.v.toFixed(1)} kmh ${b.rc ? b.rc.kmh.toFixed(0) : '-'} lat ${b.lat.toFixed(2)} along ${b.along.toFixed(2)} why ${c.why} ghost ${c.ghost.toFixed(1)} wheels ${b.rc ? b.rc.wheelsInContact() : '-'} y ${bp.y.toFixed(2)} rp ${c.rp.x.toFixed(1)},${c.rp.z.toFixed(1)} ${b.dbg} touch ${touching(phys, b)}`);
      if (tr.length > 40 && String(c.id) !== process.env.TRACE_ID) tr.shift();
      trace.set(c.id, tr);
    }
    if (f < 2 * FPS) { if (f === 2 * FPS - 1) Object.assign(startBuild, { builds: phys.terrain.stats.builds }); s.latSum = s.alongSum = s.samples = 0; s.latMax = 0; continue; } // (the first 2 s: the colliders built, the bodies spawned)
    fr.push(s.frameMs); stp.push(s.stepMs); ctl.push(s.ctlMs); ter.push(s.terrainMs); nb.push(s.bodies); cp.push(s.contactPairs);
    if (s.bodies && s.steps) perBody.push((s.stepMs + s.ctlMs) / s.steps / s.bodies * 1000);
  }
  const s = phys.stats, T = phys.terrain.stats;
  lat = s.latSum / Math.max(1, s.samples); along = s.alongSum / Math.max(1, s.samples); latMax = s.latMax;
  const rss = (process.memoryUsage().rss - rss0) / 1048576;
  const lost = phys.log.filter((l) => l.kind === 'lost');
  const row = {
    R, MAX, model, cars: life.cars.length, bodies: f2(avg(nb)), bodiesMax: Math.max(...nb),
    frameAvg: f2(avg(fr)), frameP99: f2(pct(fr, 0.99)), frameMax: f2(Math.max(...fr)),
    worldStep: f2(avg(stp)), carsOwn: f2(avg(ctl)), terrain: f2(avg(ter)), terrainMax: f2(Math.max(...ter)),
    usPerBodyStep: f2(avg(perBody)),
    chunks: T.chunks, voxels: T.voxels, tris: T.tris, builds: T.builds, buildAvg: f2(T.buildMsTotal / Math.max(1, T.builds)), buildsAfterStart: T.builds - startBuild.builds,
    prefetchMs: prefetchMs.toFixed(0), rssMB: rss.toFixed(0),
    latMean: f3(lat), latMax: f2(latMax), alongMean: f3(along), contactsMax: Math.max(...cp), contactsAvg: f2(avg(cp)),
    spawned: s.spawned, released: s.released, lost: lost.length, resynced: s.resynced, releasePop: f2(s.releasePop), notReady: s.notReady,
  };
  console.log(Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' '));
  if (verbose) for (const l of lost) {
    console.log(`  lost car ${l.id} at t ${l.t.toFixed(1)}: ${l.why} at ${l.at.map((v) => v.toFixed(1)).join(',')}`);
    if (process.env.TRACE) for (const line of (trace.get(l.id) ?? []).filter((_, i) => i % 3 === 0)) console.log('     ', line);
  }
  if (det) {
    const out = [...phys.bodies.values()].map((b) => { const p = (b.rc?.body ?? b.box).translation(); return [b.car.id, p.x, p.y, p.z]; });
    console.log('det-hash', JSON.stringify(out).length, hash(JSON.stringify(out)));
  }
  phys.dispose();
  return row;
}

function touching(phys, b) {
  const out = [];
  phys.world.contactPairsWith(b.collider, (other) => {
    let n = 0;
    phys.world.contactPair(b.collider, other, (m) => { n += m.numContacts(); });
    if (!n) return;
    const o = [...phys.bodies.values()].find((x) => x.collider.handle === other.handle);
    out.push(o ? `car${o.car.id}` : other.shape.type === 9 || other.shape.type === 6 ? 'mesh' : `T${other.shape.type}`);
  });
  return out.join('+') || '-';
}

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }

// node edits (core/columns.ts EditableNode as dig.ts does), told to the World (its source) and the physics (live edits)
function edit(src, phys, op, region) {
  for (const [tx, ty] of CO.touchedNodes(op, N, meta.tiles.levels[0].nx, meta.tiles.levels[0].ny)) {
    const key = `1/${tx}_${ty}`, d = src.columns(key);
    if (!d) continue;
    const e = new CO.EditableNode(N, d, tx, ty);
    e.apply(op);
    const enc = e.encode();
    const base = { ...enc, planes: d.planes, bld: d.bld, rooms: d.rooms, caps: d.caps, roofCaps: d.roofCaps };
    src.nodes.set(key, colData(tx, ty, base));
    const fd = TD.decodeTile(raw(`1f/${tx}_${ty}.bin`), N), fe = new CO.EditableNode(N, { ...fd, ground: enc.ground }, tx, ty);
    if (op.kind === 'sphere') fe.apply(op);
    const t0 = performance.now();
    LP.liveEdits.set(tx, ty, { base, foliage: { ...fe.encode(), ground: enc.ground } }, region);
    if (verbose) console.log(`  edit node ${tx}_${ty}: live edit + collider invalidation ${(performance.now() - t0).toFixed(2)} ms`);
  }
  src.version++;
}

// The destruction case: the bodies on round the bridge at (AX, AZ); a sphere of r 4 dug out of the deck under the
// middle of a body on it; the bodies over it should fall through (real colliders), land under the deck or in the
// river, and be wrecks; the cars behind?
async function dig() {
  const { life, phys, W, src, focus, dt } = await setup(150, 100);
  for (let f = 0; f < 4 * FPS; f++) life.update(dt, HOUR, 0, focus);
  // (a car on the deck: one with a body, or with --only edits any car: it gets one when the edit is near it)
  let pick = null, bd = Infinity;
  for (const car of life.cars) {
    const p = car.rp;
    if ((only !== 'edits' && phys.bodies.get(car)?.state !== 'track') || !p || p.y - W.groundAt(p.x, p.z) < 8 || car.v < 3) continue;
    const d = Math.hypot(p.x - AX, p.z - AZ);
    if (d < bd) { bd = d; pick = car; }
  }
  if (!pick) { console.log('no car on a deck near', AX, AZ); return; }
  const c = pick, deck = c.rp.y, R = 4;
  // (a few metres ahead of it: it drives into the hole, as a player's dig in front of traffic)
  const h = c.rh ?? 0, ax = c.rp.x + Math.sin(h) * 6, az = c.rp.z + Math.cos(h) * 6;
  const op = { kind: 'sphere', x: Math.floor(ax), y: Math.floor(az), z: Math.floor(deck) - 1, r: R, id: 0 };
  const box = [op.x - R, op.y - R, op.x + R + 1, op.y + R + 1];
  const t0 = performance.now();
  edit(src, phys, op, box);
  life.edited(box);
  console.log(`dug r ${R} at (${op.x}, ${op.y}, deck ${deck.toFixed(1)}) 6 m ahead of body ${c.id} at ${c.v.toFixed(1)} m/s; edit ${(performance.now() - t0).toFixed(1)} ms; ground there now ${W.support(ax, az, deck).toFixed(1)}`);
  const seen = new Map();
  const fr = [];
  for (let f = 0; f < 20 * FPS; f++) {
    life.update(dt, HOUR, 0, focus);
    fr.push(phys.stats.frameMs);
    for (const b of phys.bodies.values()) {
      const p = b.car.rp;
      if (!p) continue;
      const inBox = p.x > box[0] - 3 && p.x < box[2] + 3 && p.z > box[1] - 3 && p.z < box[3] + 3;
      if (inBox && !seen.has(b.car)) seen.set(b.car, { id: b.car.id, minY: p.y, t: f / FPS });
      if (seen.has(b.car)) seen.get(b.car).minY = Math.min(seen.get(b.car).minY, p.y);
    }
    if (verbose && f % 30 === 0) {
      const b = phys.bodies.get(c), p = c.rp;
      console.log(`  t ${(f / FPS).toFixed(1)} car ${c.id} ${b ? b.state : 'gone'} at ${p.x.toFixed(1)},${p.y.toFixed(2)},${p.z.toFixed(1)} ghost-lost? ${!life.cars.includes(c)}`);
    }
  }
  const lost = phys.log.filter((l) => l.kind === 'lost'), rest = phys.log.filter((l) => l.kind === 'rest');
  console.log(`frame avg ${f2(avg(fr))} max ${f2(Math.max(...fr))} ms over the 20 s after`);
  console.log(`bodies through the dug box: ${seen.size}; their lowest y: ${[...seen.values()].map((s) => `${s.id}:${s.minY.toFixed(1)}`).join(' ')}`);
  console.log(`lost (wrecks): ${lost.map((l) => `${l.id}@${l.t.toFixed(1)}s(${l.why})`).join(' ') || 'none'}`);
  console.log(`came to rest: ${rest.map((l) => `${l.id}@${l.t.toFixed(1)}s y=${l.at[1].toFixed(1)}`).join(' ') || 'none'}`);
  console.log(`option A fallers (cars without a body, life.falling) at the end: ${life.falling.length}; bodies spawned in all: ${phys.stats.spawned}; bodies now ${phys.bodies.size}`);
  phys.dispose();
}

// A wall (a box of voxels 1 m thick, 3 m high) placed across the lane 15 m ahead of a moving body: it should crash into
// it (a real collider), be a wreck; the cars behind?
async function block() {
  const { life, phys, src, focus, dt } = await setup(150, 100);
  for (let f = 0; f < 4 * FPS; f++) life.update(dt, HOUR, 0, focus);
  let pick = null, bd = Infinity;
  for (const b of phys.bodies.values()) {
    const p = b.car.rp;
    if (b.state !== 'track' || !p || b.car.v < 5) continue;
    const d = Math.hypot(p.x - AX, p.z - AZ);
    if (d < bd) { bd = d; pick = b; }
  }
  const c = pick.car, h = c.rh ?? 0, ax = c.rp.x + Math.sin(h) * 15, az = c.rp.z + Math.cos(h) * 15;
  const op = { kind: 'box', x: Math.floor(ax) - 3, y: Math.floor(az) - 3, z: Math.floor(c.rp.y), w: 7, d: 7, h: 3, id: 30 };
  const box = [op.x, op.y, op.x + op.w, op.y + op.d];
  edit(src, phys, op, box);
  life.edited(box);
  console.log(`placed a 7x7x3 m block at (${op.x}, ${op.y}, ${op.z}) 15 m ahead of body ${c.id} at ${c.v.toFixed(1)} m/s`);
  let hitT = -1;
  for (let f = 0; f < 15 * FPS; f++) {
    life.update(dt, HOUR, 0, focus);
    const b = phys.bodies.get(c);
    if (verbose && f % 20 === 0) console.log(`  t ${(f / FPS).toFixed(2)} car ${c.id} ${b ? b.state : 'gone'} at ${c.rp.x.toFixed(1)},${c.rp.y.toFixed(2)},${c.rp.z.toFixed(1)} v ${b?.rc ? b.rc.kmh.toFixed(0) : '-'} km/h ghost ${life.cars.includes(c) ? 'on' : 'off'}`);
    if (hitT < 0 && b && b.state === 'wreck') hitT = f / FPS;
  }
  const lost = phys.log.filter((l) => l.kind === 'lost');
  console.log(`car ${c.id} lost its ghost at ${hitT.toFixed(2)} s; all lost: ${lost.map((l) => `${l.id}@${l.t.toFixed(1)}s(${l.why})`).join(' ') || 'none'}`);
  const near = life.roadVehicles().filter((o) => o.rp && Math.hypot(o.rp.x - ax, o.rp.z - az) < 6);
  console.log(`cars drawn within 6 m of the block's middle after 15 s: ${near.length} (inside the block: ${near.filter((o) => o.rp.x >= op.x && o.rp.x < op.x + op.w && o.rp.z >= op.y && o.rp.z < op.y + op.d).length})`);
  phys.dispose();
}

if (digMode) await dig();
else if (blockMode) await block();
else for (const [R, MAX] of configs) await bench(R, MAX ?? 1000);
process.exit(0);
