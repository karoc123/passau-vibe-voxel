// An NPC on foot finds its way on the host (sim/npcs.ts, sim/way.ts: a walkable grid made round it from the voxels
// the host holds, A* on it; its body the players' walk, sim/walker.ts), on a synthetic world through a real host in
// Node (host/node.ts nodeHost): round a building, through the one gap in a long wall and up a step onto a terrace to
// its goal, never into a wall; then on towards a goal past a crater blown into its way after it set off, which it walks
// round after finding its way again, never falling in. A player near sees it walk (an avatar). Printed: what the walk
// costs per NPC and tick, what a search (the grid and A*) costs, the bytes a walking NPC adds to a snapshot.
// usage (in web/): node tools/npc-walk.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';

const { nodeHost } = await imp('src/host/node.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { frameOf, mapToGrid, cellToAbsZ } = await imp('src/core/layers.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));

// flat ground at G; a building (x 50..70, z 100..156) in the straight line; a wall along x 80 (z 20..230) with one gap
// (z 170..172); a terrace 1 m up east of it (x 95..120, z 110..146)
const G = 5, GAP = [170, 172];
const terrace = (x, z) => x >= 95 && x < 120 && z >= 110 && z < 146;
const walls = [
  { x0: 50, x1: 70, z0: 100, z1: 156, y0: G, y1: G + 10, mat: 'wall' },
  { x0: 80, x1: 81, z0: 20, z1: GAP[0], y0: G, y1: G + 4, mat: 'wall' }, { x0: 80, x1: 81, z0: GAP[1], z1: 230, y0: G, y1: G + 4, mat: 'wall' },
];
const { dir, data } = await synthData({ size: [256, 256], ground: (x, z) => (terrace(x, z) ? G + 1 : G), surface: () => 'earth', boxes: walls });
const server = nodeHost(dir, { world: 'tiles', edits: true, physics: { bodies: false }, interest: 300 }, data);
const sim = server.sim;
const inWall = (x, z, y) => walls.some((b) => x >= b.x0 - 0.25 && x < b.x1 + 0.25 && z >= b.z0 - 0.25 && z < b.z1 + 0.25 && y < b.y1);

// a player near watching (its view keeps the edits)
const s = server.connect('b'), link = sessionLink(s);
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const B = new MirrorSimClient(new CloneLink(link), { roads: [], peds: [], ctrls: [] }, null, server.hello);
B.send({ kind: 'view', view: { focus: { x: 90, z: 128 } } });
let bytes = 0;
const tick = async () => { B.update(STEP); server.update(STEP); link.deliver(); bytes += JSON.stringify(s.snapshot().avatars).length; await new Promise(setImmediate); };

// the searches timed (grid and A*), the walk's ticks timed
const N = sim.npcs, search = N.search.bind(N), searches = [];
N.search = (n) => { const t = performance.now(); search(n); searches.push({ ms: performance.now() - t, cells: n.grid?.cells ?? 0, way: n.way.length }); };

const id = sim.addNpc({ x: 30, y: G, z: 128 });
N.goTo(id, { x: 105.5, z: 128.5 });
const npc = N.all.get(id);
let crossed = null, worst = 0, ticks = 0, lowest = Infinity, seenB = false;
const watch = () => {
  const p = npc.pose;
  if (inWall(p.x, p.z, p.y + 0.1)) worst++;
  if (npc.prev.x < 80 && p.x >= 80) crossed = p.z;
  lowest = Math.min(lowest, p.y);
  const a = B.traffic.avatars.find((v) => v.id === id);
  if (a && Math.hypot(a.pose.x - p.x, a.pose.z - p.z) < 1) seenB = true;
};
for (; ticks < 60 / STEP && npc.goal; ticks++) { await tick(); watch(); }
const at = npc.pose;
check(!npc.goal && Math.hypot(at.x - 105.5, at.z - 128.5) < 0.6 && Math.abs(at.y - (G + 1)) < 0.01,
  `round the building, through the wall's gap and up the step onto the terrace to its goal in ${(ticks * STEP).toFixed(1)} s (at ${at.x.toFixed(1)}, ${at.y}, ${at.z.toFixed(1)})`);
check(crossed !== null && crossed > GAP[0] && crossed < GAP[1], `crossed the wall only through its gap (at z ${crossed?.toFixed(2)}, the gap ${GAP[0]}..${GAP[1]})`);
check(worst === 0, `never in a wall (${worst} ticks)`);
check(seenB, 'a player near sees it walk (an avatar where the host has it)');
const walkBytes = bytes / (ticks * STEP);

