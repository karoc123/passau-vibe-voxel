// The street traffic on an edited city, headless on the real data, as a server would run it: the world sim alone
// (src/sim/world-sim.ts WorldSim: its Traffic and its LifePhysics, no three.js, no StreetLife), on its
// fixed tick, its random numbers seeded (Math.random throws while it runs). The traffic runs round the bridge nearest
// BRIDGE (the World over the level-1 node files, read as needed) with the bodies attached from the start; then, each
// from a fresh start:
//   dig    a sphere of r 4 dug out of the deck 6 m ahead of a moving car (core/world-edits.ts apply, as dig.ts does:
//          core/live-edits.ts, the colliders; heard by the World; told to the world sim, as main.ts does). That car
//          gets a body, falls through the deck to the ground under it and is a wreck at rest there; the cars behind
//          fall in too or stop at the rim; people over the hole fall (option A: dropped).
//   block  a 7x7x3 m block placed 25 m ahead of a moving car: its body brakes and stops before it (its ghost waits:
//          still in the traffic), the car behind it stops behind it; nobody touches it or ends up in it.
//   wreck  a car near an edit wrecked (LifePhysics.wreck): it comes to rest on the road, the cars coming up behind it
//          stop behind it, none touches it.
//   moto   a moving motorbike gets its catalogue body near an edit, then returns to lane tracking when it clears.
//   keep   the world keeps an edit while a player's focus is near it (sim/edit-keeper.ts): a crater over a node's edge
//          (two nodes) stays while one focus of several is near either node, and both go together once none has been
//          for the delay.
// In every one, every tick: nothing drawn in an edited box stands more than 1 m over the ground there without coming
// down for more than HOVER_S s (cars: their kinematic pose, or their body's; people: on their path); no body tracks a
// car further than NEAR * 1.15 from an edit. Before the edit (WARM s): no body, no collider, nothing stepped (zero cost).
// The dig is run twice: the bodies and the cars bit-identical. Transit is replayed with two frame rates.
//   players  two players by id (WorldSim.send: follow, enterSeat, seatInput, leaveSeat; no physics): the commands wait for
//          the next update; the person walked stands where the walk's poses put them, holds one player, and is kept
//          with the car followed when the focus moves away; a walk pose 100 m off is taken clamped (Tuning.walk) and
//          the walk told, a run's step from there is not; the seat taken and left as events (seated, unseated); let go,
//          both leave with the circle. Over a hole the others fall and the one walked stands; two readers of the events
//          (WorldSim.eventsSince) at different rates get the same ones, each with its tick. With the road physics: a car holds one driver (another's enterSeat refused);
//          the driver walking as a person leaves the wheel first, back at the wheel leaves the person; leaveSeat; a seat
//          the mode does not allow (WorldSim.mayEnter) refused.
//   crafts two players, each the pilot of a craft of the world sim's (a boat, a helicopter; WorldSim addCraft,
//          placeCraft; enterSeat, seatInput, leaveSeat; its collision over the node files, on the world's clock): a
//          seat holds one pilot (another's enterSeat refused, the refused keeps their own), each craft takes its own
//          pilot's input, and each moves exactly as it does alone in the world (nothing assumes one local player); a
//          pilot counts as a focus (the edits near them kept); left, a craft goes on with hands off; a pilot walking as
//          a person leaves the craft first, back in it leaves the person; a craft followed is an entity (sim/entities.ts)
//          where its core is, and a focus.
//   left   a vehicle stays in the world when left (ADR 0008), through a SimServer and a client of its snapshots
//          (MirrorSimClient): two pilots get out of a helicopter in the air and a boat under way (leaveSeat); both
//          stay and are stepped hands off (the helicopter lets down onto its skids, the boat coasts), listed empty by
//          the client (crafts()); a third player enters the helicopter (enterSeat; the first is refused it then) and
//          flies it, the client's copy where the sim's is; by the edits' presence rule (a short keeping here) the empty
//          boat goes once no focus has been near it for the delay; a parked car stays while B flies by it, and both go
//          once B has left the helicopter too.
// Prints the costs (the bodies' tick, the colliders).
// usage (in web/): node tools/life-edit.mjs [-v] [dig|block|wreck|moto|transit|players|crafts|left|keep ...]; prints one PASS line, or the failures and exit 1
import fs from 'node:fs';
import { DATA, load, nodeWorld, rawTile as raw, readMeta } from './real-city.mjs';

const argv = process.argv.slice(2), verbose = argv.includes('-v');
const only = argv.filter((a) => !a.startsWith('-'));
const BRIDGE = { x: 4381, y: 2703 }, STREET = { x: 6500, y: 2600 }, WARM = 30, HOVER_S = 0.25, HOUR = 17, SEED = 7;

const meta = readMeta(), N = meta.tiles.N;
const { STEP } = await load('sim/traffic.ts'), { WorldSim } = await load('sim/world-sim.ts'), { unpackTraffic } = await load('sim/traffic-pack.ts');
const LP = await load('physics/rapier/life-phys.ts'), VH = await load('sim/vehicles.ts');
const WE = LP.worldEdits, LY = await load('core/layers.ts'), TC = await load('core/tile-cache.ts');
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

