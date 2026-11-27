// Swimming on foot, on a small synthetic world (no city data) through the real host (WorldSim, SimServer, a client per
// player over a CloneLink): the page's walk (nav/foot.ts on the World the viewer builds from the same node files, its
// water one voxel over the soil as the data has it) walks player A from a low bank into a basin: it wades, then swims
// (the eyes just over the water, never under the bed, never on the water's top, slower than walking), turns back and
// climbs out onto the bank 1 m over the water; at a quay 4 m high it stays in the water. Walked off a footbridge and
// let go of from high up (a paraglider's fall) it goes in without landing on the water, sinks a little and comes up.
// The host takes every pose unclamped and B, near, sees A swim and then walk.
// usage (in web/): node tools/swim.mjs; prints PASS lines, or FAIL and exit 1
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
const { Foot } = await imp('src/nav/foot.ts');
const { FLOAT, CLIMB_OUT } = await imp('src/sim/swim.ts');
const { EYE } = await imp('src/nav/spots.ts');
const { Glide } = await imp('src/nav/glide.ts');
const { MoveKeys } = await imp('src/nav/move-keys.ts');

const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));

// a basin (x 60..110, z 40..220) of water at 5 m; west of it a bank at 6 m (1 m over the water), east a quay at 9 m;
// a footbridge across it (z 150..154) at 13 m
const WATER = 5, BANK = 6, QUAY = 9, DECK = 13;
const wet = (x, z) => x >= 60 && x < 110 && z >= 40 && z < 220;
const tw = await makeWorld({
  size: [256, 256],
  ground: (x, z) => (wet(x, z) ? WATER : x >= 110 ? QUAY : BANK),
  surface: (x, z) => (wet(x, z) ? 'water' : 'earth'),
  boxes: [{ x0: 56, x1: 114, z0: 150, z1: 154, y0: DECK - 1, y1: DECK, mat: 'deck' }],
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
const A = player('a', 85, 128), B = player('b', 85, 120), all = [A, B];
const tick = () => { for (const p of all) p.c.update(STEP); server.update(STEP); for (const p of all) p.link.deliver(); };
tick();

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
const foot = new Foot(camera, { target: new THREE.Vector3() }, new MoveKeys(), new Glide(camera), () => world, () => []);

// A's frame as the page's (nav.ts update, walkBody): the walk, its pose to the host (put down first), the host's tick;
// a pose the host took otherwise than sent is clamped. Every frame: the soles never under the bed, never on the water
let body = false, clamped = 0, underBed = 0, onWater = 0;
const surface = () => foot.wet.surface(foot.pos.x, foot.pos.z);
const bed = () => foot.wet.support(foot.pos.x, foot.pos.z, foot.feet + 0.01);
const frame = (stick) => {
  foot.updateWalk(STEP, stick);
  const s = surface();
  // (afloat or sinking; walking up the shelf to a shallower bed is a step up, as onto a kerb)
  if (s !== null && (foot.swimming || foot.vy < 0) && foot.feet < bed() - 1e-6) underBed++;
  if (s !== null && s - bed() > 2 && Math.abs(foot.feet - s) < 0.05 && foot.vy === 0) onWater++;
  const pose = { x: foot.pos.x, y: foot.feet, z: foot.pos.z, h: foot.yaw, moving: !!stick, arm: 0, ...(foot.swimming ? { swim: true } : {}) };
  A.c.send(body ? { kind: 'seatInput', role: 'walker', input: pose } : { kind: 'request', request: { kind: 'walk', pose } });
  body = true;
  tick();
  const W = sim.players.get('a')?.walk?.pose;
  if (W && Math.hypot(W.x - pose.x, W.y - pose.y, W.z - pose.z) > 1e-6) clamped++;
};
const seen = () => B.c.traffic.avatars.find((a) => a.player === 'a')?.pose;
const ahead = [1, 0];
const face = (h) => { foot.yaw = h; };

// on the bank facing the water (+x), walking in (slowly: the shallows are a step wide)
foot.fallAt({ x: 50, y: BANK, z: 128 }, { x: 0, y: 0, z: 0 }, Math.PI / 2);
let waded = false, swamAt = null;
for (let i = 0; i < 30 / STEP && foot.pos.x < 85; i++) {
  frame(foot.pos.x < 59 || foot.pos.x > 63 ? ahead : [0.2, 0]);
  const s = surface();
  if (s !== null && !foot.swimming && foot.feet < s - 0.2 && Math.abs(foot.feet - bed()) < 1e-6) waded = true;
  if (foot.swimming && swamAt === null) swamAt = foot.pos.x;
}
check(waded && swamAt !== null && swamAt < 63, `walked in from the bank: waded on the bottom first, afloat from x ${swamAt?.toFixed(1)} (the edge at 60)`);
for (let i = 0; i < 2 / STEP; i++) frame(null);
const eye = foot.pos.y - WATER;
check(foot.swimming && Math.abs(eye - (EYE - FLOAT)) < 0.05 && !foot.under, `afloat in deep water: the eyes ${eye.toFixed(2)} m over it (${(WATER - bed()).toFixed(1)} m deep)`);
let x0 = foot.pos.x;
for (let i = 0; i < 1 / STEP; i++) frame(ahead);
const swim = foot.pos.x - x0;
check(swim > 1.4 && swim < 2.1 && foot.swimming, `swimming at ${swim.toFixed(2)} m/s (walking: 6)`);
foot.jump();
frame(null);
check(foot.feet < WATER - FLOAT + 0.1, 'no jump out of the water afloat');
check(seen()?.swim === true && Math.abs(seen().y - foot.feet) < 0.5, `B sees A swimming (its pose's swim, at ${seen()?.y.toFixed(2)})`);

// at the quay 4 m over the water: no way up, it stays afloat beside it
for (let i = 0; i < 20 / STEP && foot.pos.x < 109; i++) frame(ahead);
for (let i = 0; i < 2 / STEP; i++) frame(ahead);
check(foot.swimming && foot.pos.x < 110 && foot.pos.x > 108 && foot.feet < WATER, `at a quay ${QUAY - WATER} m over the water: still afloat beside it (x ${foot.pos.x.toFixed(2)}), not up it`);

// back west to the bank 1 m over the water: climbed out
face(-Math.PI / 2);
let out = false;
for (let i = 0; i < 40 / STEP && !out; i++) { frame(ahead); out = foot.pos.x < 59 && foot.feet === BANK && !foot.swimming; }
for (let i = 0; i < 0.5 / STEP; i++) frame(ahead);
check(out && foot.feet === BANK && foot.pos.x < 58, `climbed out onto the bank ${BANK - WATER} m over the water (up to ${CLIMB_OUT} m: x ${foot.pos.x.toFixed(1)}, feet at ${foot.feet})`);
check(!seen()?.swim && Math.abs(seen().y - BANK) < 0.5, 'B sees A walking again');

// a fall into the water: tracked until afloat again (the soles' lowest, the eyes' under the water, a landing on it)
const fall = (what, frames, stick) => {
  let low = Infinity, under = 0, hitTop = false;
  for (let i = 0; i < frames; i++) {
    frame(stick && foot.feet > WATER ? stick : null);
    low = Math.min(low, foot.feet);
    if (foot.under) under++;
    if (Math.abs(foot.feet - WATER) < 1e-6 && foot.vy === 0) hitTop = true;
  }
  const e = foot.pos.y - WATER;
  check(!hitTop && low < WATER - FLOAT - 0.05 && foot.swimming && Math.abs(e - (EYE - FLOAT)) < 0.08,
    `${what}: into the water without landing on it, sank to ${(WATER - low).toFixed(1)} m (eyes under for ${(under * STEP).toFixed(2)} s), afloat again (eyes ${e.toFixed(2)} m over it)`);
};
// walked off the footbridge 8 m over the water
foot.fallAt({ x: 85, y: DECK, z: 152 }, { x: 0, y: 0, z: 0 }, 0);
body = false;
for (let i = 0; i < 5; i++) frame(null);
check(foot.feet === DECK, `on the footbridge (${foot.feet})`);
fall('walked off a footbridge 8 m up', 4 / STEP, ahead);
// let go of a paraglider 40 m up, falling at 30 m/s
foot.fallAt({ x: 85, y: WATER + 40, z: 100 }, { x: 4, y: -30, z: 0 }, 0);
body = false;
fall('a fall from 40 m (a paraglider let go of)', 5 / STEP, null);

check(underBed === 0 && onWater === 0, `never under the bed (${underBed} frames), never stood on the water (${onWater})`);
check(clamped === 0, `the host took every pose unclamped (${clamped} clamped)`);

if (fail.length) process.exit(1);
