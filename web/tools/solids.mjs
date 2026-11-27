// The walker among the solid things, on a synthetic world (flat ground, no roads: tools/lib.mjs synthData, a real host
// in Node, host/node.ts nodeHost, a few seconds): the page's walk (nav/walk.ts walkFrame) against what its street life
// draws (view/life.ts solids, three.js in Node, no renderer) of the host's world as its snapshots bring it. A car the
// host holds out of the traffic (as one parked or driven by another player is) stops the walker walking at it and
// strafing into it; moved into the walker it shoves it ahead, never through, and squeezing it against a wall pushes it
// out past its side, never leaves it in the car. Another player on foot stops it; a
// hovercraft another player sits in stops it, and so does a traffic boat lying at its pier. On foot A/D step sideways
// (the heading kept) and the arrows turn. A car's roof is jumped onto, walked across and down off, and ridden on when
// the car drives off faster than a walk (the host's walker riding along too); a page walking through a parked car is
// kept out of it on the host; a car another player drives (the road physics) stops at a player on foot and nudges them.
// A train standing at its station stops the walker at its side, a page walking through a coach is kept out of it on
// the host, and a walker dropped onto a coach's roof is carried off with the train, on the host too. A page over a
// lagged link (~133 ms) riding a driven car's roof and a coach's by the gap behind it is seen by the others where it
// stands on it (its input names the spot on the roof, the host puts it there on the thing as the host has it), and a
// spot it names far along the roof is walked to within the walk's bound. A walker on a car's roof driven under a
// footbridge too low for it is swept off in front of the deck, on the page and on the host.
// usage (in web/): node tools/solids.mjs; prints PASS lines, or FAIL and exit 1
import * as THREE from 'three';
import { imp, sessionLink, synthData } from './lib.mjs';

const { nodeHost } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { StreetLife } = await imp('src/view/life.ts');
const { walkFrame, footKeys, stride } = await imp('src/nav/walk.ts');
const { MoveKeys } = await imp('src/nav/move-keys.ts');
const { reach, carShape, solidAt, roofUnder, WALKER_R, WALKER_HEAD, CRAFT_SHAPES, TOUR_B, COACH_SHAPE } = await imp('src/sim/solids.ts');
const { Foot } = await imp('src/nav/foot.ts');
const { WALK_BOUNDS } = await imp('src/sim/walk-bounds.ts');
const { Glide } = await imp('src/nav/glide.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const G = 5;
// a footbridge's deck across z 10..30 at x 180..184, its underside DECK0 over the ground: a car passes under it, a
// walker standing on the car's roof does not
const DECK0 = G + 3, DECK = { x0: 180, x1: 184, z0: 10, z1: 30, y0: DECK0, y1: DECK0 + 1, mat: 'wall' };
const inDeck = (x, z) => x >= DECK.x0 && x < DECK.x1 && z >= DECK.z0 && z < DECK.z1;
const { dir, data } = await synthData({ size: [256, 256], ground: () => G, surface: () => 'earth', boxes: [DECK] });
// an excursion boat lying at its pier (x 181..219, its side at z 216: the tour's start)
data.boats = { berths: [], tour: [[200, 220], [250, 220]] };
// a track along x at z RAIL with a station at x 128: its train of four coaches stands there, from x 96.5 to 159.5,
// from ARRIVED s of the world clock on for 25 s
const RAIL = 240, ARRIVED = 1736, trains = () => [{ p: [[0, RAIL, G], [256, RAIL, G]], svc: [{ ref: 'RB 1', op: 'synthetic', stops: [128] }] }];
data.traffic.trains = trains();
const server = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, interest: 120 }, data);
// the walk's world: flat ground, nothing in the way but a wall west of x 22 for z 90..110 (the voxels are
// tools/collision.mjs's) and the deck
const WALL = 22, wall = (x, z) => x < WALL && z > 90 && z < 110;
const ground = { support: (x, z, top) => (inDeck(x, z) && top >= DECK.y1 ? DECK.y1 : G),
  blocked: (x, z, y0, y1) => wall(x, z) || (inDeck(x, z) && y0 < DECK.y1 && y1 > DECK.y0) };

