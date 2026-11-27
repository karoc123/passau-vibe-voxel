// NPCs on foot as enemies (sim/npc-mind.ts, their use in sim/world-sim.ts) through a real host in Node (host/node.ts
// nodeHost, sessions, a client per player over a CloneLink) on a synthetic world: a guard does not notice a player
// behind a wall and notices one in sight; it fires the MG and that player's health drops on the host and the page; the
// player gone behind a building, it searches where it saw them and goes back to its post; a patrol walks its loop;
// one NPC killed by the MG and one by a grenade lie (drawn so on the page), take no more harm, and are gone later;
// the debug request puts a guard and a patrol down ahead of the player. Printed: the bytes 10 NPCs in sight cost a
// player (deflated, as over the network), the host's cost with 10 and 50 NPCs, some fighting.
// usage (in web/): node tools/npc-fight.mjs; prints PASS lines, or FAIL and exit 1
import zlib from 'node:zlib';
import { imp, sessionLink, synthData } from './lib.mjs';

const { nodeHost } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { EYE } = await imp('src/sim/figure.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));
const settle = () => new Promise((r) => setImmediate(r));

// flat ground at G; a wall along z 80 (x 60..140) with B behind it; a building (x 120..126, z 110..140) A hides behind;
// the patrol's square far off (x 300 ± 8, z 60 ± 8)
const G = 5, GUARD = { x: 100.5, z: 100.5 }, LOOP = [[308, 68], [308, 52], [292, 52], [292, 68]].map(([x, z]) => ({ x: x + 0.5, z: z + 0.5 }));
const boxes = [
  { x0: 60, x1: 140, z0: 80, z1: 81, y0: G, y1: G + 4, mat: 'wall' },
  { x0: 120, x1: 126, z0: 110, z1: 140, y0: G, y1: G + 8, mat: 'wall' },
];
const { dir, data } = await synthData({ size: [384, 256], ground: () => G, surface: () => 'earth', boxes });
const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, camps: [] }, data), sim = host.sim, N = sim.npcs;
const all = [];
const add = (name) => {
  const link = sessionLink(host.connect(name)), c = new MirrorSimClient(new CloneLink(link), { roads: [], peds: [], ctrls: [] }, null, host.hello);
  const p = { c, link, name, snaps: [] }, take = link.onSnapshot;
  link.onSnapshot = (s) => { if (p.keep) p.snaps.push(s); take(s); };
  all.push(p);
  return p;
};
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) { for (const p of all) p.c.update(STEP); host.update(STEP); for (const p of all) p.link.deliver(); await settle(); }
};
const walk = (p, x, z, h = 0) => {
  p.c.send({ kind: 'view', view: { focus: { x, z } } });
  p.c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h, moving: false } } });
};
const fireAt = (p, slot, x, y, z) => {
  const w = sim.players.get(p.name).walk.pose, dx = x - w.x, dz = z - w.z;
  p.c.send({ kind: 'fire', slot, h: Math.atan2(dx, dz), pitch: Math.atan2(y - w.y - EYE, Math.hypot(dx, dz)) });
};
const near = (n, q, d = 1) => Math.hypot(n.pose.x - q.x, n.pose.z - q.z) < d;
const shotsBy = (p, id, since) => p.c.eventsSince(since).filter((e) => e.kind === 'shot' && e.player === `npc${id}`);

const A = add('a'), B = add('b');
walk(B, 100.5, 60.5);
A.c.send({ kind: 'view', view: { focus: { x: 100, z: 125 } } });
const guard = sim.addNpc({ x: GUARD.x, y: G, z: GUARD.z }, undefined, { kind: 'guard', x: GUARD.x, z: GUARD.z, h: 0 });
const g = N.all.get(guard);
await tick(60);
check(g.mind.state === 'post' && g.mind.target === null && near(g, GUARD, 0.5), `a guard does not notice B behind a wall 40 m off (${g.mind.state})`);

// A in sight 25 m ahead
walk(A, 100.5, 125.5, Math.PI);
let t0 = sim.tick, noticed = null;
for (let i = 0; i < 60 && noticed === null; i++) { await tick(); if (g.mind.state === 'attack') noticed = (sim.tick - t0) * STEP; }
check(noticed !== null && g.mind.target === 'a', `it notices A in sight 25 m off in ${noticed?.toFixed(2)} s (target ${g.mind.target})`);
const t1 = sim.tick;
await tick(150);
const shots = shotsBy(A, guard, t1), hits = shots.filter((e) => e.hit?.kind === 'avatar').length, hp = sim.lives.hp('player:a');
check(shots.length >= 6 && hits > 0 && hits < shots.length, `it fires the MG at A, not every shot a hit (${shots.length} shots in 5 s, ${hits} hits)`);
check(hp !== undefined && hp < 100 && A.c.health('player:a')?.hp === Math.ceil(hp), `A's health drops on the host and A's page (${hp}, ${A.c.health('player:a')?.hp})`);
const dA = Math.hypot(g.pose.x - 100.5, g.pose.z - 125.5);
check(Math.abs(g.pose.h) < 0.2 && dA > 15 && dA < 21, `it faces A and follows to 20 m of them (h ${g.pose.h.toFixed(2)}, ${dA.toFixed(1)} m)`);