// an edit (as dig.ts does it): applied to the world (core/world-edits.ts, over a TileCache of the files: the live edits,
// which the colliders read); the World's source hears of it as the viewer's streamer does (its nodes' columns); the
// world sim is told the box, as main.ts does
const frame = LY.frameOf(meta);
WE.initWorldEdits({ cache: new TC.TileCache({ N, load: async (p) => raw(p), edits: LP.liveEdits }), frame, ...meta.tiles.levels[0] });
let heard = null;
LP.liveEdits.listen((tx, ty, node) => { if (heard && node) heard.src.nodes.set(`1/${tx}_${ty}`, heard.colData(tx, ty, node.base)); });
// op in map cells (as the tools write them) -> in the project grid (core/layers.ts WorldOp)
const worldOp = ({ x, y, z, id, ...rest }) => {
  const [col, row] = LY.mapToGrid(frame, x, y);
  return { ...rest, col, row, z: LY.cellToAbsZ(frame, z), colour: id };
};
async function edit(ctx, op, box) {
  heard = ctx;
  try { await WE.apply(worldOp(op), box); } finally { heard = null; }
  ctx.src.version++;
  ctx.sim.edited(box);
}
const clearEdits = () => WE.dropAll();

// a fresh world sim round the bridge, WARM s on, bodies attached (nothing edited: they must cost nothing)
async function setup(at) {
  const { W, src, colData } = await nodeWorld();
  const sim = new WorldSim(td, { seed: SEED, loadPhysics: (tuning) => LP.LifePhysics.load(meta, { x: at.x, z: at.y }, {}, { load: async (p) => raw(p) }, tuning.ride) });
  sim.setWorld(W);
  const phys = await sim.loadPhysics(), T = sim.traffic;
  // (the tiles round the bridge decoded up front, as the page's streaming has them: no load lands mid-run)
  const want = 400;
  for (let tz = Math.floor((at.y - want) / N); tz <= Math.floor((at.y + want) / N); tz++)
    for (let tx = Math.floor((at.x - want) / N); tx <= Math.floor((at.x + want) / N); tx++) await phys.terrain.prefetch(tx * N + 1, tz * N + 1);
  const ctx = { sim, T, phys, W, src, colData, focus: { x: at.x, z: at.y }, costs: [], t: 0 };
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
      ctx.sim.update(STEP, { hour: HOUR, focus: ctx.focus });
      ctx.t += STEP;
      if (ctx.T.edits.length) ctx.costs.push(ctx.phys.stats.tickMs);
      each?.(i);
    }
  } finally { Math.random = realRandom; }
}

