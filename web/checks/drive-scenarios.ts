// Exercise the same player commands and shared tick that the viewer uses on synthetic terrain.
import RAPIER from '@dimforge/rapier3d-compat';
import { STEP, Traffic } from '../src/sim/traffic';
import type { Car, TrainPathData } from '../src/sim/types';
import type { CoachBox } from '../src/sim/train-traffic';
import type { VehicleId } from '../src/sim/contract/ids';
import type { RoadPose } from '../src/sim/contract/pose';
import { type CarInput, PARK } from '../src/sim/contract/inputs';
import { LifePhysics } from '../src/physics/rapier/life-phys';
import type { DriveNote } from '../src/sim/contract/events';
import { CRASH_MS, SINK_MS } from '../src/sim/contract/snapshot';
import type { Check } from './check';
import { synthMap, WATER, type Col } from './world';

const FRAME_MS = 1000 / 60, PLAYER = 'driver';
const r2 = (x: number) => Math.round(x * 100) / 100;
let id = 1;
export const carAt = (x: number, y: number, z: number): Car => ({
  id: id++, kind: 'car', v: 0, brake: 0, len: 4.4, bus: false, col: '#fff',
  detachedPose: { x, y, z, h: 0, pitch: 0, roll: 0 },
  geo: { px: 0, py: 0, cx: 0, cy: 0, z: 0, fx: 0, fy: 1 },
} as Car);

export class Drive {
  readonly notes: DriveNote[] = [];
  // the parked cars as drawn (view/life.ts drawCars: LifePhysics.pose), by id; first where they were placed
  private readonly drawn = new Map<number, RoadPose>();

  constructor(readonly traffic: Traffic, readonly physics: LifePhysics, readonly car: Car) {
    for (const c of traffic.detachedCars) this.drawn.set(c.id, { ...c.detachedPose! });
  }

  /** car c as drawn after the last step */
  pose(c: Car) { return this.drawn.get(c.id)!; }

  get snapshot() { return this.physics.driverSnapshot(PLAYER); }
  get kmh() { return this.snapshot?.kmh ?? 0; }

  step(dt: number, input: CarInput) {
    this.physics.input(PLAYER, input);
    this.traffic.update(dt, 10, this.car.detachedPose!);
    this.notes.push(...this.physics.driverNotes(PLAYER));
    for (const c of this.traffic.detachedCars) this.drawn.set(c.id, { ...this.physics.pose(c, this.traffic.acc / STEP, this.drawn.get(c.id) ?? { ...c.detachedPose! }) });
  }

  park() {
    this.physics.releaseWheel(PLAYER);
    this.step(STEP, PARK);
  }
}

export function takeOver(col: (x: number, z: number) => Col, x: number, z: number, kmh: number, others: Car[] = [], withPedestrian = false, choice?: VehicleId, trains?: TrainPathData[], heading = 0): Drive {
  const map = synthMap(2, col);
  const physics = new LifePhysics(map.meta, { chunksPerTick: 99 }, { load: () => Promise.reject(null) });
  for (const t of map.tiles) physics.terrain.setTile(t.tx, t.tz, t.tile);
  const y = col(Math.floor(x), Math.floor(z)).g, car = carAt(x, y, z);
  car.v = kmh / 3.6;
  car.detachedPose!.h = heading;
  const traffic = new Traffic({ roads: [], peds: withPedestrian ? [{ p: [[x - 2, 50, y], [x + 2, 50, y]], a: 0, b: 1, w: 1 }] : [], ctrls: [], trains });
  traffic.bodies = physics;
  traffic.detachedCars.push(car, ...others);
  if (withPedestrian) traffic.people.push({ kind: 'person', id: 1, e: 0, dir: 1, s: 2, v: 0, lat: 0, ph: 0, wait: false, col: '#fff' });
  physics.takeWheel(traffic, PLAYER, car.id, choice);
  return new Drive(traffic, physics, car);
}

