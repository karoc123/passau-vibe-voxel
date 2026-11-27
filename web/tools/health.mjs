// Health and damage through the real host (host/node.ts nodeHost, SimServer sessions, a client per player over a
// CloneLink, so commands cross as JSON and snapshots as clones) on a synthetic flat world: an MG hit lowers a player's
// health and a helicopter's (its pilot takes a share), and the pages see it; quiet ticks send no health at all; two
// grenades wreck the helicopter (its pilot hurt, not killed; the pilot's climb no more taken; its seat refused once
// left); a player shot to 0 is down (their walk not taken), then back at full health where they stood, told by the
// event; a fall of 20 m on foot hurts, one of 2 m does not. The pages see the wreck as one (CraftView.wreck) and draw
// it so (view/crafts/wreck.ts): charred, its rotors still, smoke over it, one draw call more for any number of wrecks.
// usage (in web/): node tools/health.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';

const { nodeHost } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { craftBox } = await imp('src/sim/solids.ts');
const { SPAWN_HEIGHT } = await imp('src/sim/craft/craft-collision.ts');
const { EYE } = await imp('src/sim/figure.ts');
const { HEALTH } = await imp('src/sim/health.ts');
const THREE = await import('three');
const { craftLook, wreckSmoke } = await imp('checks/wreck-checks.ts');
const { CORES } = await imp('src/sim/craft/cores.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');
const { WRECK_COL } = await imp('src/sim/contract/agents.ts');

const fail = [], pass = (s) => console.log(`PASS ${s}`), check = (ok, s) => (ok ? pass(s) : fail.push(s));
const settle = () => new Promise((r) => setImmediate(r));

const G = 5;
const { dir, data } = await synthData({ size: [384, 256], ground: () => G, boxes: [] });
const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false } }, data), sim = host.sim;
const traffic = () => ({ roads: [], peds: [], ctrls: [] });
const all = [];
// (the health each snapshot carried, by player)
const add = (name) => {
  const link = sessionLink(host.connect(name)), c = new MirrorSimClient(new CloneLink(link), traffic(), null, host.hello);
  const p = { c, link, name, health: [] }, take = link.onSnapshot;
  link.onSnapshot = (s) => { if (s.health) p.health.push(...s.health); take(s); };
  all.push(p);
  return p;
};
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) { for (const p of all) p.c.update(STEP); host.update(STEP); for (const p of all) p.link.deliver(); await settle(); }
};
const walk = (p, x, z, y = G) => {
  p.c.send({ kind: 'view', view: { focus: { x, z } } });
  p.c.send({ kind: 'request', request: { kind: 'walk', pose: { x, y, z, h: 0, moving: false } } });
};
const hp = (c, life) => c.health(life)?.hp ?? null;
// a shot of p's weapon in slot at the point (x, y, z) from where the host has p's eyes (a grenade aimed a little over:
// its arc drops)
const fireAt = (p, slot, x, y, z, lob = 0) => {
  const w = sim.players.get(p.name).walk.pose, dx = x - w.x, dz = z - w.z, d = Math.hypot(dx, dz);
  p.c.send({ kind: 'fire', slot, h: Math.atan2(dx, dz), pitch: Math.atan2(y - w.y - EYE, d) + lob });
};

const A = add('a'), B = add('b'), P = add('p');
walk(A, 100, 100); walk(B, 110, 100);
P.c.send({ kind: 'view', view: { focus: { x: 140, z: 100 } } });
P.c.send({ kind: 'request', request: { kind: 'craft', type: 'helicopter', spot: { x: 140, y: G + SPAWN_HEIGHT.helicopter, z: 100, h: 0 } } });
await tick(20);
const heli = [...sim.crafts.values()][0], craft = `craft:${heli?.id}`;
check([A, B].every((p) => p.c.seat()?.role === 'walker') && P.c.seat()?.role === 'pilot', 'two players on foot, one piloting a helicopter');

// an MG hit on B
fireAt(A, 1, 110, G + 1.2, 100);
await tick(3);
check(sim.lives.hp('player:b') === 90 && hp(B.c, 'player:b') === 90 && hp(A.c, 'player:b') === 90,
  `an MG hit takes 10 off B on the host, B's page and A's (${sim.lives.hp('player:b')}, ${hp(B.c, 'player:b')}, ${hp(A.c, 'player:b')})`);

