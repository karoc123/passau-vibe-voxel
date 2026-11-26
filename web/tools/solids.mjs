// The walker among the solid things, on a synthetic world (flat ground, no roads: tools/lib.mjs synthData, a real host
// in Node, host/node.ts nodeHost, a few seconds): the page's walk (nav/walk.ts walkFrame) against what its street life
// draws (view/life.ts solids, three.js in Node, no renderer) of the host's world as its snapshots bring it. A car the
// host holds out of the traffic (as one parked or driven by another player is) stops the walker walking at it and
// strafing into it; moved into the walker it shoves it ahead, never through. Another player on foot stops it; a
// hovercraft another player sits in stops it. On foot A/D step sideways (the heading kept) and the arrows turn.
// usage (in web/): node tools/solids.mjs; prints PASS lines, or FAIL and exit 1
import * as THREE from 'three';
import { imp, sessionLink, synthData } from './lib.mjs';

const { nodeHost } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { StreetLife } = await imp('src/view/life.ts');
const { walkFrame, footKeys, stride } = await imp('src/nav/walk.ts');
const { MoveKeys } = await imp('src/nav/move-keys.ts');
const { reach, carShape, solidAt, WALKER_R, CRAFT_SHAPES } = await imp('src/sim/solids.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const G = 5;
const { dir, data } = await synthData({ size: [256, 256], ground: () => G, surface: () => 'earth' });
const server = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 120 }, data);
// the walk's world: flat ground, nothing in the way (the voxels are tools/collision.mjs's)
const ground = { support: () => G, blocked: () => false };

const player = (name, x, z) => {
  const s = server.connect(name), link = sessionLink(s);
  const c = new MirrorSimClient(new CloneLink(link), { roads: [], peds: [], ctrls: [] }, null, server.hello);
  c.send({ kind: 'view', view: { focus: { x, z } } });
  c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h: 0, moving: false } } });
  return { c, link };
};
const A = player('a', 40, 128), B = player('b', 90, 160), all = [A, B];
const life = new StreetLife(new THREE.Scene(), A.c);

// a car the host holds out of the traffic, put and moved by the tool (as a driven body moves one)
const car = { kind: 'car', id: 9001, e: 0, lane: 0, s: 0, ds: 0, off: 0, dOff: 0, prev: -1, prevOff: 0, next: -1, len: 4.6, bus: false,
  col: '#888888', brake: 0, v: 0, wait: 0, why: 'free', by: null, block: null, geo: { px: 0, py: 0, cx: 0, cy: 0, z: 0, fx: 0, fy: 1 } };
const putCar = (x, z, h) => { car.detachedPose = { x, y: G, z, h, pitch: 0, roll: 0 }; };
putCar(46, 128, 0);
server.sim.traffic.detachedCars.push(car);

// a frame: the host's tick, the snapshots, the client's render clock and the street life drawn; then the walk
const P = { x: 40, z: 128 };
let yaw = Math.PI / 2;
const frame = (m) => {
  for (const p of all) p.c.update(STEP);
  server.update(STEP);
  for (const p of all) p.link.deliver();
  life.update(STEP, 0, P);
  const moved = walkFrame(ground, P, G, m, life.solids(P));
  A.c.send({ kind: 'seatInput', role: 'walker', input: { x: P.x, y: G, z: P.z, h: yaw, moving: moved } });
  return moved;
};
// how far the walker is in the car as the host has it now (> 0: in it)
const inCar = () => reach(solidAt(carShape(car), car.detachedPose), P.x, P.z, G);
for (let i = 0; i < 10; i++) frame(null);
check(A.c.seat()?.role === 'walker' && life.solids(P).some((s) => Math.abs(s.x - 46) < 0.01), 'on foot, the parked car among the solids the page draws');

// walking at the parked car (facing +x, 6 m/s for 3 s): stopped at its side, never in it
let most = -1;
for (let i = 0; i < 3 / STEP; i++) { frame(stride(yaw, 1, 0, 6 * STEP)); most = Math.max(most, inCar()); }
const side = 46 - carShape(car).hx - WALKER_R;
check(P.x < side + 0.01 && P.x > side - 0.4 && most <= 0.01, `walking at a parked car stops at its side (x ${P.x.toFixed(2)}, its side ${side.toFixed(2)}, deepest ${most.toFixed(3)} m)`);

