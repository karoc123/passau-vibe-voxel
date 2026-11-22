// The street traffic on an edited city, headless on the real data, as a server would run it: the world sim alone
// (src/sim/traffic.ts Traffic + src/physics/rapier/life-phys.ts LifePhysics, no three.js, no StreetLife), on its
// fixed tick, its random numbers seeded (Math.random throws while it runs). The traffic runs round the bridge nearest
// BRIDGE (the World over the level-1 node files, read as needed) with the bodies attached from the start; then, each
// from a fresh start:
//   dig    a sphere of r 4 dug out of the deck 6 m ahead of a moving car (core/columns.ts EditableNode, as dig.ts
//          does; told to the World, to core/live-edits.ts (the colliders) and to the traffic, as main.ts does). That car
//          gets a body, falls through the deck to the ground under it and is a wreck at rest there; the cars behind
//          fall in too or stop at the rim; people over the hole fall (option A: dropped).
//   block  a 7x7x3 m block placed 25 m ahead of a moving car: its body brakes and stops before it (its ghost waits:
//          still in the traffic), the car behind it stops behind it; nobody touches it or ends up in it.
//   wreck  a car near an edit wrecked (LifePhysics.wreck): it comes to rest on the road, the cars coming up behind it
//          stop behind it, none touches it.
//   moto   a moving motorbike gets its catalogue body near an edit, then returns to lane tracking when it clears.
// In every one, every tick: nothing drawn in an edited box stands more than 1 m over the ground there without coming
// down for more than HOVER_S s (cars: their kinematic pose, or their body's; people: on their path); no body tracks a
// car further than NEAR * 1.15 from an edit. Before the edit (WARM s): no body, no collider, nothing stepped (zero cost).
// The dig is run twice: the bodies and the cars bit-identical. Prints the costs (the bodies' tick, the colliders).
// usage (in web/): node tools/life-edit.mjs [-v] [dig|block|wreck|moto ...]; prints one PASS line, or the failures and exit 1
import fs from 'node:fs';
import { DATA, load, nodeWorld, rawTile as raw, readMeta } from './real-city.mjs';

const argv = process.argv.slice(2), verbose = argv.includes('-v');
const only = argv.filter((a) => !a.startsWith('-'));
const BRIDGE = { x: 4381, y: 2703 }, STREET = { x: 6500, y: 2600 }, WARM = 30, HOVER_S = 0.25, HOUR = 17, SEED = 7;

