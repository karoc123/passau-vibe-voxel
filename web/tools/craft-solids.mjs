// The crafts among the solid things, on a synthetic world (a lake with a shore of land, an excursion boat's straight
// tour on it at 10:00 in July, a real host in Node, host/node.ts nodeHost, a few seconds): what a player at the wheel
// would notice, measured on the host's own poses by the shapes the walker meets (sim/solids.ts). A traffic boat under
// way stops before a player's boat lying in its way and goes on once it has gone; a player's boat driven at a moored
// traffic boat and at another player's boat bounces off it and never passes through; a hovercraft driven at a parked
// car stops at it. A car a player drives (the road physics) at a hovering hovercraft bumps off it, never through it
// nor shoving it away (the crafts are walls to the road physics); a car of the traffic on a road stops for a player on
// foot in its lane, and for a hovercraft let down in it. A floatplane and a jet flown at a parked car crash on it, one
// passing it close crashes on it with a wing, a wing tip clipping a pillar crashes it; a drone bounces off a parked
// car and a paraglider stops at one, none passes through.
// usage (in web/): node tools/craft-solids.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';

const { nodeHost } = await imp('src/host/node.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { carShape, CRAFT_SHAPES, meetShapes, overlap, solidAt, vesselShape, WALKER_R } = await imp('src/sim/solids.ts');
const { HOVER_HEIGHT } = await imp('src/sim/craft/craft-motion.ts');
const { DRONE } = await imp('src/sim/craft/fpv-flight.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const WATER = 4, LAND = 6, SHORE = 160, TOUR_Z = 60;
// (a pillar on the land a plane's wing tip clips)
const PILLAR = { x0: 200, x1: 202, z0: 198, z1: 204 };
const { dir, data } = await synthData({ size: [256, 256], ground: (x, z) => (z < SHORE ? WATER : LAND), surface: (x, z) => (z < SHORE ? 'water' : 'road'),
  boxes: [{ ...PILLAR, y0: LAND, y1: LAND + 14, mat: 'wall' }] });
data.boats = { berths: [], tour: [[30, TOUR_Z], [230, TOUR_Z]] };
// a straight one-lane road on the land, east along z ROAD_Z (its points: x, z, height)
const ROAD_Z = 245;
data.traffic.roads = [{ a: 0, b: 1, w: 1, lanes: 1, v: 12, c: 1, o0: 0, p: [[10, ROAD_Z, LAND], [246, ROAD_Z, LAND]] }];
const server = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 300, time: { hour: 10, day: 190 } }, data);
const sim = server.sim, T = sim.traffic;

const players = [];
const player = (name, type, x, z, h, y, speed) => {
  const s = server.connect(name), link = sessionLink(s);
  s.send({ kind: 'view', view: { focus: { x: 128, z: 128 } } });
  if (type) s.send({ kind: 'request', request: { kind: 'craft', type, spot: { x, y, z, h, speed } } });
  const P = { s, link, type, craft: () => sim.craftOf(s.player) };
  P.input = (input) => s.send({ kind: 'seatInput', role: 'pilot', input });
  P.put = (x, z, h) => s.send({ kind: 'request', request: { kind: 'placeCraft', spot: { x, y, z, h } } });
  players.push(P);
  return P;
};
// a tick of the host (the tiles read between them: the crafts' collisions wait for them)
const tick = async () => {
  server.update(STEP);
  for (const p of players) p.link.deliver();
  await new Promise((r) => setImmediate(r));
};
const run = async (s, each = () => {}) => { for (let i = 0; i < s / STEP; i++) { await tick(); each(); } };
const solidOf = (P) => { const c = P.craft(); return solidAt(CRAFT_SHAPES[c.type], c.core.pose); };
const vessel = (id) => T.boats.poses.find((p) => p.kind === 'boat' && p.id === id);
const vesselSolid = (id) => { const p = vessel(id); return solidAt(vesselShape(p), { x: p.x, y: p.y, z: p.z, h: p.heading }); };
const STILL = { throttle: 0, steer: 0, drift: false }, FULL = { throttle: 1, steer: 0, drift: false };

