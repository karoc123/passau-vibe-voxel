// Rapier car: reproducible driving scenarios on synthetic voxel terrain, run headless (tools/rapier-car.mjs) or in the
// page (window.__rapierScenarios). Each builds a small map (2 x 2 tiles of 64 m), drops the car, drives it with scripted
// input at a fixed 1/60 s step and judges the outcome from its telemetry.
import RAPIER from '@dimforge/rapier3d-compat';
import { MAT } from '../../voxelMaterial';
import { RapierCar, TUNED, type CarInput, type CarEvent, type CarTuning } from './car';
import { RapierTerrain, terrainTile, terrainPalette } from './terrain';

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

export interface Sample { t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; kmh: number; up: number; heading: number; wheels: number; stepMs: number }

export class Sim {
  readonly world: RAPIER.World;
  readonly terrain: RapierTerrain;
  readonly car: RapierCar;
  readonly log: Sample[] = [];
  readonly events: CarEvent[] = [];
  t = 0;

  constructor(map: ScenarioMap, at: { x: number; z: number }, heading: number, speed = 0) {
    const R = RAPIER;
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.terrain = new RapierTerrain(R, this.world, map.meta, { x: 0, z: 0 }, { budgetMs: 1e9 });
    for (const t of map.tiles) this.terrain.setTile(t.tx, t.tz, t.tile);
    this.terrain.update([{ x: at.x, z: at.z }]);
    const g = this.terrain.groundAt(at.x, at.z, 1e4) ?? 0;
    this.car = new RapierCar(R, this.world, { x: at.x, y: g + 1.0, z: at.z }, heading, this.terrain, scenarioTuning.tuning);
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
    this.log.push({ t: this.t, x: pp.x, y: pp.y, z: pp.z, vx: vv.x, vy: vv.y, vz: vv.z, kmh: this.car.kmh, up, heading: Math.atan2(fx, fz), wheels: this.car.wheelsInContact(), stepMs: ms });
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

export interface Outcome { name: string; pass: boolean; detail: Record<string, number | string | boolean> }

function summary(s: Sim) {
  const L = s.log;
  let maxStep = 0, sumStep = 0, minUp = 1;
  for (const l of L) { maxStep = Math.max(maxStep, l.stepMs); sumStep += l.stepMs; minUp = Math.min(minUp, l.up); }
  return { stepMsAvg: +(sumStep / Math.max(1, L.length)).toFixed(3), stepMsMax: +maxStep.toFixed(2), minUp: +minUp.toFixed(2), status: s.car.status };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

// The scenarios. `ids`: a subset (all by default).
export const SCENARIOS: Record<string, () => Outcome> = {
  // a 1 m terrace across the way (earth, no ramp), driven up at 30 km/h, square on and at 35°; and down again
  terrace_up_30() { return terrace('terrace_up_30', 30, 0, 1); },
  terrace_up_15() { return terrace('terrace_up_15', 15, 0, 1); },
  terrace_up_diag() { return terrace('terrace_up_diag', 30, 0.6, 1); },
  terrace_up_from_rest() { return terrace('terrace_up_from_rest', 0, 0, 1, 34); },
  terrace_down() { return terrace('terrace_down', 30, 0, -1); },
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
    const d = { yEnd: r2(end.y), zEnd: r2(end.z), kmhEnd: r2(end.kmh), maxVertAccel: r2(jerk), pitchRateEnd: r2(pitchRate), minWheels: Math.min(...L.map((l) => l.wheels)), ...summary(s) };
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

function terrace(name: string, kmh: number, angle: number, rise: number, target = kmh) {
  const map = synthMap(2, (_x, z) => ({ g: z >= 50 ? 10 + rise : 10 }));
  const s = new Sim(map, { x: 64, z: 30 }, angle, kmh / 3.6);
  s.run(Math.max(5, 40 / ((target || 30) / 3.6)), cruise(target || 30));
  const L = s.log, end = L[L.length - 1];
  const up = rise > 0 ? end.y > 10 + rise : end.y < 10.9;
  const climbed = end.z > 58 && up;
  let jerk = 0;
  for (let i = 1; i < L.length; i++) jerk = Math.max(jerk, Math.abs(L[i].vy - L[i - 1].vy) / STEP);
  const d = { climbed, zEnd: r2(end.z), yEnd: r2(end.y), kmhEnd: r2(end.kmh), maxVertAccel: r2(jerk), steps: s.events.filter((e) => e.kind === 'step').length, ...summary(s) };
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

export async function runScenarios(ids?: string[]) {
  await RAPIER.init();
  const out: Outcome[] = [];
  for (const [id, f] of Object.entries(SCENARIOS)) if (!ids || ids.includes(id)) out.push(f());
  return out;
}

void GAS;