export function run(d: Drive, seconds: number, input: (d: Drive) => CarInput, until?: (d: Drive) => boolean) {
  for (let i = 0; i < seconds * 60; i++) {
    d.step(FRAME_MS / 1000, input(d));
    if (until?.(d)) break;
  }
  return d;
}

export const cruise = (kmh: number) => (d: Drive): CarInput => ({ gas: d.kmh < kmh ? 1 : 0, brake: 0, steer: 0, handbrake: false });
export const said = (d: Drive, text: string) => d.notes.some((n) => n.text.startsWith(text));
const street = (): Col => ({ g: 10, mat: 1 });
const testTrack = (start: number, stops: number[]): TrainPathData[] =>
  [{ p: [[start, 50, 10], [start + 1200, 50, 10]], svc: [{ ref: 'R', op: '', stops }] }];

// the traffic's clock set to the first time the head coach of the trains' timetable (and it 10 s on) is as wanted
function clockWhen(d: Drive, ok: (head: CoachBox, later: CoachBox) => boolean) {
  const T = d.traffic, head = (t: number) => { T.trains.tick(t, 10); return T.trains.coachBoxes().next().value; };
  for (let t = 0; t < 7200; t += 0.25) {
    const k = head(t), later = head(t + 10);
    if (k && later && k.id === later.id && ok(k, later)) { T.t = t; T.trains.tick(t, 10); return; }
  }
  throw new Error('no such time in the timetable');
}

function kinematicBodies(d: Drive) {
  const bodies: RAPIER.RigidBody[] = [];
  d.physics.world.forEachRigidBody((body) => { if (body.isKinematic()) bodies.push(body); });
  return bodies;
}

function sharedDrive() {
  const map = synthMap(2, street);
  const physics = new LifePhysics(map.meta, { chunksPerTick: 3 }, { load: () => Promise.reject(null) });
  for (const t of map.tiles) physics.terrain.setTile(t.tx, t.tz, t.tile);
  const traffic = new Traffic({ roads: [{ p: [[64, 4, 10], [64, 120, 10]], a: 0, b: 1, w: 1, lanes: 1, v: 0.1, c: 1, o0: 0 }],
    peds: [], ctrls: [] }, 7);
  traffic.bodies = physics;
  traffic.edited([58, 55, 69, 71]);
  const a = carAt(64, 10, 25), b = carAt(84, 10, 25), ai = carAt(64, 10, 61);
  a.id = 9001; b.id = 9002; ai.id = 9003;
  a.v = 11;
  traffic.detachedCars.push(a, b);
  Object.assign(ai, { detachedPose: undefined, e: 0, lane: 0, s: 59, off: 0, prev: -1, prevOff: 0, next: -1, v0f: 1, wait: 0,
    ghost: 0, ds: 0, dOff: 0, why: 'free', by: null, boxNode: -1, boxFrom: -1, boxTo: -1, boxLane: 0, boxT: 0, boxTurn: 0, block: null });
  traffic.cars.push(ai);
  traffic.roads[0].lists[0].push(ai);
  const tick = () => traffic.update(STEP, 12, { x: 64, z: 50 });
  for (let i = 0; i < 10; i++) tick();
  const existing = physics.bodies.get(ai.id), physicalBefore = existing?.state === 'track';
  const claimed = physics.takeWheel(traffic, 'first', a.id), refused = !physics.takeWheel(traffic, 'second', a.id);
  tick();
  const won = claimed && refused && physics.driverSnapshot('first')?.entityId === a.id && !physics.driverSnapshot('second');
  physics.takeWheel(traffic, 'second', b.id);
  const input = { gas: 1, brake: 0, steer: 0, handbrake: false };
  for (let i = 0; i < 115; i++) {
    physics.input('first', { ...input, gas: Number((physics.driverSnapshot('first')?.kmh ?? 0) < 40) });
    physics.input('second', { ...input, gas: Number((physics.driverSnapshot('second')?.kmh ?? 0) < 20) });
    tick();
  }
  const collision = physics.log.some((e) => e.id === ai.id && e.kind === 'lost' && e.why === 'player contact');
  const reusedAI = !!existing && physics.bodies.get(ai.id) === existing;
  const firstBody = physics.bodies.get(a.id), bBefore = b.detachedPose!.z;
  physics.releaseWheel('first');
  for (let i = 0; i < 30; i++) tick();
  const released = !physics.driverSnapshot('first') && physics.bodies.get(a.id) === firstBody;
  const droveOn = b.detachedPose!.z > bBefore + 2 && physics.driverSnapshot('second')?.entityId === b.id;
  physics.dispose();
  return { physicalBefore, won, collision, reusedAI, released, droveOn };
}