// A lies in the tour's way 80 m ahead of the excursion boat casting off (its bow at x 49 heading +x)
const A = player('a', 'boat', 130, TOUR_Z, -Math.PI / 2, WATER);
await run(0.5);
check(vessel(0)?.underway && A.craft()?.placed, `the excursion boat casts off (at x ${vessel(0)?.x.toFixed(1)}) with a player's boat in its way (at x 130)`);
let deep = 0;
await run(60, () => { deep = Math.max(deep, overlap(solidOf(A), vesselSolid(0))); });
const v0 = vessel(0), gap = A.craft().core.pose.x - CRAFT_SHAPES.boat.hz - (v0.x + v0.len / 2);
const x1 = v0.x;
await run(1);
check(deep <= 0.05 && gap > 0 && gap < 20 && Math.abs(vessel(0).x - x1) < 0.01,
  `the traffic boat stops before the player's boat (its bow ${gap.toFixed(1)} m short, still; deepest ${deep.toFixed(3)} m)`);
A.put(130, 130, 0);
await run(15);
check(vessel(0).x - x1 > 10, `the way clear, it goes on (${(vessel(0).x - x1).toFixed(1)} m in 15 s)`);

// A driven at the spare excursion boat moored outermost in the raft at the pier (x 11..49, its side at z 82)
const moored = vesselSolid(2);
A.put(30, 115, Math.PI);
await run(0.5);
A.input(FULL);
deep = 0;
let vMax = 0;
await run(5, () => { deep = Math.max(deep, overlap(solidOf(A), moored)); vMax = Math.max(vMax, -A.craft().core.motion.vz); });
A.input(STILL);
await run(1);
const az = A.craft().core.pose.z, side = moored.z + moored.hx;
check(deep <= 0.05 && az > side + CRAFT_SHAPES.boat.hz - 0.1 && A.craft().core.motion.vz >= -0.5,
  `a boat driven at a moored traffic boat (${vMax.toFixed(1)} m/s) bounces off it (its stern at z ${(az - CRAFT_SHAPES.boat.hz).toFixed(2)}, the side at ${side.toFixed(1)}; deepest ${deep.toFixed(3)} m)`);

// A driven at B's boat lying broadside, 30 m ahead
const B = player('b', 'boat', 180, 110, Math.PI / 2, WATER);
A.put(180, 140, Math.PI);
await run(0.5);
A.input(FULL);
deep = 0;
await run(5, () => { deep = Math.max(deep, overlap(solidOf(A), solidOf(B))); });
const za = A.craft().core.pose.z, zb = B.craft().core.pose.z;
check(deep <= 0.05 && za - zb > CRAFT_SHAPES.boat.hz + CRAFT_SHAPES.boat.hx - 0.2,
  `a boat driven at another player's boat stops at it, never through (${(za - zb).toFixed(2)} m between them; deepest ${deep.toFixed(3)} m)`);

// C's hovercraft driven at a car parked on the land, 30 m ahead
const car = { kind: 'car', id: 9001, e: 0, lane: 0, s: 0, ds: 0, off: 0, dOff: 0, prev: -1, prevOff: 0, next: -1, len: 4.6, bus: false,
  col: '#888888', brake: 0, v: 0, wait: 0, why: 'free', by: null, block: null, geo: { px: 0, py: 0, cx: 128, cy: 220, z: LAND, fx: 0, fy: 1 },
  detachedPose: { x: 128, y: LAND, z: 220, h: Math.PI / 2, pitch: 0, roll: 0 } };
T.detachedCars.push(car);
const C = player('c', 'hovercraft', 128, 185, 0, LAND + HOVER_HEIGHT);
await run(1);
C.input({ turn: 0, drive: 1, lift: 0, side: 0 });
deep = 0;
vMax = 0;
const carSolid = solidAt(carShape(car), car.detachedPose);
await run(6, () => { deep = Math.max(deep, overlap(solidOf(C), carSolid)); vMax = Math.max(vMax, C.craft().core.velocity.z); });
const front = C.craft().core.pose.z + CRAFT_SHAPES.hovercraft.hz, back = 220 - carSolid.hx;
check(deep <= 0.05 && front < back + 0.05 && front > back - 1 && T.detachedCars.includes(car),
  `a hovercraft driven at a parked car (${vMax.toFixed(1)} m/s) stops at it (its bow at z ${front.toFixed(2)}, the car's side at ${back.toFixed(2)}; deepest ${deep.toFixed(3)} m)`);

