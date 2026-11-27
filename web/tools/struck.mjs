// A person run into by the driven car is thrown ahead, not toppled where they stood. On a synthetic flat street the
// road physics (physics/rapier/life-phys.ts hitPeople, through checks/drive-scenarios.ts) drives a car at 30 and at
// 50 km/h into a person crossing its lane; the struck event it records is drawn by the page (view/life.ts StreetLife,
// as either host's events reach it) for 6 s at 60 frames a second, and the person as drawn (the torso's middle, 1.1 m
// up the body) is followed:
//   - thrown along the car's heading at least MIN_M m (30, 50 km/h), the faster hit at least FASTER times as far;
//   - in the air: the feet at least MIN_UP m over the ground at their highest, and the lowest of feet and head off the
//     ground (over 0.25 m) for at least MIN_AIR s;
//   - then lying still, flat, on the ground, not further off the car's line than a metre.
// Toppled where they stood (the page's old drawing) it was ~2.6 m and ~3.2 m, the feet 0.34 m up, 0.25 s off the ground.
// usage (in web/): node tools/struck.mjs [-v]; one PASS / FAIL line a speed, exit code 1 if one fails
import * as THREE from 'three';
import { imp } from './lib.mjs';

const verbose = process.argv.includes('-v');
const ds = await imp('checks/drive-scenarios.ts');
const { StreetLife } = await imp('src/view/life.ts');
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
await RAPIER.init();

const GROUND = 10, FPS = 60, SECONDS = 6;
const MIN_M = { 30: 5, 50: 11 }, MIN_UP = { 30: 0.5, 50: 1 }, MIN_AIR = { 30: 0.45, 50: 0.7 }, FASTER = 1.6;
const r2 = (x) => Math.round(x * 100) / 100;

// the struck event of a car driven at kmh into a person 20 m ahead in its lane (heading +z)
function strike(kmh) {
  const d = ds.takeOver(() => ({ g: GROUND, mat: 1 }), 64, 30, kmh, [], true);
  ds.run(d, 3, ds.cruise(kmh), (x) => x.traffic.struck.length > 0);
  const { by: _by, ...e } = d.traffic.struck[0] ?? {};
  d.park();
  return { d, e: e.person === undefined ? null : { kind: 'struck', ...e } };
}

// the person of event e as StreetLife draws it, frame by frame: the torso's middle, the feet and the head
function draw(d, e) {
  const traffic = d.traffic;
  traffic.ground = { surface: () => GROUND, support: () => GROUND };
  // (the sim has no other players; the mirror lists them)
  traffic.avatars ??= [];
  let tick = 0;
  const client = { get tick() { return tick; }, traffic, eventsSince: (t) => (t < e.tick && tick >= e.tick ? [e] : []), avatars: () => [] };
  // (the torso's instances: the people walking first, none here, so the person knocked down is the first)
  const life = new StreetLife(new THREE.Scene(), client), T = life.M.torso, m = new THREE.Matrix4(), v = new THREE.Vector3(), out = [];
  for (let i = 0; i < SECONDS * FPS; i++) {
    tick = e.tick;
    life.update(1 / FPS, 0, { x: e.pose.x, z: e.pose.z, y: e.pose.y });
    if (T.count < 1) { out.push(null); continue; }
    T.getMatrixAt(0, m);
    const p = (y) => v.set(0, y, 0).applyMatrix4(m).clone();
    out.push({ mid: p(1.1), feet: p(0), head: p(1.75) });
  }
  return out;
}

const fails = [], dist = {};
for (const kmh of [30, 50]) {
  const { d, e } = strike(kmh);
  if (!e) { d.physics.dispose(); fails.push(kmh); console.log(`FAIL struck_${kmh}: the car did not knock the person down`); continue; }
  const v = Math.hypot(e.vx, e.vz), ux = e.vx / v, uz = e.vz / v, frames = draw(d, e);
  d.physics.dispose();
  const along = (p) => (p.x - e.pose.x) * ux + (p.z - e.pose.z) * uz, across = (p) => (p.x - e.pose.x) * uz - (p.z - e.pose.z) * ux;
  let up = 0, air = 0;
  for (const f of frames) if (f) {
    up = Math.max(up, f.feet.y - GROUND);
    if (Math.min(f.feet.y, f.head.y) - GROUND > 0.25) air += 1 / FPS;
  }
  const last = frames.at(-1), before = frames.at(-FPS);
  const far = last ? along(last.mid) : 0, side = last ? Math.abs(across(last.mid)) : 99;
  const still = !!last && !!before && last.mid.distanceTo(before.mid) < 0.01;
  const flat = !!last && Math.abs(last.head.y - last.feet.y) < 0.3 && last.mid.y - GROUND < 0.5 && last.mid.y >= GROUND;
  dist[kmh] = far;
  const detail = { carKmh: r2(v * 3.6), thrownM: r2(far), upM: r2(up), airS: r2(air), sideM: r2(side), still, flat };
  const pass = far >= MIN_M[kmh] && up >= MIN_UP[kmh] && air >= MIN_AIR[kmh] && side < 1 && still && flat;
  if (!pass) fails.push(kmh);
  console.log(`${pass ? 'PASS' : 'FAIL'} struck_${kmh}: ${JSON.stringify(detail)}`);
  if (verbose) frames.forEach((f, i) => f && i % 6 === 0 && console.log(`  t=${(i / FPS).toFixed(2)} along ${r2(along(f.mid))} mid ${r2(f.mid.y - GROUND)} feet ${r2(f.feet.y - GROUND)} head ${r2(f.head.y - GROUND)}`));
}
if (dist[30] !== undefined && dist[50] !== undefined) {
  const pass = dist[50] >= FASTER * dist[30];
  if (!pass) fails.push('scale');
  console.log(`${pass ? 'PASS' : 'FAIL'} struck_scale: 50 km/h thrown ${r2(dist[50])} m, 30 km/h ${r2(dist[30])} m (at least ${FASTER}x)`);
}
process.exit(fails.length ? 1 : 0);
