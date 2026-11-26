// The crafts among the solid things, on a synthetic world (a lake with a shore of land, an excursion boat's straight
// tour on it at 10:00 in July, a real host in Node, host/node.ts nodeHost, a few seconds): what a player at the wheel
// would notice, measured on the host's own poses by the shapes the walker meets (sim/solids.ts). A traffic boat under
// way stops before a player's boat lying in its way and goes on once it has gone; a player's boat driven at a moored
// traffic boat and at another player's boat bounces off it and never passes through; a hovercraft driven at a parked
// car stops at it.
// usage (in web/): node tools/craft-solids.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';

const { nodeHost } = await imp('src/host/node.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { carShape, CRAFT_SHAPES, overlap, solidAt, vesselShape } = await imp('src/sim/solids.ts');
const { HOVER_HEIGHT } = await imp('src/sim/craft/craft-motion.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const WATER = 4, LAND = 6, SHORE = 160, TOUR_Z = 60;
const { dir, data } = await synthData({ size: [256, 256], ground: (x, z) => (z < SHORE ? WATER : LAND), surface: (x, z) => (z < SHORE ? 'water' : 'road') });
data.boats = { berths: [], tour: [[30, TOUR_Z], [230, TOUR_Z]] };
const server = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 300, time: { hour: 10, day: 190 } }, data);
const sim = server.sim, T = sim.traffic;

const players = [];
const player = (name, type, x, z, h, y) => {
  const s = server.connect(name), link = sessionLink(s);
  s.send({ kind: 'view', view: { focus: { x: 128, z: 128 } } });
  s.send({ kind: 'request', request: { kind: 'craft', type, spot: { x, y, z, h } } });
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

server.dispose?.();
for (const f of fail) console.log(`FAIL ${f}`);
process.exit(fail.length ? 1 : 0);