// a car's pose as drawn at the tick (view/life.ts drawCars at a = 1): kinematic, or its body's
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
  // The car must be too fast to stop short of the hole (at 4 m/s its look-ahead brakes it at the rim, held: it never
  // falls); the first one so on the deck there, waiting for it in half seconds (which car it is depends on the traffic
  // as traffic.json has it).
  const near = { x: 4350, z: 2780, radius: 15 }, MIN_V = 7;
  let car = null;
  for (let k = 0; k < 40 && !(car = pickCar(ctx, 8, MIN_V, false, near)); k++) run(ctx, 0.5);
  if (!check(car, `a car at ${MIN_V} m/s or more on the bridge deck within ${near.radius} m of (${near.x}, ${near.z})`)) return ctx;
  const p = drawn(ctx, car), deck = p.y, R = 4;
  const ax = p.x + Math.sin(car.rh) * 6, az = p.z + Math.cos(car.rh) * 6;
  const op = { kind: 'sphere', x: Math.floor(ax), y: Math.floor(az), z: Math.floor(deck) - 1, r: R, id: 0 };
  const box = [op.x - R, op.y - R, op.x + R + 1, op.y + R + 1];
  await edit(ctx, op, box);
  const below = W.support(ax, az, deck);
  log(`dig: r ${R} at (${op.x}, ${op.y}, deck ${deck.toFixed(1)}) 6 m ahead of car ${car.id} at ${car.v.toFixed(1)} m/s; ground there now ${below.toFixed(1)}`);
  check(below < deck - 3, `the dig opened the deck: ground ${f2(below)} under it, deck ${f2(deck)}`);
  const w = watcher(ctx);
  let bodyAt = -1, minY = Infinity, fallers = new Set(), dropped = 0, seen = ctx.sim.tick;
  // a second reader of the events, every 5 s (WorldSim.eventsSince): the same ones, each with its tick
  let late = [], lateSeen = ctx.sim.tick, firstTick = ctx.sim.tick;
  const t0 = ctx.t;
  run(ctx, 15, (i) => {
    w.tick();
    if (bodyAt < 0 && phys.owns(car)) bodyAt = ctx.t - t0;
    if (car.rp) minY = Math.min(minY, car.rp.y + lowEdge(car));
    for (const c of [...T.cars, ...T.detachedCars]) if (c.rp && c.rp.y < deck - 3 && Math.hypot(c.rp.x - ax, c.rp.z - az) < 8) fallers.add(c.id);
    const fresh = ctx.sim.eventsSince(seen);
    check(fresh.every((e) => e.tick > seen && e.tick <= ctx.sim.tick), 'the events read are those of the ticks since the last read');
    dropped += fresh.filter((e) => e.kind === 'dropped').length;
    seen = ctx.sim.tick;
    if (i % 150 === 149) { late.push(...ctx.sim.eventsSince(lateSeen)); lateSeen = ctx.sim.tick; }
  });
  check(late.filter((e) => e.kind === 'dropped').length === dropped && late.every((e) => e.tick > firstTick),
    `a reader every 5 s gets the same events (${late.filter((e) => e.kind === 'dropped').length} / ${dropped} dropped)`);
  check(ctx.sim.eventsSince(ctx.sim.tick).length === 0, 'nothing since the last tick');
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
  await edit(ctx, op, box);
  const behind = behindOf(ctx, car);
  log(`block: 7x7x3 m at (${op.x}, ${op.y}, ${op.z}) 25 m ahead of car ${car.id} at ${car.v.toFixed(1)} m/s; car ${behind.id} behind it`);
  const w = watcher(ctx);
  const inBlock = (q) => q && q.x >= op.x - 0.5 && q.x < op.x + op.w + 0.5 && q.z >= op.y - 0.5 && q.z < op.y + op.d + 0.5 && q.y < op.z + op.h;
  let inside = 0, touch = 0, maxAlong = 0;
  run(ctx, 15, () => {
    w.tick();
    for (const c of [...T.cars, ...T.detachedCars]) if (inBlock(c.rp)) inside++;
    for (const id of [car, behind]) {
      const b = phys.bodies.get(id.id);
      if (!b) continue;
      if (b.state === 'track') maxAlong = Math.max(maxAlong, Math.abs(b.along));
      phys.world.contactPairsWith(b.chassis, (other) => phys.world.contactPair(b.chassis, other, (m) => { if (m.numContacts() > 0 && !other.parent()?.isDynamic() && other.shape.type !== 9 && Math.abs(m.normal().y) < 0.6) touch++; }));
    }
  });
  const b = phys.bodies.get(car.id), bb = phys.bodies.get(behind.id);
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
  ctx.sim.edited([f.x - 40, f.z - 40, f.x + 40, f.z + 40]);
  let car = null;
  for (let k = 0; k < 20 && !car; k++) { run(ctx, 0.5); car = pickCar(ctx, -99, 5, true); if (car && !phys.owns(car)) car = null; }
  if (!check(car, `a moving car with a body and one behind it near (${f.x}, ${f.z})`)) return null;
  const v0 = car.v, ok = phys.wreck(car, T, 'test');
  check(ok, `the car has a body to wreck (${phys.bodies.get(car.id)?.state})`);
  const w = watcher(ctx), t0 = ctx.t;
  let restAt = -1, touched = 0;
  const stoppers = new Set();
  run(ctx, 25, () => {
    w.tick();
    const wb = phys.bodies.get(car.id);
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
  ctx.sim.edited(box);
  run(ctx, 3);
  const b = phys.bodies.get(bike.id);
  check(b?.state === 'track' && b.build.bike && b.build.half.x === spec.build.half.x,
    'the motorbike tracks with its narrow Rapier body');
  ctx.sim.edited(box, true);
  run(ctx, 0.2);
  check(!phys.owns(bike) && T.cars.includes(bike), 'clearing the edit returns the motorbike to lane tracking');
  results.moto = { id: bike.id, tracked: b?.state === 'track', released: !phys.owns(bike) };
  return ctx;
}

function transit() {
  const localTop = (x) => (x < 7000 ? 9 : 8);
  const data = { roads: [], peds: [], ctrls: [], trains: td.trains };
  const boats = JSON.parse(fs.readFileSync(`${DATA}boats.json`, 'utf8'));
  const focus = { x: 7000, z: 2900 };
  function replay(ticksPerFrame, seed) {
    const sim = new WorldSim(data, { seed }), world = sim.traffic;
    sim.setBoats(boats);
    const snapshots = [];
    const snapshot = () => ({
      tick: world.tickNumber,
      coaches: [...world.trains.coaches()],
      vessels: world.boats.poses,
    });
    const advance = (ticks, hour) => {
      for (let i = 0; i < ticks; i += ticksPerFrame)
        sim.update(STEP * ticksPerFrame, { hour, day: 200, focus, viewer: focus });
      snapshots.push(snapshot());
    };
    Math.random = noRandom;
    try {
      sim.update(STEP / 4, { hour: 10, day: 200, focus });
      check(world.tickNumber === 0 && !world.boats.poses.length, 'boats wait for the first world tick');
      advance(30, 10);
      advance(60, 10);
      sim.setWorld(null, { waterColumn: (x) => ({ water: localTop(x) }) }); // (the world's columns, two stretches)
      advance(2, 10);
      sim.setWorld(null, null);
      advance(2, 15);
      check(world.boats.previous.every((p) => world.boats.poses.some((q) =>
        p.kind === q.kind && p.id === q.id && Math.hypot(p.x - q.x, p.z - q.z) < 0.2)),
      'clock resets avoid interpolating between distant poses');
    } finally {
      Math.random = realRandom;
    }
    return snapshots;
  }
  const a = replay(1, SEED), b = replay(2, SEED), c = replay(1, SEED + 1);
  check(JSON.stringify(a) === JSON.stringify(b), 'train and boat snapshots are bit-identical at two frame rates');
  check(JSON.stringify(a[0].coaches) !== JSON.stringify(c[0].coaches)
    && JSON.stringify(a[0].vessels) !== JSON.stringify(c[0].vessels), 'the world seed changes rail and river traffic');
  const rail = a[0].coaches.find((p) => a[1].coaches.some((q) => p.id === q.id && Math.hypot(p.x - q.x, p.z - q.z) > 1));
  check(rail && rail.y > 0, 'the train publishes moving coach poses at rail height');
  const tour = a[0].vessels.find((p) => p.kind === 'boat' && p.underway);
  check(tour && a[1].vessels.some((p) => p.kind === 'boat' && p.id === tour.id && Math.hypot(p.x - tour.x, p.z - tour.z) > 1),
    'a boat on the timetable moves on the world tick');
  check(a[2].vessels.length && a[2].vessels.every((p) => p.y === localTop(p.x)),
    'each vessel floats on the water top under it');
  check(a[3].vessels.some((p) => p.kind === 'boat') && a[3].vessels.every((p) => p.y === 8 || p.y === 9),
    'without the columns a vessel keeps the last water top known');
  results.transit = { replay: 'same', coaches: a[0].coaches.length, vessels: a[0].vessels.length };
}

async function players() {
  const sim = new WorldSim(td, { seed: SEED }), T = sim.traffic, focus = { x: BRIDGE.x, z: BRIDGE.y };
  const tick = (seconds, f = focus, each) => {
    for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) { each?.(i); sim.update(STEP, { hour: HOUR, focus: f }); }
  };
  const send = (kind, player, more = {}) => sim.send({ kind, player, ...more });
  Math.random = noRandom;
  try {
    tick(5);
    const ids = new Set([...T.people, ...T.riders].map((q) => q.id));
    check(ids.size === T.people.length + T.riders.length, `every person has an id of their own (${ids.size} for ${T.people.length + T.riders.length})`);
    const p = T.people.find((q) => !q.wait && q.v > 1), c = T.cars.find((q) => q.v > 1);
    if (!check(p && c, 'a walking person and a moving car near the bridge')) return;
    const other = T.people.find((q) => q !== p && !q.wait), o0 = other?.s;
    const P0 = T.personPoint(p, 0, { x: 0, y: 0, z: 0 }), at = { x: P0.x, y: P0.z, z: P0.y, h: 0, moving: false };
    send('follow', 'A', { entity: { kind: 'person', id: p.id } });
    send('follow', 'B', { entity: { kind: 'car', id: c.id } });
    send('enterSeat', 'A', { entity: { kind: 'person', id: p.id }, role: 'walker', pose: at });
    send('enterSeat', 'B', { entity: { kind: 'person', id: p.id }, role: 'walker', pose: at });
    const before = sim.seat('A') === null && !T.held.person.size;
    tick(STEP);
    const okA = sim.results('A', 'enterSeat', 'walker'), okB = sim.results('B', 'enterSeat', 'walker');
    check(before && okA.length === 1 && okA[0].ok && okB.length === 1 && !okB[0].ok,
      'the commands wait for the next update; the person walked holds one player: another\'s enterSeat is refused');
    check(sim.seat('A')?.role === 'walker' && sim.seat('A').entity.id === p.id && sim.seat('B') === null, 'the walker holds the person\'s seat, the follower none');
    const s0 = p.s, e0 = p.e;
    let last = at;
    tick(3, focus, (i) => { last = { ...at, x: at.x + (i + 1) * 0.04, h: 0.5, moving: true }; send('seatInput', 'A', { role: 'walker', input: last }); });
    check(p.s === s0 && p.e === e0 && sim.walkedPose(p.id)?.x === last.x && !sim.results('A', 'seatInput', 'walker').length,
      'the person walked stands where the walk puts them, off their way');
    check(other && other.s !== o0, 'the crowd walks on meanwhile');
    // a walk pose out of reach (100 m across, 50 m up in a frame) is taken clamped, and the walk is told; a run's
    // step (7 m/s) from there is taken as it is
    send('seatInput', 'A', { role: 'walker', input: { ...last, x: last.x + 100, y: last.y + 50 } });
    tick(STEP);
    const w = sim.walkedPose(p.id), B = sim.tuning.walk, clamped = sim.results('A', 'seatInput', 'walker');
    const across = w.x - last.x, up = w.y - last.y;
    send('seatInput', 'A', { role: 'walker', input: { ...w, x: w.x + 7 * STEP } });
    tick(STEP);
    check(clamped.length === 1 && !clamped[0].ok && across > 0 && across <= B.speed * STEP + B.slack + 1e-9 && up > 0 && up <= B.climb * STEP + B.slack + 1e-9 &&
      sim.walkedPose(p.id).x === w.x + 7 * STEP && !sim.results('A', 'seatInput', 'walker').length,
      `a teleporting walk pose is clamped (${across.toFixed(2)} m across, ${up.toFixed(2)} m up), a run from there is not`);
    const far = { x: focus.x + 3000, z: focus.z };
    tick(1, far);
    const kept = T.people.includes(p) && T.cars.includes(c);
    check(kept, 'the person walked and the car followed are kept when the focus moves 3 km away');
    send('leaveSeat', 'A');
    send('follow', 'A', { entity: null });
    send('follow', 'B', { entity: null });
    tick(STEP, far);
    check(sim.walkedPose(p.id) === null && sim.seat('A') === null && !T.held.person.size && !T.held.car.size, 'left and unfollowed: nothing held');
    // the seat taken and left as events (sim/entities.ts Seat: role, index), each at the first tick after its command
    const seats = sim.eventsSince(-1).filter((e) => e.kind === 'seated' || e.kind === 'unseated');
    check(JSON.stringify(seats.map((e) => [e.kind, e.player, e.seat])) ===
      JSON.stringify([['seated', 'A', { entity: { kind: 'person', id: p.id }, role: 'walker', index: 0 }], ['unseated', 'A', { entity: { kind: 'person', id: p.id }, role: 'walker', index: 0 }]]) &&
      seats[1].tick === sim.tick, `the seat taken and left as events, the refused none (${seats.map((e) => `${e.kind}@${e.tick}`).join(' ')})`);
    tick(1, { x: far.x + 200, z: far.z });
    const gone = !T.people.includes(p) && !T.cars.includes(c);
    check(gone, 'let go, they leave with the circle');
    // a hole (a ground with nothing under the street round a person walked): the others there fall, the one walked
    // stands; two readers of the events, one every tick, one every 2 s, get the same ones with their ticks
    const sim2 = new WorldSim(td, { seed: SEED }), T2 = sim2.traffic;
    const tick2 = (seconds, each) => { for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) { sim2.update(STEP, { hour: HOUR, focus }); each?.(i); } };
    tick2(5);
    const q = T2.people.find((r) => !r.wait), Q = q && T2.personPoint(q, 0, { x: 0, y: 0, z: 0 });
    if (!check(q, 'a person near the bridge')) return;
    sim2.send({ kind: 'enterSeat', player: 'A', entity: { kind: 'person', id: q.id }, role: 'walker', pose: { x: Q.x, y: Q.z, z: Q.y, h: 0, moving: false } });
    const near = (x, z) => Math.hypot(x - Q.x, z - Q.y) < 40;
    sim2.setWorld({ surface: (x, z, y) => y, support: (x, z, top) => (near(x, z) ? -1000 : top) });
    sim2.edited([Q.x - 40, Q.y - 40, Q.x + 40, Q.y + 40]);
    const every = [], slow = [];
    let seen = sim2.tick, slowSeen = sim2.tick;
    const from = sim2.tick;
    tick2(4, (i) => {
      every.push(...sim2.eventsSince(seen)); seen = sim2.tick;
      if (i % 60 === 59) { slow.push(...sim2.eventsSince(slowSeen)); slowSeen = sim2.tick; }
    });
    const drops = every.filter((e) => e.kind === 'dropped');
    check(drops.length > 0 && drops.every((e) => e.person !== q) && T2.people.includes(q), `the people over the hole fall (${drops.length}), the one walked stands`);
    check(JSON.stringify(every.map((e) => [e.tick, e.kind, e.person?.id])) === JSON.stringify(slow.map((e) => [e.tick, e.kind, e.person?.id]))
      && every.every((e, k) => e.tick > from && (k === 0 || e.tick >= every[k - 1].tick)),
    'two readers of the events at different rates get the same ones, in tick order');
    results.players = { seat: 'one', clamped: `${across.toFixed(2)}m`, kept: kept ? 'yes' : 'no', released: gone ? 'yes' : 'no', dropped: drops.length };
  } finally {
    Math.random = realRandom;
  }
  await driverSeat();
}

