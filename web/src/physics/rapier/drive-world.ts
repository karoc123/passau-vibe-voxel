// The player's car on Rapier (car.ts) in the drive mode (nav/drive.ts, one drive: nav/drive-session.ts):
// one world for the page, its voxel colliders built near the car (terrain.ts), the traffic near it as kinematic bodies
// the car runs into. Loaded in the background once the city is shown (loadRapierDrive: Rapier's wasm, its first step
// and the collision decoding's first tile taken then, not on the first drive).
//
// The drive mode keeps its car (a traffic Car of sim/life.ts, drawn by the street life) and moves it from here: the
// body's pose is put on the Car (its ground point rp, heading rh, pitch and roll; any orientation: a car on its roof is
// drawn on its roof and stays there).
//
// What the car runs into, kept cheap and near it: a traffic car hit hard (KNOCK m/s between them) turns from a
// kinematic box into a dynamic one (a wreck: knocked away, it comes to rest and stays where it lies, then a kinematic
// box again); a person walking or cycling (the street life's) the car's box runs into is reported (a 'person' event
// with the car's velocity: the street life shoves them away and lays them down, life.ts knockDown; no bodies here).
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Meta } from '../../types';
import { bus, CAR, RapierCar, type CarBuild, type CarEvent, type CarInput } from './car';
import { warmUp } from './vehicle';
import { FixedStep } from '../../core/fixed-step';
import { modelHalf, VEHICLES, type VehicleId } from '../../sim/vehicles';
import { CHUNK, RapierTerrain, WORLD_GROUPS, chunkShapes, type TerrainOptions } from './terrain';
import { viewerTileCache } from '../../viewer-tiles';

export const STEP = 1 / 60;
const MAX_STEPS = 4;
const OBSTACLE_R = 40; // m: traffic within this of the car is in the world
const KNOCK = 4; // m/s between the car and a traffic car that knocks it away
const MAX_WRECKS = 4, WRECK_REST_S = 0.8, WRECK_MAX_S = 20;
const HIT_SPEED = 2.5; // m/s: slower, the car nudges people aside unreported (they walk on)

// something on the road the car meets (a traffic car or bus): its ground point and heading, length, kind
export interface Obstacle { key: object; x: number; y: number; z: number; h: number; len: number; bus: boolean; vt?: VehicleId }
// a person near the car (walking or cycling): their ground point
export interface Walker { key: object; x: number; y: number; z: number }
// what the car did to them: knocked a traffic car away (now a wreck: drawn from wrecks()), hit a person (vx, vz: the
// car's velocity then, m/s)
export type DriveEvent = CarEvent | { kind: 'knock'; key: object; speed: number } | { kind: 'person'; key: object; speed: number; vx: number; vz: number };
interface Kin { body: RAPIER.RigidBody; collider: RAPIER.Collider; mass: number; from: THREE.Vector3; fromH: number; to: THREE.Vector3; toH: number; seen: boolean; lift: number; v: THREE.Vector3 }
interface Wreck { body: RAPIER.RigidBody; lift: number; age: number; still: number }

// The drawn pose: the ground point under the body's origin (as a traffic car's rp), heading, pitch (nose up), roll
export interface DrawnPose { x: number; y: number; z: number; h: number; pitch: number; roll: number }

// what is driven, for a traffic car or bus of `len` m
export const buildFor = (isBus: boolean, len: number): CarBuild => (isBus ? bus(len) : CAR);
// what is driven, for a traffic car of any type (sim/vehicles.ts)
export { buildOf } from '../../sim/vehicles';

let loading: Promise<RapierDrive> | null = null;

// Rapier, warmed up, and the drive's world (once per page; `focus`: where to decode a first tile)
export function loadRapierDrive(meta: Meta, focus: { x: number; z: number }) {
  return loading ??= (async () => {
    await RAPIER.init();
    warmUp();
    const d = new RapierDrive(meta, focus);
    await d.warmTerrain(focus);
    return d;
  })();
}