const meta = readMeta(), N = meta.tiles.N;
const TD = await load('tile-data.ts'), CO = await load('core/columns.ts');
const { Traffic, STEP } = await load('sim/traffic.ts'), { unpackTraffic } = await load('sim/traffic-pack.ts');
const LP = await load('physics/rapier/life-phys.ts'), VH = await load('sim/vehicles.ts');
const td = unpackTraffic(JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8')));
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
await RAPIER.init();

const bad = [];
const check = (ok, what) => { if (!ok) { bad.push(what); console.log(`  FAIL ${what}`); } return ok; };
const log = (...a) => { if (verbose) console.log(...a); };
const f2 = (x) => x.toFixed(2);
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const realRandom = Math.random;
const noRandom = () => { throw new Error('Math.random in the world sim (it draws from its seeded rng)'); };

// an edit (as dig.ts and stream.ts do it): the World's source, the live edits (the colliders), the traffic
const touched = new Set();
function edit(ctx, op, box) {
  const { src, T, colData } = ctx;
  for (const [tx, ty] of CO.touchedNodes(op, N, meta.tiles.levels[0].nx, meta.tiles.levels[0].ny)) {
    const key = `1/${tx}_${ty}`, d = src.columns(key);
    if (!d) continue;
    const e = new CO.EditableNode(N, d, tx, ty);
    e.apply(op);
    const enc = e.encode(), base = { ...enc, planes: d.planes, bld: d.bld, rooms: d.rooms, caps: d.caps, roofCaps: d.roofCaps };
    src.nodes.set(key, colData(tx, ty, base));
    const fd = TD.decodeTile(raw(`1f/${tx}_${ty}.bin`), N), fe = new CO.EditableNode(N, { ...fd, ground: enc.ground }, tx, ty);
    if (op.kind === 'sphere') fe.apply(op);
    LP.liveEdits.set(tx, ty, { base, foliage: { ...fe.encode(), ground: enc.ground } }, box);
    touched.add(`${tx}_${ty}`);
  }
  src.version++;
  T.edited(box);
}
const clearEdits = () => { for (const k of touched) { const [tx, ty] = k.split('_').map(Number); LP.liveEdits.set(tx, ty, null); } touched.clear(); };

// a fresh world sim round the bridge, WARM s on, bodies attached (nothing edited: they must cost nothing)
async function setup(at) {
  const { W, src, colData } = await nodeWorld();
  const T = new Traffic(td, SEED);
  T.ground = W;
  const phys = await LP.LifePhysics.load(meta, { x: at.x, z: at.y }, {}, { load: async (p) => raw(p) });
  // (the tiles round the bridge decoded up front, as the page's streaming has them: no load lands mid-run)
  const want = 400;
  for (let tz = Math.floor((at.y - want) / N); tz <= Math.floor((at.y + want) / N); tz++)
    for (let tx = Math.floor((at.x - want) / N); tx <= Math.floor((at.x + want) / N); tx++) await phys.terrain.prefetch(tx * N + 1, tz * N + 1);
  T.bodies = phys;
  const ctx = { T, phys, W, src, colData, focus: { x: at.x, z: at.y }, costs: [], t: 0 };
  let worked = 0;
  run(ctx, WARM, () => { if (phys.stats.tickMs || phys.bodies.size || phys.terrain.stats.chunks || phys.t) worked++; });
  check(worked === 0 && phys.t === 0, `nothing edited, nothing done: ${worked} tick(s) with bodies, colliders or a step`);
  return ctx;
}

// whole ticks for `seconds` (Math.random off), each() after each
function run(ctx, seconds, each) {
  Math.random = noRandom;
  try {
    for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) {
      ctx.T.update(STEP, HOUR, ctx.focus);
      ctx.t += STEP;
      if (ctx.T.edits.length) ctx.costs.push(ctx.phys.stats.tickMs);
      each?.(i);
    }
  } finally { Math.random = realRandom; }
}

// a car's pose as drawn at the tick (life.ts drawCars at a = 1): kinematic, or its body's
const pose = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };
function drawn(ctx, c) {
  if (ctx.T.cars.includes(c)) {
    ctx.T.carPose(c, c.s, c.off, pose);
    c.rp = { x: pose.x, y: pose.y, z: pose.z }; c.rh = pose.h; c.pitch = pose.pitch; c.roll = 0;
  }
  ctx.phys.pose(c, 1);
  return c.rp;
}

// how far a car's lowest edge is under its drawn ground point (m, <= 0): 0 on its wheels; lying on its side (a van
// fallen into a hole) its flank is the bottom, half its width under the point (its model's box, sim/vehicles.ts)
function lowEdge(c) {
  const m = VH.modelHalf(VH.vehicleOf(c)), r = c.roll ?? 0, k = Math.cos(c.pitch ?? 0);
  let low = 0;
  for (const x of [-m.x, m.x]) for (const y of [0, 2 * m.y]) low = Math.min(low, (x * Math.sin(r) + y * Math.cos(r)) * k);
  return low;
}