// The driver's seat in the seat table (with the road physics): one player a car, another's enterSeat refused; the
// driver walking as a person leaves the wheel first (the car parked where it is), taking the wheel again leaves the
// person; leaveSeat leaves whatever is held
async function driverSeat() {
  const sim = new WorldSim(td, { seed: SEED, loadPhysics: (tuning) => LP.LifePhysics.load(meta, { x: BRIDGE.x, z: BRIDGE.y }, {}, { load: async (p) => raw(p) }, tuning.ride) });
  const phys = await sim.loadPhysics(), T = sim.traffic, focus = { x: BRIDGE.x, z: BRIDGE.y };
  const tick = (seconds) => { for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) sim.update(STEP, { hour: HOUR, focus }); };
  Math.random = noRandom;
  try {
    tick(5);
    const c = T.cars.find((q) => q.v > 1 && !q.bus), p = T.people.find((q) => !q.wait);
    if (!check(c && p, 'seats: a moving car and a person near the bridge')) return;
    sim.send({ kind: 'enterSeat', player: 'A', entity: { kind: 'car', id: c.id }, role: 'driver' });
    sim.send({ kind: 'enterSeat', player: 'B', entity: { kind: 'car', id: c.id }, role: 'driver' });
    tick(STEP);
    const a = sim.results('A', 'enterSeat', 'driver'), b = sim.results('B', 'enterSeat', 'driver');
    check(a[0]?.ok && b.length === 1 && !b[0].ok && sim.seat('A')?.role === 'driver' && sim.seat('A').entity.id === c.id &&
      sim.driverSnapshot('A')?.entityId === c.id && sim.seat('B') === null, 'seats: the car holds one driver; another\'s enterSeat is refused');
    const P = T.personPoint(p, 0, { x: 0, y: 0, z: 0 });
    sim.send({ kind: 'enterSeat', player: 'A', entity: { kind: 'person', id: p.id }, role: 'walker', pose: { x: P.x, y: P.z, z: P.y, h: 0, moving: false } });
    tick(STEP);
    const switched = sim.seat('A')?.role === 'walker' && sim.driverSnapshot('A') === null && T.detachedCars.includes(c) && !phys.controlled(c);
    sim.send({ kind: 'enterSeat', player: 'A', entity: { kind: 'car', id: c.id }, role: 'driver' });
    tick(STEP);
    const back = sim.results('A', 'enterSeat', 'driver')[0]?.ok && sim.seat('A')?.role === 'driver' && sim.walkedPose(p.id) === null && !T.walked.size;
    sim.send({ kind: 'leaveSeat', player: 'A' });
    tick(STEP);
    // a seat the mode does not allow (WorldSim.mayEnter): refused, nothing held
    sim.mayEnter = (player, seat) => !(player === 'B' && seat.entity.kind === 'car');
    sim.send({ kind: 'enterSeat', player: 'B', entity: { kind: 'car', id: c.id } });
    tick(STEP);
    const barred = sim.results('B', 'enterSeat', 'driver');
    check(barred.length === 1 && !barred[0].ok && sim.seat('B') === null && sim.driverSnapshot('B') === null,
      'seats: a seat the mode does not allow (mayEnter) is refused');
    sim.mayEnter = () => true;
    check(switched && back && sim.seat('A') === null && sim.driverSnapshot('A') === null && !phys.controlled(c),
      `seats: a driver walking as a person leaves the wheel first (${switched}), back at the wheel leaves the person (${back}); leaveSeat leaves the car`);
    results.players.seats = 'one';
  } finally {
    Math.random = realRandom;
    phys.dispose();
  }
}

