// Enemy camps (sim/camps.ts; the NPCs' hearing, hits and alarms in sim/npc-mind.ts and sim/world-sim.ts) through a
// real host in Node (host/node.ts nodeHost, a client per player over a CloneLink) on a synthetic world, the camps'
// radii and refill shortened: a player who walks up meets the camp's squad without the debug request, none put down
// in front of them; one who appears close finds it empty; gone, the host holds none of its NPCs; a squad cut down
// comes back cut down, a camp cleared is full again after its refill and not before; four players near meet four NPCs;
// an NPC shot from beyond its sight goes for the shooter, one hears a shot and goes to look, a squad mate out of sight
// is alarmed. Printed: the host's cost and the bytes a player gets with a squad fighting.
// usage (in web/): node tools/camps.mjs; prints PASS lines, or FAIL and exit 1
import zlib from 'node:zlib';
import { imp, sessionLink, synthData } from './lib.mjs';

const { nodeHost } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { EYE } = await imp('src/sim/weapons/weapon.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));
const settle = () => new Promise((r) => setImmediate(r));

// flat ground; camp O for one player (west), camp F for four (east), 400 m apart
const G = 5, O = { name: 'west', x: 200.5, z: 128.5, h: -Math.PI / 2 }, F = { name: 'east', x: 600.5, z: 128.5, h: -Math.PI / 2 };
const K = { ...DEFAULT_TUNING.camps, wake: 120, sleep: 160, unseen: 80, refill: 30 };
const tuning = { ...DEFAULT_TUNING, camps: K };
const { dir, data } = await synthData({ size: [768, 256], ground: () => G, surface: () => 'earth', boxes: [] });
const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, tuning, camps: [O, F] }, data), sim = host.sim, N = sim.npcs;
const all = [];
const add = (name) => {
  const link = sessionLink(host.connect(name)), c = new MirrorSimClient(new CloneLink(link), { roads: [], peds: [], ctrls: [] }, null, host.hello);
  const p = { c, link, name, snaps: [] }, take = link.onSnapshot;
  link.onSnapshot = (s) => { if (p.keep) p.snaps.push(s); take(s); };
  all.push(p);
  return p;
};
const tick = async (n = 1, each) => {
  for (let i = 0; i < n; i++) { for (const p of all) p.c.update(STEP); host.update(STEP); for (const p of all) p.link.deliver(); await settle(); each?.(); }
};
const walk = (p, x, z, h = 0) => {
  p.c.send({ kind: 'view', view: { focus: { x, z } } });
  p.c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y: G, z, h, moving: false } } });
};
const fireAt = (p, slot, x, y, z) => {
  const w = sim.players.get(p.name).walk.pose, dx = x - w.x, dz = z - w.z;
  p.c.send({ kind: 'fire', slot, h: Math.atan2(dx, dz), pitch: Math.atan2(y - w.y - EYE, Math.hypot(dx, dz)) });
};
const squad = (k) => [...N.all.values()].filter((n) => n.mind?.squad === k && n.dead === null);
const dist = (n, q) => Math.hypot(n.pose.x - q.x, n.pose.z - q.z);
// (the players kept on their feet: the camps are the point here, not who wins)
const heal = sim.harm.bind(sim);
sim.harm = () => { heal(); for (const p of all) sim.lives.heal(`player:${p.name}`); };

// A appears 30 m from the west camp: it stays empty in front of them; gone far, then walking up from 300 m off
const A = add('a');
walk(A, O.x - 30, O.z, Math.PI / 2);
await tick(60);
check(squad(0).length === 0, `a player appearing 30 m off finds the camp empty (${squad(0).length} NPCs)`);
walk(A, 20.5, O.z, Math.PI / 2);
await tick(30);
let manned = null, firstSeen = null;
for (let x = 20.5; x <= O.x - 25 && firstSeen === null; x += 1) {
  walk(A, x, O.z, Math.PI / 2);
  await tick(2);
  const s = squad(0);
  if (s.length && manned === null) manned = { x, near: Math.min(...s.map((n) => dist(n, sim.players.get('a').walk.pose))) };
  if (s.some((n) => n.mind.state === 'attack' && n.mind.target === 'a')) firstSeen = x;
}
await tick(60);
const shots = A.c.eventsSince(0).filter((e) => e.kind === 'shot' && String(e.player).startsWith('npc')).length;
check(manned !== null && manned.near >= K.unseen && squad(0).length === K.squad[0] && squad(0).some((n) => n.mind.duty.kind === 'guard') && squad(0).some((n) => n.mind.duty.kind === 'patrol'),
  `walking up, A meets a guard and a patrol, put down ${manned?.near.toFixed(0)} m off (none nearer than ${K.unseen})`);
check(firstSeen !== null && shots > 0, `the squad notices A ${(O.x - firstSeen).toFixed(0)} m from the camp and fires (${shots} shots)`);

// cut down: one killed, A away (asleep: none held), back: one comes back
const [first] = squad(0);
N.kill(first.id);
const t0 = sim.tick * STEP;
await tick(5);
walk(A, 20.5, O.z, Math.PI / 2);
await tick(30);
check(squad(0).length === 0 && ![...N.all.values()].some((n) => n.mind?.squad === 0), `A gone ${(O.x - 20).toFixed(0)} m off, the host holds none of the camp's NPCs (${N.all.size} NPCs in all)`);
walk(A, O.x - 100, O.z, Math.PI / 2);
await tick(30);
check(squad(0).length === 1, `back, the squad cut down comes back cut down (${squad(0).length} NPC)`);