// on south along x 105 to z 30; once it is under way a crater (r 6) is blown into its way at z 70
const n0 = searches.length;
N.goTo(id, { x: 105.5, z: 30.5 });
for (let i = 0; i < 2 / STEP; i++) { await tick(); watch(); }
const before = npc.way.map((p) => `${p.x},${p.z}`).join(' ');
const through = npc.way.some((p, i) => i > 0 && Math.abs((npc.way[i - 1].x + p.x) / 2 - 105.5) < 3) || npc.way.every((p) => Math.abs(p.x - 105.5) < 3);
const hole = { x: 105.5, z: 70 };
const frame = frameOf(data.meta), [col, row] = mapToGrid(frame, Math.floor(hole.x), Math.floor(hole.z));
s.send({ kind: 'edit', op: { kind: 'sphere', col, row, z: cellToAbsZ(frame, G), r: 6, colour: 0 }, ref: 1 });
lowest = Infinity;
let closest = Infinity;
ticks = 0;
for (; ticks < 60 / STEP && npc.goal; ticks++) {
  await tick(); watch();
  closest = Math.min(closest, Math.hypot(npc.pose.x - hole.x, npc.pose.z - hole.z));
}
const end = npc.pose, after = searches.length - n0;
check(sim.ground.support(hole.x, hole.z, G + 1) < G - 3, `the crater blown into its way (${(G - sim.ground.support(hole.x, hole.z, G + 1)).toFixed(0)} m deep)`);
check(through, `the way first went straight through where the crater came (${before})`);
check(!npc.goal && Math.hypot(end.x - 105.5, end.z - 30.5) < 0.6 && after >= 2,
  `found its way again round the fresh crater to its goal in ${(ticks * STEP).toFixed(1)} s (${after} searches; at ${end.x.toFixed(1)}, ${end.z.toFixed(1)})`);
check(lowest > G - 0.5 && closest > 4, `never fell in (lowest feet ${lowest.toFixed(2)}, nearest the crater's middle ${closest.toFixed(1)} m)`);
check(worst === 0, `still never in a wall (${worst} ticks)`);

// the walk's cost per NPC and tick: 40 NPCs walking to and fro across open ground (their searches timed apart)
const many = [];
for (let k = 0; k < 40; k++) {
  const m = sim.addNpc({ x: 140 + (k % 8) * 12, y: G, z: 170 + Math.floor(k / 8) * 12 });
  N.goTo(m, { x: 140 + ((k + 3) % 8) * 12, z: 20 + (k % 5) * 6 });
  many.push(m);
}
N.goTo(id, null);
for (let i = 0; i < 10; i++) await tick();
const s0 = searches.length, search0 = searches.reduce((a, b) => a + b.ms, 0), tick0 = N.tick.bind(N);
let tickMs = 0, nTicks = 0;
N.tick = (...a) => { const t = performance.now(); tick0(...a); tickMs += performance.now() - t; nTicks++; };
for (let i = 0; i < 150; i++) await tick();
const searchIn = searches.slice(s0).reduce((a, b) => a + b.ms, 0), walking = [...N.all.values()].filter((n) => n.pose.moving).length;
const walkUs = (tickMs - searchIn) / nTicks / N.all.size * 1000;
const nAll = N.all.size, nT = nTicks;
// the first way again, warm: round the building and through the gap
const again = sim.addNpc({ x: 30, y: G, z: 128 });
N.goTo(again, { x: 105.5, z: 128.5 });
await tick();
const hard = searches.at(-1);
const big = searches.toSorted((a, b) => b.ms - a.ms);
console.log(`cost: the walk ${walkUs.toFixed(1)} µs per NPC and tick (${nAll} NPCs, ${walking} walking, ${nT} ticks); ` +
  `a search (grid and A*) ${(search0 / s0).toFixed(2)} ms mean over ${s0}, the largest ${big[0].ms.toFixed(2)} ms (${big[0].cells} cells); ` +
  `round the building and through the gap ${hard.ms.toFixed(2)} ms (${hard.cells} cells read, ${hard.way} points); one walking NPC ~${(walkBytes / 1000).toFixed(1)} kB/s in a snapshot (raw JSON)`);
check(walkUs < 200, `the walk under 200 µs per NPC and tick (${walkUs.toFixed(1)})`);
check(big[0].ms < 50, `a search under 50 ms (the largest ${big[0].ms.toFixed(2)})`);

server.dispose();
if (fail.length) { console.log(`FAIL ${fail.length}`); process.exit(1); }