// the per-tick checks in the edited boxes: hovering, bodies far from the edits
function watcher(ctx) {
  const { T, phys, W } = ctx, hover = new Map(), lastY = new Map(), worst = { t: 0, what: '' };
  let farBody = 0, farWhat = '';
  const P = { x: 0, y: 0, z: 0 };
  const inBox = (x, z) => T.edits.some((b) => x >= b[0] - 2 && z >= b[1] - 2 && x < b[2] + 2 && z < b[3] + 2);
  const look = (k, o, x, y, z) => {
    if (!inBox(x, z)) { hover.delete(o); return; }
    const over = y - W.support(x, z, y + 0.5), down = lastY.has(o) && y < lastY.get(o) - 1e-3;
    lastY.set(o, y);
    if (over > 1 && !down) {
      const h = (hover.get(o) ?? 0) + STEP;
      hover.set(o, h);
      if (h > worst.t) Object.assign(worst, { t: h, what: `${k} at (${x.toFixed(1)}, ${y.toFixed(2)}, ${z.toFixed(1)}) ${over.toFixed(2)} m over the ground at t ${ctx.t.toFixed(2)}` });
    } else hover.delete(o);
  };
  return {
    tick() {
      for (const c of [...T.cars, ...T.detachedCars]) { const p = drawn(ctx, c); look(`car ${c.id}${phys.owns(c) ? ' (body)' : ''}`, c, p.x, p.y + lowEdge(c), p.z); }
      for (const p of [...T.people, ...T.riders]) { T.personPoint(p, 0, P); look('person', p, P.x, P.z, P.y); }
      for (const b of phys.bodies.values()) {
        if (b.state !== 'track') continue;
        const d = phys.editDist(b.car.geo.cx, b.car.geo.cy);
        if (d > LP.NEAR * 1.15 + 2) { farBody++; farWhat = `car ${b.car.id} ${d.toFixed(0)} m from an edit`; }
      }
    },
    report() {
      check(worst.t <= HOVER_S, `nothing hovers over an edited box: ${f2(worst.t)} s ${worst.what}`);
      check(farBody === 0, `no body away from the edits: ${farBody} tick(s), e.g. ${farWhat}`);
      return worst.t;
    },
  };
}

// a moving car, its ground at least `deck` m over the ground under it, nearest the focus; with a car close behind it
// (within 30 m, in its lane) if `follower`
function pickCar(ctx, deck, minV, follower = false, near = { ...ctx.focus, radius: 120 }) {
  const { T, W } = ctx;
  let car = null, bd = Infinity;
  for (const c of T.cars) {
    const p = drawn(ctx, c);
    if (p.y - W.groundAt(p.x, p.z) < deck || c.v < minV || c.bus) continue;
    if (follower && !behindOf(ctx, c)) continue;
    const d = Math.hypot(p.x - near.x, p.z - near.z);
    if (d < bd) { bd = d; car = c; }
  }
  return bd < near.radius ? car : null;
}

// the car behind c in its lane (within 30 m: its kinematic pose behind c's, less than 1.5 m across)
function behindOf(ctx, c) {
  const p = drawn(ctx, c), fx = Math.sin(c.rh), fz = Math.cos(c.rh);
  let best = null, bd = 30;
  for (const o of ctx.T.cars) {
    if (o === c || o.bus) continue;
    const q = drawn(ctx, o), dx = p.x - q.x, dz = p.z - q.z, along = dx * fx + dz * fz, lat = Math.abs(dx * fz - dz * fx);
    if (along > c.len && along < bd && lat < 1.5 && Math.abs(q.y - p.y) < 2) { bd = along; best = o; }
  }
  return best;
}

const hashOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
function stateHash(ctx) {
  const bodies = [...ctx.phys.bodies.values()].map((b) => { const p = b.body.translation(), r = b.body.rotation(); return [b.car.id, b.state, p.x, p.y, p.z, r.x, r.y, r.z, r.w]; });
  const cars = ctx.T.cars.map((c) => [c.id, c.e, c.lane, c.s, c.v, c.off]);
  return hashOf(JSON.stringify([bodies, cars, ctx.T.people.length, ctx.T.riders.length]));
}

const results = {};