// Crafts in the world sim: a world sim with the crafts' collisions over the node files (their own TileCache, the clock
// the ticks' time); each craft's tiles loaded before it is put down (findSpawn, as the boat's shell does), so no step
// waits. plan: [type, x, z, h, input(t), spot(collision)] per pilot; returns the sim, the crafts, its tick
const BOAT = await load('sim/craft/boat-motion.ts');
// a spot for a boat: on open water near (x, z) (as the boat's shell finds it); for one in the air: dy m over the ground
const afloat = (x, z, h) => (col) => BOAT.findSpawn(col, x, z, h, 48);
const aloft = (x, z, h, dy) => (col) => { const s = col.surface(x, z); return s && { x, y: s.top + dy, z, h }; };
async function craftWorld(plan, tuning) {
  let ms = 0;
  const sim = new WorldSim(td, { seed: SEED, tuning, crafts: { meta, cache: new TC.TileCache({ N, load: async (p) => raw(p) }), now: () => ms } });
  const crafts = [];
  for (const [type, x, z, , , spot] of plan) {
    const c = sim.addCraft(type), zero = { x: 0, y: 0, z: 0 };
    const ready = () => [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].every(([i, j]) => c.collision.surface(x + i * N, z + j * N) !== null);
    for (let i = 0; i < 4000 && !ready(); i++) { ms += 200; c.collision.prefetch({ x, y: 0, z }, zero); await new Promise((d) => setTimeout(d, 2)); }
    if (!check(ready(), `crafts: the tiles round ${type} at ${x}, ${z} load`)) return null;
    const at = spot(c.collision);
    if (!check(at, `crafts: a spot for the ${type} near ${x}, ${z}`)) return null;
    sim.placeCraft(c.id, at);
    crafts.push(c);
  }
  // (run: the frame, by default the sim's update; focus: the viewer's)
  const tick = (seconds, each, { focus = { x: BRIDGE.x, z: BRIDGE.y }, run = (dt, input) => sim.update(dt, input) } = {}) => {
    for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) { each?.(i * STEP); ms += STEP * 1000; run(STEP, { hour: HOUR, focus }); }
  };
  return { sim, crafts, tick };
}

