// Rapier car: reproducible driving scenarios on synthetic voxel terrain, run headless (tools/rapier-car.mjs) or in the
// page (window.__rapierScenarios). Each builds a small map (2 x 2 tiles of 64 m), drops the car, drives it with scripted
// input at a fixed 1/60 s step and judges the outcome from its telemetry.
import RAPIER from '@dimforge/rapier3d-compat';
import { MAT } from '../../core/materials';
import { bus, CAR, RapierCar, RIDE, TUNED, type CarBuild, type CarInput, type CarEvent, type CarTuning } from './car';
import { DRIVE, RapierTerrain, terrainTile, terrainPalette, WHEEL_GROUPS } from './terrain';

// (the ride's and the car surface's numbers, for tools/rapier-car.mjs --set: the same module instances as the scenarios')
export { DRIVE, RIDE };

const N = 64;
// the tuning the scenarios' cars get (tools/rapier-car.mjs --spike: the spike's car)
export const scenarioTuning: { tuning: CarTuning } = { tuning: TUNED };
const STEP = 1 / 60;
// fixture palette: 0 earth (solid, not paved), 1 street (paved: ramps), 2 wall, 3 water
const PALETTE: [number, number, number, number][] = [[120, 100, 80, MAT.SOIL], [90, 90, 90, MAT.MARK], [200, 190, 180, MAT.WALL], [40, 80, 120, MAT.WATER]];
export const EARTH = 0, STREET = 1, WALL = 2, WATER = 3;

// a column: its ground (top, m) and surface material; on it, optional runs [lo, hi, material]
export interface Col { g: number; mat?: number; runs?: [number, number, number][] }

// a map of `tiles` x `tiles` tiles of N m from a column function of world (x, z)
export type ScenarioMap = { meta: { W: number; D: number; tiles: { N: number }; palette: [number, number, number, number][] }; tiles: { tx: number; tz: number; tile: ReturnType<typeof terrainTile> }[] };

export function synthMap(tiles: number, col: (x: number, z: number) => Col): ScenarioMap {
  const meta = { W: tiles * N, D: tiles * N, tiles: { N }, palette: PALETTE };
  const pal = terrainPalette(PALETTE), S = N + 2;
  const out: { tx: number; tz: number; tile: ReturnType<typeof terrainTile> }[] = [];
  for (let tz = 0; tz < tiles; tz++) for (let tx = 0; tx < tiles; tx++) {
    const ground = new Uint8Array(S * S), counts = new Uint16Array(S * S), runs: number[] = [];
    const frun: number[] = [], fcounts = new Uint16Array(S * S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const x = Math.min(meta.W - 1, Math.max(0, tx * N + i - 1)), z = Math.min(meta.D - 1, Math.max(0, tz * N + j - 1));
      const c = col(x, z), k = i + S * j;
      ground[k] = c.g;
      const r: [number, number, number][] = [[c.g - 1, c.g, c.mat ?? EARTH], ...(c.runs ?? [])];
      for (const [lo, hi, m] of r) runs.push(lo, hi - lo, m);
      counts[k] = r.length;
    }
    out.push({ tx, tz, tile: terrainTile(N, { ground, counts, runs: Uint16Array.from(runs) }, { counts: fcounts, runs: Uint16Array.from(frun) }, pal) });
  }
  return { meta, tiles: out };
}

// pr, rr: the chassis' pitch and roll rate (rad/s, about its own side and forward axes); yr: its yaw rate (rad/s, about
// the world's up); road: the height of what the wheels drive on under the front and rear axles, their mean (NaN: none
// within 3 m under the body);
// load: the wheels' suspension forces over the car's weight (1: resting on level ground); steer: the front wheels'
// angle (rad); pitch (nose up), roll: the chassis' forward and side axes' angles over the horizontal (rad)
export interface Sample {
  t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; kmh: number; up: number; heading: number;
  pitch: number; roll: number; wheels: number; pr: number; rr: number; yr: number; road: number; load: number; steer: number; stepMs: number;
}

export class Sim {
  readonly world: RAPIER.World;
  readonly terrain: RapierTerrain;
  readonly car: RapierCar;
  readonly log: Sample[] = [];
  readonly events: CarEvent[] = [];
  t = 0;