// strafing: A/D step sideways, the heading kept; the arrows turn
const K = new MoveKeys();
K.add(MoveKeys.of('KeyD'));
const d = footKeys(K);
K.clear(); K.add(MoveKeys.of('ArrowRight'));
const t = footKeys(K);
check(d.side === 1 && d.turn === 0 && t.turn === 1 && t.side === 0 && K.turn() === 1, `on foot D steps right (side ${d.side}, turn ${d.turn}), the right arrow turns (turn ${t.turn}); off foot both turn`);
const z0 = P.z, x0 = P.x;
P.x -= 2;
for (let i = 0; i < 1 / STEP; i++) frame(stride(yaw, d.go, d.side, 6 * STEP));
check(Math.abs(P.x - (x0 - 2)) < 1e-9 && P.z - z0 > 5.9 && P.z - z0 < 6.1, `D strafes: 6 m to the right of the heading (+z facing +x: dz ${(P.z - z0).toFixed(2)}, dx ${(P.x - x0 + 2).toFixed(3)})`);
// strafing into the car's side (facing +z, right is -x): stopped there
P.x = 50; P.z = 128;
yaw = 0;
most = -1;
for (let i = 0; i < 2 / STEP; i++) { frame(stride(yaw, 0, 1, 6 * STEP)); most = Math.max(most, inCar()); }
const other = 46 + carShape(car).hx + WALKER_R;
check(most <= 0.01 && P.x > other - 0.01 && P.x < other + 0.4, `strafing into the car stops at its side (x ${P.x.toFixed(2)}, its side ${other.toFixed(2)}, deepest ${most.toFixed(3)} m)`);

// a car driven at the walker standing still (from +x along -x at 8 m/s for 3.5 s): shoved ahead, never passed through
P.x = 40; P.z = 128; yaw = Math.PI / 2;
putCar(60, 128, -Math.PI / 2);
for (let i = 0; i < 10; i++) frame(null);
const start = P.x;
most = -1;
let cx = 60;
for (let i = 0; i < 3.5 / STEP; i++) { cx -= 8 * STEP; putCar(cx, 128, -Math.PI / 2); frame(null); most = Math.max(most, inCar()); }
// (what the page draws is a tick or two behind the host: the walker is clear of that, within a stride of the host's)
for (let i = 0; i < 10; i++) frame(null);
const front = cx - carShape(car).hz;
check(P.x < front && P.x > front - 1 && start - P.x > 5 && most < 8 * STEP * 3 + 0.05,
  `a moving car shoves the walker ahead of it (walker x ${P.x.toFixed(2)}, the car's front ${front.toFixed(2)}, shoved ${(start - P.x).toFixed(1)} m, at most ${most.toFixed(2)} m behind the host's car)`);

// another player on foot: walked at, stopped by
P.x = 80; P.z = 160; yaw = Math.PI / 2;
for (let i = 0; i < 10; i++) frame(null);
for (let i = 0; i < 2 / STEP; i++) frame(stride(yaw, 1, 0, 6 * STEP));
check(P.x < 90 - 2 * WALKER_R + 0.01 && P.x > 90 - 2 * WALKER_R - 0.4, `another player on foot stops the walker (x ${P.x.toFixed(2)}, B at 90)`);

// a hovercraft another player sits in
B.c.send({ kind: 'request', request: { kind: 'craft', type: 'hovercraft', spot: { x: 150, y: G + 1, z: 60, h: 0 } } });
for (let i = 0; i < 60; i++) frame(null);
const hc = A.c.crafts().find((c) => c.type === 'hovercraft');
P.x = 140; P.z = 60; yaw = Math.PI / 2;
for (let i = 0; i < 3 / STEP; i++) frame(stride(yaw, 1, 0, 6 * STEP));
const hp = hc?.core.pose;
const hside = hp && hp.x - CRAFT_SHAPES.hovercraft.hx - WALKER_R;
check(hp && P.x < hside + 0.01 && P.x > hside - 0.4, `a hovercraft stops the walker (x ${P.x.toFixed(2)}, the craft at ${hp?.x.toFixed(2)})`);

server.dispose?.();
for (const f of fail) console.log(`FAIL ${f}`);
process.exit(fail.length ? 1 : 0);