// cleared: the other killed; A waits 100 m off (out of the camp's sight, in its wake): empty until the refill
for (const n of squad(0)) N.kill(n.id);
let early = 0, refilled = null;
while (refilled === null && sim.tick * STEP < t0 + K.refill + 5) {
  await tick(3);
  const now = sim.tick * STEP, k = squad(0).length;
  if (now < t0 + K.refill - 0.2 && k) early++;
  if (k) refilled = now - t0;
}
check(early === 0 && refilled !== null && refilled >= K.refill - 0.2 && squad(0).length === K.squad[0],
  `the camp cleared is manned again ${refilled?.toFixed(1)} s after its first loss (refill ${K.refill} s), not before`);

// four players near the east camp: four NPCs
walk(A, 20.5, O.z, Math.PI / 2);
const more = ['b', 'c', 'd'].map(add);
for (const [k, p] of [A, ...more].entries()) walk(p, F.x - 100, F.z - 30 + k * 20, Math.PI / 2);
await tick(30);
check(squad(1).length === K.squad[3] && squad(1).filter((n) => n.mind.duty.kind === 'guard').length === 2, `four players near the other camp meet ${squad(1).length} NPCs`);
for (const [k, p] of [A, ...more].entries()) walk(p, 20.5, 40 + k * 20, Math.PI / 2);
await tick(30);

// the host's cost and a player's bytes: the east camp's four fight B 40 m off for 10 s
const B = more[0];
walk(B, F.x - 100, F.z, Math.PI / 2);
await tick(30);
walk(B, F.x - 40, F.z, Math.PI / 2);
await tick(30);
const minds = sim.minds.bind(sim), step = N.tick.bind(N), camps = sim.manCamps.bind(sim);
let ms = 0;
const timed = (f) => (...a) => { const t = performance.now(); f(...a); ms += performance.now() - t; };
sim.minds = timed(minds); N.tick = timed(step); sim.manCamps = timed(camps);
B.keep = true;
const SECS = 10, T = SECS / STEP;
await tick(T);
B.keep = false;
delete sim.minds; delete N.tick; delete sim.manCamps;
const z = zlib.createDeflateRaw();
let deflated = 0;
z.on('data', (b) => { deflated += b.length; });
for (const s of B.snaps) {
  z.write(JSON.stringify({ npcs: s.npcs, gone: s.gone[7], ev: s.events.filter((e) => typeof e.player === 'string' && e.player.startsWith('npc')), health: s.health }));
  await new Promise((r) => z.flush(zlib.constants.Z_SYNC_FLUSH, r));
}
const fighting = squad(1).filter((n) => n.mind.state === 'attack').length;
console.log(`cost: a camp of 4 (${fighting} fighting) ${(ms / T).toFixed(3)} ms a tick on the host; ${(deflated / SECS / 1024).toFixed(2)} kB/s deflated to the player it fights`);
check(fighting >= 2 && ms / T < 1 && deflated / SECS / 1024 < 3, `a camp of 4 fighting costs the host under 1 ms a tick and its player under 3 kB/s`);
walk(B, 20.5, 60, Math.PI / 2);
await tick(30);

// shot from 80 m: the west camp's guard, hit, goes for A (beyond its sight); the patrol hears it
walk(A, O.x - 100, O.z, Math.PI / 2);
await tick(40);
const guard = squad(0).find((n) => n.mind.duty.kind === 'guard'), patrol = squad(0).find((n) => n.mind.duty.kind === 'patrol');
walk(A, guard.pose.x - 80, guard.pose.z, Math.PI / 2);
await tick(5);
let hit = false;
for (let i = 0; i < 40 && !hit; i++) {
  fireAt(A, 1, guard.pose.x, G + 1.2, guard.pose.z);
  await tick(1);
  hit = guard.mind.target === 'a';
}
const d0 = dist(guard, sim.players.get('a').walk.pose);
await tick(60);
check(hit && d0 > DEFAULT_TUNING.npc.sight && ['search', 'attack'].includes(guard.mind.state) && dist(guard, sim.players.get('a').walk.pose) < d0 - 3,
  `the guard shot from ${d0.toFixed(0)} m (its sight ${DEFAULT_TUNING.npc.sight}) goes for A (${guard.mind.state}, ${dist(guard, sim.players.get('a').walk.pose).toFixed(0)} m)`);
check(patrol && patrol.mind.state !== 'post', `its patrol hears the shots and goes to look (${patrol?.mind.state})`);
walk(A, 20.5, O.z, Math.PI / 2);
await tick(60);

// alarm: two of one squad 100 m apart; the one that notices A tells the other, which cannot see A
const near = sim.addNpc({ x: 100.5, y: G, z: 230.5 }, undefined, { kind: 'guard', x: 100.5, z: 230.5, h: 0 }, 7);
const far = sim.addNpc({ x: 200.5, y: G, z: 230.5 }, undefined, { kind: 'guard', x: 200.5, z: 230.5, h: 0 }, 7);
const n1 = N.all.get(near), n2 = N.all.get(far);
walk(A, 100.5, 200.5, 0);
let told = null;
for (let i = 0; i < 30 && told === null; i++) { await tick(1); if (n1.mind.state === 'attack' && n2.mind.target === 'a') told = i; }
await tick(30);
check(told !== null && n2.mind.state !== 'post' && dist(n2, sim.players.get('a').walk.pose) > DEFAULT_TUNING.npc.sight,
  `a squad mate ${dist(n2, sim.players.get('a').walk.pose).toFixed(0)} m off, out of sight, is alarmed when the other notices A (${n2.mind.state})`);

host.dispose();
if (fail.length) { console.log(`FAIL ${fail.length}`); process.exit(1); }
