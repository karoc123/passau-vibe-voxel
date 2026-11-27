// The enemy plane (sim/pilot-mind.ts, its camp's call in sim/camps.ts, its pilot and its shots in sim/world-sim.ts)
// through a real host in Node (host/node.ts nodeHost, a client over a CloneLink) on a synthetic world: a camp on a hill,
// a second hill, a hut, flat land round them. The camp's alarm calls a plane, which appears out of every player's
// sight and unseen by their page; on a player standing in the open it makes at least three passes in two minutes,
// pauses between them, and its fire hurts them; the same player in the hut takes no harm. 25 MG hits leave it flying,
// the 26th makes it a wreck that comes down, stays down and fires no more, and the camp calls none before its refill;
// its pilot is no player: the camp sleeps once the player is far though the plane is near. Fifteen minutes of passes
// at a player by the second hill without the plane hitting the ground; on the real data (when there) the Oberhaus's
// plane hurts a player in the open north of it. Printed: the host's cost a tick and the bytes
// a player gets of it.
// usage (in web/): node tools/pilot.mjs; prints PASS lines, or FAIL and exit 1
import zlib from 'node:zlib';
import { imp, sessionLink, synthData } from './lib.mjs';
import { DATA, hasData } from './real-city.mjs';

const { nodeHost, readHostData } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');
const { weaponById } = await imp('src/sim/weapons/index.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));
const settle = () => new Promise((r) => setImmediate(r));
const K = DEFAULT_TUNING.pilot, MG = weaponById('mg');
// (the host's clock, which paces its crafts' tile fetches, runs with the simulated ticks: as fast as this runs, a
// plane would otherwise wait for its tiles; the costs are timed on the real one)
const realNow = performance.now.bind(performance);
let simMs = 0;
performance.now = () => simMs;

// the camp C on a hill 60 m high; a second hill B 80 m high; the open spot S between; a hut (walls and a roof) at U
const G = 5, SIZE = 2816, C = { x: 1408.5, z: 1408.5 }, B = { x: 2000, z: 1700 }, S = { x: 1760.5, z: 1500.5 }, U = { x: 1060.5, z: 1500.5 };
const cone = (x, z, p, top, r, flat) => Math.max(0, Math.min(top, top * (r - Math.hypot(x - p.x, z - p.z)) / (r - flat)));
const ground = (x, z) => Math.round(G + Math.max(cone(x, z, C, 60, 300, 40), cone(x, z, B, 80, 260, 20)));
const ux = Math.floor(U.x), uz = Math.floor(U.z);
const HUT = [[-4, -4, 4, -3], [-4, 3, 4, 4], [-4, -3, -3, 3], [3, -3, 4, 3]].map(([a, b, c, d]) => ({ x0: ux + a, z0: uz + b, x1: ux + c, z1: uz + d, y0: G, y1: G + 4, mat: 'wall' }));
HUT.push({ x0: ux - 4, z0: uz - 4, x1: ux + 4, z1: uz + 4, y0: G + 4, y1: G + 5, mat: 'wall' });
const { dir, data } = await synthData({ size: [SIZE, SIZE], ground, surface: () => 'earth', boxes: HUT });
const camp = { name: 'test', x: C.x, z: C.z, h: -Math.PI / 2 };
// (a camp of one, quickly asleep; the players stand through every hit, so the passes can be counted; a long run's
// tank lasts)
const H = DEFAULT_TUNING.health;
const tuning = (long) => ({ ...DEFAULT_TUNING, camps: { ...DEFAULT_TUNING.camps, squad: [1], wake: 300, sleep: 400, unseen: 80 },
  health: { ...H, player: { ...H.player, max: 1e6 } }, ...(long ? { fuel: { ...DEFAULT_TUNING.fuel, fighter: { ...DEFAULT_TUNING.fuel.fighter, full: 1e5 } } } : {}) });

// a host with the camp and player A; its shots and hits by the plane's pilot noted
function world(long = false) {
  const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, tuning: tuning(long), camps: [camp], stands: false }, structuredClone(data));
  const sim = host.sim, link = sessionLink(host.connect('a')), c = new MirrorSimClient(new CloneLink(link), { roads: [], peds: [], ctrls: [] }, null, host.hello);
  const W = { host, sim, link, c, shots: [], snaps: null };
  const take = link.onSnapshot;
  link.onSnapshot = (s) => {
    W.snaps?.push(s);
    // (how far off the player's page is first sent the plane)
    const e = W.met === undefined && s.crafts.find((c) => sim.enemies.has(c.id)), a = sim.players.get('a')?.walk?.pose;
    if (e && a) W.met = Math.hypot(e.core.flight.p.x - a.x, e.core.flight.p.z - a.z);
    take(s);
  };
  const shoot = sim.shoot.bind(sim);
  sim.shoot = (by, own, w, from, d) => { if (own.kind === 'craft') W.shots.push({ t: sim.tick * STEP, by }); shoot(by, own, w, from, d); };
  W.tick = async (n = 1, each) => { for (let i = 0; i < n; i++) { simMs += STEP * 1000; c.update(STEP); host.update(STEP); link.deliver(); await settle(); if (each?.() === false) break; } };
  W.walk = (p, h = 0) => {
    c.send({ kind: 'view', view: { focus: { x: p.x, z: p.z } } });
    c.send({ kind: 'request', request: { kind: 'walk', pose: { x: p.x, y: ground(p.x, p.z), z: p.z, h, moving: false } } });
  };
  W.hp = () => sim.lives.hp('player:a') ?? 1e6;
  W.plane = () => { for (const [id, e] of sim.enemies) if (e !== 'lost') return sim.crafts.get(id); return null; };
  return W;
}
const passes = (shots, from, to) => {
  const out = [];
  for (const s of shots) if (s.t >= from && s.t < to) { const last = out.at(-1); if (last && s.t - last.end < 5) last.end = s.t; else out.push({ start: s.t, end: s.t, n: 0 }); out.at(-1).n++; }
  return out;
};