// a link holding each command UP ticks and each snapshot DOWN (with the tick a command waits for the host's next
// update: a ping of 4 ticks, ~133 ms)
const UP = 1, DOWN = 2;
const lagged = (inner) => {
  const up = [], down = [];
  let now = 0;
  const o = {
    onHello() {}, onSnapshot() {},
    send(c) { up.push([now + UP, c]); },
    close() { inner.close(); },
    deliver() {
      now++;
      while (up.length && up[0][0] <= now) inner.send(up.shift()[1]);
      inner.deliver();
      while (down.length && down[0][0] <= now) o.onSnapshot(down.shift()[1]);
    },
  };
  inner.onHello = (h) => o.onHello(h);
  inner.onSnapshot = (s) => down.push([now + DOWN, structuredClone(s)]);
  return o;
};
const player = (name, x, z, lag = false) => {
  const s = server.connect(name), link = lag ? lagged(sessionLink(s)) : sessionLink(s);
  const c = new MirrorSimClient(new CloneLink(link), { roads: [], peds: [], ctrls: [], trains: trains() }, null, server.hello);
  c.send({ kind: 'view', view: { focus: { x, z } } });
  c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h: 0, moving: false } } });
  return { c, link, s };
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

// the excursion boat lying at its pier, walked at (as from a jetty)
P.x = 200; P.z = 205; yaw = 0;
for (let i = 0; i < 3 / STEP; i++) frame(stride(yaw, 1, 0, 6 * STEP));
const hull = 220 - TOUR_B / 2 - WALKER_R;
check(P.z < hull + 0.01 && P.z > hull - 0.4, `a traffic boat stops the walker (z ${P.z.toFixed(2)}, its side ${hull.toFixed(2)})`);

// a car driven at the walker standing at a wall (along -x at 4 m/s, its front up to the wall): the walker squeezed out
// past the car's side, never left in it
P.x = WALL + 1; P.z = 100; yaw = Math.PI / 2;
const hz = carShape(car).hz;
putCar(WALL + 12, 100, -Math.PI / 2);
for (let i = 0; i < 10; i++) frame(null);
cx = WALL + 12;
for (let i = 0; i < 4 / STEP; i++) { cx = Math.max(WALL + hz, cx - 4 * STEP); putCar(cx, 100, -Math.PI / 2); frame(null); }
for (let i = 0; i < 10; i++) frame(null);
check(inCar() <= 0.01 && !wall(P.x, P.z), `a car driven at the walker against a wall squeezes it out past its side (walker ${P.x.toFixed(2)}, ${P.z.toFixed(2)}; the car's front at ${(cx - hz).toFixed(2)}, the wall at ${WALL}; in it ${Math.max(0, inCar()).toFixed(2)} m)`);

