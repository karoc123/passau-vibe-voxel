// The paraglider let go of and opened again, on a small synthetic world (no city data): through the real host
// (WorldSim, SimServer, a client per player over a CloneLink) player A flies a paraglider (its shell's CraftLink), lets
// go of it into a free fall on foot (nav/foot.ts fallAt, its poses sent as the page's walk sends them), opens a canopy
// again while falling, and does so many times; B, near, sees the wing vanish and the body fall, then the wing again.
// The fall keeps the wing's velocity, stays within the host's walk bound (no pose clamped), and lands; on the ground (or
// a jump high) no canopy opens.
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
const { GLIDER_HEIGHT } = await imp('src/sim/craft/craft-motion.ts');
const { WALK_BOUNDS, boundWalk } = await imp('src/sim/walk-bounds.ts');
const { CraftLink } = await imp('src/nav/craft.ts');
const { Foot } = await imp('src/nav/foot.ts');
const { CANOPY_DROP } = await imp('src/sim/walker.ts');
const { Glide } = await imp('src/nav/glide.ts');
const { MoveKeys } = await imp('src/nav/move-keys.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));

// flat ground, its top at y 10
const G = 10, { meta } = await makeWorld({ size: [256, 256], ground: () => G });
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
const ctx = { sim: Promise.resolve(A.c), tiles: { meta, cache, now: () => performance.now() } };
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
const flyFrame = () => { glider.input({ drive: 0, turn: 0, lift: 0, side: 0 }); tick(); };
const release = () => {
  const { p, velocity: v, heading } = glider.craft.core.motion, vel = { ...v };
  glider.close(true);
  foot.fallAt({ x: p.x, y: p.y - GLIDER_HEIGHT, z: p.z }, vel, heading);
  body = false; last = null;
  return vel;
};
// as the shell opens one (special-craft.ts canopy): refused unless falling high enough
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