// A behind the building: it searches where it last saw A, then goes back to its post
walk(A, 130.5, 125.5, Math.PI);
const seenAt = { ...g.mind.seen };
let searched = false, reached = false, back = null;
t0 = sim.tick;
for (let i = 0; i < 40 / STEP && back === null; i++) {
  await tick();
  if (g.mind.state === 'search') searched = true;
  if (searched && near(g, seenAt, 2)) reached = true;
  if (searched && g.mind.state === 'post' && near(g, GUARD, 1) && !g.goal) back = (sim.tick - t0) * STEP;
}
check(searched && reached, `out of sight it searches where it last saw A (${seenAt.x?.toFixed(1)}, ${seenAt.z?.toFixed(1)}): reached ${reached}`);
check(back !== null && Math.abs(g.pose.h) < 0.05, `then back on its post facing its way after ${back?.toFixed(1)} s`);

// a patrol walks its loop (nobody in sight)
const patrol = sim.addNpc({ x: LOOP[3].x, y: G, z: LOOP[3].z }, undefined, { kind: 'patrol', loop: LOOP });
const pn = N.all.get(patrol), visited = new Set();
B.c.send({ kind: 'view', view: { focus: { x: 300, z: 60 } } });
for (let i = 0; i < 60 / STEP && visited.size < 5; i++) {
  await tick();
  LOOP.forEach((q, k) => { if (near(pn, q, 0.6)) visited.add(visited.has(k) && k === 0 ? 'again' : k); });
}
check(visited.size >= 5 && pn.mind.state === 'post', `a patrol walks its loop's four points and on round (${[...visited]})`);

// the debug request: a guard and a patrol put down ahead of A
const before = new Set(N.all.keys());
A.c.send({ kind: 'request', request: { kind: 'npc', patrol: false } });
await tick(2);
A.c.send({ kind: 'request', request: { kind: 'npc', patrol: true } });
await tick(2);
const made = [...N.all.values()].filter((n) => !before.has(n.id)), aw = sim.players.get('a').walk.pose;
check(made.length === 2 && made[0].mind.duty.kind === 'guard' && made[1].mind.duty.kind === 'patrol' && made.every((n) => Math.hypot(n.pose.x - aw.x, n.pose.z - aw.z) < 5)
  && A.c.results('npc').length === 2 && A.c.results('npc').every((r) => r.ok), `the debug request puts a guard and a patrol down ahead of A (${made.map((n) => n.mind.duty.kind)})`);
for (const n of made) N.all.delete(n.id);

// killed by the MG: A fires at the guard from 25 m (it fires back)
walk(A, 100.5, 125.5, Math.PI);
await tick(10);
for (let i = 0; i < 60 && g.dead === null; i++) { fireAt(A, 1, g.pose.x, G + 1.2, g.pose.z); await tick(2); }
await tick(3);
const lying = A.c.traffic.avatars.find((a) => a.id === guard);
check(g.dead !== null && g.pose.down && lying?.pose.down && !lying.pose.arm, `the MG kills the guard: it lies, on A's page too (dead ${g.dead !== null}, drawn down ${lying?.pose.down})`);
const shotsAfter = shotsBy(A, guard, sim.tick);
fireAt(A, 1, g.pose.x, G + 0.2, g.pose.z);
await tick(3);
check(shotsAfter.length === 0 && shotsBy(A, guard, sim.tick - 3).length === 0 && A.c.eventsSince(sim.tick - 3).filter((e) => e.kind === 'shot' && e.hit?.kind === 'avatar' && e.hit.id === guard).length === 0,
  'a dead NPC fires no more and is no body to shots');

// killed by a grenade at its feet
const second = sim.addNpc({ x: 108.5, y: G, z: 118.5 }, undefined, { kind: 'guard', x: 108.5, z: 118.5, h: 0 }), s2 = N.all.get(second);
await tick(2);
fireAt(A, 2, s2.pose.x, G + 1, s2.pose.z);
for (let i = 0; i < 90 && s2.dead === null; i++) await tick();
check(s2.dead !== null && s2.pose.down, `a grenade at its feet kills another (${sim.lives.hp(`npc:${second}`)})`);
const gone = Math.ceil(20 / STEP) + 10;
await tick(gone);
check(!N.all.has(guard) && !N.all.has(second) && !A.c.traffic.avatars.some((a) => a.id === guard || a.id === second) && sim.lives.hp(`npc:${guard}`) === undefined,
  'the dead are taken away after a while, from the host and the page');

