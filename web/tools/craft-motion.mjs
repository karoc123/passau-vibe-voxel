// The player craft motion laws against the same swept voxel probes as the viewer.
// Run from web/ with node tools/craft-motion.mjs.
import { load } from './real-city.mjs';

const { makeWorld } = await load('nav/collision-checks.ts');
const { VoxelCollision } = await load('nav/voxel-collision.ts');
const { craftWorld, CRAFT_RADIUS, SPAWN_HEIGHT } = await load('nav/craft-collision.ts');
const { CraftMotion } = await load('nav/craft-motion.ts');
const { meta } = await makeWorld({
  size: [128, 128],
  ground: (_x, z) => z < 40 ? 5 : 6,
  surface: (_x, z) => z < 40 ? 'water' : 'road',
  boxes: [{ x0: 8, x1: 108, z0: 90, z1: 92, y0: 6, y1: 19, mat: 'wall' }],
});

const out = [];
const check = (name, pass) => out.push({ name, pass });
const dt = 1 / 60;
const neutral = { drive: 0, lift: 0, turn: 0, side: 0 };

async function craft(kind) {
  const col = new VoxelCollision(meta, undefined, { radius: CRAFT_RADIUS[kind] });
  for (let i = 0; i < 1000; i++) {
    col.prefetch({ x: 64, y: 0, z: 64 }, { x: 0, y: 0, z: 0 });
    if (col.surface(64, 64)) return { motion: new CraftMotion(kind), world: craftWorld(kind, col, () => 0) };
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('Synthetic craft collision tiles did not load');
}

function run({ motion, world }, seconds, input = {}) {
  let result;
  for (let frame = 0; frame < Math.round(seconds / dt); frame++) {
    result = motion.step({ ...neutral, ...input }, dt, world);
    if (result === 'landed' || result === 'splash' || result === 'loading') return result;
  }
  return result;
}

const hover = await craft('hovercraft');
hover.motion.reset({ x: 64, y: 5 + SPAWN_HEIGHT.hovercraft, z: 20 }, 0);
run(hover, 4.5, { drive: 1 });
check('hovercraft crosses a low bank from water to land', hover.motion.p.z > 45 && hover.motion.p.y >= 6.65);
run(hover, 16, { drive: -1 });
check('hovercraft crosses from land back to water', hover.motion.p.z < 39 && hover.motion.p.y < 5.8);
hover.motion.reset({ x: 64, y: 6 + SPAWN_HEIGHT.hovercraft, z: 75 }, 0);
check('hovercraft stops at a wall', run(hover, 3, { drive: 1 }) === 'blocked' && hover.motion.p.z < 88.1);
hover.motion.reset({ x: 64, y: 5 + SPAWN_HEIGHT.hovercraft, z: 8 }, 0, 20);
run(hover, 1, { drive: 1, turn: 1 });
{
  const m = hover.motion, across = Math.abs(-m.velocity.x * Math.cos(m.heading) + m.velocity.z * Math.sin(m.heading));
  check('hovercraft turns right on D (the heading falls) and drifts across its nose', m.heading < -0.6 && across > 3);
}
hover.motion.reset({ x: 64, y: 5 + SPAWN_HEIGHT.hovercraft, z: 8 }, 0, 20);
const glideResult = run(hover, 1);
check('hovercraft glides on with the throttle let go', glideResult === 'moving' && hover.motion.speed > 15 && hover.motion.speed < 19);

const heli = await craft('helicopter');
heli.motion.reset({ x: 64, y: 6 + SPAWN_HEIGHT.helicopter, z: 50 }, 0);
run(heli, 2.5, { lift: 1 });
const altitude = heli.motion.p.y;
check('helicopter takes off vertically', altitude > 20 && heli.motion.p.x === 64 && heli.motion.p.z === 50);
run(heli, 4);
const hoverY = heli.motion.p.y;
run(heli, 2);
check('helicopter holds a steady hover', Math.abs(heli.motion.p.y - hoverY) < 0.01 && heli.motion.speed < 0.01);
run(heli, 1.1, { drive: 1 });
check('helicopter flies forward above the wall height, nose down', heli.motion.p.z > 53 && heli.motion.p.y > 20 &&
  heli.motion.pitch < -0.1);
run(heli, 3, { drive: 1 });
const fast = heli.motion.speed;
check('helicopter gathers speed over seconds, not at once', fast > 20 && fast < 35);
run(heli, 6);
check('helicopter settles into a hover with the stick let go', heli.motion.speed < 1);
run(heli, 1, { turn: 1 });
check('helicopter turns right on D (the heading falls)', heli.motion.heading < -0.5);
heli.motion.reset({ x: 64, y: 22, z: 50 }, 0);
run(heli, 2, { side: 1 });
check('helicopter slides sideways to the right on E (toward -x at heading 0)', heli.motion.p.x < 58 && heli.motion.bank > 0.05);
heli.motion.reset({ x: 64, y: heli.motion.p.y, z: 65 }, 0);
run(heli, 12, { lift: -1 });
check('helicopter lands and remains supported', Math.abs(heli.motion.p.y - 7.09) < 0.05 && heli.motion.grounded);
const parked = { ...heli.motion.p };
run(heli, 2, { drive: 1, turn: 1 });
check('helicopter does not taxi or turn on its skids', Math.hypot(heli.motion.p.x - parked.x, heli.motion.p.z - parked.z) < 0.01 &&
  heli.motion.heading === 0);
run(heli, 3, { lift: 1 });
check('helicopter can take off again', heli.motion.p.y > 20);

const glider = await craft('paraglider');
glider.motion.reset({ x: 70, y: 23, z: 45 }, 0, 13);
run(glider, 2, { turn: 1 });
check('paraglider turns right on D and glides toward a landing site', glider.motion.heading < -0.8 &&
  glider.motion.p.x < 66 && glider.motion.p.z > 55 && glider.motion.p.y < 21);
glider.motion.reset({ x: 64, y: 40, z: 45 }, 0, 11);
run(glider, 3);
check('paraglider glides about 8:1 hands up', glider.motion.p.z - 45 > 30 && 40 - glider.motion.p.y < 5);
glider.motion.reset({ x: 64, y: 16, z: 50 }, 0, 11);
check('paraglider touches down on dry ground', run(glider, 20, { drive: -1 }) === 'landed' &&
  Math.abs(glider.motion.p.y - 6.45) < 0.3);
glider.motion.reset({ x: 64, y: 8, z: 30 }, Math.PI, 8);
check('paraglider reports a water landing', run(glider, 4, { drive: -1 }) === 'splash');

for (const { name, pass } of out) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
if (out.some(({ pass }) => !pass)) process.exitCode = 1;