  // at.y: the ground to start on is at or below it (default: the highest)
  constructor(map: ScenarioMap, at: { x: number; y?: number; z: number }, heading: number, speed = 0, build: CarBuild = CAR) {
    const R = RAPIER;
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    // (the tiles are all given: one not given is off the map)
    this.terrain = new RapierTerrain(R, this.world, map.meta, { x: 0, z: 0 }, { budgetMs: 1e9, load: () => Promise.reject(null) });
    for (const t of map.tiles) this.terrain.setTile(t.tx, t.tz, t.tile);
    this.terrain.update([{ x: at.x, z: at.z }]);
    const g = this.terrain.groundAt(at.x, at.z, at.y ?? 1e4) ?? 0;
    this.car = new RapierCar(R, this.world, { x: at.x, y: g + build.ride + 0.15, z: at.z }, heading, this.terrain, scenarioTuning.tuning, build);
    this.car.body.setLinvel({ x: Math.sin(heading) * speed, y: 0, z: Math.cos(heading) * speed }, true);
    // settle on its wheels
    for (let i = 0; i < 30; i++) this.step({ gas: 0, brake: 0, steer: 0, handbrake: false }, false);
    this.car.body.setLinvel({ x: Math.sin(heading) * speed, y: this.car.body.linvel().y, z: Math.cos(heading) * speed }, true);
    this.log.length = 0;
    this.events.length = 0;
    this.t = 0;
  }

  step(input: CarInput, record = true) {
    const b = this.car.body, p = b.translation(), v = b.linvel();
    this.terrain.update([{ x: p.x, z: p.z, vx: v.x, vz: v.z }]);
    const t0 = performance.now();
    this.car.step(input, STEP);
    this.world.step();
    const ev = this.car.afterStep(STEP);
    const ms = performance.now() - t0;
    this.t += STEP;
    if (!record) return;
    if (ev) this.events.push(ev);
    const q = b.rotation(), pp = b.translation(), vv = b.linvel();
    // the chassis' up axis' y (1: upright, < 0: on its roof); heading from its forward axis
    const up = 1 - 2 * (q.x * q.x + q.z * q.z);
    const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    // the angular velocity in the chassis' frame (q's conjugate applied)
    const w = b.angvel(), qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
    const ix = qw * w.x + qy * w.z - qz * w.y, iy = qw * w.y + qz * w.x - qx * w.z, iz = qw * w.z + qx * w.y - qy * w.x, iw = -qx * w.x - qy * w.y - qz * w.z;
    const lx = ix * qw + iw * -qx + iy * -qz - iz * -qy, lz = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    // (the road under the front and rear axles, straight down from over the body's origin: a car glued to its road
    // would be at their mean)
    const B = this.car.build, sh = Math.hypot(fx, fz) || 1;
    const road = (dz: number) => {
      const x = pp.x + fx / sh * dz, z = pp.z + fz / sh * dz;
      const hit = this.world.castRay(new RAPIER.Ray({ x, y: pp.y + 1, z }, { x: 0, y: -1, z: 0 }), 4, true, undefined, WHEEL_GROUPS, undefined, b);
      return hit ? pp.y + 1 - hit.timeOfImpact : NaN;
    };
    const c = this.car.controller;
    let load = 0;
    for (let i = 0; i < c.numWheels(); i++) load += c.wheelSuspensionForce(i) ?? 0;
    this.log.push({
      t: this.t, x: pp.x, y: pp.y, z: pp.z, vx: vv.x, vy: vv.y, vz: vv.z, kmh: this.car.kmh, up, heading: Math.atan2(fx, fz),
      pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (q.y * q.z - q.w * q.x)))), roll: Math.asin(Math.max(-1, Math.min(1, 2 * (q.x * q.y + q.w * q.z)))),
      wheels: this.car.wheelsInContact(), pr: lx, rr: lz, yr: w.y, road: (road(B.wheels[0].z) + road(B.wheels[2].z)) / 2,
      load: load / (b.mass() * 9.81 * RIDE.gravity), steer: c.wheelSteering(0) ?? 0, stepMs: ms,
    });
  }

  run(seconds: number, input: CarInput | ((s: Sim) => CarInput)) {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      this.step(typeof input === 'function' ? input(this) : input);
      if (this.car.status === 'water') break;
    }
    return this;
  }

  dispose() { this.world.free(); }
}

const GAS: CarInput = { gas: 1, brake: 0, steer: 0, handbrake: false };
// holds a speed (km/h) along the car's heading
export const cruise = (kmh: number): ((s: Sim) => CarInput) => (s) => ({ gas: s.car.kmh < kmh ? 1 : 0, brake: s.car.kmh > kmh + 4 ? 0.3 : 0, steer: 0, handbrake: false });

// follows a path (world x, z points) at a speed (km/h): pure pursuit, a point ahead by the speed
export function follow(path: [number, number][], kmh: number): (s: Sim) => CarInput {
  const cr = cruise(kmh);
  let near = 0;
  return (s) => {
    const p = s.car.body.translation(), r = s.car.body.rotation();
    // (the nearest point, searched forward from the last one)
    for (let i = near; i < Math.min(path.length, near + 20); i++) if (Math.hypot(path[i][0] - p.x, path[i][1] - p.z) < Math.hypot(path[near][0] - p.x, path[near][1] - p.z)) near = i;
    const ahead = 4 + Math.abs(s.car.kmh) / 3.6 * 0.6;
    let k = near, d = 0;
    while (k < path.length - 1 && d < ahead) { d += Math.hypot(path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1]); k++; }
    const fx = 2 * (r.x * r.z + r.w * r.y), fz = 1 - 2 * (r.x * r.x + r.y * r.y);
    let a = Math.atan2(path[k][0] - p.x, path[k][1] - p.z) - Math.atan2(fx, fz);
    a = Math.atan2(Math.sin(a), Math.cos(a));
    const done = near >= path.length - 2;
    return { ...cr(s), gas: done ? 0 : cr(s).gas, brake: done ? 1 : cr(s).brake, steer: Math.max(-1, Math.min(1, -a * 2.5)) };
  };
}

