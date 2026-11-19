import { Vector3 } from 'three';
import { ArcadeCar, CRASH_SPEED, type DriveInput } from '../nav/arcade-car';
import { airWorld, carGround, STEP } from '../nav/car-contact';
import type { Pose } from '../sim/types';
import { Body } from './body';
import { makeWorld, type Box, type TestWorld, type WorldSpec } from './testbed';

// Headless physics scenarios: the driven car (nav/arcade-car.ts, with the drive prototype's contact, car-contact.ts) and
// bodies (body.ts) against small synthetic worlds (testbed.ts) through the real VoxelCollision. Run them with
// `node tools/physics.mjs` (web/): each prints its checks and a few feel numbers; --trace NAME dumps a run step by step.
// A scenario fails when a check does; a change in feel shows in the numbers before it breaks a check.

export interface Sample { t: number; x: number; y: number; z: number; h: number; speed: number; vy: number; mode: string; status: string }
export interface Run { trace: Sample[]; events: { t: number; kind: string; value: number }[]; car: ArcadeCar }
export interface Check { ok: boolean; what: string }
export interface Outcome { checks: Check[]; metrics: Record<string, number>; trace?: Sample[] }
export interface Scenario { name: string; about: string; run: () => Promise<Outcome> }

const X = 128; // the lane the car drives along, +z (heading 0)
const GAS: DriveInput = { gas: 1, brake: 0, steer: 0, handbrake: false };
const COAST: DriveInput = { gas: 0, brake: 0, steer: 0, handbrake: false };
const BRAKE: DriveInput = { gas: 0, brake: 1, steer: 0, handbrake: false };
const check = (ok: boolean, what: string): Check => ({ ok, what });
const r2 = (v: number) => Math.round(v * 100) / 100;

const tick = () => new Promise((r) => setTimeout(r, 5));

// waits until the collision tiles around p are in: all of the world's (at most 2 x 2 tiles, all within p's 3 x 3)
async function loaded(w: TestWorld, p: Vector3, v = new Vector3()) {
  const nx = Math.ceil(w.meta.W / 128), nz = Math.ceil(w.meta.D / 128);
  for (let i = 0; i < 2000; i++) {
    w.collision.prefetch(p, v);
    let all = true;
    for (let tz = 0; tz < nz; tz++) for (let tx = 0; tx < nx; tx++) if (!w.collision.support(tx * 128 + 64, tz * 128 + 64, 1e3)) all = false;
    if (all) return;
    await tick();
  }
  throw new Error('collision tiles never loaded');
}

// Drives a car from pose `start` at `speed` with input(t) for `seconds` (or until it lands in water), at the drive's
// fixed step, as drive.prototype.ts advance() does (no other cars).
export async function drive(w: TestWorld, start: Omit<Pose, 'y'> & { y?: number }, speed: number, input: (t: number, car: ArcadeCar) => DriveInput, seconds: number, bus = false): Promise<Run> {
  const p = new Vector3(start.x, 0, start.z);
  await loaded(w, p);
  const y = start.y ?? w.collision.support(start.x, start.z, 1e3)!.height;
  const car = new ArcadeCar({ ...start, y }, speed, bus);
  const air = airWorld(w.collision), contact = (q: Pose) => carGround(w.collision, q, car.length, bus);
  const trace: Sample[] = [], events: Run['events'] = [];
  let t = 0, waits = 0;
  while (t < seconds) {
    const before = car.speed, status = car.step(input(t, car), STEP, contact, air);
    if (status === 'loading') {
      if (++waits > 2000) throw new Error(`collision tiles never loaded at ${car.pose.x}, ${car.pose.z}`);
      w.collision.prefetch(p.set(car.pose.x, car.pose.y, car.pose.z), new Vector3(car.vx, 0, car.vz));
      await tick();
      continue;
    }
    t += STEP;
    const q = car.pose;
    trace.push({ t: r2(t * 1000) / 1000, x: q.x, y: q.y, z: q.z, h: q.h, speed: car.speed, vy: car.vy, mode: car.mode, status });
    if (status === 'impact') events.push({ t, kind: 'impact', value: before }); // (the speed into it)
    if (car.landing) events.push({ t, kind: car.landing.crash ? 'crash' : 'landing', value: car.landing.impact });
    if (status === 'water') { events.push({ t, kind: 'water', value: car.speed }); break; }
  }
  return { trace, events, car };
}