// The bytes: C watches 10 NPCs 40..140 m off (not on foot: no target): 4 patrolling, 4 guards, 2 fighting D (on
// foot, out of C's sight of the walls). What C's session gets of them (the NPCs, their shots, their health) deflated
// as a socket would, per second
for (const n of [...N.all.keys()]) N.all.delete(n);
walk(A, 20.5, 20.5);
const C = add('c'), D = add('d');
C.c.send({ kind: 'view', view: { focus: { x: 200, z: 160 } } });
walk(D, 200.5, 230.5, Math.PI);
const ten = [];
for (let k = 0; k < 4; k++) {
  const cx = 160 + k * 25, cz = 120;
  ten.push(sim.addNpc({ x: cx, y: G, z: cz }, undefined, { kind: 'patrol', loop: [{ x: cx, z: cz }, { x: cx + 15, z: cz }, { x: cx + 15, z: cz + 15 }, { x: cx, z: cz + 15 }] }));
}
for (let k = 0; k < 4; k++) ten.push(sim.addNpc({ x: 170 + k * 20, y: G, z: 100 }, undefined, { kind: 'guard', x: 170 + k * 20, z: 100, h: Math.PI }));
for (let k = 0; k < 2; k++) ten.push(sim.addNpc({ x: 190 + k * 20, y: G, z: 200 }, undefined, { kind: 'guard', x: 190 + k * 20, z: 200, h: 0 }));
await tick(30);
C.keep = true;
const SECS = 10;
// (fighting: in an attack at some time of the window; D, killed, lies a while and comes back)
const fought = new Set();
for (let i = 0; i < SECS / STEP; i++) {
  await tick();
  for (const id of ten) if (N.all.get(id)?.mind.state === 'attack') fought.add(id);
}
C.keep = false;
const z = zlib.createDeflateRaw();
let deflated = 0, raw = 0;
z.on('data', (b) => { deflated += b.length; });
const mine = (key) => key.startsWith('npc:');
for (const s of C.snaps) {
  const part = { npcs: s.npcs, gone: s.gone[7], ev: s.events.filter((e) => typeof e.player === 'string' && e.player.startsWith('npc')), health: s.health?.filter(([k]) => mine(k)) };
  const t = JSON.stringify(part);
  raw += t.length;
  z.write(t);
  await new Promise((r) => z.flush(zlib.constants.Z_SYNC_FLUSH, r));
}
const fighting = fought.size;
const kbs = deflated / SECS / 1024, rawKbs = raw / SECS / 1024;
console.log(`bytes: 10 NPCs in sight (${fighting} fighting) ${kbs.toFixed(2)} kB/s deflated, ${rawKbs.toFixed(1)} raw, a player`);
check(fighting >= 1 && kbs < 3, `10 NPCs in sight, ${fighting} fighting, cost a player ${kbs.toFixed(2)} kB/s (budget 3)`);

// the host's cost: 10, then 50 NPCs (a fifth fighting D, kept on their feet)
const heal = sim.harm.bind(sim);
sim.harm = () => { heal(); sim.lives.heal('player:d'); };
const cost = async (n) => {
  for (const id of [...N.all.keys()]) N.all.delete(id);
  for (let k = 0; k < n; k++) {
    const fight = k % 5 === 0, x = 150 + (k % 10) * 10 + (fight ? 10 * Math.floor(k / 10) : 0), zz = fight ? 210 : 40 + Math.floor(k / 10) * 8;
    sim.addNpc({ x, y: G, z: zz }, undefined, fight ? { kind: 'guard', x, z: zz, h: 0 } : { kind: 'patrol', loop: [{ x, z: zz }, { x: x + 6, z: zz }, { x: x + 6, z: zz + 6 }] });
  }
  await tick(60);
  const minds = sim.minds.bind(sim), step = N.tick.bind(N);
  let ms = 0;
  sim.minds = () => { const t = performance.now(); minds(); ms += performance.now() - t; };
  N.tick = (...a) => { const t = performance.now(); step(...a); ms += performance.now() - t; };
  const T = 150;
  await tick(T);
  delete sim.minds; delete N.tick;
  return { ms: ms / T, fighting: [...N.all.values()].filter((m) => m.mind?.state === 'attack').length };
};
const c10 = await cost(10), c50 = await cost(50);
console.log(`cost: the NPCs' minds and walk ${c10.ms.toFixed(2)} ms a tick with 10 (${c10.fighting} fighting), ${c50.ms.toFixed(2)} with 50 (${c50.fighting} fighting)`);
check(c50.ms < 5 && c50.fighting >= 5, `50 NPCs, ${c50.fighting} fighting, cost the host under 5 ms a tick (${c50.ms.toFixed(2)})`);

host.dispose();
if (fail.length) { console.log(`FAIL ${fail.length}`); process.exit(1); }