export const DRIVE_SCENARIOS: Record<string, () => Check> = {
  drive_standing_coach() {
    const d = takeOver(street, 64, 25, 50, [], false, 'car', testTrack(-1100, [1134.5]));
    // (the clock at the timetabled train's stop across the test street, standing for the next 10 s)
    clockWhen(d, (k, later) => Math.abs(k.x - 66) < 0.5 && later.x === k.x);
    const start = d.traffic.trains.coachBoxes().next().value!;
    let approachKmh = 0;
    const throttle = cruise(50);
    run(d, 4, (drive) => {
      if (!said(drive, 'Contact')) approachKmh = drive.kmh;
      return throttle(drive);
    });
    const coach = d.traffic.trains.coachBoxes().next().value!;
    const x = coach.x - d.physics.origin.x, z = coach.z - d.physics.origin.z, y = coach.y + coach.size.y / 2;
    const aligned = kinematicBodies(d).some((body) => {
      const p = body.translation();
      return Math.hypot(p.x - x, p.y - y, p.z - z) < 0.01;
    });
    const stoppedZ = d.snapshot!.pose.z;
    const endKmh = d.kmh, impact = said(d, 'Contact');
    const coachStayed = start.id === coach.id && start.x === coach.x && aligned;
    d.park();
    const released = !kinematicBodies(d).length;
    d.physics.dispose();
    const detail = { approachKmh: r2(approachKmh), endKmh: r2(endKmh), stoppedZ: r2(stoppedZ), impact, coachStayed, released };
    return { name: 'drive_standing_coach', pass: approachKmh >= 48 && stoppedZ > 44 && stoppedZ < 48.5 &&
      impact && coachStayed && released && Math.abs(endKmh) < 1, detail };
  },
  drive_moving_coach_bike() {
    const d = takeOver(street, 64, 50, 0, [], false, 'moto', testTrack(-1020, []));
    // (the clock with the timetabled train's head about 30 m short of the bike, coming on)
    clockWhen(d, (k, later) => Math.abs(k.x - 34) < 2.5 && later.x > k.x);
    const start = d.traffic.trains.coachBoxes().next().value!;
    run(d, 4, () => PARK, (drive) => !!drive.snapshot?.fallMs);
    const coach = d.traffic.trains.coachBoxes().next().value!;
    const detail = { fell: !!d.snapshot?.fallMs && said(d, 'Crash! You came off'),
      movedM: r2(coach.x - start.x), sameCoach: start.id === coach.id };
    d.physics.dispose();
    return { name: 'drive_moving_coach_bike', pass: detail.fell && detail.movedM > 5 && detail.sameCoach, detail };
  },
  drive_shared() {
    const checks = sharedDrive();
    return { name: 'drive_shared', pass: Object.values(checks).every(Boolean), detail: checks };
  },
  // a traffic car standing in the lane, run into at 40 km/h: knocked out of the traffic (takeWheel) and away (its Car
  // drawn where its body lies)
  drive_knock() {
    const other = carAt(64, 10, 60);
    const d = takeOver(street, 64, 30, 40, [other]);
    run(d, 4, cruise(40));
    const moved = Math.hypot(d.pose(other).x - 64, d.pose(other).z - 60);
    const detail = { taken: d.physics.bodies.get(other.id)?.state === 'wreck' || d.physics.bodies.get(other.id)?.state === 'rest', crashNote: said(d, 'Crash!'), movedM: r2(moved), carZ: r2(d.pose(d.car).z) };
    d.park();
    d.physics.dispose();
    return { name: 'drive_knock', pass: detail.taken && detail.crashNote && moved > 1, detail };
  },
  // a person in the lane, run into at 30 km/h: knocked down along the car's velocity
  drive_person() {
    const d = takeOver(street, 64, 30, 30, [], true);
    run(d, 3, cruise(30));
    const k = d.traffic.struck[0];
    const detail = { knocked: !!k, ouch: said(d, 'Ouch!'), vz: r2(k?.vz ?? 0) };
    d.park();
    d.physics.dispose();
    return { name: 'drive_person', pass: !!k && detail.ouch && k.vz > 2, detail };
  },
  // off the bank into the river at 40 km/h (the river's water the ground's top voxel, 3 m under the bank): a splash,
  // no control while it sinks, then back on the bank some 12 m before its edge (where it was last on the road, not
  // where it was taken), standing, on its wheels
  drive_river_respawn() {
    const d = takeOver((_x, z) => (z >= 60 ? { g: 4, mat: WATER } : { g: 7 }), 64, 20, 40);
    run(d, 8, cruise(40), (x) => !!x.snapshot?.sinkMs);
    const splashAt = d.traffic.t * 1000, splash = said(d, 'Splash!'), held = !!d.snapshot?.sinkMs;
    run(d, (SINK_MS + 200) / 1000, cruise(40));
    // (back: placed once its ground is built, then settled for a second, no input)
    run(d, 1, () => ({ gas: 0, brake: 0, steer: 0, handbrake: true }));
    const snap = d.snapshot!, p = d.pose(d.car);
    const detail = { splash, held, backAfterS: r2((d.traffic.t * 1000 - splashAt) / 1000), status: snap.status, onWheels: snap.onWheels, zBack: r2(p.z), yBack: r2(p.y), kmh: r2(d.kmh) };
    d.park();
    d.physics.dispose();
    return { name: 'drive_river_respawn', pass: splash && held && detail.status === 'ok' && detail.onWheels && p.z < 50 && p.z > 35 && Math.abs(p.y - 7) < 0.5, detail };
  },
  // parked in the river: back on the bank first
  drive_park_in_river() {
    const d = takeOver((_x, z) => (z >= 60 ? { g: 4, mat: WATER } : { g: 7 }), 64, 20, 40);
    run(d, 8, cruise(40), (x) => !!x.snapshot?.sinkMs);
    d.park();
    const p = d.pose(d.car);
    const detail = { zParked: r2(p.z), yParked: r2(p.y), carGone: !d.snapshot };
    return { name: 'drive_park_in_river', pass: p.z < 50 && Math.abs(p.y - 7) < 0.5 && detail.carGone, detail };
  },
  // off a 10 m cliff at 60 km/h: a crash landing; the player's input ignored for CRASH_MS, then back
  drive_crash_landing() {
    const d = takeOver((_x, z) => ({ g: z < 50 ? 20 : 10 }), 64, 25, 60);
    run(d, 5, cruise(60), (x) => !!x.snapshot?.crashMs);
    const crashed = !!d.snapshot?.crashMs, heldNow = (d.snapshot?.crashMs ?? 0) > CRASH_MS - 1, note = said(d, 'Crash!');
    run(d, (CRASH_MS + 100) / 1000, () => PARK);
    const heldAfter = !!d.snapshot?.crashMs;
    const detail = { crashed, note, heldNow, heldAfter };
    d.park();
    d.physics.dispose();
    return { name: 'drive_crash_landing', pass: crashed && note && heldNow && !heldAfter, detail };
  },
};

export async function runDriveScenarios(ids?: string[]) {
  await RAPIER.init();
  const out: Check[] = [];
  for (const [id, f] of Object.entries(DRIVE_SCENARIOS)) if (!ids || ids.includes(id)) out.push(f());
  return out;
}