// How much the car wobbles, over the samples on the ground (from the first to the last with a wheel down): the pitch
// and roll rates' jitter (rad/s: RMS of the rate less its 0.5 s moving mean, so a slope's change is not counted, its
// bumps are), their peaks, the share of samples with fewer than four wheels down (liftPct) and how often a wheel left
// the ground (lifts: 4 -> fewer).
export function wobble(L: Sample[]) {
  const W = 15; // samples a side of the mean (1/4 s)
  let pj = 0, rj = 0, pm = 0, rm = 0, n = 0, lift = 0, lifts = 0;
  for (let i = W; i < L.length - W; i++) {
    let mp = 0, mr = 0;
    for (let k = i - W; k <= i + W; k++) { mp += L[k].pr; mr += L[k].rr; }
    mp /= 2 * W + 1; mr /= 2 * W + 1;
    pj += (L[i].pr - mp) ** 2; rj += (L[i].rr - mr) ** 2;
    pm = Math.max(pm, Math.abs(L[i].pr)); rm = Math.max(rm, Math.abs(L[i].rr));
    if (L[i].wheels < 4) lift++;
    if (L[i].wheels < 4 && L[i - 1].wheels === 4) lifts++;
    n++;
  }
  n = Math.max(1, n);
  return { pitchJit: r3(Math.sqrt(pj / n)), rollJit: r3(Math.sqrt(rj / n)), pitchMax: r2(pm), rollMax: r2(rm), liftPct: r2(100 * lift / n), lifts };
}

// How floaty the car is, over the samples: how its body's height follows the road under it.
// - vyErr (m/s): RMS of the body's vertical speed less the road's under it (along the car's way): 0 for a car glued
//   to its road, large when the body lifts off crests and wallows in dips.
// - heave (cm): RMS of the body's height over the road less its 1 s moving mean (how far it bobs on its springs).
// - lightPct: share of samples with the wheels carrying under half the car's weight (light: little grip, no steering);
//   airPct: no wheel touching.
export function floaty(L: Sample[]) {
  let e2 = 0, ne = 0, light = 0, air = 0;
  for (let i = 1; i < L.length; i++) {
    const a = L[i - 1], b = L[i];
    if (b.load < 0.5) light++;
    if (b.wheels === 0) air++;
    // (not across a jump in what is under it: an edge, a deck)
    if (!Number.isFinite(a.road) || !Number.isFinite(b.road) || Math.abs(b.road - a.road) > 0.3) continue;
    e2 += (b.vy - (b.road - a.road) / STEP) ** 2;
    ne++;
  }
  const W = 30, h = L.map((l) => l.y - l.road);
  let h2 = 0, nh = 0;
  for (let i = W; i < L.length - W; i++) {
    let m = 0, ok = Number.isFinite(h[i]);
    for (let k = i - W; k <= i + W && ok; k++) { ok = Number.isFinite(h[k]); m += h[k]; }
    if (!ok) continue;
    h2 += (h[i] - m / (2 * W + 1)) ** 2;
    nh++;
  }
  const n = Math.max(1, L.length - 1);
  return { vyErr: r3(Math.sqrt(e2 / Math.max(1, ne))), heave: r2(100 * Math.sqrt(h2 / Math.max(1, nh))), lightPct: r2(100 * light / n), airPct: r2(100 * air / n) };
}

// wobble and floatiness together
export const feel = (L: Sample[]) => ({ ...wobble(L), ...floaty(L) });

// A disturbance's settling: how a signal (from its value at rest) swings after a kick at sample 0: its first peak, the
// overshoot past rest the other way (% of the peak), the time until it stays within `band` of rest (s), the swing's
// frequency (Hz, from the first two crossings of rest; 0: none)
function settling(v: number[], rest: number, band: number) {
  const d = v.map((x) => x - rest);
  let peak = 0, k = 0;
  while (k < d.length && Math.abs(d[k]) >= Math.abs(peak)) peak = d[k++];
  let over = 0, last = 0;
  const cross: number[] = [];
  for (let i = 1; i < d.length; i++) {
    if (Math.sign(d[i]) !== Math.sign(d[i - 1]) && d[i] !== 0) cross.push(i);
    if (cross.length && cross.length < 2) over = Math.max(over, -Math.sign(peak) * d[i]);
    if (Math.abs(d[i]) > band) last = i;
  }
  return { peak: r3(peak), overPct: r2(peak ? 100 * Math.max(0, over) / Math.abs(peak) : 0), settleS: r2((last + 1) * STEP), hz: cross.length >= 2 ? r2(1 / (2 * (cross[1] - cross[0]) * STEP)) : 0 };
}