async function dig() {
  const ctx = await setup(BRIDGE), { T, phys, W } = ctx;
  // The straight approach keeps the hole in the vehicle's path. Warming the traffic still uses the bridge focus.
  const near = { x: 4350, z: 2780, radius: 15 };
  const car = pickCar(ctx, 8, 3, false, near);
  if (!check(car, `a moving car on the bridge deck within ${near.radius} m of (${near.x}, ${near.z})`)) return ctx;
  const p = drawn(ctx, car), deck = p.y, R = 4;
  const ax = p.x + Math.sin(car.rh) * 6, az = p.z + Math.cos(car.rh) * 6;
  const op = { kind: 'sphere', x: Math.floor(ax), y: Math.floor(az), z: Math.floor(deck) - 1, r: R, id: 0 };
  const box = [op.x - R, op.y - R, op.x + R + 1, op.y + R + 1];
  edit(ctx, op, box);
  const below = W.support(ax, az, deck);
  log(`dig: r ${R} at (${op.x}, ${op.y}, deck ${deck.toFixed(1)}) 6 m ahead of car ${car.id} at ${car.v.toFixed(1)} m/s; ground there now ${below.toFixed(1)}`);
  check(below < deck - 3, `the dig opened the deck: ground ${f2(below)} under it, deck ${f2(deck)}`);
  const w = watcher(ctx);
  let bodyAt = -1, minY = Infinity, fallers = new Set(), dropped = 0;
  const t0 = ctx.t;
  run(ctx, 15, () => {
    w.tick();
    if (bodyAt < 0 && phys.owns(car)) bodyAt = ctx.t - t0;
    if (car.rp) minY = Math.min(minY, car.rp.y + lowEdge(car));
    for (const c of [...T.cars, ...T.detachedCars]) if (c.rp && c.rp.y < deck - 3 && Math.hypot(c.rp.x - ax, c.rp.z - az) < 8) fallers.add(c.id);
    dropped += T.dropped.length; T.dropped = [];
  });
  const lost = phys.log.find((l) => l.kind === 'lost' && l.id === car.id), rest = phys.log.find((l) => l.kind === 'rest' && l.id === car.id);
  const rim = [...phys.bodies.values()].filter((b) => b.state === 'track' && b.held && Math.hypot(b.car.rp.x - ax, b.car.rp.z - az) < 20).length;
  log(`  car ${car.id}: body after ${f2(bodyAt)} s, lowest ${f2(minY)}, lost ${lost ? `at ${f2(lost.t)} (${lost.why})` : 'never'}, rest ${rest ? `at y ${f2(rest.at[1])}` : 'never'}; ${fallers.size} car(s) fell in, ${rim} held near the rim; ${dropped} person(s) fell`);
  check(bodyAt >= 0 && bodyAt < 0.3, `the car gets a body as the edit lands (${f2(bodyAt)} s)`);
  check(Math.abs(minY - below) < 1, `it falls through the deck to the ground under it (lowest ${f2(minY)}, ground ${f2(below)})`);
  check(lost && rest && Math.abs(rest.at[1] - below) < 2 && T.detachedCars.includes(car), `it is a wreck at rest down there (lost: ${lost?.why}, rest: ${rest ? f2(rest.at[1]) : 'never'})`);
  const hover = w.report();
  results.dig = { car: car.id, fell: f2(deck - minY), fallers: fallers.size, rim, hover: f2(hover) };
  return ctx;
}

