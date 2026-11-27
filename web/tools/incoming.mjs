// Incoming fire told to the player it is aimed at (client/incoming.ts, the one place that reads a host's event as
// fire at the page's player; ui/incoming.ts draws its arcs) through a real host in Node (host/node.ts nodeHost, a
// client over a CloneLink) on a flat synthetic world, once per kind of enemy shooter: an NPC on foot at a player on
// foot, a camp's lookout at a player in a helicopter, an enemy plane at a player on foot. Each time, from the events
// the player's page is sent: a hit names where the shooter is (as the host has it), a shot that misses close by is a
// near miss from there too, and the arc's place on the screen's rim is the side a camera sees the shooter on. A
// kind of shooter added to the game gets its run here. The view: another's tracer far off is wide enough to see.
// usage (in web/): node tools/incoming.mjs; prints PASS lines, or FAIL and exit 1
import { imp, sessionLink, synthData } from './lib.mjs';

const { nodeHost } = await imp('src/host/node.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { DEFAULT_TUNING } = await imp('src/sim/tuning.ts');
const { incoming, bearing } = await imp('src/client/incoming.ts');
const THREE = await imp('node_modules/three/build/three.module.js');
const { WeaponsView } = await imp('src/view/weapons/weapons-view.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));
const settle = () => new Promise((r) => setImmediate(r));
// (the host's clock, which paces its crafts' tile fetches, runs with the simulated ticks)
let simMs = 0;
performance.now = () => simMs;

const G = 5, SIZE = 2816, O = { x: 1408.5, z: 1408.5 };
const { dir, data } = await synthData({ size: [SIZE, SIZE], ground: () => G, surface: () => 'earth', boxes: [] });
// (the player stands through every hit; a camp of its lookout alone, no plane of its own)
const H = DEFAULT_TUNING.health;
const tuning = { ...DEFAULT_TUNING, camps: { ...DEFAULT_TUNING.camps, squad: [0], planes: 0 }, health: { ...H, player: { ...H.player, max: 1e6 } } };

// a host with player a, whose page reads its events as the viewer does: where(): the player's place, as the page has it
function world(camps = []) {
  const host = nodeHost(dir, { world: 'tiles', physics: { bodies: false }, tuning, camps, stands: false }, structuredClone(data));
  const sim = host.sim, link = sessionLink(host.connect('a')), c = new MirrorSimClient(new CloneLink(link), { roads: [], peds: [], ctrls: [] }, null, host.hello);
  const W = { host, sim, c, each: null, got: [] };
  let seen = 0;
  W.tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      simMs += STEP * 1000;
      W.each?.();
      c.update(STEP); host.update(STEP); link.deliver(); await settle();
      const at = W.where();
      for (const e of c.eventsSince(seen)) {
        const i = c.player && incoming(e, { player: c.player, body: c.seat()?.entity ?? null, at });
        if (i) W.got.push({ ...i, me: { ...at }, shooter: W.shooter(i.by) });
      }
      seen = c.tick;
    }
  };
  W.walk = (p, h = 0) => {
    const pose = { x: p.x, y: G, z: p.z, h, moving: false };
    c.send({ kind: 'view', view: { focus: { x: p.x, z: p.z } } });
    c.send({ kind: 'request', request: { kind: 'walk', pose } });
    W.where = () => pose;
  };
  // until fire of the kind wanted (hit or near miss) reached the page, secs at most
  W.until = async (hit, secs) => { for (let i = 0; i < secs / STEP && !W.got.some((g) => g.hit === hit && g.shooter); i++) await W.tick(); return W.got.find((g) => g.hit === hit && g.shooter) ?? null; };
  return W;
}

