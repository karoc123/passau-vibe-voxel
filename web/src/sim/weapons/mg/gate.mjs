// The machine gun's gate, on a small synthetic world (no city data, a second or so): through the real host
// (WorldSim, SimServer, a client per player over a CloneLink, so commands cross as JSON and snapshots as clones) a
// player on foot fires at a wall and at another player's body; the shots stop there, at most at the MG's rate, only on
// foot; a player near sees them, one far off does not; the world's voxels stay as they were; the view draws them.
// Then on node files a real host reads (tools/lib.mjs synthData, host/node.ts nodeHost): the first shot of a player
// put down in a part of the world no ray has asked for stops at the wall there (the host keeps the voxels round a
// player on foot loaded; a node read only when a ray first meets it let that shot through).
// usage (in web/): node src/sim/weapons/mg/gate.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData, wallTick } from '../../../../tools/lib.mjs';

const { WorldSim } = await imp('src/sim/world-sim.ts');
const { SimServer } = await imp('src/sim/server/sim-server.ts');
const { sandbox } = await imp('src/sim/modes/sandbox.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { hello } = await imp('src/sim/hello.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { weaponIn } = await imp('src/sim/weapons/index.ts');
const { EYE } = await imp('src/sim/figure.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));

// the world: flat ground at y 0, a wall 2 m thick and 10 m high from x 20 to 22 (map metres, y up)
const WALL = 20;
let voxelReads = 0;
const solid = (x, y, z) => (voxelReads++, y < 0 || (x >= WALL && x < WALL + 2 && y < 10 && Math.abs(z) < 50));
const world = {
  surface: () => 0, support: () => 0,
  raycast(o, d, max) { for (let t = 0; t < max; t += 0.01) if (solid(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t)) return t; return Infinity; },
};
const traffic = () => ({ roads: [], peds: [], ctrls: [] });
const sim = new WorldSim(traffic());
sim.setWorld(world, null, world);
const server = new SimServer(sim, sandbox(), null, { nodes: () => [], ready: async () => () => {} });
server.interest = 200;
server.trackEdits();
let edits = 0;

const player = (name, x, z, h) => {
  const s = server.connect(name), link = sessionLink(s), c = new MirrorSimClient(new CloneLink(link), traffic(), null, hello(null));
  const take = link.onSnapshot;
  link.onSnapshot = (snap) => { edits += snap.edits.length; take(snap); };
  c.send({ kind: 'view', view: { focus: { x, z } } });
  c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: 0, z, h, moving: false } } });
  return { c, link, x, z, h };
};
const A = player('a', 0, 0, Math.PI / 2), B = player('b', 5, 6, 0), C = player('c', 1000, 0, 0);
const all = [A, B, C];
// (a client sends its commands on its frame: each tick follows one)
const tick = () => { for (const p of all) p.c.update(STEP); server.update(STEP); for (const p of all) p.link.deliver(); };
for (let i = 0; i < 3; i++) tick();
check(all.every((p) => p.c.seat()?.role === 'walker'), 'three players on foot');

const shots = (c, since) => c.eventsSince(since).filter((e) => e.kind === 'shot');
const near = (a, b, d = 0.05) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < d;

// A fires along +x, level: at the wall's face, at the eyes' height
let t0 = sim.tick;
A.c.send({ kind: 'fire', slot: 1, h: Math.PI / 2, pitch: 0 });
tick();
let s = shots(A.c, t0);
check(s.length === 1 && s[0].hit === 'world' && s[0].weapon === 'mg' && s[0].player === 'a' && near(s[0].to, { x: WALL, y: EYE, z: 0 }) && near(s[0].at, { x: 0, y: EYE, z: 0 }),
  `a shot along +x stops at the wall (${JSON.stringify(s[0]?.to)}, ${s[0]?.hit})`);
check(shots(B.c, t0).length === 1, 'B, 8 m away, sees A\'s shot');
check(shots(C.c, t0).length === 0, 'C, 1 km away, is not sent it');

// at B's body (5 m east, 6 m south): it stops at B, not at the wall behind
t0 = sim.tick;
A.c.send({ kind: 'fire', slot: 1, h: Math.atan2(5, 6), pitch: -0.1 });
tick();
s = shots(B.c, t0);
check(s.length === 1 && s[0].hit?.kind === 'avatar' && Math.hypot(s[0].to.x - 5, s[0].to.z - 6) < 0.6, `a shot at B's body hits it (${JSON.stringify(s[0]?.hit)})`);

// up into the sky: nothing, 300 m out (after a pause: two shots spent the trigger's burst)
for (let i = 0; i < 5; i++) tick();
t0 = sim.tick;
A.c.send({ kind: 'fire', slot: 1, h: 0, pitch: 1 });
tick();
s = shots(A.c, t0);
check(s.length === 1 && s[0].hit === null && Math.abs(Math.hypot(s[0].to.x - s[0].at.x, s[0].to.y - s[0].at.y, s[0].to.z - s[0].at.z) - 300) < 0.01, `a shot into the sky goes 300 m and hits nothing (${JSON.stringify(s[0])})`);

