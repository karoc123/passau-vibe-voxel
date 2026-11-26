// Two players over a real WebSocket (src/host/ws.ts on a free port, the page's own client and SocketLink, Node's
// WebSocket) in one world by the cathedral, on the host's clock and the clients' render clocks in real time. The first
// flies a helicopter, the second drives a car of the traffic and makes an edit, then the first walks on foot; each
// must see the other's player (their own id each), the other's craft, car or body moving smoothly (drawn somewhere new
// in nearly every frame), the body gone when its walk ends, and the other's edit in its own live edits. A third player
// stands by the Ingling dam, 3 km off: the first and the third must each have cars of the street life around them and
// be sent nothing of the other's place (no cars, people, crafts: the host's interest filter).
// usage (in web/): node tools/ws-smoke.mjs [-v] [--every N] [--interest M] (the host's ?every=, ?interest=); prints
// PASS with the numbers, or FAIL
import { DATA, hasData, load } from './real-city.mjs';

if (!hasData()) { console.log(`SKIP ws-smoke: no ${DATA}meta.json / traffic.json`); process.exit(0); }
const verbose = process.argv.includes('-v');
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? `&${k}=${process.argv[i + 1]}` : ''; };
const { serve } = await load('host/ws.ts');
const { readHostData } = await load('host/node.ts');
const { MirrorSimClient } = await load('client/sim-client.ts');
const { SocketLink } = await load('client/sim-worker-link.ts');
const { hello } = await load('sim/hello.ts'), { checkBuild } = await load('core/data-contract.ts');
const { frameOf, mapToGrid, cellToAbsZ } = await load('core/layers.ts');
const { STEP } = await load('sim/road-net.ts');
const { easeAvatar } = await load('view/life.ts');

const data = readHostData(DATA), spot = data.meta.labels.find((l) => l.kind === 'cathedral') ?? { x: 8085, y: 2771 };
const focus = { x: spot.x, z: spot.y }, dam = data.meta.labels.find((l) => /Ingling/.test(l.name)) ?? { x: 6105, y: 5207 };
const host = serve({ dir: DATA, host: '127.0.0.1', port: 0, query: `seed=3&dig=1${arg('every')}${arg('interest')}`, log: (l) => { if (verbose) console.log(`  host: ${l}`); } });
const port = await host.port, mine = hello(checkBuild(data.meta, () => {})), fail = [];
const client = () => new MirrorSimClient(new SocketLink(`ws://127.0.0.1:${port}`), structuredClone(data.traffic), null, mine);
const A = client(), B = client(), C = client(), view = { kind: 'view', view: { focus, viewer: { ...focus, y: 30 } } };
const far = { kind: 'view', view: { focus: { x: dam.x, z: dam.y } } };

// the frames: both clients' commands sent and their render clocks moved on, at about 60 fps in real time
// (each client's render clock on the real time between frames, as a page's on its frames' times)
let frames = 0, t0 = performance.now();
const frame = () => new Promise((r) => setTimeout(() => {
  const now = performance.now(), dt = (now - t0) / 1000;
  t0 = now;
  for (const c of [A, B, C]) { c.send(c === C ? far : view); c.update(dt); }
  frames++;
  r();
}, 1000 / 60));
const until = async (what, ok, seconds) => {
  for (let i = 0; i < seconds * 60; i++) { if (ok()) return true; await frame(); }
  fail.push(`${what}: not within ${seconds} s`);
  return false;
};
// how smoothly c draws what pose() gives: the share of frames it is drawn somewhere new, over seconds
async function smooth(pose, seconds, each) {
  let last = null, moved = 0, n = 0, dist = 0;
  for (let i = 0; i < seconds * 60; i++) {
    each?.();
    await frame();
    const p = pose();
    if (!p) continue;
    if (last) { const d = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z); n++; dist += d; if (d > 1e-4) moved++; }
    last = { x: p.x, y: p.y, z: p.z };
  }
  return { share: n ? moved / n : 0, dist };
}