// The walker on a car's roof, on foot as the page walks (nav/foot.ts Foot: the stride, the jump, gravity) among what
// the street life draws: the car parked along x at (60, 40), its roof TOP over the ground
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
const foot = new Foot(camera, { target: new THREE.Vector3() }, new MoveKeys(), new Glide(camera), () => ground, (near) => life.solids(near));
const TOP = carShape(car).top, HX = carShape(car).hx, HZ = carShape(car).hz;
const onRoof = () => Math.abs(foot.feet - G - TOP) < 0.05 && reach(solidAt({ ...carShape(car), top: 9 }, car.detachedPose), foot.pos.x, foot.pos.z, G) > 0;
const fframe = (stick) => {
  for (const p of all) p.c.update(STEP);
  server.update(STEP);
  for (const p of all) p.link.deliver();
  life.update(STEP, 0, foot.pos);
  foot.updateWalk(STEP, stick);
  A.c.send({ kind: 'seatInput', role: 'walker', input: { x: foot.pos.x, y: foot.feet, z: foot.pos.z, h: foot.yaw, moving: !!stick } });
  for (const w of walkers) w.frame();
};
// pages walking besides A's in each frame (C over a lagged link)
const walkers = [];
putCar(60, 40, Math.PI / 2);
foot.setAt(ground, new THREE.Vector3(52, G, 40), [52, 40], true, new THREE.Vector3(1, 0, 0), 0);
for (let i = 0; i < 10; i++) fframe(null);
for (let i = 0; i < 1 / STEP; i++) fframe([1, 0]);
const atSide = foot.pos.x;
foot.jump();
let up = false, across = -Infinity;
for (let i = 0; i < 0.5 / STEP; i++) { fframe([1, 0]); if (onRoof()) { up = true; across = Math.max(across, foot.pos.x - 60); } }
for (let i = 0; i < 1 / STEP; i++) { fframe([1, 0]); if (onRoof()) across = Math.max(across, foot.pos.x - 60); }
for (let i = 0; i < 20; i++) fframe(null);
check(atSide < 60 - HZ && up && across > HZ - 0.5 && foot.pos.x > 60 + HZ && Math.abs(foot.feet - G) < 0.01,
  `the walker jumps onto a parked car's roof (stopped at its end at x ${atSide.toFixed(2)} first), walks across it to ${across.toFixed(2)} m past its middle and down off its far end (x ${foot.pos.x.toFixed(2)}, feet ${(foot.feet - G).toFixed(2)} m up)`);

// back up onto it, standing on its middle; the car then driven off with the walker on top: 30 m/s for 2 s turning 0.3 rad
// a second (faster than any walk the host takes), then stopped
foot.yaw = -Math.PI / 2;
foot.jump();
for (let i = 0; i < 0.5 / STEP; i++) fframe([1, 0]);
for (let i = 0; i < 40 && Math.abs(foot.pos.x - 60) > 0.3; i++) fframe([Math.sign(foot.pos.x - 60), 0]);
for (let i = 0; i < 10; i++) fframe(null);
const rode0 = { x: foot.pos.x - 60, z: foot.pos.z - 40 }, wasOn = onRoof();
let h = Math.PI / 2, rx = 60, rz = 40, off = 0, hostOff = 0;
const hostWalk = () => server.sim.players.get(A.s.player).walk.pose;
for (let i = 0; i < 2 / STEP; i++) {
  h += 0.3 * STEP; rx += Math.sin(h) * 30 * STEP; rz += Math.cos(h) * 30 * STEP;
  putCar(rx, rz, h);
  fframe(null);
  if (!onRoof()) off++;
  // (the host's walker on the host's car: its roof under it but for the tick or two the page sees the car late)
  const w = hostWalk(), d = Math.hypot(w.x - rx, w.z - rz);
  if (d > HZ + 30 * STEP * 3 || Math.abs(w.y - G - TOP) > 0.1) hostOff++;
}
for (let i = 0; i < 20; i++) fframe(null);
const w = hostWalk(), moved = Math.hypot(foot.pos.x - 60, foot.pos.z - 40);
check(wasOn && off <= 2 && onRoof() && moved > 50 && hostOff === 0 && Math.hypot(w.x - foot.pos.x, w.z - foot.pos.z) < 0.5,
  `a car driven off with the walker on its roof carries it along, turning (carried ${moved.toFixed(1)} m, off the roof ${off} frames; the host's walker off its car ${hostOff} ticks, ${Math.hypot(w.x - foot.pos.x, w.z - foot.pos.z).toFixed(2)} m from the page's at the end)`);