// ---- the alarm: A walks up to the camp's guard, is noticed; a plane is called, appears out of A's sight
const W = world(), { sim } = W;
W.walk({ x: C.x - 150, z: C.z }, Math.PI / 2);
await W.tick(60);
W.walk({ x: C.x - 35, z: C.z }, Math.PI / 2);
const t00 = sim.tick * STEP;
let called = null;
await W.tick(30 / STEP, () => { const p = W.plane(); if (p) called = { t: sim.tick * STEP, p: { ...p.core.pose }, id: p.id }; return !p; });
const me = sim.players.get('a').walk.pose, d0 = called && Math.hypot(called.p.x - me.x, called.p.z - me.z);
await W.tick(5);
check(!!called && d0 >= K.appear && W.met === undefined,
  `the camp's alarm calls an enemy plane ${called && (called.t - t00).toFixed(0)} s after A came near; it appears ${d0?.toFixed(0)} m from them (at least ${K.appear}), not sent to their page`);
for (const n of sim.npcs.all.values()) sim.npcs.kill(n.id);

// ---- in the open: two minutes from its first pass
W.walk(S, 0);
const h0 = W.hp(), t0 = sim.tick * STEP;
let first = null;
await W.tick(90 / STEP, () => { first = W.shots[0]?.t ?? null; return first === null; });
let pilotsMs = 0, cratesMs = 0, ticks = 0;
const pilots = sim.pilots.bind(sim), steps = sim.stepCrafts.bind(sim);
sim.pilots = () => { const t = realNow(); pilots(); pilotsMs += realNow() - t; ticks++; };
sim.stepCrafts = () => { const t = realNow(); steps(); cratesMs += realNow() - t; };
W.snaps = [];
await W.tick(120 / STEP);
delete sim.pilots; delete sim.stepCrafts;
const P = first === null ? [] : passes(W.shots, first, first + 120), gaps = P.slice(1).map((p, i) => p.start - P[i].end);
const lost = h0 - W.hp();
check(W.met !== undefined && W.met > 900, `the player's page is first sent the plane ${W.met?.toFixed(0)} m off: it flies into sight, it does not pop in`);
console.log(`in the open: the first pass ${first === null ? '-' : (first - t0).toFixed(0)} s after A stood there; passes ${P.map((p) => `${(p.start - first).toFixed(0)}s:${p.n}`).join(' ')}; A lost ${lost} (${(lost / MG.damage.points).toFixed(0)} hits)`);
check(P.length >= 3 && gaps.every((g) => g >= 10), `on a player in the open it makes ${P.length} passes in 2 min (at least 3), pauses of ${gaps.map((g) => g.toFixed(0)).join(', ')} s between (each at least 10)`);
check(lost > 0, `its fire hurts the player (${lost} points)`);
// bytes: what A is sent of it (the plane's state, its shots)
const name = sim.enemies.get(W.plane()?.id)?.name;
const z = zlib.createDeflateRaw();
let deflated = 0;
z.on('data', (b) => { deflated += b.length; });
for (const s of W.snaps) {
  z.write(JSON.stringify({ c: s.crafts, ev: s.events.filter((e) => e.player === name) }));
  await new Promise((r) => z.flush(zlib.constants.Z_SYNC_FLUSH, r));
}
W.snaps = null;
const kBs = deflated / 120 / 1024;
console.log(`cost: its pilot ${(pilotsMs / ticks).toFixed(3)} ms a tick, its flight ${(cratesMs / ticks).toFixed(3)} ms; ${kBs.toFixed(2)} kB/s deflated to the player it attacks`);
check(pilotsMs / ticks + cratesMs / ticks < 1 && kBs < 4, `an enemy plane costs the host under 1 ms a tick (${(pilotsMs / ticks + cratesMs / ticks).toFixed(2)}) and its player under 4 kB/s (${kBs.toFixed(2)})`);