// an MG hit on the helicopter: half of it taken, a share passed to its pilot
let box = craftBox('helicopter', heli.core.pose);
fireAt(A, 1, box.x, box.y + box.ht / 2, box.z);
await tick(3);
const H = HEALTH.craft.helicopter, pilotTook = 10 * H.take.bullet * H.through;
const seen = (p) => p.c.crafts().find((c) => c.id === heli.id);
check(seen(A).wreck === false && seen(P).wreck === false, 'a hurt helicopter is no wreck on the pages');
check(hp(A.c, craft) === H.max - 10 * H.take.bullet && hp(P.c, 'player:p') === Math.ceil(100 - pilotTook),
  `an MG hit on the helicopter: ${hp(A.c, craft)}/${H.max} on A's page, its pilot ${hp(P.c, 'player:p')} on theirs`);

// nothing changes: no health sent
await tick(10);
for (const p of all) p.health.length = 0;
await tick(30);
check(all.every((p) => p.health.length === 0), `30 quiet ticks send no health (${all.map((p) => p.health.length)})`);

// two grenades at the helicopter from 9 m: wrecked, its pilot hurt, not killed
walk(A, 140 - 9 - box.r, 100);
await tick(5);
for (let i = 0; i < 2; i++) {
  box = craftBox('helicopter', heli.core.pose);
  fireAt(A, 2, box.x, box.y + box.ht / 2, box.z, 0.02);
  await tick(60);
}
const y0 = heli.core.pose.y;
check(sim.wrecked({ kind: 'craft', id: heli.id }) && hp(A.c, craft) === 0 && hp(P.c, craft) === 0, `two grenades wreck the helicopter (${hp(A.c, craft)} on A's page)`);
check(seen(A).wreck === true && seen(P).wreck === true, 'both pages see the helicopter a wreck');
const pilotHp = hp(P.c, 'player:p');
check(pilotHp > 0 && pilotHp < 100 && !sim.isDown('p'), `its pilot is hurt, not killed (${pilotHp})`);
for (let i = 0; i < 30; i++) { P.c.send({ kind: 'seatInput', role: 'pilot', input: { turn: 0, drive: 0, lift: 1, side: 0 } }); await tick(); }
check(heli.core.pose.y <= y0 + 0.01, `the wreck's pilot's climb is not taken (${y0.toFixed(2)} -> ${heli.core.pose.y.toFixed(2)})`);
P.c.send({ kind: 'leaveSeat', pose: { x: 140, y: G, z: 104, h: 0, moving: false } });
await tick(3);
P.c.send({ kind: 'enterSeat', entity: { kind: 'craft', id: heli.id }, role: 'pilot' });
await tick(3);
const r = P.c.results('enterSeat');
check(P.c.seat()?.role === 'walker' && r.length === 1 && !r[0].ok, `out of the wreck, its pilot's seat is refused (${JSON.stringify(r)})`);

// B shot to 0: down, then back
walk(A, 100, 100);
await tick(10);
const bAt = { ...sim.players.get('b').walk.pose };
for (let i = 0; i < 30 && !sim.isDown('b'); i++) { fireAt(A, 1, 110, G + 1.2, 100); await tick(4); }
check(sim.isDown('b') && hp(B.c, 'player:b') === 0 && hp(A.c, 'player:b') === 0, `B shot to 0 is down, on both pages (${hp(B.c, 'player:b')})`);
const since = sim.tick;
B.c.send({ kind: 'seatInput', role: 'walker', input: { ...bAt, x: bAt.x + 2, moving: true } });
await tick(3);
check(Math.abs(sim.players.get('b').walk.pose.x - bAt.x) < 0.01, 'a walk of B down is not taken');
await tick(Math.ceil(HEALTH.downMs / 1000 / STEP) + 2);
const back = B.c.eventsSince(since).find((e) => e.kind === 'back' && e.player === 'b');
check(!sim.isDown('b') && hp(B.c, 'player:b') === null && hp(A.c, 'player:b') === null, 'B is back at full health after the time down, on both pages');
check(back && Math.hypot(back.to.x - bAt.x, back.to.z - bAt.z) < 0.5, `B's page is told where B is back (${JSON.stringify(back?.to)})`);

// falls on foot: 2 m nothing, 20 m hurts
const fallFrom = async (p, x, h) => {
  walk(p, x, 100, G + h);
  await tick(3);
  let y = G + h, v = 0;
  while (y > G) {
    v += 9.81 * STEP; y = Math.max(G, y - v * STEP);
    p.c.send({ kind: 'seatInput', role: 'walker', input: { x, y, z: 100, h: 0, moving: false } });
    await tick();
  }
  await tick(10);
};
await fallFrom(B, 60, 2);
check(sim.lives.hp('player:b') === undefined, 'a 2 m drop on foot does not hurt');
await fallFrom(B, 60, 20);
const fell = hp(B.c, 'player:b'), want = 100 - (Math.sqrt(2 * 9.81 * 20) - HEALTH.player.safe) * HEALTH.perMs;
check(fell !== null && Math.abs(fell - want) < 6, `a 20 m fall on foot hurts (${fell}, ~${Math.round(want)})`);

