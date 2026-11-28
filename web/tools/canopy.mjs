// The paraglider let go of and opened again, on a small synthetic world (no city data): through the real host
// (WorldSim, SimServer, a client per player over a CloneLink) player A flies a paraglider (its shell's CraftLink), lets
// go of it into a free fall on foot (nav/foot.ts fallAt, its poses sent as the page's walk sends them), opens a canopy
// again while falling, and does so many times; B, near, sees the wing vanish and the body fall, then the wing again.
// The fall keeps the wing's velocity, stays within the host's walk bound (no pose clamped), and lands; on the ground (or
// a jump high) no canopy opens. Out of every aircraft and the drone low in the air, where none opens, the body starts
// beside the craft's boxes at its height and falls from there, the host taking that start as it is. Beside a wall a
// canopy is refused, in the open it fits.
// usage (in web/): node tools/canopy.mjs; prints PASS lines, or FAIL and exit 1
import * as THREE from 'three';
import { imp, sessionLink } from './lib.mjs';

const { makeWorld } = await imp('checks/world.ts');
const { TileCache } = await imp('src/core/tile-cache.ts');
const { fetchGzip } = await imp('src/fetch.ts');
const { WorldSim } = await imp('src/sim/world-sim.ts');
const { SimServer } = await imp('src/sim/server/sim-server.ts');
const { sandbox } = await imp('src/sim/modes/sandbox.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { hello } = await imp('src/sim/hello.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { GLIDER_HEIGHT, CRAFT } = await imp('src/sim/craft/craft-motion.ts');
const { CORES } = await imp('src/sim/craft/cores.ts');
const { WALK_BOUNDS, boundWalk, letGo } = await imp('src/sim/walk-bounds.ts');
const { CraftLink, AIRCRAFT } = await imp('src/nav/craft.ts');
const { canopyFits } = await imp('src/sim/craft/craft-collision.ts');
const { besideSolids, craftMeets, reach, meetShapes } = await imp('src/sim/solids.ts');
const { Foot } = await imp('src/nav/foot.ts');
const { CANOPY_DROP, canopyOpens } = await imp('src/sim/walker.ts');
const { Glide } = await imp('src/nav/glide.ts');
const { MoveKeys } = await imp('src/nav/move-keys.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));

// flat ground, its top at y 10; a wall 80 m high off to one side (x 200..204), where nothing else here flies
const G = 10, WALL = { x0: 200, x1: 204, z0: 150, z1: 250, y0: G, y1: G + 80, mat: 'wall' };
const { meta } = await makeWorld({ size: [256, 256], ground: () => G, boxes: [WALL] });
const cache = new TileCache({ N: meta.tiles.N, load: (p) => fetchGzip(`data/tiles/${p}`) });
const traffic = () => ({ roads: [], peds: [], ctrls: [] });
const sim = new WorldSim(traffic(), { crafts: { meta, cache, now: () => performance.now() } });
const server = new SimServer(sim, sandbox(), null, { nodes: () => [], ready: async () => () => {} });
server.interest = 400;

const player = (name, x, z) => {
  const s = server.connect(name), link = sessionLink(s), c = new MirrorSimClient(new CloneLink(link), traffic(), null, hello(null));
  c.send({ kind: 'view', view: { focus: { x, z } } });
  return { c, link };
};
const A = player('a', 128, 128), B = player('b', 140, 128), all = [A, B];
const tick = () => { for (const p of all) p.c.update(STEP); server.update(STEP); for (const p of all) p.link.deliver(); };
tick();

// A's shell: its CraftLink, and its walk (the page's Foot over the same ground)
const ctx = { nav: { stepOut: null }, sim: Promise.resolve(A.c), tiles: { meta, cache, now: () => performance.now() } };
const glider = new CraftLink(ctx, 'paraglider');
await null;
const world = { support: () => G, blocked: () => false };
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
const foot = new Foot(camera, { target: new THREE.Vector3() }, new MoveKeys(), new Glide(camera), () => world, () => []);

// the page's walk body (nav.ts walkBody): put down the first frame, then its pose each frame
let body = false, clamped = 0, fastest = 0, last = null;
const walkFrame = () => {
  foot.updateWalk(STEP, null);
  const pose = { x: foot.pos.x, y: foot.feet, z: foot.pos.z, h: foot.yaw, moving: true, arm: 0 };
  if (last && boundWalk(last, pose, STEP) !== pose) clamped++;
  fastest = Math.max(fastest, -foot.vy);
  last = pose;
  A.c.send(body ? { kind: 'seatInput', role: 'walker', input: pose } : { kind: 'request', request: { kind: 'walk', pose } });
  body = true;
  tick();
};
const HANDS_OFF = { drive: 0, turn: 0, lift: 0, side: 0 };
const flyFrame = () => { glider.input(HANDS_OFF); tick(); };
const release = () => {
  const { p, velocity: v, heading } = glider.craft.core.motion, vel = { ...v };
  glider.close(true);
  foot.fallAt({ x: p.x, y: p.y - GLIDER_HEIGHT, z: p.z }, vel, heading);
  body = false; last = null;
  return vel;
};
// as X on foot opens one (nav.ts openWing): refused unless falling high enough
const reopen = () => {
  if (!foot.canOpen) return false;
  const speed = Math.hypot(foot.carry.x, foot.carry.z), h = speed > 1 ? Math.atan2(foot.carry.x, foot.carry.z) : foot.yaw;
  glider.open();
  glider.spawn({ x: foot.pos.x, y: foot.feet + GLIDER_HEIGHT, z: foot.pos.z, h, speed });
  return true;
};
const bCrafts = () => B.c.crafts().filter((c) => c.type === 'paraglider');
const bAvatars = () => B.c.traffic.avatars.filter((a) => a.player === 'a');

// a wing 300 m up, flying at 16 m/s along +x; its tiles loaded before the steps
glider.open();
glider.spawn({ x: 60, y: G + 300, z: 128, h: Math.PI / 2, speed: 16 });
for (let i = 0; i < 400 && !(glider.craft && glider.craft.core.motion.p.x > 75); i++) { flyFrame(); await new Promise((r) => setTimeout(r, 2)); }
check(A.c.seat()?.role === 'pilot' && glider.craft?.core.motion.p.x > 75 && bCrafts().length === 1 && bCrafts()[0].pilot === 'a',
  `A flies the paraglider and B sees it (x ${glider.craft?.core.motion.p.x.toFixed(1)})`);

// let go: a body falls from where the wing was, its velocity kept
const v0 = release(), x0 = foot.pos.x, y0 = foot.feet;
for (let i = 0; i < 30; i++) walkFrame();
const across = (foot.pos.x - x0) / (30 * STEP);
check(A.c.seat()?.role === 'walker' && A.c.seat()?.entity.kind === 'avatar' && bCrafts().length === 0 && bAvatars().length === 1,
  'let go: A is a body on foot; B sees the wing gone and the body');
check(Math.hypot(v0.x, v0.z) > 8 && across > 0.85 * v0.x && across <= v0.x + 0.01 && foot.feet < y0 - 1,
  `the fall keeps the wing's speed across (${v0.x.toFixed(1)} m/s at release, ${across.toFixed(1)} m/s over 1 s) and drops (${(y0 - foot.feet).toFixed(1)} m)`);
check(Math.abs(bAvatars()[0].pose.y - foot.feet) < 3, `B sees the body falling (at ${bAvatars()[0]?.pose.y.toFixed(1)}, the walk at ${foot.feet.toFixed(1)})`);

// open again while falling: a wing over the body, B sees the wing and no body
check(reopen(), 'falling high, a canopy opens');
for (let i = 0; i < 3; i++) flyFrame();
const m = glider.craft?.core.motion;
check(A.c.seat()?.role === 'pilot' && m && Math.abs(m.p.y - GLIDER_HEIGHT - foot.feet) < 2 && Math.abs(m.p.x - foot.pos.x) < 2 && m.velocity.x > 5,
  `the wing opens where the body is, flying on its way (at ${m?.p.x.toFixed(1)}, ${m?.p.y.toFixed(1)}, ${m?.velocity.x.toFixed(1)} m/s)`);
check(bCrafts().length === 1 && bAvatars().length === 0, 'B sees the wing again and the body gone');

// many times: one wing and no body left over, A seated in each
let seatsOk = true;
for (let k = 0; k < 40; k++) {
  release();
  for (let i = 0; i < 6; i++) walkFrame();
  seatsOk &&= A.c.seat()?.role === 'walker';
  if (!reopen()) { seatsOk = false; break; }
  for (let i = 0; i < 4; i++) flyFrame();
  seatsOk &&= A.c.seat()?.role === 'pilot';
}
check(seatsOk && sim.crafts.size === 1 && sim.avatars.size === 0 && bCrafts().length === 1 && bAvatars().length === 0,
  `40 times let go and opened again: A seated each time, one wing in the world, no body left (${sim.crafts.size} crafts, ${sim.avatars.size} bodies)`);

// Out of every craft into a paraglider within one frame, as X high up does (nav.ts getOut): the craft's controls
// sent that frame are still held by the host for their tick when the seat changes, and are not the wing's (a plane's
// lever taken for a paraglider's input left it hanging in the air). The wing flies: forward at about its trim speed,
// sinking at about its glide's rate, turned by its own input.
const HANDS = { turn: 1, drive: 1, lift: 1, side: 1 }, LEVER = { turn: 1, pitch: 1, throttle: 1 };
const HELD = { boat: { throttle: 1, steer: 1, drift: true }, hovercraft: HANDS, helicopter: HANDS, gunship: HANDS, drone: null, floatplane: LEVER, jet: LEVER, fighter: LEVER };
const others = Object.keys(CORES).filter((t) => t !== 'paraglider'), P = CRAFT.paraglider;
check(others.every((t) => t in HELD), `every craft type has its controls in this gate (${others.filter((t) => !(t in HELD)).join(', ') || 'all'})`);
const flown = [];
glider.close(true);
tick();
for (const type of others.filter((t) => t in HELD)) {
  const from = new CraftLink(ctx, type);
  await null;
  from.open();
  from.spawn({ x: 60, y: G + 300, z: 60, h: Math.PI / 2, speed: 20 });
  for (let i = 0; i < 6; i++) { from.input(HELD[type]); tick(); }
  // (till it flies: the tiles round it are in then, and the wing opened under it steps from its first tick)
  for (let i = 0; i < 400 && !(from.craft && sim.crafts.get(from.craft.id).core.result !== 'loading'); i++) { from.input(HELD[type]); tick(); await new Promise((r) => setTimeout(r, 2)); }
  const id = from.craft?.id, at = from.craft?.core.pose ?? { x: 60, y: G + 300, z: 60 };
  // (its last controls stamped for page ticks to come, as a page that runs ahead of its host's ticks sends them, and
  // the wing's own a few ticks late, as a network bunches them)
  for (let k = 1; k <= 4; k++) A.link.send([{ kind: 'seatInput', role: 'pilot', input: HELD[type], seq: 1e9 + k, tick: A.c.page + k }]);
  from.close();
  glider.open();
  glider.spawn({ x: at.x, y: at.y - 40, z: at.z, h: Math.PI / 2, speed: 16 });
  for (let i = 0; i < 6; i++) { tick(); await new Promise((r) => setTimeout(r, 2)); }
  // (a step waiting for a tile of its collision's is not taken: the tiles given time to come, and only the ticks
  // stepped counted)
  const wing = () => [...sim.crafts.values()].find((c) => c.pilot === 'a' && c.type === 'paraglider');
  const fly = async (n, input) => {
    let stepped = 0;
    for (let i = 0; i < 2000 && stepped < n; i++) {
      glider.input(input); tick();
      if (wing() && wing().core.result !== 'loading') stepped++;
      else await new Promise((r) => setTimeout(r, 2));
    }
    return stepped === n;
  };
  if (!await fly(5, HANDS_OFF)) { flown.push(`NOT ${type}: no paraglider`); continue; }
  const a = { ...wing().core.motion.p };
  await fly(45, HANDS_OFF);
  const b = { ...wing().core.motion.p }, h0 = wing().core.motion.heading, fwd = (b.x - a.x) / (45 * STEP), sink = (a.y - b.y) / (45 * STEP);
  await fly(30, { ...HANDS_OFF, turn: 1 });
  const turned = Math.abs(wing().core.motion.heading - h0);
  const ok = id !== undefined && A.c.seat()?.role === 'pilot' && fwd > 0.7 * P.trim && fwd < 1.6 * P.trim && sink > 0.4 * P.sink && sink < 2 * P.sink && turned > 0.3;
  flown.push(`${ok ? '' : 'NOT '}${type} ${fwd.toFixed(1)} m/s, sinking ${sink.toFixed(2)}, turned ${turned.toFixed(2)} rad`);
  glider.close(true);
  tick();
  if (id !== undefined) sim.removeCraft(id);
}
check(!flown.some((f) => f.startsWith('NOT')), `out of every craft with its controls held, the paraglider flies and answers its own (${flown.join('; ')})`);

// Out of every aircraft, and the drone, low in the air (too low for a canopy under it): as X does there (nav.ts
// fallBeside), the body starts beside the craft's boxes at its height and falls with its velocity; the host puts it
// down there in the tick the seat is left and clamps no pose of the fall.
const LOW = 8, lows = [];
for (const type of [...AIRCRAFT, 'drone']) {
  const from = new CraftLink(ctx, type);
  await null;
  from.open();
  from.spawn({ x: 60, y: G + LOW, z: 60, h: Math.PI / 2, speed: 20 });
  for (let i = 0; i < 400 && !(from.craft && sim.crafts.get(from.craft.id).core.result !== 'loading'); i++) { from.input(HELD[type]); tick(); await new Promise((r) => setTimeout(r, 2)); }
  const c = from.craft;
  if (!c) { lows.push(`NOT ${type}: no craft`); continue; }
  const pose = { ...c.core.pose }, boxes = craftMeets(type, pose), at = besideSolids(world, boxes);
  const under = Math.min(...boxes.map((b) => b.y)), top = Math.max(...meetShapes('paraglider').map((b) => b.top));
  const noCanopy = !canopyOpens(world, pose.x, pose.z, under - 0.5 - top);
  const outside = !!at && boxes.every((b) => reach(b, at.x, at.z, at.y) <= 0), level = !!at && Math.abs(at.y - boxes[0].y) < 0.01 && at.y > G + 3;
  if (!at) { lows.push(`NOT ${type}: no room beside it`); from.close(true); tick(); continue; }
  ctx.nav.stepOut = { ...at, h: pose.h, moving: false };
  from.close();
  ctx.nav.stepOut = null;
  foot.fallAt(at, letGo(c.core.velocity), pose.h);
  body = false; last = null;
  const clamped0 = clamped;
  walkFrame();
  const first = foot.feet, seat = sim.seat('a'), seen = seat && sim.entities.pose(seat.entity), walker = A.c.seat()?.role === 'walker';
  for (let i = 0; i < 60 * 10 && foot.feet > G; i++) walkFrame();
  const ok = noCanopy && outside && level && walker && Math.abs(first - at.y) < 0.5 && !!seen && Math.abs(seen.y - first) < 1.5 && Math.hypot(seen.x - foot.pos.x, seen.z - foot.pos.z) < 30
    && foot.feet === G && clamped === clamped0;
  lows.push(`${ok ? '' : 'NOT '}${type} beside it at ${at.y.toFixed(1)} (its foot ${boxes[0].y.toFixed(1)}, outside ${outside}, no canopy ${noCanopy}), first frame ${first.toFixed(1)}, the host's ${seen?.y.toFixed(1)}, landed ${foot.feet.toFixed(1)}, clamped ${clamped - clamped0}`);
  sim.removeCraft(c.id);
  tick();
}
check(!lows.some((f) => f.startsWith('NOT')), `out of every aircraft and the drone ${LOW} m up, too low for a canopy: the body starts beside its boxes at its height, not on the ground, and falls there (${lows.join('; ')})`);

// A canopy opens only clear of the voxels (special-craft.ts openAt): in the open and 12 m from the wall it fits, 4 m
// from the wall (its span reaches in) it is refused.
const col = new CraftLink(ctx, 'paraglider');
await null;
const fits = async (at) => {
  const w = col.open();
  for (let i = 0; i < 400; i++) { w.prefetch(at, { x: 0, y: 0, z: 0 }); const r = canopyFits(w, at); if (r !== 'loading') return r; await new Promise((r) => setTimeout(r, 5)); }
  return 'loading';
};
const mid = (WALL.z0 + WALL.z1) / 2, wall = [await fits({ x: 120, y: G + 40, z: mid, h: 0 }), await fits({ x: WALL.x0 - 12, y: G + 40, z: mid, h: 0 }), await fits({ x: WALL.x0 - 4, y: G + 40, z: mid, h: 0 })];
check(wall[0] === true && wall[1] === true && wall[2] === false, `a canopy fits in the open and 12 m from a wall, and is refused 4 m from it (${wall.join(', ')})`);

glider.open();
glider.spawn({ x: 60, y: G + 300, z: 128, h: Math.PI / 2, speed: 16 });
for (let i = 0; i < 10; i++) flyFrame();

// let go and fall to the ground: within the host's walk bound all the way (no pose clamped), landed, no canopy there
release();
for (let i = 0; i < 60 * 30 && foot.feet > G; i++) walkFrame();
check(foot.feet === G && foot.vy === 0 && foot.carry.x === 0 && foot.carry.z === 0 && A.c.seat()?.role === 'walker',
  `the fall lands on the ground and stands (falling at most ${fastest.toFixed(1)} m/s)`);
check(clamped === 0 && fastest < WALK_BOUNDS.fall, `no pose of the fall clamped by the host's walk bound (${clamped}, top ${fastest.toFixed(1)} < ${WALK_BOUNDS.fall} m/s)`);
check(!reopen() && A.c.seat()?.role === 'walker' && sim.crafts.size === 0, 'on the ground no canopy opens (refused, A stays on foot)');
foot.jump();
let opened = false;
for (let i = 0; i < 60; i++) { walkFrame(); opened ||= foot.canOpen; }
check(!opened && foot.feet - G < CANOPY_DROP, 'nor at the top of a jump');

if (fail.length) process.exit(1);