// a page that walks through a parked car (a modified one: no solids in its walk), along x at 3 m/s: the host keeps its
// walker out of the car
putCar(60, 40, Math.PI / 2);
for (let i = 0; i < 10; i++) frame(null);
let deepest = -1, hx = 52;
for (let i = 0; i < 5 / STEP; i++) {
  hx += 3 * STEP;
  A.c.send({ kind: 'seatInput', role: 'walker', input: { x: hx, y: G, z: 40, h: Math.PI / 2, moving: true } });
  for (const p of all) p.c.update(STEP);
  server.update(STEP);
  for (const p of all) p.link.deliver();
  const q = hostWalk();
  deepest = Math.max(deepest, reach(solidAt(carShape(car), car.detachedPose), q.x, q.z, q.y));
}
check(deepest <= 0.01, `a page walking through a parked car is kept out of it by the host (its walker at most ${deepest.toFixed(3)} m in it)`);

// B drives the car at A standing still 15 m ahead of it (the road physics in): the car stops at A and only nudges it
// along, never runs through
P.x = 85; P.z = 100; yaw = Math.PI / 2;
putCar(100, 100, -Math.PI / 2);
B.s.send({ kind: 'request', request: { kind: 'walk', pose: { x: 100, y: G, z: 102, h: 0, moving: false } } });
for (let i = 0; i < 10; i++) frame(null);
const wheel = { kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' };
B.s.send(wheel);
for (let i = 0; i < 6; i++) frame(null);
await server.sim.loadPhysics({ x: 100, z: 100 });
B.s.send(wheel);
for (let i = 0; i < 30; i++) { frame(null); await new Promise((r) => setImmediate(r)); }
const driving = server.sim.seat(B.s.player)?.role === 'driver';
B.s.send({ kind: 'seatInput', role: 'driver', input: { gas: 1, brake: 0, steer: 0, handbrake: false } });
let vTop = 0, vNear = 0, was = car.detachedPose.x, through = false;
const startA = P.x;
for (let i = 0; i < 6 / STEP; i++) {
  frame(null);
  await new Promise((r) => setImmediate(r));
  const cx = car.detachedPose.x, v = (was - cx) / STEP;
  was = cx;
  vTop = Math.max(vTop, v);
  const gap = cx - carShape(car).hz - P.x;
  if (gap < 0.3 && i * STEP > 0.5) vNear = Math.max(vNear, v);
  if (P.x > cx) through = true;
}
check(driving && vTop > 5 && vNear < 2.5 && !through && startA - P.x > 1,
  `a driven car (up to ${vTop.toFixed(1)} m/s) stops at a player on foot and nudges them along (at most ${vNear.toFixed(1)} m/s touching them; shoved ${(startA - P.x).toFixed(1)} m${through ? ', passed through' : ''})`);

// The train standing at its station (the world clock put just after it came in): walked at across the track from
// the south at x 133 (a coach's middle third), the walker stops at its side on the page and on the host
server.sim.traffic.t = ARRIVED + 1;
const coachAt = (k, q) => reach(solidAt({ ...COACH_SHAPE, top: 9 }, { x: k.x, y: k.y, z: k.z, h: k.heading }), q.x, q.z, k.y);
const hostCoaches = () => server.sim.traffic.trains.coaches();
foot.setAt(ground, new THREE.Vector3(133, G, RAIL - 8), [133, RAIL - 8], true, new THREE.Vector3(0, 0, 1), 0);
// (the host's walker brought over from the last scene within its walk bound)
for (let i = 0; i < 90; i++) fframe(null);
for (let i = 0; i < 2 / STEP; i++) fframe([1, 0]);
const railSide = RAIL - COACH_SHAPE.hx - WALKER_R, hw = hostWalk();
check(foot.pos.z < railSide + 0.01 && foot.pos.z > railSide - 0.4 && Math.abs(hw.z - foot.pos.z) < 0.05,
  `a train standing at its station stops the walker at its side (z ${foot.pos.z.toFixed(2)}, the host's ${hw.z.toFixed(2)}, its side ${railSide.toFixed(2)})`);
// a page walking through a standing coach (no solids in its walk), across at 3 m/s: kept out of it by the host
deepest = -1;
let wz = RAIL - 6;
for (let i = 0; i < 4 / STEP; i++) {
  wz += 3 * STEP;
  A.c.send({ kind: 'seatInput', role: 'walker', input: { x: 133, y: G, z: wz, h: 0, moving: true } });
  for (const p of all) p.c.update(STEP);
  server.update(STEP);
  for (const p of all) p.link.deliver();
  const q = hostWalk();
  for (const k of hostCoaches()) deepest = Math.max(deepest, reach(solidAt(COACH_SHAPE, { x: k.x, y: k.y, z: k.z, h: k.heading }), q.x, q.z, q.y));
}
check(deepest <= 0.01, `a page walking through a train's coach is kept out of it by the host (its walker at most ${deepest.toFixed(3)} m in it)`);
// C: a page over a lagged link (UP, DOWN), walking as A's does among what its own street life draws. Riding a roof
// it sees the carrier late; what the others see (the host's walker on the host's carrier, as each snapshot brings
// both): how far along and across the roof it is from where its page stands on it, and the ticks it is off the roof
const C = player('c', 104, RAIL - 60, true), lifeC = new StreetLife(new THREE.Scene(), C.c);
const footC = new Foot(camera, { target: new THREE.Vector3() }, new MoveKeys(), new Glide(camera), () => ground, (near) => lifeC.solids(near));
all.push(C);
// (cheat: a spot of its own C's page sends instead of where it stands, once)
let cheat = null;
walkers.push({ frame() {
  lifeC.update(STEP, 0, footC.pos);
  footC.updateWalk(STEP, null);
  if (cheat) { C.c.send({ kind: 'seatInput', role: 'walker', input: { x: footC.pos.x, y: footC.feet, z: footC.pos.z, h: footC.yaw, moving: false, roof: cheat } }); cheat = null; return; }
  C.c.send({ kind: 'seatInput', role: 'walker', input: { x: footC.pos.x, y: footC.feet, z: footC.pos.z, h: footC.yaw, moving: false, ...(footC.roof() ? { roof: footC.roof() } : {}) } });
} });
const hostWalkOf = (p) => server.sim.players.get(p.s.player).walk.pose;
// the roof C's page stands on and the same thing as the host has it (hostSolid(id)): C along (u) and across (v) it on
// each, and whether the host's walker is on that roof
const roofOffset = (hostSolid) => {
  const pg = roofUnder(lifeC.solids(footC.pos), footC.pos.x, footC.pos.z, footC.feet + 0.05, 0), q = hostWalkOf(C), hs = pg && hostSolid(pg.id);
  if (!hs) return null;
  const local = (s, x, z) => { const c = Math.cos(s.h), n = Math.sin(s.h), dx = x - s.x, dz = z - s.z; return { v: dx * c - dz * n, u: dx * n + dz * c }; };
  const a = local(pg, footC.pos.x, footC.pos.z), b = local(hs, q.x, q.z);
  return { d: Math.hypot(b.u - a.u, b.v - a.v), u: b.u, on: Math.abs(b.v) <= hs.hx && Math.abs(b.u) <= hs.hz && Math.abs(q.y - hs.y - hs.top) < 0.1 };
};
const dropC = (x, y, z) => {
  footC.fallAt({ x, y, z }, { x: 0, y: 0, z: 0 }, 0);
  C.c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y, z, h: 0, moving: false } } });
};
// a car of its own (another detached one), parked at (104, RAIL - 60) along -z; C dropped onto its roof, then the car
// driven off at 30 m/s for 2 s turning 0.3 rad a second
const car2 = { ...car, id: 9002, detachedPose: { x: 104, y: G, z: RAIL - 60, h: Math.PI, pitch: 0, roll: 0 } };
server.sim.traffic.detachedCars.push(car2);
dropC(104, G + carShape(car2).top + 0.5, RAIL - 60);
for (let i = 0; i < 40; i++) fframe(null);
const carOn = (id) => id === 'car9002' ? solidAt(carShape(car2), car2.detachedPose) : null;
const rideStats = () => ({ most: 0, off: 0, seen: 0 });
const carRide = rideStats();
{
  let h = Math.PI, x = 104, z = RAIL - 60;
  for (let i = 0; i < 2 / STEP; i++) {
    h += 0.3 * STEP; x += Math.sin(h) * 30 * STEP; z += Math.cos(h) * 30 * STEP;
    car2.detachedPose = { x, y: G, z, h, pitch: 0, roll: 0 };
    fframe(null);
    const o = roofOffset(carOn);
    if (!o) continue;
    carRide.seen++; carRide.most = Math.max(carRide.most, o.d); if (!o.on) carRide.off++;
  }
}
server.sim.traffic.detachedCars.splice(server.sim.traffic.detachedCars.indexOf(car2), 1);