const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 5000);
// g, fire the page read: its `from` against the shooter's place on the host, and its arc against a camera's view of
// the shooter at four headings (facing it, either side, nearly behind)
function points(g, what) {
  if (!g) { check(false, `${what}: none reached the page`); return; }
  const s = g.shooter, off = Math.hypot(g.from.x - s.x, g.from.z - s.z), far = Math.hypot(s.x - g.me.x, s.z - g.me.z);
  const facing = Math.atan2(s.x - g.me.x, s.z - g.me.z);
  let sides = 0, worst = 0;
  for (const turn of [0, 1, -1, 2.6]) {
    const h = facing + turn, b = bearing(g.from, g.me, h), truth = bearing(s, g.me, h);
    worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(b - truth), Math.cos(b - truth))));
    camera.position.set(g.me.x, G + 1.6, g.me.z);
    camera.lookAt(g.me.x + Math.sin(h), G + 1.6, g.me.z + Math.cos(h));
    camera.updateMatrixWorld();
    const ndc = new THREE.Vector3(s.x, G + 1.6, s.z).project(camera);
    // (ahead and to the camera's right: the arc right of the top; turned away from it: the arc in the lower half)
    if (turn === 0 ? Math.abs(b) < 0.1 : Math.abs(turn) === 1 ? ndc.z < 1 && Math.sign(ndc.x) === Math.sign(Math.sin(b)) && Math.cos(b) > 0 : Math.cos(b) < 0) sides++;
  }
  check(off < Math.max(4, 0.05 * far) && worst < 0.06 && sides === 4,
    `${what}: from ${far.toFixed(0)} m off, the page's direction is the shooter's (${off.toFixed(1)} m beside it, ${(worst * 180 / Math.PI).toFixed(1)}° off at worst), its arc on the camera's side of the screen at ${sides} of 4 headings`);
}

// ---- an NPC on foot fires at a player on foot 25 m in front of it
{
  const W = world(), { sim } = W, at = { x: O.x, y: G, z: O.z + 25 };
  W.walk(O, 0);
  await W.tick(20);
  const id = sim.addNpc(at, undefined, { kind: 'guard', x: at.x, z: at.z, h: Math.PI });
  W.shooter = (by) => (by === `npc${id}` ? { ...sim.npcs.all.get(id).pose } : null);
  points(await W.until(true, 30), 'an NPC on foot hits a player on foot');
  points(await W.until(false, 30), 'its shot that misses close by is a near miss');
  check(W.c.seat()?.role === 'walker' && W.got.every((g) => g.by !== 'a'), 'the player on foot; no fire of their own is read as incoming');
  W.host.dispose();
}

// ---- a camp's lookout fires at a player in a helicopter 150 m off, 60 m up; seen from there its tracer is wide
{
  const camp = { name: 'test', x: O.x, z: O.z, h: 0, lookout: { x: O.x, z: O.z, h: 0 } };
  const W = world([camp]), { sim, c } = W, spot = { x: O.x + 30, y: G + 60, z: O.z + 280, h: Math.PI / 2 };
  c.send({ kind: 'view', view: { focus: { x: spot.x, z: spot.z } } });
  c.send({ kind: 'request', request: { kind: 'craft', type: 'helicopter', spot } });
  W.where = () => spot;
  W.shooter = () => null;
  await W.tick(10);
  const id = [...sim.crafts.values()][0]?.id;
  W.each = () => sim.placeCraft(id, spot);
  const lookout = () => [...sim.npcs.all.values()].find((n) => n.mind?.duty.kind === 'lookout' && n.dead === null);
  W.shooter = (by) => { const n = lookout(); return n && by === `npc${n.id}` ? { ...n.pose } : null; };
  // (a camp mans no place in front of a player: the helicopter comes near once its lookout stands)
  for (let i = 0; i < 300 && !lookout(); i++) await W.tick();
  spot.z = O.z + 150;
  const scene = new THREE.Scene(), view = new WeaponsView(scene, c), eye = new THREE.Vector3(spot.x, spot.y, spot.z);
  let wide = 0, drawn = 0;
  const tick = W.tick;
  W.tick = async (n) => {
    await tick(n);
    view.update(STEP, [], eye);
    scene.traverse((o) => { if (o.visible && o.geometry?.type === 'BoxGeometry') { drawn++; if (o.scale.x >= 0.002 * o.position.distanceTo(eye)) wide++; } });
  };
  const g = await W.until(true, 60);
  check(c.seat()?.entity.kind === 'craft' && c.seat().entity.id === id, 'the player at a helicopter\'s controls');
  points(g, 'a lookout hits a player\'s helicopter');
  await W.tick(10);
  check(drawn > 0 && wide === drawn, `its tracers seen from the helicopter are never thinner than 2 mm a metre of distance (${wide} of ${drawn} drawn)`);
  W.host.dispose();
}

// ---- an enemy plane passes at a player on foot in the open
{
  const W = world(), { sim } = W;
  W.walk(O, 0);
  await W.tick(20);
  const id = sim.callPlane(O);
  W.shooter = (by) => (id !== null && sim.enemies.get(id)?.name === by ? { ...sim.crafts.get(id).core.pose } : null);
  points(await W.until(true, 240), 'an enemy plane hits a player on foot');
  W.host.dispose();
}

if (fail.length) { console.log(`FAIL ${fail.length}`); process.exit(1); }