const flat = (g = 10): WorldSpec => ({ size: [256, 256], ground: () => g });
const withBoxes = (spec: WorldSpec, boxes: Box[]): WorldSpec => ({ ...spec, boxes: [...(spec.boxes ?? []), ...boxes] });
// a river across the lane from z0 to z1: its bed at 3, the water's top at 7
const river = (z0: number, z1: number, bank = 10): WorldSpec => ({
  size: [256, 256], ground: (_x, z) => (z >= z0 && z < z1 ? 3 : bank), surface: (_x, z) => (z >= z0 && z < z1 ? 'earth' : 'road'),
  boxes: [{ x0: 0, x1: 256, z0, z1, y0: 3, y1: 7, mat: 'water' }],
});
const first = (r: Run, kind: string) => r.events.find((e) => e.kind === kind);
const maxOf = (r: Run, f: (s: Sample) => number) => r.trace.reduce((m, s) => Math.max(m, f(s)), -Infinity);
const minOf = (r: Run, f: (s: Sample) => number) => r.trace.reduce((m, s) => Math.min(m, f(s)), Infinity);
const last = (r: Run) => r.trace[r.trace.length - 1];

export const SCENARIOS: Scenario[] = [
  {
    name: 'accelerate',
    about: 'full throttle from rest on a flat road for 6 s',
    async run() {
      const w = await makeWorld(flat());
      const r = await drive(w, { x: X, z: 10, h: 0 }, 0, () => GAS, 6);
      const t100 = r.trace.find((s) => s.speed >= 100 / 3.6)?.t ?? Infinity;
      const end = last(r);
      return {
        checks: [
          check(r.trace.every((s) => s.mode === 'ground'), 'stays on the ground'),
          check(Math.abs(end.y - 10) < 1e-6 && Math.abs(end.x - X) < 1e-6, 'straight and level'),
          check(end.speed > 20 && end.speed < 38, `speed after 6 s in 20..38 m/s (${r2(end.speed)})`),
        ],
        metrics: { 'speed 6 s m/s': r2(end.speed), '0-100 km/h s': r2(t100), 'distance m': r2(end.z - 10) },
        trace: r.trace,
      };
    },
  },
  {
    name: 'brake',
    about: 'full brake from 20 m/s on a flat road',
    async run() {
      const w = await makeWorld(flat());
      const r = await drive(w, { x: X, z: 10, h: 0 }, 20, () => BRAKE, 4);
      const stop = r.trace.find((s) => s.speed < 0.05);
      return {
        checks: [check(!!stop, 'comes to a stop within 4 s'), check(!!stop && stop.z - 10 < 30, `stops within 30 m (${stop ? r2(stop.z - 10) : '-'})`)],
        metrics: { 'stop distance m': stop ? r2(stop.z - 10) : NaN, 'stop time s': stop?.t ?? NaN },
        trace: r.trace,
      };
    },
  },
  {
    name: 'wall',
    about: 'into a 5 m wall across the road at 15 m/s',
    async run() {
      const w = await makeWorld(withBoxes(flat(), [{ x0: 96, x1: 160, z0: 60, z1: 62, y0: 10, y1: 15, mat: 'wall' }]));
      const r = await drive(w, { x: X, z: 10, h: 0 }, 15, () => GAS, 6);
      const hit = first(r, 'impact');
      const front = maxOf(r, (s) => s.z) + r.car.length / 2;
      return {
        checks: [
          check(!!hit, 'an impact'),
          check(front <= 60.2, `never through the wall (front reaches z ${r2(front)} of 60)`),
          check(last(r).speed < 3, `slow after it (${r2(last(r).speed)} m/s)`),
          check(r.trace.every((s) => s.mode === 'ground'), 'no flight'),
        ],
        metrics: { 'impact speed m/s': hit ? r2(hit.value) : NaN, 'impacts': r.events.filter((e) => e.kind === 'impact').length },
        trace: r.trace,
      };
    },
  },
  {
    name: 'step-up',
    about: 'a sharp 1 m step up (bare earth, no ramp) at 8 m/s: climbed',
    async run() {
      const w = await makeWorld({ size: [256, 256], ground: (_x, z) => (z < 60 ? 10 : 11), surface: () => 'earth' });
      const r = await drive(w, { x: X, z: 40, h: 0 }, 8, () => GAS, 4);
      return {
        checks: [check(last(r).z > 70, `past the step (z ${r2(last(r).z)})`), check(Math.abs(last(r).y - 11) < 0.01, `on top (y ${r2(last(r).y)})`)],
        metrics: { impacts: r.events.filter((e) => e.kind === 'impact').length },
        trace: r.trace,
      };
    },
  },
  {
    name: 'step-up-2m',
    about: 'a 2 m step up at 8 m/s: a wall',
    async run() {
      const w = await makeWorld({ size: [256, 256], ground: (_x, z) => (z < 60 ? 10 : 12), surface: () => 'earth' });
      const r = await drive(w, { x: X, z: 10, h: 0 }, 8, () => GAS, 8);
      return {
        checks: [check(!!first(r, 'impact'), 'an impact'), check(maxOf(r, (s) => s.y) < 10.01, 'never on top'), check(maxOf(r, (s) => s.z) < 60, 'stopped before it')],
        metrics: {},
        trace: r.trace,
      };
    },
  },
  {
    name: 'ramp',
    about: 'a paved 1:5 slope (1 m every 5 m, smoothed by ramps.ts) at 10 m/s',
    async run() {
      const g = (z: number) => 10 + Math.max(0, Math.min(8, Math.floor((z - 60) / 5)));
      const w = await makeWorld({ size: [256, 256], ground: (_x, z) => g(z) });
      const r = await drive(w, { x: X, z: 10, h: 0 }, 10, () => GAS, 8);
      let jump = 0;
      for (let i = 1; i < r.trace.length; i++) jump = Math.max(jump, Math.abs(r.trace[i].y - r.trace[i - 1].y));
      return {
        checks: [
          check(!first(r, 'impact'), 'no impact'),
          check(Math.abs(last(r).y - 18) < 0.05, `up on top (y ${r2(last(r).y)} of 18)`),
          check(jump < 0.1, `smooth: at most ${r2(jump)} m a step (< 0.1)`),
          check(r.trace.every((s) => s.mode !== 'air'), 'no flight'),
        ],
        metrics: { 'max dy per step m': Math.round(jump * 1000) / 1000, 'speed at top m/s': r2(last(r).speed) },
        trace: r.trace,
      };
    },
  },
  {
    name: 'cliff-3m',
    about: 'off a 3 m drop at 15 m/s: flies, lands, drives on',
    async run() {
      const w = await makeWorld({ size: [256, 256], ground: (_x, z) => (z < 60 ? 13 : 10) });
      const r = await drive(w, { x: X, z: 10, h: 0 }, 15, () => GAS, 6);
      const land = first(r, 'landing') ?? first(r, 'crash');
      const air = r.trace.filter((s) => s.mode === 'air');
      return {
        checks: [
          check(air.length > 0, 'airborne'),
          check(!!land && land.kind === 'landing', `lands, no crash (${land?.kind ?? 'none'})`),
          check(last(r).mode === 'ground' && Math.abs(last(r).y - 10) < 0.01, 'back on the road below'),
          check(air.length > 0 && air[0].z > 55, 'leaves at the edge'),
        ],
        metrics: { 'air time s': r2(air.length * STEP), 'jump length m': air.length ? r2(air[air.length - 1].z - air[0].z) : 0, 'impact m/s': land ? r2(land.value) : NaN },
        trace: r.trace,
      };
    },
  },
  {
    name: 'cliff-20m',
    about: 'off a 20 m drop at 15 m/s: a crash landing',
    async run() {
      const w = await makeWorld({ size: [256, 256], ground: (_x, z) => (z < 60 ? 30 : 10) });
      const r = await drive(w, { x: X, z: 10, h: 0 }, 15, () => GAS, 6);
      const crash = first(r, 'crash');
      return {
        checks: [check(!!crash, `a crash (impact ${crash ? r2(crash.value) : '-'} >= ${r2(CRASH_SPEED)} m/s)`), check(Math.abs(last(r).y - 10) < 0.01, 'down below')],
        metrics: { 'impact m/s': crash ? r2(crash.value) : NaN },
        trace: r.trace,
      };
    },
  },
  {
    name: 'kerb-down',
    about: 'a 1 m step down at 10 m/s: followed, no flight',
    async run() {
      const w = await makeWorld({ size: [256, 256], ground: (_x, z) => (z < 60 ? 11 : 10), surface: () => 'earth' });
      const r = await drive(w, { x: X, z: 40, h: 0 }, 10, () => COAST, 4);
      return {
        checks: [check(r.trace.every((s) => s.mode !== 'air'), 'no flight'), check(Math.abs(last(r).y - 10) < 0.01, 'down')],
        metrics: {},
        trace: r.trace,
      };
    },
  },
  {
    name: 'quay',
    about: 'off a quay 3 m over the river at 12 m/s: into the water',
    async run() {
      const w = await makeWorld(river(60, 200));
      const r = await drive(w, { x: X, z: 10, h: 0 }, 12, () => GAS, 8);
      const wet = first(r, 'water');
      return {
        checks: [check(!!wet, 'ends in the water'), check(!!wet && last(r).z > 60, 'beyond the quay'), check(!first(r, 'crash'), 'no crash first')],
        metrics: { 'splash after s': wet ? r2(wet.t) : NaN, 'splash at z': r2(last(r).z) },
        trace: r.trace,
      };
    },
  },
  {
    name: 'bridge',
    about: 'over a deck level with the road across the river at 12 m/s: stays on it',
    async run() {
      const spec = withBoxes(river(70, 150), [{ x0: 116, x1: 140, z0: 60, z1: 160, y0: 9, y1: 10, mat: 'deck' }]);
      const w = await makeWorld(spec);
      const r = await drive(w, { x: X, z: 10, h: 0 }, 12, () => GAS, 9);
      return {
        checks: [
          check(!first(r, 'water'), 'never in the water'),
          check(minOf(r, (s) => s.y) > 9.95, `never below the deck (lowest y ${r2(minOf(r, (s) => s.y))})`),
          check(r.trace.every((s) => s.mode === 'ground'), 'no flight'),
          check(last(r).z > 160, `across (z ${r2(last(r).z)})`),
        ],
        metrics: {},
        trace: r.trace,
      };
    },
  },
  {
    name: 'body-drop',
    about: 'a 1 m box dropped 10 m onto flat ground (body.ts)',
    async run() {
      const w = await makeWorld(flat());
      await loaded(w, new Vector3(X, 20, 128));
      const b = new Body({ boxes: [{ offset: new Vector3(0, 0.5, 0), half: new Vector3(0.5, 0.5, 0.5) }] });
      b.position.set(X, 20, 128);
      const world = airWorld(w.collision), trace: Sample[] = [];
      let impact = 0, t = 0;
      for (; t < 5; t += STEP) {
        const s = b.step(STEP, world);
        if (s.status === 'loading') throw new Error('loading');
        if (s.landed && !impact) impact = s.impact;
        trace.push({ t, x: b.position.x, y: b.position.y, z: b.position.z, h: 0, speed: b.velocity.length(), vy: b.velocity.y, mode: b.onGround ? 'ground' : 'air', status: s.landed ? 'landed' : '' });
      }
      const want = Math.sqrt(2 * b.gravity * 10);
      return {
        checks: [
          check(Math.abs(impact - want) / want < 0.05, `first impact ${r2(impact)} m/s ~ sqrt(2 g h) ${r2(want)}`),
          check(b.onGround && Math.abs(b.position.y - 10) < 0.01, `at rest on the ground (y ${r2(b.position.y)})`),
          check(minOf({ trace } as Run, (s) => s.y) > 9.99, 'never into the ground'),
        ],
        metrics: { 'impact m/s': r2(impact), bounces: trace.filter((s) => s.status === 'landed').length },
        trace,
      };
    },
  },
  {
    name: 'body-wall',
    about: 'a 1 m box thrown at a wall at 10 m/s (body.ts)',
    async run() {
      const w = await makeWorld(withBoxes(flat(), [{ x0: 96, x1: 160, z0: 140, z1: 142, y0: 10, y1: 15, mat: 'wall' }]));
      await loaded(w, new Vector3(X, 10, 138));
      const b = new Body({ boxes: [{ offset: new Vector3(0, 0.5, 0), half: new Vector3(0.5, 0.5, 0.5) }] });
      b.position.set(X, 10, 138);
      b.onGround = true;
      b.velocity.set(0, 0, 10);
      const world = airWorld(w.collision);
      let wall = 0, maxZ = 0; // (the ground's friction, 4/s, takes some 6 m/s off before it gets there)
      for (let t = 0; t < 3; t += STEP) {
        const s = b.step(STEP, world);
        wall = Math.max(wall, s.wall);
        maxZ = Math.max(maxZ, b.position.z + 0.5);
      }
      return {
        checks: [check(wall > 2, `hits it (${r2(wall)} m/s into it)`), check(maxZ <= 140.01, `stays before it (front z ${r2(maxZ)})`), check(b.velocity.z <= 0.01, 'bounced or stopped')],
        metrics: { 'into wall m/s': r2(wall) },
      };
    },
  },
];