// dropped onto the coach's roof (as off a bridge) and the train left to go: carried along on the page and on the host,
// till it is well on its way (at 20 s past its leaving: ~16 m/s)
foot.fallAt({ x: 133, y: G + 6, z: RAIL }, { x: 0, y: 0, z: 0 }, Math.PI / 2);
// (C onto the second coach from the back near its rear end, over the gap behind: the train leaves along +x)
const second = [...hostCoaches()].sort((a, b) => a.x - b.x)[1];
dropC(second.x - COACH_SHAPE.hz + 0.6, G + 6, RAIL);
for (let i = 0; i < 30; i++) fframe(null);
const coachOn = (id) => { const k = hostCoaches().find((c) => `coach${c.id}` === id); return k && solidAt(COACH_SHAPE, { x: k.x, y: k.y, z: k.z, h: k.heading }); };
const trainRide = rideStats();
// (over a coach, its feet on the roof)
const onCoach = (q, feet, list) => list.some((k) => coachAt(k, q) > 0 && Math.abs(feet - k.y - COACH_SHAPE.top) < 0.1);
const rideFrom = foot.pos.x, upFirst = onCoach(foot.pos, foot.feet, [...A.c.traffic.trains.coaches()]);
let pageOff = 0, hostOffTrain = 0, ticks = 0;
while (server.sim.traffic.t < ARRIVED + 45) {
  fframe(null);
  ticks++;
  if (!onCoach(foot.pos, foot.feet, [...A.c.traffic.trains.coaches()])) pageOff++;
  const q = hostWalk();
  if (!onCoach(q, q.y, hostCoaches())) hostOffTrain++;
  const o = roofOffset(coachOn);
  if (o) { trainRide.seen++; trainRide.most = Math.max(trainRide.most, o.d); if (!o.on) trainRide.off++; }
}
const rides = (r) => `${r.most.toFixed(2)} m, off the roof ${r.off} of ${r.seen} ticks`;
check(carRide.seen > 50 && trainRide.seen > 800 && carRide.most < 0.3 && trainRide.most < 0.3 && carRide.off === 0 && trainRide.off === 0,
  `over a ${(UP + 1 + DOWN) * STEP * 1000 | 0} ms link others see a walker riding a roof where its page has it on it: on a car driven at 30 m/s at most ${rides(carRide)}; on a coach by the gap behind it at most ${rides(trainRide)}`);