async function block() {
  const ctx = await setup(STREET), { T, phys } = ctx;
  const car = pickCar(ctx, -99, 6, true);
  if (!check(car, `a moving car with one behind it near (${ctx.focus.x}, ${ctx.focus.z})`)) return null;
  const p = drawn(ctx, car), h = car.rh, ax = p.x + Math.sin(h) * 25, az = p.z + Math.cos(h) * 25;
  const op = { kind: 'box', x: Math.floor(ax) - 3, y: Math.floor(az) - 3, z: Math.floor(p.y), w: 7, d: 7, h: 3, id: 30 };
  const box = [op.x, op.y, op.x + op.w, op.y + op.d];
  edit(ctx, op, box);
  const behind = behindOf(ctx, car);
  log(`block: 7x7x3 m at (${op.x}, ${op.y}, ${op.z}) 25 m ahead of car ${car.id} at ${car.v.toFixed(1)} m/s; car ${behind.id} behind it`);
  const w = watcher(ctx);
  const inBlock = (q) => q && q.x >= op.x - 0.5 && q.x < op.x + op.w + 0.5 && q.z >= op.y - 0.5 && q.z < op.y + op.d + 0.5 && q.y < op.z + op.h;
  let inside = 0, touch = 0, maxAlong = 0;
  run(ctx, 15, () => {
    w.tick();
    for (const c of [...T.cars, ...T.detachedCars]) if (inBlock(c.rp)) inside++;
    for (const id of [car, behind]) {
      const b = phys.bodies.get(id);
      if (!b) continue;
      if (b.state === 'track') maxAlong = Math.max(maxAlong, Math.abs(b.along));
      phys.world.contactPairsWith(b.chassis, (other) => phys.world.contactPair(b.chassis, other, (m) => { if (m.numContacts() > 0 && !other.parent()?.isDynamic() && other.shape.type !== 9 && Math.abs(m.normal().y) < 0.6) touch++; }));
    }
  });
  const b = phys.bodies.get(car), bb = phys.bodies.get(behind);
  const face = (q) => { const dx = Math.max(op.x - q.x, 0, q.x - (op.x + op.w)), dz = Math.max(op.y - q.z, 0, q.z - (op.y + op.d)); return Math.hypot(dx, dz); };
  const gap = car.rp && behind.rp ? Math.hypot(car.rp.x - behind.rp.x, car.rp.z - behind.rp.z) - (car.len + behind.len) / 2 : NaN;
  log(`  car ${car.id}: ${b ? b.state : 'no body'} v ${b ? f2(b.vb) : '-'} ${f2(face(car.rp))} m from the block, in traffic ${T.cars.includes(car)}, along max ${f2(maxAlong)}; car ${behind.id}: ${bb ? bb.state : 'no body'} gap ${f2(gap)} m`);
  check(b && b.state === 'track' && T.cars.includes(car) && Math.abs(b.vb) < 0.5, `the car stops before the block, still in the traffic (${b?.state}, v ${b ? f2(b.vb) : '-'})`);
  check(face(car.rp) > 0.3 && face(car.rp) < 10, `... in front of it (${f2(face(car.rp))} m from it)`);
  check(maxAlong < 10, `its ghost waits for it (along at most ${f2(maxAlong)} m)`);
  check(bb && Math.abs(bb.vb) < 0.5 && gap > 0.3, `the car behind stops behind it (${bb?.state}, gap ${f2(gap)} m)`);
  check(inside === 0 && touch === 0, `nobody in the block (${inside}) or touching a wall or a body (${touch} contact(s))`);
  w.report();
  results.block = { stopAt: f2(face(car.rp)), gapBehind: f2(gap), along: f2(maxAlong) };
  return ctx;
}

