// The street life on an edited city (src/sim/life.ts edited/dropOverHoles), headless on the real data: the life runs
// round the bridge nearest BRIDGE (the World over the level-1 node files, read as needed), then a sphere of r 3 m is
// dug out of the deck under the middle of a car on it (core/columns.ts EditableNode, as dig.ts does), the World and
// the life told (life.edited, as main.ts does from core/live-edits.ts), and the life run on for RUN s. Checked:
//   - that car falls (life.falling) at once, comes down to the ground under the deck (or the water) and is gone after;
//   - nothing drawn in the dug box (cars, falling cars, people, riders) stays more than 1 m over the ground there
//     (World.support) without coming down, for more than HOVER_S s;
//   - cars keep on into the hole and fall too (no braking: they fall where the ground is gone).
// Math.random is seeded. usage (in web/): node tools/life-edit.mjs [-v]; prints one PASS line, or the failures and exit 1
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { DATA, load, readMeta } from './real-city.mjs';

const verbose = process.argv.includes('-v');
let seed = 11;
Math.random = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const BRIDGE = { x: 4381, y: 2703 }, R = 3, WARM = 40, RUN = 40, FPS = 60, HOVER_S = 0.25, HOUR = 17;

const meta = readMeta(), N = meta.tiles.N, S = N + 2;
const { World } = await load('world.ts'), TD = await load('tile-data.ts'), CO = await load('core/columns.ts');
const { StreetLife } = await load('sim/life.ts'), { unpackTraffic } = await load('sim/traffic-pack.ts');
const td = unpackTraffic(JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8')));

// the level-1 nodes as the streamer holds them (stream.ts setData), read when first asked for
const nodes = new Map();
const colData = (tx, ty, c) => {
  const off = new Uint32Array(S * S + 1);
  for (let i = 0; i < S * S; i++) off[i + 1] = off[i] + c.counts[i];
  return { ...c, s: 1, x0: tx * N, y0: ty * N, S, off, roomOff: c.rooms ? TD.roomOffsets(c.rooms, S * S) : null };
};
const src = { N, levels: [1], version: 0, columns(key) {
  if (!nodes.has(key)) {
    const t = key.split('/')[1], [tx, ty] = t.split('_').map(Number), f = `${DATA}tiles/1/${t}.bin`;
    let d;
    if (fs.existsSync(f)) { const b = zlib.gunzipSync(fs.readFileSync(f)); d = colData(tx, ty, TD.decodeTile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), N)); }
    nodes.set(key, d);
  }
  return nodes.get(key);
} };
const W = new World(src, meta);

const bad = [];
const check = (ok, what) => { if (!ok) { bad.push(what); console.log(`  FAIL ${what}`); } return ok; };
const log = (...a) => { if (verbose) console.log(...a); };

const life = new StreetLife(new THREE.Scene(), td);
life.world = W;
const focus = { x: BRIDGE.x, z: BRIDGE.y }, dt = 1 / FPS;
for (let f = 0; f < WARM * FPS; f++) life.update(dt, HOUR, 0, focus);

// a car on the deck (its ground at least 8 m over the ground under it), the nearest the bridge's middle
let car = null, bd = Infinity;
for (const c of life.cars) {
  const p = c.rp;
  if (!p || p.y - W.groundAt(p.x, p.z) < 8 || c.v < 2) continue;
  const d = Math.hypot(p.x - BRIDGE.x, p.z - BRIDGE.y);
  if (d < bd) { bd = d; car = c; }
}
if (!check(car && bd < 60, `a moving car on the bridge deck within 60 m of (${BRIDGE.x}, ${BRIDGE.y})`)) { console.log('FAIL life-edit'); process.exit(1); }
const deck = car.rp.y;
const op = { kind: 'sphere', x: Math.floor(car.rp.x), y: Math.floor(car.rp.z), z: Math.floor(deck) - 1, r: R, id: 0 };
for (const [tx, ty] of CO.touchedNodes(op, N, meta.tiles.levels[0].nx, meta.tiles.levels[0].ny)) {
  const key = `1/${tx}_${ty}`, d = src.columns(key);
  if (!d) continue;
  const e = new CO.EditableNode(N, d, tx, ty);
  e.apply(op);
  nodes.set(key, colData(tx, ty, { ...e.encode(), planes: d.planes, bld: d.bld, rooms: d.rooms, caps: d.caps, roofCaps: d.roofCaps }));
}
src.version++;
const box = [op.x - R, op.y - R, op.x + R + 1, op.y + R + 1];
life.edited(box);
const below = W.support(car.rp.x, car.rp.z, deck);
log(`dug r ${R} at (${op.x}, ${op.y}, ${op.z}) under car ${car.id} (deck ${deck.toFixed(2)}, now ground ${below.toFixed(2)} there)`);
check(below < deck - 3, `the dig opened the deck: ground ${below.toFixed(2)} under the car, deck ${deck.toFixed(2)}`);

