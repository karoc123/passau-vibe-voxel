// The page's walk the same as before it was shared with the host: nav/foot.ts Foot (the player's own walk, its body
// now sim/walker.ts) driven through a fixed run on a synthetic world (a kerb, stairs, a drop off a ledge, a wall with a
// door under a low lintel, a diagonal wall, a parked car, a car's roof jumped onto and ridden, a basin waded, swum and
// climbed out of, a fall into it), every frame's state hashed and compared bit for bit with checks/walk-trace.json,
// recorded from the walk as it was (nav/walk.ts, nav/swim.ts, nav/foot.ts before the move). A changed walk fails
// here: record again only when the walk is meant to change (--record), and say so in the commit.
// usage (in web/): node tools/walk-same.mjs [--record]; prints PASS lines, or FAIL and exit 1
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { imp } from './lib.mjs';
import { web } from './data-dir.mjs';

const { makeWorld } = await imp('checks/world.ts');
const { worldOf } = await imp('checks/collision-checks.ts');
const { Foot } = await imp('src/nav/foot.ts');
const { Glide } = await imp('src/nav/glide.ts');
const { MoveKeys } = await imp('src/nav/move-keys.ts');

const TRACE = path.join(web, 'checks/walk-trace.json'), record = process.argv.includes('--record');
const fail = [], check = (ok, s) => (ok ? console.log(`PASS ${s}`) : (console.log(`FAIL ${s}`), fail.push(s)));

// along z 128 going +x: a kerb at x 40, stairs to 9 m, a plateau dropping 4 m at x 60; a wall at x 80 with a door
// (z 127..129) under a lintel 2.5 m up; a diagonal wall north of it; a basin (x 140..190) 1 m under the land
const G = 5, wet = (x, z) => x >= 140 && x < 190 && z >= 100 && z < 200;
const ground = (x, z) => {
  if (wet(x, z)) return G - 1;
  if (z < 120 || z > 136) return G;
  return x >= 40 && x < 41 ? 6 : x >= 41 && x < 43 ? 7 : x >= 43 && x < 45 ? 8 : x >= 45 && x < 60 ? 9 : G;
};
const boxes = [
  { x0: 80, x1: 81, z0: 100, z1: 127, y0: G, y1: G + 4, mat: 'wall' }, { x0: 80, x1: 81, z0: 129, z1: 156, y0: G, y1: G + 4, mat: 'wall' },
  { x0: 80, x1: 81, z0: 127, z1: 129, y0: G + 2.5, y1: G + 4, mat: 'wall' },
  ...Array.from({ length: 12 }, (_, i) => ({ x0: 90 + i, x1: 91 + i, z0: 110 - i, z1: 111 - i, y0: G, y1: G + 4, mat: 'wall' })),
];
const tw = await makeWorld({ size: [256, 256], ground, surface: (x, z) => (wet(x, z) ? 'water' : 'earth'), boxes });
const world = await worldOf(tw);

// a car parked at x 100 on the way (id car1), and one (car2) whose roof is jumped onto and that drives off
const parked = { x: 100, y: G, z: 128, h: 0, hx: 0.95, hz: 2.3, top: 1.5, id: 'car1' };
const driven = { x: 115, y: G, z: 128, h: 0, hx: 0.95, hz: 2.3, top: 1.5, id: 'car2' };
const solids = () => [{ ...parked }, { ...driven }];

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000), K = new MoveKeys();
const foot = new Foot(camera, { target: new THREE.Vector3() }, K, new Glide(camera), () => world, solids);
const DT = 1 / 60;
const state = [], hash = crypto.createHash('sha256'), buf = new Float64Array(10);
let frames = 0, most = { feet: -Infinity, swam: 0, rode: 0, under: 0 };
const frame = (stick = null) => {
  foot.updateWalk(DT, stick);
  const s = [foot.pos.x, foot.pos.y, foot.pos.z, foot.feet, foot.vy, foot.yaw, foot.carry.x, foot.carry.z, foot.swimming ? 1 : 0, foot.under ? 1 : 0];
  buf.set(s);
  hash.update(Buffer.from(buf.buffer));
  if (frames++ % 20 === 0) state.push(s);
  most.feet = Math.max(most.feet, foot.feet);
  if (foot.swimming) most.swam++;
  if (foot.roof()) most.rode++;
};
const hold = (keys, secs, opts = {}) => {
  K.clear();
  for (const k of keys) K.add(MoveKeys.of(k));
  K.shift = !!opts.shift;
  for (let i = 0; i < secs / DT; i++) { opts.each?.(i); frame(opts.stick ?? null); }
  K.clear(); K.shift = false;
};