// D drives car 9001 (east, along +x) at C's hovercraft hovering 40 m ahead, broadside
C.put(175, 220, 0);
C.input({ turn: 0, drive: 0, lift: 0, side: 0 });
const D = player('d', null, 128, 218, 0, LAND);
D.s.send({ kind: 'request', request: { kind: 'walk', pose: { x: 128, y: LAND, z: 217.5, h: 0, moving: false } } });
await run(0.5);
const seat = { kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' };
D.s.send(seat);
await run(0.2);
await sim.loadPhysics({ x: 128, z: 220 });
D.s.send(seat);
await run(0.5);
check(sim.seat(D.s.player)?.role === 'driver', `a player takes the parked car's wheel (the road physics in: ${!!sim.physics})`);
await run(1);
const hc0 = { ...C.craft().core.pose };
D.input = (input) => D.s.send({ kind: 'seatInput', role: 'driver', input });
D.input({ gas: 1, brake: 0, steer: 0, handbrake: false });
deep = 0;
vMax = 0;
const carNow = () => solidAt(carShape(car), car.detachedPose);
let x0 = car.detachedPose.x;
await run(9, () => { deep = Math.max(deep, overlap(carNow(), solidOf(C))); vMax = Math.max(vMax, (car.detachedPose.x - x0) / STEP); x0 = car.detachedPose.x; });
D.input({ gas: 0, brake: 1, steer: 0, handbrake: false });
await run(1);
const hc1 = C.craft().core.pose, moved = Math.hypot(hc1.x - hc0.x, hc1.z - hc0.z);
check(deep <= 0.3 && moved < 3,
  `a driven car (${vMax.toFixed(1)} m/s) bumps off a hovering hovercraft, never through nor shoving it away (the craft moved ${moved.toFixed(2)} m; deepest ${deep.toFixed(3)} m)`);

// a car of the traffic on the road, coming at D on foot in its lane 60 m ahead
D.s.send({ kind: 'leaveSeat' });
D.s.send({ kind: 'request', request: { kind: 'walk', pose: { x: 150, y: LAND, z: ROAD_Z, h: 0, moving: false } } });
await run(0.2);
const road = T.roads[0];
const tc = { ...structuredClone(car), id: 9002, detachedPose: undefined, e: 0, lane: 0, s: 90, v: 10, off: 0, v0f: 1, ghost: 0, next: -1, boxNode: -1, boxFrom: -1, boxTo: -1, boxLane: 0, boxT: 0, boxTurn: 0 };
delete tc.detachedPose;
road.lists[0].push(tc);
T.cars.push(tc);
let past = -Infinity;
await run(10, () => { if (T.cars.includes(tc)) past = Math.max(past, tc.geo.px - 150); });
check(T.cars.includes(tc) && past < -WALKER_R && tc.v < 0.1 && tc.why === 'walker',
  `a car of the traffic stops for a player on foot in its lane (its front ${(-past).toFixed(2)} m short of the walker, ${tc.v.toFixed(2)} m/s, waiting for: ${tc.why})`);

// the light crafts and the planes, each flown along +x at a car parked across its way (or a pillar) on the land: met by
// all its boxes (the planes' wings too), never reached into further than a hair
const parked = (id, x, z) => {
  const c = { ...structuredClone(car), id, geo: { ...car.geo, cx: x, cy: z }, detachedPose: { x, y: LAND, z, h: 0, pitch: 0, roll: 0 } };
  T.detachedCars.push(c);
  return solidAt(carShape(c), c.detachedPose);
};
const deepest = (P, solid) => Math.max(...meetShapes(P.type).map((sh) => overlap(solidAt(sh, P.craft().core.pose), solid)));
const fly = async (P, solid, s, input, each = () => {}) => {
  let d = 0, x = -Infinity;
  if (input) P.input(input);
  await run(s, () => { if (P.craft()?.placed) { d = Math.max(d, deepest(P, solid)); x = Math.max(x, P.craft().core.pose.x); each(); } });
  P.s.send({ kind: 'request', request: { kind: 'dropCraft' } });
  return { d, x };
};
const crashed = (P) => () => { if (P.craft().core.flight.state === 'crashed') P.crashed = true; };
const LEVEL = { turn: 0, pitch: 0, throttle: 0.6 };

// a floatplane flown low (its floats 0.1 m over the road) at a parked car, nose on
const car1 = parked(9101, 110, 190);
const E = player('e', 'floatplane', 40, 190, Math.PI / 2, LAND + 1.7, 45);
let r = await fly(E, car1, 3, LEVEL, crashed(E));
check(E.crashed && r.d <= 0.05 && r.x < car1.x,
  `a floatplane flown at a parked car crashes on it, never through (its furthest x ${r.x.toFixed(1)}, the car at ${car1.x}; deepest ${r.d.toFixed(3)} m)`);

// a jet flown past a parked car with only its low wing over it
const car2 = parked(9102, 110, 172);
const jz = 172 + carShape(car).hz + CRAFT_SHAPES.jet.hx + 0.5;
const F = player('f', 'jet', 30, jz, Math.PI / 2, LAND + 1.5, 80);
r = await fly(F, car2, 3, { ...LEVEL, throttle: 1 }, crashed(F));
check(F.crashed && r.d <= 0.05 && r.x < car2.x + car2.hx,
  `a jet flown past a parked car (its fuselage ${(jz - 172 - carShape(car).hz - CRAFT_SHAPES.jet.hx).toFixed(1)} m clear of it) crashes on it with its wing (furthest x ${r.x.toFixed(1)}; deepest ${r.d.toFixed(3)} m)`);

// a floatplane flown past a pillar its fuselage clears by 1.5 m, its wing tip over the pillar
const G = player('g', 'floatplane', 130, PILLAR.z1 + 3, Math.PI / 2, LAND + 1.7, 45);
r = await fly(G, { x: 0, y: 0, z: 0, h: 0, hx: 0, hz: 0, top: 0 }, 3, LEVEL, crashed(G));
check(G.crashed && r.x < PILLAR.x0 && r.x > PILLAR.x0 - 5,
  `a floatplane flown past a pillar (its fuselage clear, its wing tip not) crashes on it (furthest x ${r.x.toFixed(1)}, the pillar from ${PILLAR.x0})`);

// a drone hovering a little under a parked car's roof 3 m short of its side, sent at it at 8 m/s
const car3 = parked(9103, 60, 205);
const H = player('h', 'drone', car3.x - car3.hx - 3, 205, Math.PI / 2, LAND + car3.top * 0.8);
H.input({ roll: 0, pitch: 0, yaw: 0, throttle: DRONE.hover });
await run(0.5);
Object.assign(H.craft().core.flight.velocity, { x: 8, y: 0, z: 0 });
r = await fly(H, car3, 1.5);
check(r.d <= 0.05 && r.x < car3.x - car3.hx,
  `a drone flown at a parked car bounces off it, never through (its furthest x ${r.x.toFixed(2)}, the car's side at ${(car3.x - car3.hx).toFixed(2)}; deepest ${r.d.toFixed(3)} m)`);

// a paraglider gliding in low at a parked car
const car4 = parked(9104, 60, 175);
const I = player('i', 'paraglider', 48, 175, Math.PI / 2, LAND + 1.4, 9);
r = await fly(I, car4, 3, { turn: 0, drive: 0, lift: 0, side: 0 });
check(r.d <= 0.05 && r.x < car4.x - car4.hx,
  `a paraglider gliding at a parked car stops at it, never through (its furthest x ${r.x.toFixed(2)}, the car's side at ${(car4.x - car4.hx).toFixed(2)}; deepest ${r.d.toFixed(3)} m)`);

// the car of the traffic that stopped for D goes on once D has left its lane, at C's hovercraft let down in it
C.put(200, ROAD_Z, Math.PI / 2);
C.input({ turn: 0, drive: 0, lift: 0, side: 0 });
D.s.send({ kind: 'request', request: { kind: 'walk', pose: { x: 150, y: LAND, z: 230, h: 0, moving: false } } });
await run(0.2);
const hc = solidOf(C);
past = -Infinity;
await run(16, () => { if (T.cars.includes(tc)) past = Math.max(past, tc.geo.px - (hc.x - hc.hz)); });
check(T.cars.includes(tc) && past < 0 && tc.v < 0.1 && tc.why === 'craft',
  `a car of the traffic stops for a hovercraft in its lane (its front ${(-past).toFixed(2)} m short, ${tc.v.toFixed(2)} m/s, waiting for: ${tc.why})`);

server.dispose?.();
for (const f of fail) console.log(`FAIL ${f}`);
process.exit(fail.length ? 1 : 0);
