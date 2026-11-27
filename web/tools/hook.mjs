// The grappling hook, on a small synthetic world (no city data) through the real host (WorldSim, SimServer, a client
// per player over a CloneLink): on foot (the page's walk, nav/foot.ts, on the World the viewer builds) a hook at a
// wall reels the player there and they land standing, one under a roof's edge pulls them up onto the roof, one high on
// a wall leaves them hanging until a jump, one down from the roof lands them unhurt; beyond the range and at the sky
// nothing happens; a point behind a thin wall never takes the body through it, at a slow frame rate either. Under the
// paraglider (its core on the host, the pilot's input carrying the point) a hook reels the wing up and on, and let go
// it glides again; a point beyond the range does nothing. Every frame the body and the wing are out of the voxels,
// and the host takes every pose unclamped.
// usage (in web/): node tools/hook.mjs; prints PASS lines, or FAIL and exit 1
import * as THREE from 'three';
import { imp, sessionLink } from './lib.mjs';

const { makeWorld } = await imp('checks/world.ts');
const { worldOf } = await imp('checks/collision-checks.ts');
const { TileCache } = await imp('src/core/tile-cache.ts');
const { fetchGzip } = await imp('src/fetch.ts');
const { WorldSim } = await imp('src/sim/world-sim.ts');
const { SimServer } = await imp('src/sim/server/sim-server.ts');
const { sandbox } = await imp('src/sim/modes/sandbox.ts');
const { MirrorSimClient, CloneLink } = await imp('src/client/sim-client.ts');
const { hello } = await imp('src/sim/hello.ts');
const { STEP } = await imp('src/sim/road-net.ts');
const { CraftLink } = await imp('src/nav/craft.ts');
const { Foot } = await imp('src/nav/foot.ts');
const { HEAD } = await imp('src/sim/walk.ts');
const { HOOK } = await imp('src/sim/hook.ts');
const { CRAFT } = await imp('src/sim/craft/craft-motion.ts');
const { Glide } = await imp('src/nav/glide.ts');
const { MoveKeys } = await imp('src/nav/move-keys.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));

// flat ground at 10 m; a house 20 m high (x 100..110, z 60..70), a tower 80 m high (x 150..160, z 120..136), a wall
// 1 m thick and 6 m high (x 60..61, z 180..220)
const G = 10, ROOF = 30;
const tw = await makeWorld({
  size: [256, 256], ground: () => G,
  boxes: [
    { x0: 100, x1: 110, z0: 60, z1: 70, y0: G, y1: ROOF, mat: 'wall' },
    { x0: 150, x1: 160, z0: 120, z1: 136, y0: G, y1: 90, mat: 'wall' },
    { x0: 60, x1: 61, z0: 180, z1: 220, y0: G, y1: 16, mat: 'wall' },
  ],
});
const world = await worldOf(tw), meta = tw.meta;
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
const A = player('a', 128, 100), B = player('b', 128, 110), all = [A, B];
const tick = (dt = STEP) => { for (const p of all) p.c.update(dt); server.update(dt); for (const p of all) p.link.deliver(); };
tick();

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
const foot = new Foot(camera, { target: new THREE.Vector3() }, new MoveKeys(), new Glide(camera), () => world, () => []);

// A's frame as the page's (nav.ts update, walkBody): the walk, its pose to the host with the hook's point, the host's
// tick. Counted: a frame with the body in a voxel, a pose the host took otherwise than sent
let body = false, clamped = 0, inSolid = 0, fastest = 0;
const frame = () => {
  const y0 = foot.feet, x0 = foot.pos.x, z0 = foot.pos.z;
  foot.updateWalk(STEP, null);
  if (world.blocked(foot.pos.x, foot.pos.z, foot.feet + 0.05, foot.feet + HEAD)) inSolid++;
  fastest = Math.max(fastest, Math.hypot(foot.pos.x - x0, foot.feet - y0, foot.pos.z - z0) / STEP);
  const pose = { x: foot.pos.x, y: foot.feet, z: foot.pos.z, h: foot.yaw, moving: true, arm: 0, ...(foot.hook ? { hook: foot.hook } : {}) };
  A.c.send(body ? { kind: 'seatInput', role: 'walker', input: pose } : { kind: 'request', request: { kind: 'walk', pose } });
  body = true;
  tick();
  const W = sim.players.get('a')?.walk?.pose;
  if (W && Math.hypot(W.x - pose.x, W.y - pose.y, W.z - pose.z) > 1e-6) clamped++;
};
const put = (x, y, z, yaw, pitch) => { foot.fallAt({ x, y, z }, { x: 0, y: 0, z: 0 }, yaw); foot.pitch = pitch; body = false; for (let i = 0; i < 5; i++) frame(); };
const run = (s, until = () => false) => { let i = 0; while (i < s / STEP && !until()) { frame(); i++; } return i * STEP; };
const hurt = () => { const h = A.c.health('player:a'); return h ? h.max - h.hp : 0; };
const seen = () => B.c.traffic.avatars.find((a) => a.player === 'a')?.pose;
const WEST = -Math.PI / 2;

// 1: 30 m east of the house, the hook at its wall at eye height
put(140, G, 65, WEST, 0);
foot.hookShot(world);
check(!!foot.hook && Math.abs(foot.anchor.x - 110) < 0.01, `a hook at a wall 30 m off holds (at x ${foot.anchor?.x.toFixed(1)})`);
let t = run(4, () => !foot.hook);
run(0.5);
check(!foot.hook && foot.pos.x < 111.5 && foot.pos.x > 110 && foot.feet === G && foot.vy === 0,
  `reeled to the wall in ${t.toFixed(2)} s and landed standing (x ${foot.pos.x.toFixed(2)}, feet ${foot.feet.toFixed(2)}, at most ${fastest.toFixed(0)} m/s)`);
check(Math.abs(seen()?.x - foot.pos.x) < 0.5, `B sees A at the wall (x ${seen()?.x.toFixed(1)})`);

// 2: a hook a metre under the roof's edge: up onto the roof
put(140, G, 65, WEST, Math.atan2(ROOF - 1 - foot.pos.y, 30));
foot.hookShot(world);
t = run(4, () => !foot.hook);
run(0.5);
check(!foot.hook && foot.feet === ROOF && foot.pos.x < 110 && foot.vy === 0, `a hook under the roof's edge: pulled up onto the roof in ${t.toFixed(2)} s (x ${foot.pos.x.toFixed(2)}, feet ${foot.feet.toFixed(2)})`);

// 3: from the roof down to the street 30 m off: landed, unhurt (the host counts no fall on the line)
foot.yaw = Math.PI / 2; foot.pitch = Math.atan2(G - foot.pos.y, 30);
for (let i = 0; i < 5; i++) frame();
foot.hookShot(world);
t = run(4, () => !foot.hook);
run(1);
check(!foot.hook && foot.feet === G && foot.pos.x > 125 && hurt() === 0, `a hook from the roof at the street: down in ${t.toFixed(2)} s, standing, unhurt (x ${foot.pos.x.toFixed(1)}, harm ${hurt()})`);

// 4: a hook half way up the wall: hanging there until a jump
put(140, G, 65, WEST, Math.atan2(20 - G - 1.6, 30));
foot.hookShot(world);
run(2.5);
const hungAt = foot.feet;
run(1);
check(!!foot.hook && hungAt > G + 5 && foot.feet === hungAt && foot.pos.x < 111.5, `a hook high on a wall: hanging at ${hungAt.toFixed(1)} m (the ground at ${G}), not falling`);
foot.jump();
run(3);
check(!foot.hook && foot.feet === G, 'a jump lets go: fallen to the street');

// 5: beyond the range, and at the sky: nothing
put(110 + HOOK.range + 5, G, 65, WEST, 0);
foot.hookShot(world);
const far = !foot.hook;
foot.pitch = 1.2;
foot.hookShot(world);
const x5 = foot.pos.x;
run(0.5);
check(far && !foot.hook && foot.pos.x === x5 && foot.feet === G, `a wall ${HOOK.range + 5} m off (the range: ${HOOK.range}) and the sky: no line, the player stays`);

// 6: a point behind a thin wall (an edit put the wall there, or a page lied): never through it, at 10 frames a second too
let through = 0;
for (const dt of [STEP, 0.1]) {
  put(70, G, 200, WEST, 0);
  foot.hookTo({ x: 40, y: G, z: 200 });
  for (let i = 0; i < 3 / dt; i++) {
    foot.move(dt, [], 6, () => null);
    if (world.blocked(foot.pos.x, foot.pos.z, foot.feet + 0.05, foot.feet + HEAD) || foot.pos.x < 61) through++;
  }
  body = false;
}
check(through === 0 && !foot.hook && foot.pos.x > 61 && foot.pos.x < 62.5, `a point behind a wall 1 m thick: stopped at the wall and let go (x ${foot.pos.x.toFixed(2)})`);
check(inSolid === 0 && clamped === 0, `on foot: no frame with the body in a voxel (${inSolid}), the host took every pose as sent (${clamped} clamped)`);

// ---------------------------------------------------------------- the paraglider
foot.fallAt({ x: 5, y: G, z: 5 }, { x: 0, y: 0, z: 0 }, 0);
const ctx = { sim: Promise.resolve(A.c), tiles: { meta, cache, now: () => performance.now() } };
const glider = new CraftLink(ctx, 'paraglider');
await null;
let wingIn = 0;
const fly = (hook) => {
  glider.input({ drive: 0, turn: 0, lift: 0, side: 0, ...(hook ? { hook } : {}) });
  tick();
  const p = glider.craft?.core.motion.p;
  if (p && world.blocked(p.x, p.z, p.y - 0.4, p.y + 0.4)) wingIn++;
};
const motion = () => glider.craft.core.motion;
// 50 m over the street, 70 m west of the tower, flying at it
glider.open();
glider.spawn({ x: 80, y: G + 50, z: 128, h: Math.PI / 2, speed: CRAFT.paraglider.trim });
for (let i = 0; i < 400 && !(glider.craft && motion().p.x > 82); i++) { fly(); await new Promise((r) => setTimeout(r, 2)); }
check(A.c.seat()?.role === 'pilot' && motion().p.x > 82, `A flies the paraglider (x ${glider.craft?.core.motion.p.x.toFixed(1)})`);

// a point 150 m up and away: beyond the range, the wing glides as it did
for (let i = 0; i < 30; i++) fly({ x: 150, y: G + 190, z: 128 });
check(motion().speed < CRAFT.paraglider.trim + 0.5 && motion().velocity.y < 0, `a point beyond the range: the wing glides on (${motion().speed.toFixed(1)} m/s, ${motion().velocity.y.toFixed(1)} m/s up)`);

// the hook high on the tower's face: reeled up and on, let go near it (as the shell does), the glide back
const at = { x: 150, y: 88, z: 128 }, y0 = motion().p.y;
let top = 0, reeled = 0;
for (let i = 0; i < 6 / STEP; i++) {
  const m = motion(), p = m.p;
  if (Math.hypot(at.x - p.x, at.y - p.y, at.z - p.z) < HOOK.near || glider.craft.core.result === 'blocked') break;
  fly(at);
  top = Math.max(top, Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z));
  reeled += STEP;
}
const yHook = motion().p.y;
check(top > 0.8 * HOOK.glide && yHook > y0 + 15 && motion().p.x < 150, `a hook on the tower: reeled ${(yHook - y0).toFixed(0)} m up in ${reeled.toFixed(1)} s at up to ${top.toFixed(0)} m/s, to x ${motion().p.x.toFixed(1)} (the face at 150)`);
let peak = yHook;
for (let i = 0; i < 4 / STEP; i++) {
  // (turned away from the tower, as a pilot would)
  glider.input({ drive: 0, turn: 1, lift: 0, side: 0 });
  tick();
  const p = motion().p;
  if (world.blocked(p.x, p.z, p.y - 0.4, p.y + 0.4)) wingIn++;
  peak = Math.max(peak, p.y);
}
const m = motion();
check(!glider.craft.core.ended && m.speed < CRAFT.paraglider.trim + 2 && m.velocity.y < 0 && m.velocity.y > -4 && A.c.seat()?.role === 'pilot',
  `let go: the wing glides again (${m.speed.toFixed(1)} m/s, sinking ${(-m.velocity.y).toFixed(1)} m/s; carried ${(peak - yHook).toFixed(1)} m higher first)`);
check(wingIn === 0, `the wing never in a voxel, the tower's among them (${wingIn} frames)`);
check(B.c.crafts().some((c) => c.type === 'paraglider' && Math.abs(c.core.pose.y - m.p.y) < 3), 'B sees the wing where A flies it');

if (fail.length) { console.log(`${fail.length} failed`); process.exit(1); }
process.exit(0);