export interface Outcome { name: string; pass: boolean; detail: Record<string, number | string | boolean> }

function summary(s: Sim) {
  const L = s.log;
  let maxStep = 0, sumStep = 0, minUp = 1;
  for (const l of L) { maxStep = Math.max(maxStep, l.stepMs); sumStep += l.stepMs; minUp = Math.min(minUp, l.up); }
  return { stepMsAvg: +(sumStep / Math.max(1, L.length)).toFixed(3), stepMsMax: +maxStep.toFixed(2), minUp: +minUp.toFixed(2), status: s.car.status };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// The scenarios. `ids`: a subset (all by default).
export const SCENARIOS: Record<string, () => Outcome> = {
  // a 1 m terrace across the way (earth, no ramp), driven up at 30 km/h, square on and at 35°; and down again
  terrace_up_30() { return terrace('terrace_up_30', 30, 0, 1); },
  terrace_up_15() { return terrace('terrace_up_15', 15, 0, 1); },
  terrace_up_diag() { return terrace('terrace_up_diag', 30, 0.6, 1); },
  terrace_up_from_rest() { return terrace('terrace_up_from_rest', 0, 0, 1, 34); },
  terrace_down() { return terrace('terrace_down', 30, 0, -1); },
  // a 1 m platform (not ground: a wedge) driven onto at 30 km/h, square on and at 35°, and off it
  block_up_30() { return terrace('block_up_30', 30, 0, 1, 30, true); },
  block_up_diag() { return terrace('block_up_diag', 30, 0.6, 1, 30, true); },
  block_down() { return terrace('block_down', 30, 0, -1, 30, true); },
  terrace_2m_blocks() {
    // two metres is a wall: it stops, not climbs
    const o = terrace('terrace_2m_blocks', 30, 0, 2);
    o.pass = !o.detail.climbed;
    return o;
  },
  // a wall along z at x = 70; the car at 50 km/h heading 25° (45°) into it, gas held
  wall_glance_25() { return wallGlance('wall_glance_25', 25); },
  wall_glance_45() { return wallGlance('wall_glance_45', 45); },
  wall_head_on_50() {
    const map = synthMap(2, (_x, z) => (z >= 60 && z < 63 ? { g: 10, runs: [[10, 16, WALL]] } : { g: 10 }));
    const s = new Sim(map, { x: 64, z: 20 }, 0, 50 / 3.6);
    s.run(4, cruise(50));
    const end = s.log[s.log.length - 1];
    const d = { zEnd: r2(end.z), impacts: s.events.filter((e) => e.kind === 'impact').length, maxImpact: r2(Math.max(0, ...s.events.filter((e) => e.kind === 'impact').map((e) => e.speed))), ...summary(s) };
    s.dispose();
    return { name: 'wall_head_on_50', pass: end.z < 60 && end.up > 0.8, detail: d };
  },
  // a garage (a room, scripts/interiors.py): driven in through its 4 m door at 20 km/h, gas held to its back wall --
  // it stays in, on its floor, under its roof; and into the wall beside the door, where it stays out
  garage_in() { return garage('garage_in', 64); },
  garage_wall() { return garage('garage_wall', 56); },
  cliff_10m() { return cliff('cliff_10m', 10, 60, true); },
  cliff_4m() { return cliff('cliff_4m', 4, 50, false); },
  // the river as the data has it: its water the ground's top voxel (at 4), a bank 3 m over it, driven off at 40 km/h
  river() {
    const map = synthMap(2, (_x, z) => (z >= 60 ? { g: 4, mat: WATER } : { g: 7 }));
    return river('river', map, 40);
  },
  // a paved slip down into it at 15 km/h
  river_slip() {
    const map = synthMap(2, (_x, z) => (z >= 60 ? { g: 4, mat: WATER } : { g: Math.min(9, 4 + Math.ceil((60 - z) / 4)), mat: STREET }));
    return river('river_slip', map, 15);
  },
  // deeper: water standing 4 m over the river's bed
  river_deep() {
    const map = synthMap(2, (_x, z) => (z >= 60 ? { g: 5, runs: [[5, 9, WATER]] } : { g: 12 }));
    return river('river_deep', map, 40);
  },
  ramp_street() {
    // a paved street climbing 1 m every 5 m (voxel stairs, smoothed by ramps.ts) for 40 m, at 50 km/h
    const map = synthMap(2, (x, z) => {
      const street = x >= 56 && x < 72;
      const g = 10 + Math.max(0, Math.min(8, Math.floor((z - 30) / 5)));
      return street ? { g, mat: STREET } : { g: g + 3 };
    });
    const s = new Sim(map, { x: 64, z: 15 }, 0, 50 / 3.6);
    s.run(5, cruise(50));
    const L = s.log;
    let jerk = 0, pitchRate = 0;
    for (let i = 1; i < L.length; i++) jerk = Math.max(jerk, Math.abs(L[i].vy - L[i - 1].vy) / STEP);
    const ang = s.car.body.angvel();
    pitchRate = Math.abs(ang.x);
    const end = L[L.length - 1];
    const d = { yEnd: r2(end.y), zEnd: r2(end.z), kmhEnd: r2(end.kmh), maxVertAccel: r2(jerk), pitchRateEnd: r2(pitchRate), minWheels: Math.min(...L.map((l) => l.wheels)), ...feel(L.filter((l) => l.z < 74)), ...summary(s) };
    s.dispose();
    return { name: 'ramp_street', pass: end.z > 75 && jerk < 60, detail: d };
  },
  ramp_landing() {
    // off a 3 m ledge at 50 km/h onto a paved street running down (1 m per 4 m, smoothed by ramps.ts)
    const map = synthMap(2, (x, z) => {
      if (x < 56 || x >= 72) return { g: 30 };
      if (z < 40) return { g: 18 };
      return { g: Math.max(5, 14 - Math.floor((z - 40) / 4)), mat: STREET };
    });
    const s = new Sim(map, { x: 64, z: 20 }, 0, 50 / 3.6);
    s.run(4, cruise(50));
    const L = s.log, end = L[L.length - 1];
    const land = s.events.find((e) => e.kind === 'landing');
    const after = L.filter((l) => l.z > 60 && l.z < 80);
    const minKmh = Math.min(...after.map((l) => l.kmh));
    const d = { landingSpeed: land ? r2(land.speed) : 0, minKmhAfter: r2(minKmh), zEnd: r2(end.z), impacts: s.events.filter((e) => e.kind === 'impact').length, ...summary(s) };
    s.dispose();
    return { name: 'ramp_landing', pass: minKmh > 35 && d.minUp > 0.8 && !land?.crash, detail: d };
  },
  bridge() {
    // a ramp up (paved, 1 m per 4 m) onto a deck 4 m over the ground below, across a 20 m gap, and down again
    const map = synthMap(2, (x, z) => {
      if (x < 58 || x >= 70) return { g: 30 };
      if (z < 30) return { g: 10, mat: STREET };
      if (z < 46) return { g: 10 + Math.floor((z - 30) / 4) + 1, mat: STREET };
      if (z < 66) return { g: 4, runs: [[12, 14, STREET]] };
      if (z < 82) return { g: 10 + Math.floor((81 - z) / 4) + 1, mat: STREET };
      return { g: 10, mat: STREET };
    });
    const s = new Sim(map, { x: 64, z: 15 }, 0, 40 / 3.6);
    s.run(8, cruise(40));
    const L = s.log, end = L[L.length - 1];
    const minYOnDeck = Math.min(...L.filter((l) => l.z > 48 && l.z < 64).map((l) => l.y));
    const d = { zEnd: r2(end.z), yEnd: r2(end.y), minYOnDeck: r2(minYOnDeck), ...summary(s) };
    s.dispose();
    return { name: 'bridge', pass: end.z > 95 && minYOnDeck > 14, detail: d };
  },
  // wobble on slopes (wobble()): a paved street sloping sideways (1 m per 6 m across it), driven along at 40 km/h
  ramp_cross() { return slope('ramp_cross', (x, z) => 10 + Math.floor((x - 40) / 6) + 0 * z, 40); },
  // ... climbing diagonally (1 m per 6 m along x and along z)
  ramp_diag() { return slope('ramp_diag', (x, z) => 10 + Math.floor((x + z - 60) / 6), 40); },
  // ... a steep old-town lane: 1 m per 4 m, 12 m wide between walls, at 30 km/h
  ramp_steep() { return slope('ramp_steep', (_x, z) => 10 + Math.max(0, Math.min(12, Math.floor((z - 30) / 4))), 30, 6); },
  // a raised paved square (1 m) met at 30° at 30 km/h: a paved step (smoothed by ramps.ts)
  kerb_paved_diag() {
    const map = synthMap(2, (_x, z) => ({ g: z >= 50 ? 11 : 10, mat: STREET }));
    const s = new Sim(map, { x: 64, z: 30 }, 0.5, 30 / 3.6);
    s.run(3, cruise(30));
    const L = s.log, end = L[L.length - 1];
    const d = { yEnd: r2(end.y), zEnd: r2(end.z), ...feel(L), ...summary(s) };
    s.dispose();
    return { name: 'kerb_paved_diag', pass: end.y > 11.5 && d.minUp > 0.8, detail: d };
  },
  // terraces (earth: no ramps) 1 m up every 6 m, four of them, at 25 km/h
  terrace_stairs() {
    const map = synthMap(2, (_x, z) => ({ g: 10 + Math.max(0, Math.min(4, Math.floor((z - 44) / 6) + 1)) }));
    const s = new Sim(map, { x: 64, z: 25 }, 0, 25 / 3.6);
    s.run(9, cruise(25));
    const L = s.log, end = L[L.length - 1];
    const d = { yEnd: r2(end.y), zEnd: r2(end.z), kmhEnd: r2(end.kmh), steps: s.events.filter((e) => e.kind === 'step').length, ...feel(L), ...summary(s) };
    s.dispose();
    return { name: 'terrace_stairs', pass: end.y > 14.5 && end.z > 70 && d.minUp > 0.8, detail: d };
  },
  // a bus (12 m) up the ramp street at 40 km/h and onto a 1 m terrace at 25
  bus_ramp() {
    const map = synthMap(2, (x, z) => {
      const g = 10 + Math.max(0, Math.min(8, Math.floor((z - 30) / 5)));
      return x >= 56 && x < 72 ? { g, mat: STREET } : { g: g + 3 };
    });
    const s = new Sim(map, { x: 64, z: 12 }, 0, 40 / 3.6, bus(12));
    s.run(6, cruise(40));
    const L = s.log, end = L[L.length - 1];
    const d = { yEnd: r2(end.y), zEnd: r2(end.z), kmhEnd: r2(end.kmh), ...feel(L.filter((l) => l.z < 74)), ...summary(s) };
    s.dispose();
    return { name: 'bus_ramp', pass: end.z > 75 && d.minUp > 0.9, detail: d };
  },
  bus_terrace() {
    const map = synthMap(2, (_x, z) => ({ g: z >= 50 ? 11 : 10 }));
    const s = new Sim(map, { x: 64, z: 25 }, 0, 25 / 3.6, bus(12));
    s.run(6, cruise(25));
    const L = s.log, end = L[L.length - 1];
    const d = { yEnd: r2(end.y), zEnd: r2(end.z), kmhEnd: r2(end.kmh), ...feel(L), ...summary(s) };
    s.dispose();
    return { name: 'bus_terrace', pass: end.z > 65 && end.y > 11.5 && d.minUp > 0.9, detail: d };
  },
  // floatiness: the body kicked at 30 km/h on level ground (as by a bump): down at 0.6 m/s (heave), nose up at 0.8
  // rad/s (pitch); how it swings back (settling(): overshoot, settle time to within 1 cm / 0.005 rad, frequency)
  settle_heave() { return kick('settle_heave', { x: 0, y: -0.6, z: 0 }, null); },
  settle_pitch() { return kick('settle_pitch', null, 0.8); },
  // floatiness over a crest: the ramp street's top (1 m per 5 m, ~25 %, onto level ground) at 50 and 30 km/h: how long
  // no wheel touches (airS), how high the body rises over its ride height (hopCm), the hardest landing (landLoad: the
  // wheels' force over the car's weight) and the time from the top until the body is back within 2 cm (settleS)
  crest_50() { return crest('crest_50', 50); },
  crest_30() { return crest('crest_30', 30); },
  // steering: at 50 km/h on level ground, half the steering held from 0.5 s: how fast the yaw rate builds up (yawRise:
  // to 90 % of its steady value), how much of the wheels' angle it turns (yawGain: 1 = as the front wheels point, less:
  // the tyres slide), the sideways g and body roll (deg)
  steer_step() {
    const map = synthMap(2, () => ({ g: 10, mat: STREET }));
    const s = new Sim(map, { x: 64, z: 30 }, 0, 50 / 3.6);
    s.run(4, (sim) => ({ ...cruise(50)(sim), steer: sim.t >= 0.5 ? 0.5 : 0 }));
    const L = s.log, at = (t: number) => L.findIndex((l) => l.t >= t);
    const tail = L.slice(at(3), at(3.9));
    const yr = tail.reduce((a, l) => a + Math.abs(l.yr), 0) / tail.length;
    const rise = L.findIndex((l) => l.t >= 0.5 && Math.abs(l.yr) >= 0.9 * yr);
    const v = Math.hypot(tail[0].vx, tail[0].vz), steer = Math.abs(tail[0].steer);
    const base = CAR.wheels[0].z - CAR.wheels[2].z;
    const d = {
      yawRise: r2(L[rise].t - 0.5), yawGain: r2(yr / (v * Math.tan(steer) / base)), latG: r2(v * yr / 9.81),
      rollDeg: r2(Math.abs(tail.reduce((a, l) => a + l.roll, 0) / tail.length) * 180 / Math.PI), kmhEnd: r2(L[L.length - 1].kmh), ...summary(s),
    };
    s.dispose();
    return { name: 'steer_step', pass: d.yawGain > 0.5 && d.minUp > 0.9, detail: d };
  },
  flat_chunk_borders() {
    // flat ground at 80 km/h over 6 chunk borders: no bumps
    const map = synthMap(2, () => ({ g: 10, mat: STREET }));
    const s = new Sim(map, { x: 63.5, z: 8 }, 0, 80 / 3.6);
    s.run(4.5, cruise(80));
    const vy = Math.max(...s.log.map((l) => Math.abs(l.vy)));
    const d = { maxAbsVy: r2(vy), zEnd: r2(s.log[s.log.length - 1].z), ...summary(s) };
    s.dispose();
    return { name: 'flat_chunk_borders', pass: vy < 0.3, detail: d };
  },
};

// a paved street on ground g(x, z) (walls 3 m high either side beyond `half` m of x = 64), driven along z from 15
function slope(name: string, g: (x: number, z: number) => number, kmh: number, half = 10): Outcome {
  const map = synthMap(2, (x, z) => (Math.abs(x + 0.5 - 64) <= half ? { g: g(x, z), mat: STREET } : { g: g(x, z) + 3 }));
  const s = new Sim(map, { x: 64, z: 15 }, 0, kmh / 3.6);
  s.run(70 / (kmh / 3.6), cruise(kmh));
  const L = s.log, end = L[L.length - 1];
  const d = { zEnd: r2(end.z), xEnd: r2(end.x), kmhEnd: r2(end.kmh), steps: s.events.filter((e) => e.kind === 'step').length, ...feel(L.filter((l) => l.z < 80)), ...summary(s) };
  s.dispose();
  return { name, pass: end.z > 80 && d.minUp > 0.8, detail: d };
}

function crest(name: string, kmh: number): Outcome {
  const map = synthMap(2, (x, z) => {
    const g = 10 + Math.max(0, Math.min(8, Math.floor((z - 30) / 5)));
    return x >= 56 && x < 72 ? { g, mat: STREET } : { g: g + 3 };
  });
  const s = new Sim(map, { x: 64, z: 15 }, 0, kmh / 3.6);
  s.run(110 / (kmh / 3.6), cruise(kmh));
  const rest = s.log[0].y - s.log[0].road;
  // (from the last stretch of the climb on)
  const L = s.log.filter((l) => l.z > 62 && l.z < 110), top = L.findIndex((l) => l.z > 72);
  const h = L.map((l) => l.y - l.road - rest);
  const d = {
    airS: r2(L.filter((l) => l.wheels === 0).length * STEP), hopCm: r2(100 * Math.max(...h)), landLoad: r2(Math.max(...L.slice(top).map((l) => l.load))),
    settleS: r2((L.length - top - [...h].reverse().findIndex((x) => Math.abs(x) > 0.02)) * STEP), ...floaty(L), ...summary(s),
  };
  s.dispose();
  return { name, pass: d.minUp > 0.9, detail: d };
}

// on level ground at 30 km/h: the body's velocity (heave) or pitch rate (rad/s, nose up) kicked at 1 s
function kick(name: string, dv: { x: number; y: number; z: number } | null, pitchRate: number | null): Outcome {
  const map = synthMap(2, () => ({ g: 10, mat: STREET }));
  const s = new Sim(map, { x: 64, z: 10 }, 0, 30 / 3.6);
  s.run(1, cruise(30));
  const rest = s.log[s.log.length - 1], b = s.car.body;
  if (dv) { const v = b.linvel(); b.setLinvel({ x: v.x + dv.x, y: v.y + dv.y, z: v.z + dv.z }, true); }
  // (heading 0: the car's side axis is x; nose up is about -x)
  if (pitchRate) { const w = b.angvel(); b.setAngvel({ x: w.x - pitchRate, y: w.y, z: w.z }, true); }
  const from = s.log.length;
  s.run(2.5, cruise(30));
  const L = s.log.slice(from);
  const st = dv ? settling(L.map((l) => l.y - l.road), rest.y - rest.road, 0.01) : settling(L.map((l) => l.pitch), rest.pitch, 0.005);
  const d = { ...st, minLoad: r2(Math.min(...L.map((l) => l.load))), airPct: floaty(L).airPct, ...summary(s) };
  s.dispose();
  return { name, pass: st.settleS < 1.5 && d.minUp > 0.9, detail: d };
}

function wallGlance(name: string, deg: number): Outcome {
  const map = synthMap(2, (x) => (x >= 70 && x < 73 ? { g: 10, runs: [[10, 16, WALL]] } : { g: 10 }));
  const a = deg * Math.PI / 180, s = new Sim(map, { x: 70 - 1.5 - 12 * Math.sin(a), z: 10 }, a, 50 / 3.6);
  s.run(4, cruise(50));
  const L = s.log, hit = L.findIndex((l) => l.x > 70 - 2.2);
  const after = L[Math.min(L.length - 1, (hit < 0 ? 0 : hit) + 60)];
  const end = L[L.length - 1];
  const imp = s.events.filter((e) => e.kind === 'impact');
  const d = { hit: hit >= 0, kmhAt1sAfterHit: r2(after.kmh), zGain: r2(end.z - 10), headingEnd: r2(end.heading), xEnd: r2(end.x), maxImpact: r2(Math.max(0, ...imp.map((e) => e.speed))), ...summary(s) };
  s.dispose();
  return { name, pass: hit >= 0 && after.kmh > 25 && end.x < 70 && d.minUp > 0.8, detail: d };
}

function river(name: string, map: ScenarioMap, kmh: number): Outcome {
  const s = new Sim(map, { x: 64, z: 30 }, 0, kmh / 3.6);
  s.run(10, cruise(kmh));
  const d = { ...summary(s), t: r2(s.t), zEnd: r2(s.log[s.log.length - 1].z) };
  s.dispose();
  return { name, pass: d.status === 'water', detail: d };
}

// a terrace across the way, `rise` m up at z = 50 (down if negative); block: not of ground but a 1 m platform standing on
// it (a loading dock, a low wall: no ramp for the car, a wedge: car.ts)
function terrace(name: string, kmh: number, angle: number, rise: number, target = kmh, block = false) {
  const map = synthMap(2, (_x, z) => (!block ? { g: z >= 50 ? 10 + rise : 10 } : (z >= 50) === rise > 0 ? { g: 10, runs: [[10, 11, WALL]] } : { g: 10 }));
  const s = new Sim(map, { x: 64, z: 30 }, angle, kmh / 3.6);
  s.run(Math.max(5, 40 / ((target || 30) / 3.6)), cruise(target || 30));
  const L = s.log, end = L[L.length - 1];
  const up = rise > 0 ? end.y > 10 + rise : end.y < 10.9 + (block ? 1 : 0);
  const climbed = end.z > 58 && up;
  let jerk = 0;
  for (let i = 1; i < L.length; i++) jerk = Math.max(jerk, Math.abs(L[i].vy - L[i - 1].vy) / STEP);
  const d = { climbed, zEnd: r2(end.z), yEnd: r2(end.y), kmhEnd: r2(end.kmh), maxVertAccel: r2(jerk), steps: s.events.filter((e) => e.kind === 'step').length, ...feel(L), ...summary(s) };
  s.dispose();
  return { name, pass: climbed && d.minUp > 0.8, detail: d };
}

function cliff(name: string, drop: number, kmh: number, crash: boolean): Outcome {
  const map = synthMap(2, (_x, z) => ({ g: z < 50 ? 10 + drop : 10 }));
  const s = new Sim(map, { x: 64, z: 25 }, 0, kmh / 3.6);
  s.run(5, cruise(kmh));
  const L = s.log, end = L[L.length - 1];
  const land = s.events.find((e) => e.kind === 'landing');
  const d = { landingSpeed: land ? r2(land.speed) : 0, crashed: !!land?.crash, upright: end.up > 0.8, zEnd: r2(end.z), ...summary(s) };
  s.dispose();
  return { name, pass: d.crashed === crash && (crash || d.upright), detail: d };
}

// A hall on level earth at 10 m (not paved: no ramps), x 50..78, z 60..110: walls 2 m thick up to 17 m, its floor the
// ground, its roof 15..17 m (5 m of headroom), a door 4 m wide and 4 m high in the south wall (x 62..66). The car
// from z 30 heading +z at x, held at 20 km/h for 16 s (through the door the back wall is 78 m off)
function garage(name: string, x: number): Outcome {
  const map = synthMap(2, (cx, cz) => {
    if (cx < 50 || cx >= 78 || cz < 60 || cz >= 110) return { g: 10 };
    const wall = cx < 52 || cx >= 76 || cz < 62 || cz >= 108, door = cz < 62 && cx >= 62 && cx < 66;
    return { g: 10, runs: [[door ? 14 : wall ? 10 : 15, 17, WALL]] };
  });
  const s = new Sim(map, { x, z: 30 }, 0, 20 / 3.6);
  s.run(16, cruise(20));
  const L = s.log, end = L[L.length - 1];
  const zMax = Math.max(...L.map((l) => l.z)), yMax = Math.max(...L.map((l) => l.y));
  const inside = end.z > 62 && end.z < 108 && end.x > 52 && end.x < 76;
  const d = { xEnd: r2(end.x), zEnd: r2(end.z), zMax: r2(zMax), yMax: r2(yMax), inside, impacts: s.events.filter((e) => e.kind === 'impact').length, ...summary(s) };
  s.dispose();
  const ok = name === 'garage_in' ? inside && zMax < 108 && yMax < 12.5 : end.z < 60 && zMax < 60;
  return { name, pass: ok && d.minUp > 0.8, detail: d };
}

export async function runScenarios(ids?: string[]) {
  await RAPIER.init();
  const out: Outcome[] = [];
  for (const [id, f] of Object.entries(SCENARIOS)) if (!ids || ids.includes(id)) out.push(f());
  return out;
}

void GAS;
