// The lookout, air defence's first step (a camp's NPC with Tuning.lookout's long sight and tight spread; players in
// vehicles as targets in sim/world-sim.ts minds) through a real host in Node (host/node.ts nodeHost, a client over a
// CloneLink) on a synthetic world: a camp with its lookout alone, a row of houses south of it. A helicopter flown 20 s
// at 60 m past it 150 m off in clear sight loses health (its pilot a share); the same flight behind the houses loses
// none; with the lookout dead none; a second run loses exactly as much as the first (the spread is seeded). The camp
// mans its lookout when the pilot comes near and takes it away when they are far. On the real data (when there): the
// Oberhaus's lookout, a helicopter 60 m over the old town side of it: the host holds the voxels between, the lookout
// fires, the helicopter loses health. Printed: what a pass costs, the long sight's cost a tick.
// usage (in web/): node tools/lookout.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';
import { DATA, hasData } from './real-city.mjs';

const { nodeHost, readHostData } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');
const { HEALTH } = await imp('src/sim/health.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));
const settle = () => new Promise((r) => setImmediate(r));
const MAX = HEALTH.craft.helicopter.max;

// flat ground; the camp's lookout at L on the ground; houses 20 m high in a row 20..30 m south of it
const G = 5, L = { x: 384.5, z: 256.5 }, CAMP = { name: 'test', x: L.x, z: L.z, h: 0, lookout: { x: L.x, z: L.z, h: 0 } };
const HOUSES = [];
for (let x = L.x - 240; x < L.x + 240; x += 14) HOUSES.push({ x0: Math.floor(x), x1: Math.floor(x) + 12, z0: Math.floor(L.z) - 30, z1: Math.floor(L.z) - 20, y0: G, y1: G + 20, mat: 'wall' });
const { dir, data } = await synthData({ size: [768, 512], ground: () => G, surface: () => 'earth', boxes: HOUSES });
// (the lookout alone: the squad's fire would muddle what the lookout does)
const tuning = { ...DEFAULT_TUNING, camps: { ...DEFAULT_TUNING.camps, squad: [0] } };

// a host with the camp and a pilot P in a helicopter held at (x, y, z); fly(): along +x from there at speed for secs,
// placed each tick (its own laws would need a pilot's hand: the flight's line is the point here)
async function pilot(at, host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, tuning, camps: [CAMP] }, data), traffic = { roads: [], peds: [], ctrls: [] }) {
  const sim = host.sim, link = sessionLink(host.connect('p')), c = new MirrorSimClient(new CloneLink(link), traffic, null, host.hello);
  let spot = { ...at, h: Math.PI / 2 }, id = null;
  const tick = async (n = 1, each) => {
    for (let i = 0; i < n; i++) {
      each?.();
      if (id !== null) sim.placeCraft(id, spot);
      c.update(STEP); host.update(STEP); link.deliver(); await settle();
    }
  };
  c.send({ kind: 'view', view: { focus: { x: at.x, z: at.z } } });
  c.send({ kind: 'request', request: { kind: 'craft', type: 'helicopter', spot } });
  await tick(10);
  id = [...sim.crafts.values()][0]?.id ?? null;
  const lookout = () => [...sim.npcs.all.values()].find((n) => n.mind?.duty.kind === 'lookout' && n.dead === null) ?? null;
  for (let i = 0; i < 300 && !lookout(); i++) await tick();
  await tick(30);
  const hp = () => sim.lives.hp(`craft:${id}`) ?? MAX, me = () => sim.lives.hp('player:p') ?? HEALTH.player.max;
  return {
    host, sim, lookout, hp, me, tick,
    put: (p) => { spot = { ...spot, ...p }; },
    async fly(speed, secs, each) {
      const x0 = spot.x;
      for (let i = 1; i <= secs / STEP; i++) await tick(1, () => { spot = { ...spot, x: x0 + speed * i * STEP }; each?.(); });
    },
  };
}

// a pass: 20 s at 20 m/s and 60 m up, 150 m to one side of the lookout (south: behind the houses)
const pass = async (side, kill = false) => {
  const z = L.z + side * 150, P = await pilot({ x: L.x - 200, y: G + 60, z });
  const n = P.lookout();
  if (kill && n) P.sim.npcs.kill(n.id);
  const h0 = P.hp(), m0 = P.me(), minds = P.sim.minds.bind(P.sim), shoot = P.sim.shoot.bind(P.sim);
  let ms = 0, ticks = 0, shots = 0, hits = 0, back = false;
  P.sim.minds = () => { const t = performance.now(); minds(); ms += performance.now() - t; ticks++; };
  P.sim.shoot = (by, ...a) => { if (String(by).startsWith('npc')) shots++; shoot(by, ...a); };
  const hurt = P.sim.hurt.bind(P.sim);
  P.sim.hurt = (life, kind, pts) => { if (life.kind === 'craft' && kind === 'bullet') hits++; hurt(life, kind, pts); };
  await P.fly(20, 20, () => { if (kill && P.lookout()) back = true; });
  delete P.sim.minds; delete P.sim.shoot; delete P.sim.hurt;
  return { P, manned: !!n, lost: h0 - P.hp(), hurt: m0 - P.me(), shots, hits, msTick: ms / ticks, back };
};