async function crafts() {
  // (a boat on the Danube by the Altstadt, the boat gate's spot; a helicopter 40 m over the street at STREET, climbing
  // and then flying on)
  const plan = [['boat', 8160.5, 2880.5, 1.8, (t) => ({ throttle: 1, steer: Math.sin(t * 0.7), drift: false }), afloat(8160.5, 2880.5, 1.8)],
    ['helicopter', STREET.x, STREET.y, 0, (t) => ({ lift: t < 2 ? 1 : 0, drive: t < 2 ? 0 : 1, turn: t > 4 ? -0.5 : 0, side: 0 }), aloft(STREET.x, STREET.y, 0, 40)]];
  const both = await craftWorld(plan);
  if (!both) return;
  const { sim, crafts: [a, b], tick } = both;
  const send = (kind, player, more = {}) => sim.send({ kind, player, ...more });
  // (B asks for A's craft after taking its own: refused, B keeps its own)
  send('enterSeat', 'A', { entity: { kind: 'craft', id: a.id }, role: 'pilot' });
  send('enterSeat', 'B', { entity: { kind: 'craft', id: b.id }, role: 'pilot' });
  send('enterSeat', 'B', { entity: { kind: 'craft', id: a.id }, role: 'pilot' });
  const foci = (sim2) => sim2.foci({ x: BRIDGE.x, z: BRIDGE.y }).length;
  Math.random = noRandom;
  let path;
  try {
    tick(6, (t) => { send('seatInput', 'A', { role: 'pilot', input: plan[0][4](t) }); send('seatInput', 'B', { role: 'pilot', input: plan[1][4](t) }); });
    const ra = sim.results('A', 'enterSeat', 'pilot'), rb = sim.results('B', 'enterSeat', 'pilot');
    check(ra.length === 1 && ra[0].ok && rb.length === 2 && rb[0].ok && !rb[1].ok,
      'crafts: each player takes a pilot\'s seat; the other\'s is refused');
    check(sim.seat('A')?.role === 'pilot' && sim.seat('A').entity.id === a.id && sim.seat('B')?.entity.id === b.id && sim.craftOf('B') === b &&
      a.pilot === 'A' && b.pilot === 'B', 'crafts: each pilot holds their own craft\'s seat (refused another, B keeps its own)');
    path = [a, b].map((c) => c.core.pose);
    const f0 = foci(sim);
    check(f0 === 3, `crafts: both pilots count as foci (${f0} with the viewer's)`);
    // each alone in the world: the same steps to the bit
    for (const k of [0, 1]) {
      const solo = await craftWorld([plan[k]]);
      if (!solo) return;
      solo.sim.send({ kind: 'enterSeat', player: 'A', entity: { kind: 'craft', id: solo.crafts[0].id }, role: 'pilot' });
      solo.tick(6, (t) => solo.sim.send({ kind: 'seatInput', player: 'A', role: 'pilot', input: plan[k][4](t) }));
      const p = solo.crafts[0].core.pose, q = path[k];
      check(p.x === q.x && p.z === q.z && p.h === q.h, `crafts: pilot ${'AB'[k]}'s craft moves as it does alone (${p.x.toFixed(2)}, ${p.z.toFixed(2)} / ${q.x.toFixed(2)}, ${q.z.toFixed(2)})`);
    }
    const moved = path.map((q, k) => Math.hypot(q.x - plan[k][1], q.z - plan[k][2]));
    check(moved[0] > 40 && moved[1] > 20, `crafts: both moved under their pilots' input (${moved.map((m) => m.toFixed(1)).join(', ')} m)`);
    // a craft followed (sim/entities.ts: an entity like a car or a person): where it is, a focus of its own
    send('follow', 'F', { entity: { kind: 'craft', id: b.id } });
    tick(STEP);
    const E = sim.entities.pose({ kind: 'craft', id: b.id }), there = E && E.x === b.core.pose.x && E.z === b.core.pose.z, fF = foci(sim);
    send('follow', 'F', { entity: null });
    tick(STEP);
    check(there && fF === 4 && foci(sim) === 3 && !sim.traffic.held.car.size && !sim.traffic.held.person.size,
      `crafts: a craft followed is an entity where its core is, a focus while followed (${fF})`);
    // A leaves: the seat empty, the boat coasts on hands off and slows (B's helicopter flies on)
    send('leaveSeat', 'A');
    const v0 = Math.abs(a.core.motion.speed);
    tick(2);
    check(sim.seat('A') === null && a.pilot === null && Math.abs(a.core.motion.speed) < v0 && sim.seat('B')?.entity.id === b.id,
      'crafts: left, the craft goes on hands off; the other pilot keeps theirs');
    // one seat a player: B, the helicopter's pilot, walks as a person (the helicopter left first), then takes the
    // helicopter again (the person left first)
    const T = sim.traffic, p = T.people.find((q) => !q.wait), P = p && T.personPoint(p, 0, { x: 0, y: 0, z: 0 });
    if (!check(p, 'crafts: a person near the bridge')) return;
    send('enterSeat', 'B', { entity: { kind: 'person', id: p.id }, role: 'walker', pose: { x: P.x, y: P.z, z: P.y, h: 0, moving: false } });
    tick(STEP);
    const walking = sim.seat('B')?.role === 'walker' && b.pilot === null && sim.craftOf('B') === null && T.walked.has(p.id);
    send('enterSeat', 'B', { entity: { kind: 'craft', id: b.id }, role: 'pilot' });
    tick(STEP);
    check(walking && sim.seat('B')?.role === 'pilot' && b.pilot === 'B' && sim.walkedPose(p.id) === null && !T.walked.size,
      `crafts: a pilot walking as a person leaves the craft first (${walking}), back in the craft leaves the person`);
    sim.removeCraft(b.id);
    check(sim.seat('B') === null && !sim.crafts.has(b.id), 'crafts: a craft taken away leaves its pilot seatless');
    results.crafts = { pilots: 2, alone: 'same', moved: moved.map((m) => m.toFixed(1)).join('/') };
  } finally {
    Math.random = realRandom;
  }
}