// ---- in the hut: no harm
W.walk(U, 0);
await W.tick(5);
const h1 = W.hp(), s1 = W.shots.length;
await W.tick(40 / STEP);
check(h1 - W.hp() === 0, `the same player in a hut takes no harm in 40 s (${h1 - W.hp()}; ${W.shots.length - s1} shots fired)`);

// ---- far off: the camp sleeps though the plane is near it (its pilot is no player)
W.walk({ x: C.x, z: C.z + 1300 }, 0);
await W.tick(30);
const plane = W.plane(), nearCamp = plane && Math.hypot(plane.core.pose.x - C.x, plane.core.pose.z - C.z);
check(sim.players.size === 1 && sim.camps.awake().length === 0 && nearCamp !== null && nearCamp < 1000,
  `the player 1300 m off, the camp sleeps with the plane ${nearCamp?.toFixed(0)} m from it: its pilot counts as no player (${sim.players.size} player)`);

// ---- shot down: 25 hits leave it flying, the 26th makes it a wreck that comes down and stays there
W.walk(S, 0);
await W.tick(30);
const id = plane.id, life = { kind: 'craft', id };
for (let i = 0; i < 25; i++) sim.hurt(life, 'bullet', MG.damage.points);
await W.tick(5);
const up = sim.enemies.get(id) !== 'lost' && !sim.wrecked(life);
sim.hurt(life, 'bullet', MG.damage.points);
const fired = W.shots.length;
let low = Infinity, rose = 0, wasDown = false;
await W.tick(60 / STEP, () => {
  const c = sim.crafts.get(id);
  if (!c) return false;
  const y = c.core.pose.y;
  if (c.core.flight.state === 'crashed') wasDown = true;
  if (wasDown) { if (y > low + 0.5) rose = Math.max(rose, y - low); low = Math.min(low, y); }
});
const wreck = sim.crafts.get(id);
check(up && sim.enemies.get(id) === 'lost' && sim.wrecked(life) && wasDown && rose === 0 && wreck?.pilot === null && W.shots.length === fired,
  `25 MG hits leave it flying, the 26th makes it a wreck: it comes down, stays down (rose ${rose.toFixed(1)} m), no pilot, no shot more`);
// (the camp's alarm again: none called before its refill)
W.walk({ x: C.x - 150, z: C.z }, Math.PI / 2);
await W.tick(60);
W.walk({ x: C.x - 35, z: C.z }, Math.PI / 2);
await W.tick(30 / STEP);
check(!W.plane(), `the camp's alarm after its plane was shot down calls none before its refill`);
W.host.dispose();

// ---- the long run: fifteen minutes of passes at a player by the second hill
{
  const L = world(true), sim = L.sim, at = { x: B.x - 280, z: B.z - 60 };
  L.walk(at, 0);
  await L.tick(30);
  const id = sim.callPlane(C);
  let crashed = null;
  const MIN = 15;
  await L.tick(MIN * 60 / STEP, () => {
    if (sim.enemies.get(id) === 'lost' || !sim.crafts.has(id)) { crashed = sim.tick * STEP; return false; }
  });
  const P = passes(L.shots, 0, Infinity);
  console.log(`long run: ${P.length} passes in ${MIN} min, ${L.shots.length} shots; ${crashed === null ? 'no crash' : `down at ${crashed.toFixed(0)} s`}`);
  check(crashed === null && P.length >= MIN * 60 / 45, `${MIN} minutes of passes by a hill (${P.length}) without the plane hitting the ground`);
  L.host.dispose();
}

// ---- the real data (when there): the Oberhaus's plane at a player in the open 300 m north of the camp, two minutes
if (hasData()) {
  const real = readHostData(DATA), host = nodeHost(DATA, { world: 'tiles', physics: { bodies: false }, tuning: tuning(false) }, real), sim = host.sim;
  const O = sim.mode.camps[0], link = sessionLink(host.connect('a')), c = new MirrorSimClient(new CloneLink(link), structuredClone(real.traffic), null, host.hello);
  const tick = async (n) => { for (let i = 0; i < n; i++) { simMs += STEP * 1000; c.update(STEP); host.update(STEP); link.deliver(); await settle(); } };
  const x = O.x, z = O.z - 300;
  c.send({ kind: 'view', view: { focus: { x, z } } });
  await tick(30);
  c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: sim.npcs.world?.support(x, z, 1e4) ?? 0, z, h: 0, moving: false } } });
  await tick(30);
  const id = sim.callPlane(O);
  let down = false;
  for (let i = 0; i < 120 / STEP && !down; i += 30) { await tick(30); down = sim.enemies.get(id) !== undefined && sim.enemies.get(id) === 'lost'; }
  const lost = 1e6 - (sim.lives.hp('player:a') ?? 1e6);
  check(!down && sim.crafts.has(id) && lost > 0, `at the Oberhaus the plane comes and its fire hurts a player in the open 300 m off in two minutes (${lost}), without hitting the ground`);
  host.dispose();
}

if (fail.length) { console.log(`FAIL ${fail.length}`); process.exit(1); }