// the page names a spot at the coach's far end (19 m along): the host walks it there at no more than the walk's bound
const sp = footC.roof(), coachC = sp && coachOn(sp.id);
let u0 = coachC && roofOffset(coachOn)?.u, jump = 0;
cheat = sp && { ...sp, u: COACH_SHAPE.hz - 0.5 };
for (let i = 0; i < 6; i++) {
  fframe(null);
  const u = roofOffset(coachOn)?.u;
  if (u !== undefined && u0 !== undefined) jump = Math.max(jump, Math.abs(u - u0));
  u0 = u;
}
const limit = WALK_BOUNDS.speed * STEP + WALK_BOUNDS.slack;
check(sp && jump > 0.5 && jump <= limit + 0.01, `a page naming a spot at the far end of the coach's roof is walked there at most ${jump.toFixed(2)} m in a tick (the walk's bound ${limit.toFixed(2)})`);
const rode = foot.pos.x - rideFrom, lastW = hostWalk();
// (the host's walker within two ticks of the train's way at full speed of the page's: the page sees the train late)
check(upFirst && rode > 100 && pageOff === 0 && hostOffTrain === 0 && Math.hypot(lastW.x - foot.pos.x, lastW.z - foot.pos.z) < 32 * STEP,
  `a walker on a coach's roof rides off with the train (carried ${rode.toFixed(1)} m; off its roof ${pageOff} of ${ticks} frames, the host's walker ${hostOffTrain} ticks, ${Math.hypot(lastW.x - foot.pos.x, lastW.z - foot.pos.z).toFixed(2)} m from the page's at the end)`);