async function left() {
  const { SimServer } = await load('sim/sim-server.ts'), { MirrorSimClient, ThreadLink } = await load('sim/sim-client.ts');
  const { DEFAULT_TUNING } = await load('sim/tuning.ts');
  const keeping = { radius: 300, after: 10 };
  const plan = [['boat', 8160.5, 2880.5, 1.8, null, afloat(8160.5, 2880.5, 1.8)], ['helicopter', STREET.x, STREET.y, 0, null, aloft(STREET.x, STREET.y, 0, 40)]];
  const w = await craftWorld(plan, { ...DEFAULT_TUNING, edits: keeping });
  if (!w) return;
  const { sim, crafts: [boat, heli], tick } = w, server = new SimServer(sim);
  const client = new MirrorSimClient(new ThreadLink(server, 'B'), unpackTraffic(JSON.parse(fs.readFileSync(`${DATA}traffic.json`, 'utf8'))), null, 'B');
  // (every frame through the client: player B's commands with it, the others' straight to the server)
  const near = { focus: { x: STREET.x, z: STREET.y }, run: (dt, input) => client.update(dt, input) };
  const away = { ...near, focus: { x: BRIDGE.x, z: BRIDGE.y } };
  Math.random = noRandom;
  try {
    const hy = heli.core.pose.y;
    server.send({ kind: 'enterSeat', player: 'C', entity: { kind: 'craft', id: boat.id }, role: 'pilot' });
    server.send({ kind: 'enterSeat', player: 'A', entity: { kind: 'craft', id: heli.id }, role: 'pilot' });
    tick(3, () => {
      server.send({ kind: 'seatInput', player: 'C', role: 'pilot', input: { throttle: 1, steer: 0, drift: false } });
      server.send({ kind: 'seatInput', player: 'A', role: 'pilot', input: { lift: 1, drive: 0, turn: 0, side: 0 } });
    }, near);
    // a parked car by the street (as the road physics leaves one: out of the traffic, where it stands)
    const T = sim.traffic, at = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };
    const car = T.cars.map((c) => { T.carPose(c, c.s, c.off, at); return { c, pose: { ...at, roll: 0 }, d: Math.hypot(at.x - STREET.x, at.z - STREET.y) }; })
      .sort((a, b) => a.d - b.d)[0];
    check(car && car.d < keeping.radius && T.detachCar(car.c, car.pose), `left: a car parked near the street (${car?.d.toFixed(0)} m)`);
    const y0 = heli.core.pose.y, b0 = { ...boat.core.pose }, v0 = Math.abs(boat.core.motion.speed);
    check(y0 > hy + 10 && v0 > 3, `left: the helicopter climbed (${y0.toFixed(1)} m), the boat under way (${v0.toFixed(1)} m/s)`);
    server.send({ kind: 'leaveSeat', player: 'A' });
    server.send({ kind: 'leaveSeat', player: 'C' });
    tick(6, null, near);
    const listed = client.crafts();
    check(sim.crafts.has(boat.id) && sim.crafts.has(heli.id) && boat.pilot === null && heli.pilot === null && sim.seat('A') === null &&
      listed.length === 2 && listed.every((c) => c.pilot === null), `left: both crafts stay in the world, empty (the client lists ${listed.length})`);
    const moved = Math.hypot(boat.core.pose.x - b0.x, boat.core.pose.z - b0.z);
    check(moved > 3 && Math.abs(boat.core.motion.speed) < v0 && heli.core.pose.y < y0 - 10,
      `left: stepped hands off: the boat coasts on (${moved.toFixed(1)} m, ${Math.abs(boat.core.motion.speed).toFixed(1)} m/s), the helicopter lets down (${(y0 - heli.core.pose.y).toFixed(1)} m)`);
    // the boat is 1.7 km from the focus, the helicopter and the car by it: past the delay the boat goes
    tick(keeping.after, null, near);
    check(!sim.crafts.has(boat.id) && sim.crafts.has(heli.id) && client.crafts().length === 1 && T.detachedCars.includes(car.c) && heli.core.motion.grounded,
      `left: with no focus near it, the empty boat goes; the helicopter (on its skids: ${heli.core.motion.grounded}) and the car by the focus stay`);
    // B takes the helicopter's seat through the client, A asks for it after; B flies it up
    client.send({ kind: 'enterSeat', player: 'B', entity: { kind: 'craft', id: heli.id }, role: 'pilot' });
    server.results('A');
    tick(STEP, null, near);
    tick(STEP, () => server.send({ kind: 'enterSeat', player: 'A', entity: { kind: 'craft', id: heli.id }, role: 'pilot' }), near);
    const mine = client.craftOf('B'), refused = server.results('A', 'enterSeat', 'pilot');
    check(client.seat('B')?.role === 'pilot' && mine?.id === heli.id && client.results('B', 'enterSeat', 'pilot')[0]?.ok === true &&
      refused.length === 1 && !refused[0].ok && heli.pilot === 'B', 'left: another player enters the empty helicopter (the client sees its seat); the first is refused it');
    const g = heli.core.pose.y;
    tick(2, () => client.send({ kind: 'seatInput', player: 'B', role: 'pilot', input: { lift: 1, drive: 0, turn: 0, side: 0 } }), near);
    const p = heli.core.pose, q = client.craftOf('B').core.pose;
    check(p.y > g + 5 && p.x === q.x && p.y === q.y && p.z === q.z && p.h === q.h,
      `left: B flies it up (${(p.y - g).toFixed(1)} m); the client's copy is where the sim's is`);
    // the viewer's focus away: B in the helicopter keeps the car by it; once B has left it too, both go after the delay
    tick(keeping.after + 1, () => client.send({ kind: 'seatInput', player: 'B', role: 'pilot', input: { lift: 0, drive: 0, turn: 0, side: 0 } }), away);
    const kept = T.detachedCars.includes(car.c) && sim.crafts.has(heli.id);
    client.send({ kind: 'leaveSeat', player: 'B' });
    tick(keeping.after - 1, null, away);
    const stays = T.detachedCars.includes(car.c) && sim.crafts.has(heli.id);
    tick(2, null, away);
    check(kept && stays && !T.detachedCars.includes(car.c) && !sim.crafts.has(heli.id) && client.crafts().length === 0 && client.seat('B') === null,
      `left: the focus away, B in the helicopter keeps the car by it (${kept}); B out, both stay the delay (${stays}), then go`);
    results.left = { stays: 'boat,helicopter,car', entered: 'B', dropped: 'boat,car,helicopter' };
  } finally {
    Math.random = realRandom;
  }
}