const greeted = await Promise.race([Promise.all([A.hello, B.hello, C.hello]).then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
if (!greeted) fail.push('the hello not taken by both clients');
await until('both players named', () => A.player && B.player, 5);
if (A.player === B.player) fail.push(`both clients are player ${A.player}`);

// A: a helicopter 40 m over the ground by the cathedral, climbing and flying on; B sees it, A's, moving
const sim = host.server.sim, ground = () => sim.traffic.ground?.support(focus.x, focus.z, 1000);
await until('the ground under the cathedral', () => ground() > 0, 10);
A.send({ kind: 'request', request: { kind: 'craft', type: 'helicopter', spot: { x: focus.x, y: ground() + 40, z: focus.z, h: 0 } } });
const heli = () => B.crafts().find((c) => c.pilot === A.player && c.type === 'helicopter');
let fly = null;
if (await until('B sees A\'s helicopter', () => heli(), 10)) {
  let t = 0;
  fly = await smooth(() => heli()?.core.drawn(B.time.alpha), 3,
    () => A.send({ kind: 'seatInput', role: 'pilot', input: { lift: t < 1 ? 1 : 0, drive: (t += 1 / 60) < 1 ? 0 : 1, turn: 0, side: 0 } }));
}

// B: the driver of a car of the traffic near the cathedral (the host loads its road physics at the start); A sees it,
// B's, moving
let car = null, drive = null;
const at = { x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0 };
const near = (c) => (sim.traffic.carPose(c, c.s, c.off, at), Math.hypot(at.x - focus.x, at.z - focus.z) < 300);
await until('a moving car near the cathedral', () => (car = sim.traffic.cars.find((c) => c.v > 1 && !c.bus && near(c))), 10);
if (car) {
  await until('the road physics', () => sim.physics, 30);
  B.send({ kind: 'enterSeat', entity: { kind: 'car', id: car.id }, role: 'driver' });
  if (await until('B drives the car', () => B.driver()?.entityId === car.id, 5)) {
    const pose = { x: 0, y: 0, z: 0, h: 0, pitch: 0, roll: 0 };
    const mirrored = () => A.traffic.roadVehicles().find((c) => c.id === car.id);
    await until('A sees B\'s car as a body', () => mirrored() && A.traffic.bodies.owns(mirrored()), 5);
    drive = await smooth(() => { const c = mirrored(); return c && A.traffic.bodies.owns(c) ? A.traffic.bodies.pose(c, A.time.alpha, pose) : null; }, 3,
      () => B.send({ kind: 'seatInput', role: 'driver', input: { gas: 1, brake: 0, steer: 0, handbrake: false } }));
  }
}

// B: an edit (a sphere into the ground by the cathedral); A's live edits get its nodes
const frameM = frameOf(data.meta), [col, row] = mapToGrid(frameM, Math.floor(focus.x), Math.floor(focus.z));
const op = { kind: 'sphere', col, row, z: cellToAbsZ(frameM, Math.floor(ground())), r: 4, colour: 0 };
let nodes = null;
B.edit(op).then((n) => { nodes = n; }, (e) => fail.push(`B's edit: ${e.message}`));
if (await until('B\'s edit made', () => nodes, 10)) await until('A has B\'s edit', () => nodes.every(([tx, ty]) => A.edits.get(tx, ty)), 3);

// A on foot (the commands the Walk button sends: nav.ts walkBody): put down by the cathedral, then walking east at
// 5 m/s; B draws A's body (as view/life.ts: between its ticks, eased) moving smoothly on its render clock, and no
// more once A stops walking
const g0 = ground(), body = () => B.traffic.avatars.find((a) => a.player === A.player);
let walk = null, gone = false, wx = focus.x;
const walkPose = (moving) => ({ x: wx, y: g0, z: focus.z, h: Math.PI / 2, moving });
A.send({ kind: 'request', request: { kind: 'walk', pose: walkPose(false) } });
let drawn = null;
const drawnA = () => {
  const a = body(), to = a && B.traffic.avatarPose(a, B.time.alpha, { x: 0, y: 0, z: 0, h: 0 });
  drawn = to && (drawn ? easeAvatar(drawn, to, B.time.dt) : to);
  return drawn && { ...drawn };
};
if (await until('B sees A on foot', () => body(), 5)) {
  const step = () => { wx += 5 / 60; A.send({ kind: 'seatInput', role: 'walker', input: walkPose(true) }); };
  // (measured once the first steps can have reached B's render clock: the host and B's lead between)
  await smooth(drawnA, 0.5, step);
  walk = await smooth(drawnA, 2, step);
  if (A.seat()?.entity.kind !== 'avatar') fail.push(`A's seat on foot: ${JSON.stringify(A.seat())}`);
  // (standing: where A stopped, facing east)
  await smooth(drawnA, 0.7, () => A.send({ kind: 'seatInput', role: 'walker', input: walkPose(false) }));
  const a = drawnA();
  if (!a || Math.abs(a.x - wx) > 0.3 || Math.abs(a.z - focus.z) > 0.5 || Math.abs(a.h - Math.PI / 2) > 0.1) fail.push(`A's body drawn by B at ${a && [a.x, a.z, a.h].map((v) => v.toFixed(1))}, A stopped at x ${wx.toFixed(1)} facing east`);
  A.send({ kind: 'leaveSeat' });
  gone = await until('A\'s body gone for B once A stops walking', () => !drawnA(), 3);
}

// the street life round the first player and round the third, each as its own client draws it, none of it in the
// other's
const P = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };
const carsNear = (X, x, z) => X.traffic.cars.filter((c) => (X.traffic.carPose(c, c.s, c.off, P), Math.hypot(P.x - x, P.z - z) < 400)).length;
const peopleNear = (X, x, z) => X.traffic.people.filter((p) => (X.traffic.personPoint(p, 0, P), Math.hypot(P.x - x, P.y - z) < 400)).length;
const life = [carsNear(A, focus.x, focus.z), carsNear(C, dam.x, dam.y)];
if (life.some((n) => n < 3)) fail.push(`cars within 400 m: ${life[0]} by the cathedral (A), ${life[1]} by the dam (C)`);
const strange = [carsNear(C, focus.x, focus.z) + peopleNear(C, focus.x, focus.z) + C.crafts().length, carsNear(A, dam.x, dam.y) + peopleNear(A, dam.x, dam.y)];
if (!arg('interest') && strange.some((n) => n > 0)) fail.push(`sent of the other's place: C ${strange[0]} cars, people and crafts by the cathedral, A ${strange[1]} by the dam`);

const stats = host.stats();
host.close();
const ok = (m, what) => { if (!m) return; if (m.share < 0.9 || m.dist < 1) fail.push(`${what}: drawn somewhere new in ${(m.share * 100).toFixed(0)}% of frames, ${m.dist.toFixed(1)} m in 3 s`); };
ok(fly, 'A\'s helicopter as B draws it');
ok(drive, 'B\'s car as A draws it');
if (walk && (walk.share < 0.9 || walk.dist < 5)) fail.push(`A's body as B draws it: drawn somewhere new in ${(walk.share * 100).toFixed(0)}% of frames, ${walk.dist.toFixed(1)} m in 2 s`);
// (kB a second of the world's time; not checked: a busy machine skips a socket's snapshots while it is backed up.
// --interest 100000 for the bytes unfiltered)
const rate = new Map(stats.bytes.map(([p, b]) => [p, b / 1024 / (stats.ticks * STEP)])), kb = [A, B, C].map((X) => rate.get(X.player) ?? 0);
const line = `3 players over a WebSocket (${life[0]} cars within 400 m of the cathedral, ${life[1]} of the dam 3 km off, ${strange.join(' / ')} of the other's place): A's helicopter seen by B (moved in ${((fly?.share ?? 0) * 100).toFixed(0)}% of frames, ${fly?.dist.toFixed(0)} m), B's car seen by A (${((drive?.share ?? 0) * 100).toFixed(0)}%, ${drive?.dist.toFixed(0)} m), B's edit in A's edits (${nodes?.length ?? 0} node(s)), A on foot seen by B (${((walk?.share ?? 0) * 100).toFixed(0)}%, ${walk?.dist.toFixed(0)} m${gone ? ', gone when A stopped' : ''}); host ${stats.tickMs.toFixed(2)} ms/tick + ${stats.sendMs.toFixed(2)} ms snapshots, ${kb.map((k) => k.toFixed(0)).join(' / ')} kB/s to A / B / C before deflate`;
if (fail.length) { console.log(fail.join('\n')); console.log(`FAIL ws-smoke: ${line}`); process.exit(1); }
console.log(`PASS ws-smoke: ${line}`);
process.exit(0);