// C dropped onto a car's roof, the car then driven along +x at 20 m/s under the footbridge's deck (low enough for the
// car, not for the walker standing on it): the walker is swept off its roof in front of the deck, on the page and on
// the host (as the others see it), never carried into the deck or through it
const car3 = { ...car, id: 9003, detachedPose: { x: 150, y: G, z: 20, h: Math.PI / 2, pitch: 0, roll: 0 } };
server.sim.traffic.detachedCars.push(car3);
dropC(150, G + carShape(car3).top + 0.5, 20);
for (let i = 0; i < 40; i++) { fframe(null); await new Promise((r) => setImmediate(r)); }
const hostWorld = server.sim.ground, inWall = (q) => hostWorld.blocked(q.x, q.z, q.y + 0.05, q.y + WALKER_HEAD);
const rodeOn = Math.abs(footC.feet - G - carShape(car3).top) < 0.05;
let hostIn = 0, pageIn = 0, past = 0;
for (let x = 150; x < 230; ) {
  x += 20 * STEP;
  car3.detachedPose = { ...car3.detachedPose, x };
  fframe(null);
  const q = hostWalkOf(C);
  if (inWall(q)) hostIn++;
  if (ground.blocked(footC.pos.x, footC.pos.z, footC.feet + 0.05, footC.feet + WALKER_HEAD)) pageIn++;
  if (q.x > DECK.x0 || footC.pos.x > DECK.x0) past++;
}
for (let i = 0; i < 30; i++) fframe(null);
server.sim.traffic.detachedCars.splice(server.sim.traffic.detachedCars.indexOf(car3), 1);
const qC = hostWalkOf(C), known = hostWorld.blocked(181, 20, DECK0, DECK0 + 1);
check(known && rodeOn && hostIn === 0 && pageIn === 0 && past === 0 && Math.abs(footC.feet - G) < 0.05 && Math.abs(qC.y - G) < 0.05 && footC.pos.x > DECK.x0 - 2 && Math.hypot(qC.x - footC.pos.x, qC.z - footC.pos.z) < 0.5,
  `a walker on a car's roof driven under a footbridge too low for it is swept off in front of the deck (the page at x ${footC.pos.x.toFixed(2)}, feet ${(footC.feet - G).toFixed(2)} m up; the host's ${qC.x.toFixed(2)}, ${(qC.y - G).toFixed(2)} m up; in the deck: the host's ${hostIn} ticks, the page's ${pageIn}; past its front ${past} ticks${known ? '' : '; the host has no deck'})`);

server.dispose?.();
for (const f of fail) console.log(`FAIL ${f}`);
process.exit(fail.length ? 1 : 0);