// (the keeper's module graph, with its own world edits: tools load each graph apart)
async function keep() {
  const EK = await load('sim/edit-keeper.ts'), WE2 = EK.worldEdits, live = WE2.liveEdits;
  WE2.initWorldEdits({ cache: new TC.TileCache({ N, load: async (p) => raw(p), edits: live }), frame, ...meta.tiles.levels[0] });
  const tx = Math.floor(BRIDGE.x / N) + 1, [col, row] = LY.mapToGrid(frame, tx * N, BRIDGE.y);
  await WE2.apply({ kind: 'sphere', col, row, z: LY.cellToAbsZ(frame, 20), r: 3, colour: 0 });
  const K = new EK.EditKeeper({ radius: 10, after: 10 }, N), far = { x: BRIDGE.x - 1000, z: BRIDGE.y }, inA = { x: (tx - 1) * N + 28, z: BRIDGE.y };
  const steps = [[0, [far], 0], [30, [far, inA], 0], [39, [far], 0], [40, [far], 2]].map(([t, foci, want]) => {
    const n = K.update(t, foci);
    check(n === want, `keep: at ${t} s with foci ${foci.map((f) => `(${f.x}, ${f.z})`).join(' ')}, ${n} node(s) dropped, not ${want}`);
    return `${n}/${live.size}`;
  });
  check(live.size === 0, `keep: every edit dropped in the end (${live.size} left)`);
  log(`keep: a crater over nodes ${tx - 1}/${tx}_${Math.floor(BRIDGE.y / N)}: dropped/left ${steps.join(' ')}`);
  results.keep = { steps: steps.join(' ') };
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
if (want('transit')) transit();
if (want('players')) await players();
if (want('crafts')) await crafts();
if (want('left')) await left();
if (want('keep')) await keep();
const cost = `bodies' tick with edits: avg ${f2(avg(costs))} p99 ${f2(pct(costs, 0.99))} max ${f2(Math.max(0, ...costs))} ms; ${bodies.join('/')} bodies, ${chunks.join('/')} chunks built per run; 0 ms before any edit`;
if (bad.length) { console.log(`FAIL life-edit: ${bad.length} check(s) failed; ${cost}`); process.exit(1); }
console.log(`PASS life-edit: ${Object.entries(results).map(([k, v]) => `${k} ${typeof v === 'string' ? v : Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')}`).join('; ')}; ${cost}`);
process.exit(0);