const open = await pass(1);
console.log(`a pass in clear sight: ${open.shots} shots, ${open.hits} hits, the helicopter ${open.lost.toFixed(0)} of ${MAX}, its pilot ${open.hurt.toFixed(1)}; the lookout's mind ${(open.msTick * 1000).toFixed(0)} us a tick`);
check(open.manned, 'the camp mans its lookout when a helicopter comes near');
check(open.lost > 0 && open.lost < MAX && open.hurt > 0, `a helicopter 20 s at 60 m past the lookout in clear sight loses health (${open.lost.toFixed(0)} of ${MAX}), its pilot a share (${open.hurt.toFixed(1)})`);
check(open.msTick < 0.2, `the lookout's long sight costs the host under 0.2 ms a tick (${(open.msTick * 1000).toFixed(0)} us)`);
// gone far: the lookout taken away with the camp
open.P.put({ x: L.x + 600, z: L.z + 200 });
await open.P.tick(30);
check(!open.P.lookout() && open.P.sim.npcs.all.size === 0, `the pilot far, the camp's lookout is taken away (${open.P.sim.npcs.all.size} NPCs)`);
open.P.host.dispose();

const again = await pass(1);
check(again.lost === open.lost && again.shots === open.shots, `a second run loses as much (${again.lost.toFixed(0)} and ${open.lost.toFixed(0)}, ${again.shots} and ${open.shots} shots)`);
again.P.host.dispose();

const hidden = await pass(-1);
check(hidden.manned && hidden.lost === 0 && hidden.shots === 0, `the same flight behind a row of houses loses none (${hidden.lost.toFixed(0)}, ${hidden.shots} shots)`);
hidden.P.host.dispose();

const dead = await pass(1, true);
check(dead.manned && dead.lost === 0 && !dead.back, `with the lookout dead it loses none, and none is put back (${dead.lost.toFixed(0)})`);
dead.P.host.dispose();

// the real data: the Oberhaus's lookout and a helicopter 60 m over the ground 205 m off towards the old town (within the camp's wake, beyond its unseen)
if (hasData()) {
  const real = readHostData(DATA), host = nodeHost(DATA, { world: 'tiles', physics: { bodies: false } }, real), sim = host.sim;
  const C = sim.mode.camps.find((c) => c.lookout), K = C.lookout, d = 205;
  // (the ground under the helicopter read once the host has it: the lookout's own hold covers it)
  const tx = K.x + Math.sin(K.h) * d, tz = K.z + Math.cos(K.h) * d;
  const P = await pilot({ x: tx, y: 200, z: tz }, host, structuredClone(real.traffic)), n = P.lookout();
  const ground = sim.npcs.world.support(tx, tz, 1e4);
  P.put({ y: ground + 60 });
  await P.tick(5);
  const eyes = n && { x: n.pose.x, y: n.pose.y + 1.3, z: n.pose.z }, craft = [...sim.crafts.values()][0].core.pose;
  const dv = eyes && { x: craft.x - eyes.x, y: craft.y - eyes.y, z: craft.z - eyes.z }, len = dv ? Math.hypot(dv.x, dv.y, dv.z) : 0;
  const ready = !!dv && sim.voxels.ready(eyes, { x: dv.x / len, y: dv.y / len, z: dv.z / len }, len);
  const h0 = P.hp(), minds = sim.minds.bind(sim);
  let ms = 0, ticks = 0;
  sim.minds = () => { const t = performance.now(); minds(); ms += performance.now() - t; ticks++; };
  await P.tick(15 / STEP);
  delete sim.minds;
  console.log(`Oberhaus: the lookout stands at ${n?.pose.y.toFixed(0)} m (the courtyard ~94), the helicopter ${len.toFixed(0)} m off at ${craft.y.toFixed(0)} m; its mind ${(ms / ticks * 1000).toFixed(0)} us a tick`);
  check(!!n && n.pose.y > 100 && ready, `at the Oberhaus the lookout stands high (${n?.pose.y.toFixed(0)} m) and the host holds the voxels to a helicopter ${len.toFixed(0)} m off`);
  check(P.hp() < h0, `it fires on the helicopter over the old town side and hits (${(h0 - P.hp()).toFixed(0)} in 15 s)`);
  host.dispose();
}

if (fail.length) { console.log(`FAIL ${fail.length}`); process.exit(1); }