const inBox = (p) => p.x >= box[0] - 2 && p.z >= box[1] - 2 && p.x < box[2] + 2 && p.z < box[3] + 2;
const hover = new Map(), lastY = new Map(), worst = { t: 0, what: '' };
let people = 0, fellAt = -1, landed = null, goneAt = -1, falls = 0, minY = Infinity;
const seen = new Set();
for (let f = 0; f < RUN * FPS; f++) {
  life.update(dt, HOUR, 0, focus);
  const t = (f + 1) * dt;
  const fc = life.falling.find((x) => x.c === car);
  if (fc && fellAt < 0) fellAt = t;
  if (fc) { minY = Math.min(minY, car.rp.y); if (fc.land >= 0 && !landed) landed = { t, y: car.rp.y }; }
  if (fellAt >= 0 && !fc && goneAt < 0) goneAt = t;
  for (const x of life.falling) if (!seen.has(x.c)) { seen.add(x.c); falls++; }
  for (const x of life.fallen) if (x.vy !== undefined && !seen.has(x)) { seen.add(x); people++; }
  const drawn = [...life.cars.map((c) => ['car', c]), ...life.falling.map((x) => ['falling car', x.c]), ...life.people.map((p) => ['person', p]), ...life.riders.map((p) => ['rider', p])];
  for (const [k, o] of drawn) {
    const p = o.rp;
    if (!p || !inBox(p)) { hover.delete(o); continue; }
    const over = p.y - W.support(p.x, p.z, p.y + 0.5), down = lastY.has(o) && p.y < lastY.get(o) - 1e-3;
    lastY.set(o, p.y);
    if (over > 1 && !down) {
      const h = (hover.get(o) ?? 0) + dt;
      hover.set(o, h);
      if (h > worst.t) Object.assign(worst, { t: h, what: `${k} at (${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}) ${over.toFixed(2)} m over the ground at t ${t.toFixed(2)}` });
    } else hover.delete(o);
  }
}
log(`car ${car.id}: fell at ${fellAt.toFixed(2)} s, landed ${landed ? `at ${landed.t.toFixed(2)} s on y ${landed.y.toFixed(2)}` : 'never'}, gone at ${goneAt.toFixed(2)} s; ${falls} car(s) fell in all; worst hover ${worst.t.toFixed(2)} s ${worst.what}`);
check(fellAt >= 0 && fellAt < 0.1, `the car over the hole falls at once (fell at ${fellAt.toFixed(2)} s)`);
check(landed && Math.abs(landed.y - below) < 0.6, `it lands on the ground under the deck (${landed?.y.toFixed(2)}, ground ${below.toFixed(2)})`);
check(goneAt > 0 && goneAt < 10, `it is gone a moment after (${goneAt.toFixed(2)} s)`);
check(worst.t <= HOVER_S, `nothing hovers over the dug box: ${worst.t.toFixed(2)} s ${worst.what}`);
check(falls >= 2, `the cars behind drive on into the hole and fall too (${falls} fell)`);
if (bad.length) { console.log(`FAIL life-edit: ${bad.length} check(s) failed`); process.exit(1); }
console.log(`PASS life-edit: hole r ${R} in the deck at (${op.x}, ${op.y}) (deck ${deck.toFixed(1)}, ground under ${below.toFixed(1)}): the car over it fell at once, landed after ${(landed.t - fellAt).toFixed(2)} s, gone after ${(goneAt - fellAt).toFixed(2)} s; ${falls} car(s), ${people} person(s) fell in ${RUN} s; longest hover ${worst.t.toFixed(2)} s`);
