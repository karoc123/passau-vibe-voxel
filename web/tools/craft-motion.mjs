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
const neutral = { drive: 0, lift: 0, turn: 0 };

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
run(hover, 2.5, { drive: 1 });
check('hovercraft crosses a low bank from water to land', hover.motion.p.z > 45 && hover.motion.p.y >= 6.65);
run(hover, 8, { drive: -1 });
check('hovercraft crosses from land back to water', hover.motion.p.z < 39 && hover.motion.p.y < 5.8);
hover.motion.reset({ x: 64, y: 6 + SPAWN_HEIGHT.hovercraft, z: 75 }, 0);
check('hovercraft stops at a wall', run(hover, 3, { drive: 1 }) === 'blocked' && hover.motion.p.z < 88.1);

const heli = await craft('helicopter');
heli.motion.reset({ x: 64, y: 6 + SPAWN_HEIGHT.helicopter, z: 50 }, 0);
run(heli, 2.5, { lift: 1 });
const altitude = heli.motion.p.y;
check('helicopter takes off vertically', altitude > 25 && heli.motion.p.x === 64 && heli.motion.p.z === 50);
run(heli, 2);
const hoverY = heli.motion.p.y;
run(heli, 2);
check('helicopter holds a steady hover', Math.abs(heli.motion.p.y - hoverY) < 0.01 && heli.motion.speed < 0.01);
run(heli, 1.1, { drive: 1 });
check('helicopter flies forward above the wall height', heli.motion.p.z > 60 && heli.motion.p.y > 25);
heli.motion.reset({ x: 64, y: heli.motion.p.y, z: 65 }, 0);
run(heli, 12, { lift: -1 });
check('helicopter lands and remains supported', Math.abs(heli.motion.p.y - 6.84) < 0.05);
run(heli, 3, { lift: 1 });
check('helicopter can take off again', heli.motion.p.y > 23);

const glider = await craft('paraglider');
glider.motion.reset({ x: 58, y: 23, z: 45 }, 0, 13);
run(glider, 2, { turn: 1 });
check('paraglider turns and glides toward a landing site', glider.motion.heading > 1.5 &&
  glider.motion.p.x > 67 && glider.motion.p.z > 50 && glider.motion.p.y < 19);
check('paraglider touches down on dry ground', run(glider, 20, { drive: -1 }) === 'landed' &&
  Math.abs(glider.motion.p.y - 6.45) < 0.3);
glider.motion.reset({ x: 64, y: 10, z: 18 }, 0);
check('paraglider reports a water landing', run(glider, 4, { drive: -1 }) === 'splash');

for (const { name, pass } of out) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
if (out.some(({ pass }) => !pass)) process.exitCode = 1;