foot.fallAt({ x: 30, y: G, z: 128 }, { x: 0, y: 0, z: 0 }, Math.PI / 2);
hold([], 0.5);
// up the kerb and the stairs, along the plateau and off its end, on to the wall and through its door
hold(['KeyW'], 4);
const top = most.feet;
hold(['KeyW'], 6, { shift: true });
// through the door, and a stretch along the wall from the far side (A strafes, the arrows turn)
hold(['KeyW', 'KeyA'], 1);
hold(['ArrowLeft'], 0.6);
hold(['KeyW'], 2);
hold(['KeyD'], 1.5);
// at the diagonal wall: walked into it at a slant, along it with a stick
foot.fallAt({ x: 96, y: G, z: 120 }, { x: 0, y: 0, z: 0 }, Math.PI * 0.75);
hold(['KeyW'], 2);
hold([], 2, { stick: [0.7, -0.6] });
// the parked car: walked into, strafed along
foot.fallAt({ x: 92, y: G, z: 128 }, { x: 0, y: 0, z: 0 }, Math.PI / 2);
hold(['KeyW'], 2);
hold(['KeyW', 'KeyD'], 1.5);
// the car's roof: walked at and jumped onto, then it drives off along +z and turns; then walked off its back
foot.fallAt({ x: 110, y: G, z: 128 }, { x: 0, y: 0, z: 0 }, Math.PI / 2);
hold(['KeyW'], 0.5);
foot.jump();
hold(['KeyW'], 0.2);
hold([], 0.5);
hold([], 3, { each: () => { driven.z += 5 * DT; driven.h += 0.2 * DT; } });
hold(['KeyS'], 1.5);
// a run and a jump on flat ground
hold(['KeyW'], 1, { shift: true, each: (i) => { if (i === 20) foot.jump(); } });
// the basin: walked in from its west bank, waded, swum, across, back and out
foot.fallAt({ x: 132, y: G, z: 150 }, { x: 0, y: 0, z: 0 }, Math.PI / 2);
hold(['KeyW'], 14);
hold(['ArrowLeft'], 1.75);
hold(['KeyW'], 20);
// a fall from high up into the water, and one onto the ground with speed across
foot.fallAt({ x: 165, y: G + 30, z: 160 }, { x: 3, y: -10, z: 1 }, 0);
hold([], 4);
foot.fallAt({ x: 60, y: G + 20, z: 60 }, { x: 6, y: 2, z: -3 }, 1);
hold([], 3);

const got = { frames, hash: hash.digest('hex'), samples: state };
console.log(`${frames} frames; highest feet ${top.toFixed(2)} (stairs) / ${most.feet.toFixed(2)}, ${most.swam} afloat, ${most.rode} on a roof`);
if (record) {
  fs.writeFileSync(TRACE, JSON.stringify(got) + '\n');
  console.log(`recorded ${path.relative(web, TRACE)}`);
} else {
  const was = JSON.parse(fs.readFileSync(TRACE, 'utf8'));
  let first = -1;
  for (let i = 0; i < was.samples.length && first < 0; i++) if (was.samples[i].some((v, k) => v !== got.samples[i]?.[k])) first = i;
  check(was.frames === got.frames && was.hash === got.hash,
    `the walk the same as recorded, bit for bit over ${frames} frames (kerb, stairs, ledge, door, diagonal wall, cars, a roof ridden, water, falls)` +
    (first >= 0 ? `; first differs by frame ${first * 20}: ${JSON.stringify(got.samples[first])} was ${JSON.stringify(was.samples[first])}` : ''));
  check(top >= 9 - 1e-9 && most.swam > 60 && most.rode > 60, `the run covers what it says (stairs to ${top}, ${most.swam} frames afloat, ${most.rode} on a roof)`);
}
if (fail.length) { console.log(`FAIL ${fail.length}`); process.exit(1); }