export class RapierDrive {
  readonly world: RAPIER.World;
  readonly terrain: RapierTerrain;
  readonly origin: { x: number; z: number };
  car: RapierCar | null = null;
  private pending: { pose: DrawnPose; speed: number; build: CarBuild } | null = null;
  // the fixed steps (core/fixed-step.ts): a frame counts for at most 0.25 s, at most MAX_STEPS steps
  private readonly clock = new FixedStep(STEP, MAX_STEPS, 0.25);
  private readonly prevP = new THREE.Vector3();
  private readonly curP = new THREE.Vector3();
  private prevRide = 0;
  private curRide = 0;
  // a bike's lean and wheelie (car.ts) at the last two steps
  private readonly prevLean = { lean: 0, wheelie: 0 };
  private readonly curLean = { lean: 0, wheelie: 0 };
  private readonly prevQ = new THREE.Quaternion();
  private readonly curQ = new THREE.Quaternion();
  private readonly kin = new Map<object, Kin>();
  private readonly wrecked = new Map<object, Wreck>();
  readonly stats = { stepMs: 0, stepMsMax: 0, frameMs: 0, frameMsMax: 0 };

  // (terrain: its options; tests give the tiles directly, terrain.setTile)
  constructor(private readonly meta: { W: number; D: number; tiles: { N: number }; palette: Meta['palette'] }, focus: { x: number; z: number }, terrain: TerrainOptions = {}) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.origin = { x: Math.floor(focus.x / CHUNK) * CHUNK, z: Math.floor(focus.z / CHUNK) * CHUNK };
    // (the viewer's shared node files, unless told where to load them from)
    this.terrain = new RapierTerrain(RAPIER, this.world, meta, this.origin, terrain.cache || terrain.load ? terrain : { ...terrain, cache: viewerTileCache(meta.tiles.N) });
  }

  // The tile under `focus` decoded (the decoding's first run, ~30-50 ms with the JIT's warm-up, out of the way) and
  // a chunk's shapes taken from it once
  async warmTerrain(focus: { x: number; z: number }) {
    const t = await this.terrain.prefetch(focus.x, focus.z);
    if (t) chunkShapes(t, this.meta.tiles.N, Math.floor(focus.x / CHUNK), Math.floor(focus.z / CHUNK));
  }

  // A car to drive at `pose` (its ground point and orientation, as drawn), placed once its ground is built
  begin(pose: DrawnPose, speed: number, build: CarBuild) {
    this.end();
    this.pending = { pose: { ...pose }, speed, build };
  }

  end() {
    this.car?.dispose(this.world);
    this.car = null;
    this.pending = null;
    for (const k of this.kin.values()) this.world.removeRigidBody(k.body);
    this.kin.clear();
    // (the wrecks stay as they lie)
    for (const w of this.wrecked.values()) this.world.removeRigidBody(w.body);
    this.wrecked.clear();
  }

  get waiting() { return !!this.pending; }

  // One frame: the colliders near the car, the traffic near it, the fixed steps. Returns what happened in them, or
  // 'loading' (the car's ground not built yet: held still).
  update(dt: number, input: CarInput, obstacles: Obstacle[], walkers: Walker[] = []): DriveEvent[] | 'loading' {
    const f0 = performance.now();
    const at = this.car ? this.toWorld(this.car.body.translation()) : this.pending ? new THREE.Vector3(this.pending.pose.x, 0, this.pending.pose.z) : null;
    if (!at) return [];
    const v = this.car?.body.linvel();
    const [ready] = this.terrain.update([{ x: at.x, z: at.z, vx: v?.x, vz: v?.z }]);
    if (!ready) { this.clock.acc = 0; return 'loading'; }
    if (this.pending) this.place();
    const car = this.car!;
    const events: DriveEvent[] = [];
    const n = this.clock.take(dt);
    this.obstacles(obstacles, at, n * STEP);
    if (n) this.walkers(walkers, n * STEP, events);
    for (let i = 0; i < n; i++) {
      this.prevP.copy(this.curP); this.prevQ.copy(this.curQ); this.prevRide = this.curRide;
      Object.assign(this.prevLean, this.curLean);
      for (const k of this.kin.values()) {
        const t = (i + 1) / n, p = k.from.clone().lerp(k.to, t);
        let dh = k.toH - k.fromH;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        k.body.setNextKinematicTranslation({ x: p.x - this.origin.x, y: p.y + k.lift, z: p.z - this.origin.z });
        k.body.setNextKinematicRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), k.fromH + dh * t));
      }
      const s0 = performance.now();
      car.step(input, STEP);
      const cv = car.body.linvel(), carV = new THREE.Vector3(cv.x, cv.y, cv.z);
      this.world.step();
      const ev = car.afterStep(STEP);
      if (ev) events.push(ev);
      this.knocks(carV, events);
      this.settleWrecks(STEP);
      const ms = performance.now() - s0;
      this.stats.stepMs = ms;
      this.stats.stepMsMax = Math.max(this.stats.stepMsMax, ms);
      this.toWorld(car.body.translation(), this.curP);
      this.curRide = car.ride;
      this.curLean.lean = car.lean; this.curLean.wheelie = car.wheelie;
      const r = car.body.rotation();
      this.curQ.set(r.x, r.y, r.z, r.w);
    }
    for (const k of this.kin.values()) { k.from.copy(k.to); k.fromH = k.toH; }
    this.stats.frameMs = performance.now() - f0;
    this.stats.frameMsMax = Math.max(this.stats.frameMsMax, this.stats.frameMs);
    return events;
  }

  // The car let go (handbrake on) until it rests, at most `seconds` of steps at once: where it is parked
  settle(seconds = 4) {
    const still: CarInput = { gas: 0, brake: 0, steer: 0, handbrake: true };
    for (let i = 0; i < seconds / STEP && this.car; i++) {
      if (this.update(STEP, still, []) === 'loading') return;
      const v = this.car.body.linvel();
      if (i > 10 && Math.hypot(v.x, v.y, v.z) < 0.3 && this.car.airTime === 0) break;
    }
    this.clock.acc = 0;
    this.prevP.copy(this.curP); this.prevQ.copy(this.curQ); this.prevRide = this.curRide;
    Object.assign(this.prevLean, this.curLean);
  }

  // the traffic cars knocked away and still moving, as drawn now
  wrecks(): Map<object, DrawnPose> {
    const out = new Map<object, DrawnPose>();
    for (const [key, w] of this.wrecked) {
      const t = w.body.translation(), r = w.body.rotation(), q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      const p = this.toWorld(t).add(new THREE.Vector3(0, -w.lift, 0).applyQuaternion(q));
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      out.set(key, { x: p.x, y: p.y, z: p.z, h: e.y, pitch: -e.x, roll: e.z });
    }
    return out;
  }

  // the car as drawn now (between its last two steps)
  drawn(): DrawnPose | null {
    if (!this.car) return null;
    const a = Math.min(1, this.clock.alpha);
    const p = this.prevP.clone().lerp(this.curP, a), q = this.prevQ.clone().slerp(this.curQ, a);
    // (the ground point: the ride height the wheels hold now under the body's origin, along the car's up)
    p.add(new THREE.Vector3(0, -(this.prevRide + (this.curRide - this.prevRide) * a), 0).applyQuaternion(q));
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    // (a bike: leaning into its turn about its wheels' line on the ground; its front up in a wheelie, about its rear
    // wheel's contact)
    const lean = this.prevLean.lean + (this.curLean.lean - this.prevLean.lean) * a;
    const wheelie = this.prevLean.wheelie + (this.curLean.wheelie - this.prevLean.wheelie) * a;
    if (wheelie) p.y += Math.sin(wheelie) * -this.car.build.wheels[2].z;
    return { x: p.x, y: p.y, z: p.z, h: e.y, pitch: -e.x + wheelie, roll: e.z + lean };
  }

  // is the car on its wheels, upright?
  get onWheels() {
    const c = this.car;
    if (!c || c.wheelsInContact() < 3) return false;
    const r = c.body.rotation();
    return 1 - 2 * (r.x * r.x + r.z * r.z) > 0.9;
  }

  // is the car more up than on its side?
  get upright() {
    const r = this.car?.body.rotation();
    return !r || 1 - 2 * (r.x * r.x + r.z * r.z) > 0.5;
  }

  get velocity() {
    const v = this.car?.body.linvel();
    return v ? new THREE.Vector3(v.x, v.y, v.z) : new THREE.Vector3();
  }

  toWorld(v: { x: number; y: number; z: number }, out = new THREE.Vector3()) { return out.set(v.x + this.origin.x, v.y, v.z + this.origin.z); }

  private place() {
    const { pose, speed, build } = this.pending!;
    this.pending = null;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pose.pitch, pose.h, pose.roll, 'YXZ'));
    // (the body's origin ride m over the ground point along the car's up; a little higher: it settles on its springs)
    const c = new THREE.Vector3(0, build.ride + 0.1, 0).applyQuaternion(q).add(new THREE.Vector3(pose.x - this.origin.x, pose.y, pose.z - this.origin.z));
    this.car = new RapierCar(RAPIER, this.world, c, { x: q.x, y: q.y, z: q.z, w: q.w }, this.terrain, undefined, build);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    this.car.body.setLinvel({ x: f.x * speed, y: 0, z: f.z * speed }, true);
    this.toWorld(this.car.body.translation(), this.curP);
    this.prevP.copy(this.curP);
    this.curQ.copy(q); this.prevQ.copy(q);
    this.curRide = this.prevRide = build.ride;
    Object.assign(this.curLean, { lean: 0, wheelie: 0 });
    Object.assign(this.prevLean, this.curLean);
    this.clock.acc = 0;
  }

  // the traffic near the car as kinematic boxes, moved over the frame's steps (`span` s) from where they were to where
  // they are (not the wrecks: they move by themselves)
  private obstacles(list: Obstacle[], at: THREE.Vector3, span: number) {
    for (const k of this.kin.values()) k.seen = false;
    for (const o of list) {
      if (Math.abs(o.x - at.x) > OBSTACLE_R || Math.abs(o.z - at.z) > OBSTACLE_R || this.wrecked.has(o.key)) continue;
      let k = this.kin.get(o.key);
      if (!k) {
        // (a type of the catalog other than the car: the box its model fills, a little shorter, clear of the ground)
        const t = o.vt && VEHICLES[o.vt], m = t && modelHalf(t);
        const half = o.bus ? { x: 1.25, y: 1.3, z: o.len / 2 } : m ? { x: m.x - 0.05, y: m.y - 0.08, z: m.z - 0.1 } : { x: 0.85, y: 0.65, z: o.len / 2 - 0.1 };
        const lift = half.y + 0.15, mass = o.bus ? 11000 : t ? t.build.mass : 1200;
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(o.x - this.origin.x, o.y + lift, o.z - this.origin.z)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), o.h)));
        const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(0.3).setCollisionGroups(WORLD_GROUPS), body);
        k = { body, collider, mass, from: new THREE.Vector3(o.x, o.y, o.z), fromH: o.h, to: new THREE.Vector3(), toH: o.h, seen: true, lift, v: new THREE.Vector3() };
        this.kin.set(o.key, k);
      }
      k.to.set(o.x, o.y, o.z);
      k.toH = o.h;
      k.v.copy(k.to).sub(k.from).divideScalar(Math.max(span, 1e-3));
      k.seen = true;
    }
    for (const [key, k] of this.kin) if (!k.seen) { this.world.removeRigidBody(k.body); this.kin.delete(key); }
  }

  // A traffic car the car touched this step, fast enough between them: a wreck (a dynamic box with its velocity); the
  // car given back its speed from before the step, so the two meet as bodies of their masses in the next one.
  private knocks(carV: THREE.Vector3, events: DriveEvent[]) {
    const car = this.car!;
    for (const [key, k] of this.kin) {
      let touching = false;
      this.world.contactPair(car.chassis, k.collider, (m) => { if (m.numContacts() > 0) touching = true; });
      if (!touching) continue;
      const rel = carV.clone().sub(k.v).length();
      if (rel < KNOCK) continue;
      if (this.wrecked.size >= MAX_WRECKS) this.restWreck([...this.wrecked.keys()][0]);
      const t = k.body.translation(), r = k.body.rotation(), half = (k.collider.shape as RAPIER.Cuboid).halfExtents;
      this.world.removeRigidBody(k.body);
      this.kin.delete(key);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(t.x, t.y, t.z).setRotation(r)
        .setLinvel(k.v.x, k.v.y, k.v.z).setCcdEnabled(true).setAngularDamping(0.3));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setMass(k.mass).setFriction(0.6)
        .setRestitution(0.1).setCollisionGroups(WORLD_GROUPS), body);
      // (drawn with its box on the ground: a kinematic one floats 0.15 m over it, clear of the voxels)
      this.wrecked.set(key, { body, lift: half.y, age: 0, still: 0 });
      car.body.setLinvel({ x: carV.x, y: carV.y, z: carV.z }, true);
      events.push({ kind: 'knock', key, speed: rel });
    }
  }

  // wrecks come to rest (or are too old, or left behind): then drawn where they lie, a kinematic box again
  private settleWrecks(dt: number) {
    const at = this.car!.body.translation();
    for (const [key, w] of this.wrecked) {
      w.age += dt;
      const v = w.body.linvel(), a = w.body.angvel(), t = w.body.translation();
      w.still = Math.hypot(v.x, v.y, v.z) < 0.25 && Math.hypot(a.x, a.y, a.z) < 0.25 ? w.still + dt : 0;
      if (w.still > WRECK_REST_S || w.age > WRECK_MAX_S || Math.hypot(t.x - at.x, t.z - at.z) > OBSTACLE_R) this.restWreck(key);
    }
  }

  // (the caller has drawn it from wrecks() up to now; its Car keeps that pose)
  private restWreck(key: object) {
    const w = this.wrecked.get(key);
    if (!w) return;
    this.world.removeRigidBody(w.body);
    this.wrecked.delete(key);
  }

  // People the car's box (grown by its travel over the frame) runs into at HIT_SPEED or more: 'person' events
  private walkers(list: Walker[], span: number, events: DriveEvent[]) {
    const car = this.car!, b = car.body, v = b.linvel(), speed = Math.hypot(v.x, v.y, v.z);
    if (speed < HIT_SPEED) return;
    const r = b.rotation(), inv = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert(), c = this.toWorld(b.translation());
    const half = car.build.half, reach = speed * span + 0.3, fwd = new THREE.Vector3(v.x, v.y, v.z).applyQuaternion(inv).z >= 0 ? 1 : -1;
    for (const w of list) {
      if (Math.abs(w.x - c.x) > 12 || Math.abs(w.z - c.z) > 12) continue;
      const l = new THREE.Vector3(w.x, w.y + 0.9, w.z).sub(c).applyQuaternion(inv);
      // (the chassis' box sits from -0.45 to 2 half.y - 0.45 over the body's origin: car.ts)
      const zlo = fwd > 0 ? -half.z - 0.3 : -half.z - reach, zhi = fwd > 0 ? half.z + reach : half.z + 0.3;
      if (Math.abs(l.x) > half.x + 0.35 || l.z < zlo || l.z > zhi || l.y < -1.6 || l.y > 2 * half.y + 0.5) continue;
      // (the car loses a little: a person's ~70 kg against its mass)
      b.setLinvel({ x: v.x * 0.95, y: v.y, z: v.z * 0.95 }, true);
      events.push({ kind: 'person', key: w.key, speed, vx: v.x, vz: v.z });
    }
  }
}