async function wreck() {
  const ctx = await setup(STREET), { T, phys } = ctx;
  // (an edit that changes nothing, round the focus: the cars near it get bodies; then a moving one with a body and
  // one behind it is wrecked)
  const f = ctx.focus;
  T.edited([f.x - 40, f.z - 40, f.x + 40, f.z + 40]);
  let car = null;
  for (let k = 0; k < 20 && !car; k++) { run(ctx, 0.5); car = pickCar(ctx, -99, 5, true); if (car && !phys.owns(car)) car = null; }
  if (!check(car, `a moving car with a body and one behind it near (${f.x}, ${f.z})`)) return null;
  const v0 = car.v, ok = phys.wreck(car, T, 'test');
  check(ok, `the car has a body to wreck (${phys.bodies.get(car)?.state})`);
  const w = watcher(ctx), t0 = ctx.t;
  let restAt = -1, touched = 0;
  const stoppers = new Set();
  run(ctx, 25, () => {
    w.tick();
    const wb = phys.bodies.get(car);
    if (restAt < 0 && wb?.state === 'rest') restAt = ctx.t;
    if (!wb || wb.state !== 'rest') return;
    phys.world.contactPairsWith(wb.chassis, (other) => phys.world.contactPair(wb.chassis, other, (m) => { if (m.numContacts() > 0 && other.parent()?.isDynamic()) touched++; }));
    for (const b of phys.bodies.values()) if (b.state === 'track' && Math.abs(b.vb) < 0.3 && Math.hypot(b.car.rp.x - car.rp.x, b.car.rp.z - car.rp.z) < 12) stoppers.add(b.car.id);
  });
  log(`wreck: car ${car.id} wrecked at ${v0.toFixed(1)} m/s, at rest after ${f2(restAt - t0)} s; ${stoppers.size} car(s) stopped behind it, ${touched} touch(es)`);
  check(restAt > 0, 'the wreck comes to rest');
  check(stoppers.size >= 1, `the cars coming up stop behind it (${stoppers.size})`);
  check(touched === 0, `none touches it (${touched} contact(s))`);
  w.report();
  results.wreck = { stopped: stoppers.size, touched };
  return ctx;
}

async function motorbike() {
  const ctx = await setup(STREET), { T, phys, focus: f } = ctx;
  const bike = T.cars.filter((c) => c.vt === 'moto' && c.v > 3)
    .map((c) => {
      const p = drawn(ctx, c);
      return { car: c, distance: Math.hypot(p.x - f.x, p.z - f.z) };
    }).sort((a, b) => a.distance - b.distance)[0]?.car;
  if (!check(bike, 'seeded traffic includes a moving motorbike')) return ctx;
  const { x, z } = bike.rp, spec = VH.VEHICLES.moto;
  check(bike.len === spec.len, 'the motorbike uses its catalogue length');
  const box = [x - 30, z - 30, x + 30, z + 30];
  T.edited(box);
  run(ctx, 3);
  const b = phys.bodies.get(bike);
  check(b?.state === 'track' && b.build.bike && b.build.half.x === spec.build.half.x,
    'the motorbike tracks with its narrow Rapier body');
  T.edited(box, true);
  run(ctx, 0.2);
  check(!phys.owns(bike) && T.cars.includes(bike), 'clearing the edit returns the motorbike to lane tracking');
  results.moto = { id: bike.id, tracked: b?.state === 'track', released: !phys.owns(bike) };
  return ctx;
}

const want = (k) => !only.length || only.includes(k);
const costs = [], chunks = [], bodies = [];
const done = (ctx) => {
  if (!ctx) return;
  costs.push(...ctx.costs); chunks.push(ctx.phys.terrain.stats.builds); bodies.push(ctx.phys.stats.spawned);
  ctx.phys.dispose(); clearEdits();
};
let h1 = null;
if (want('dig')) { const ctx = await dig(); h1 = ctx && stateHash(ctx); done(ctx); }
if (want('dig')) {
  const ctx = await dig(), h2 = ctx && stateHash(ctx);
  check(h1 && h1 === h2, `two seeded runs are bit-identical (${h1} / ${h2})`);
  results.det = h1 === h2 ? 'same' : 'differ';
  done(ctx);
}
if (want('block')) done(await block());
if (want('wreck')) done(await wreck());
if (want('moto')) done(await motorbike());
const cost = `bodies' tick with edits: avg ${f2(avg(costs))} p99 ${f2(pct(costs, 0.99))} max ${f2(Math.max(0, ...costs))} ms; ${bodies.join('/')} bodies, ${chunks.join('/')} chunks built per run; 0 ms before any edit`;
if (bad.length) { console.log(`FAIL life-edit: ${bad.length} check(s) failed; ${cost}`); process.exit(1); }
console.log(`PASS life-edit: ${Object.entries(results).map(([k, v]) => `${k} ${typeof v === 'string' ? v : Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')}`).join('; ')}; ${cost}`);
process.exit(0);