// the wreck as A's page draws it: charred, its rotors still, a smoke column over it; the same look given a whole craft
// again drawn as it was
{
  const look = craftLook('helicopter'), inner = look.look, c = seen(A), frame = { dt: 0.1, alpha: 1, night: 0, now: 0 };
  const paints = () => { const out = []; look.group.traverse((o) => { if (o.isMesh) out.push(o.material.color.getHex()); }); return out; };
  // (with a pilot at the controls: a whole one's rotor turns then, on the ground too)
  look.draw({ ...c, pilot: 'p', wreck: false }, frame);
  const before = paints(), spun = inner.rotor.rotation.y;
  look.draw({ ...c, pilot: 'p', wreck: false }, frame);
  const turning = inner.rotor.rotation.y !== spun;
  look.draw({ ...c, pilot: 'p' }, frame);
  const r0 = inner.rotor.rotation.y;
  look.draw({ ...c, pilot: 'p' }, frame);
  wreckSmoke.update(0.016, { x: 0, y: 0, z: 0 });
  const after = paints(), char = new THREE.Color(WRECK_COL).getHex();
  check(turning && inner.rotor.rotation.y === r0, `a wreck's rotor stands (it turned before: ${turning})`);
  check(after.every((h) => h === char), `the wreck is drawn charred (${new Set(after).size} paint, ${after.length} parts)`);
  check(wreckSmoke.mesh.count > 0 && wreckSmoke.mesh.visible, `smoke rises over it (${wreckSmoke.mesh.count} puffs)`);
  look.draw({ ...c, wreck: false }, frame);
  wreckSmoke.update(0.016, { x: 0, y: 0, z: 0 });
  check(paints().join() === before.join() && wreckSmoke.mesh.count === 0, 'the look given a whole craft again: its paint back, no smoke');
  // every craft's wreck charred and smoking
  const types = Object.keys(CORES), bad = [];
  for (const type of types) {
    const l = craftLook(type), core = CORES[type](DEFAULT_TUNING), lit = [];
    l.draw({ id: 500, type, pilot: null, placed: true, wreck: true, core }, frame);
    wreckSmoke.update(0.016, { x: 0, y: 0, z: 0 });
    // (a vertex-coloured model's paint is its colours times the material's: a dark one)
    const charred = (m) => m.blending === THREE.AdditiveBlending || m.color.getHex() === char || (m.vertexColors && Math.max(m.color.r, m.color.g, m.color.b) < 0.05);
    l.group.traverse((o) => { if (o.isMesh && !charred(o.material)) lit.push(o.material.color.getHexString()); });
    if (lit.length || !wreckSmoke.mesh.count) bad.push(`${type}: ${lit.length} not charred, ${wreckSmoke.mesh.count} puffs`);
  }
  check(!bad.length, `every craft's wreck charred and smoking (${types.join(', ')}) ${bad.join('; ')}`);
  // the cost: 10 wrecked helicopters and 10 whole ones, the draw calls (meshes drawn) and the CPU time a frame
  const scene = new THREE.Scene(), looks = Array.from({ length: 10 }, () => craftLook('helicopter'));
  for (const l of looks) scene.add(l.group);
  scene.add(wreckSmoke.mesh);
  const calls = () => { let n = 0; scene.traverseVisible((o) => { if (o.isMesh && (!o.isInstancedMesh || o.count > 0)) n++; }); return n; };
  const run = (wreck) => {
    const t0 = performance.now();
    for (let f = 0; f < 200; f++) {
      looks.forEach((l, i) => l.draw({ ...c, id: 1000 + i, wreck }, frame));
      wreckSmoke.update(0.016, { x: 0, y: 0, z: 0 });
    }
    return [calls(), (performance.now() - t0) / 200];
  };
  run(true); run(false);
  const [whole, wholeMs] = run(false), [wrecks, wrecksMs] = run(true);
  check(wrecks === whole + 1, `10 wrecks in view: ${wrecks} draw calls, ${whole} whole (the smoke one more); CPU ${wrecksMs.toFixed(3)} ms a frame, ${wholeMs.toFixed(3)} whole`);
}

host.dispose();
if (fail.length) { for (const f of fail) console.log(`FAIL ${f}`); process.exit(1); }
console.log('PASS health');