// held for 3 s, a command every frame (60 a second, bunched two to a tick): at most the MG's rate
for (let i = 0; i < 30; i++) tick(); // (the trigger full again)
t0 = sim.tick;
const rate = weaponIn(1).rate;
for (let i = 0; i < 90; i++) { A.c.send({ kind: 'fire', slot: 1, h: Math.PI / 2, pitch: 0 }); A.c.send({ kind: 'fire', slot: 1, h: Math.PI / 2, pitch: 0 }); tick(); }
const n = shots(A.c, t0).length, most = rate * 90 * STEP + 2;
check(n >= rate * 90 * STEP - 1 && n <= most, `a held trigger fires ${n} shots in 3 s (rate ${rate}/s, at most ${most})`);

// a slot that is none, a pitch that is no number: nothing
t0 = sim.tick;
for (let i = 0; i < 10; i++) tick();
for (const cmd of [{ slot: 0, h: 0, pitch: 0 }, { slot: 7, h: 0, pitch: 0 }, { slot: 1, h: 0, pitch: null }]) A.c.send({ kind: 'fire', ...cmd });
tick();
check(A.c.eventsSince(t0).every((e) => !('weapon' in e)), 'no slot, a broken aim: no shot');

// off foot: no shot
A.c.send({ kind: 'leaveSeat' });
tick();
t0 = sim.tick;
for (let i = 0; i < 10; i++) tick();
A.c.send({ kind: 'fire', slot: 1, h: Math.PI / 2, pitch: 0 });
tick(); tick();
check(A.c.seat() === null && shots(A.c, t0).length === 0, 'off foot the MG does not fire');

// the MG breaks no blocks (no edit made, no node changed)
check(edits === 0, 'no node of the world edited');

// the view: a shot drawn as a flash, a tracer and sparks, all gone a second later (three.js in Node, no renderer)
const THREE = await imp('node_modules/three/build/three.module.js');
const { WeaponsView } = await imp('src/view/weapons/weapons-view.ts');
const scene = new THREE.Scene(), v = new WeaponsView(scene, B.c);
const VIEW_EYE = new THREE.Vector3();
const shown = () => { let k = 0; scene.traverse((o) => { if (o.visible && (o.isMesh || o.isPoints) && (o.isPoints ? o.geometry.drawRange.count > 0 : true)) k++; }); return k; };
const before = shown();
B.c.send({ kind: 'request', request: { kind: 'walk', pose: { x: 5, y: 0, z: 6, h: 0, moving: false } } });
tick(); v.update(1 / 60, [], VIEW_EYE);
A.c.send({ kind: 'request', request: { kind: 'walk', pose: { x: 0, y: 0, z: 0, h: 0, moving: false } } });
tick(); tick(); v.update(1 / 60, [], VIEW_EYE);
A.c.send({ kind: 'fire', slot: 1, h: Math.PI / 2, pitch: 0 });
tick();
v.update(1 / 60, [], VIEW_EYE);
const during = shown();
for (let i = 0; i < 60; i++) v.update(1 / 60, [], VIEW_EYE);
check(during > before && shown() === before, `the view draws a shot of another player (${during - before} things shown) and lets it go`);

// a fresh part of the world: a wall 2 m thick at x 200..202, ground up to y 5; the player put down 30 m before it,
// shooting at once (a few ticks: the host's clock, the node files read between them); with the network host's files
// read off the thread, a shot fired at once waits for them on the host's 33 ms ticks
for (const offThread of [false, true]) {
  const { nodeHost } = await imp('src/host/node.ts');
  const G = 5, X = 200;
  const { dir, data } = await synthData({ size: [384, 256], ground: () => G, boxes: [{ x0: X, x1: X + 2, z0: 0, z1: 256, y0: G, y1: G + 10, mat: 'wall' }] });
  const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, offThread }, data), s = host.connect('f'), link = sessionLink(s);
  const c = new MirrorSimClient(new CloneLink(link), traffic(), null, host.hello);
  const step = async () => { c.update(STEP); host.update(STEP); link.deliver(); await (offThread ? wallTick() : new Promise((r) => setImmediate(r))); };
  c.send({ kind: 'request', request: { kind: 'walk', pose: { x: X - 30, y: G, z: 100, h: Math.PI / 2, moving: false } } });
  // (off the thread: fired in the walk's own tick, before any of its nodes can be in)
  if (!offThread) for (let i = 0; i < 3; i++) await step();
  const t = host.sim.tick;
  c.send({ kind: 'fire', slot: 1, h: Math.PI / 2, pitch: 0 });
  let s0;
  for (let i = 0; i < 20 && !s0; i++) { await step(); s0 = c.eventsSince(t).find((e) => e.kind === 'shot'); }
  check(c.seat()?.role === 'walker' && s0?.hit === 'world' && Math.abs(s0.to.x - X) < 0.05,
    `the first shot in a fresh part of the world stops at its wall${offThread ? ' (the files read off the thread: it waits for them)' : ''} (${JSON.stringify(s0?.to)}, ${s0?.hit})`);
  host.dispose();
}

if (fail.length) { for (const f of fail) console.log(`FAIL ${f}`); process.exit(1); }
console.log('PASS weapon mg');
