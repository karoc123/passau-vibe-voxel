// The player's car on Rapier (car.ts) in the drive mode (nav/drive.prototype.ts): one world for the page, its voxel
// colliders built near the car (terrain.ts), the traffic near it as kinematic bodies the car runs into. Loaded in the
// background once the city is shown (loadRapierDrive: Rapier's wasm, its first step and the collision decoding's
// first tile taken then, not on the first drive).
//
// The drive mode keeps its car (a traffic Car of sim/life.ts, drawn by the street life) and moves it from here: the
// body's pose is put on the Car (its ground point rp, heading rh, pitch and roll; any orientation: a car on its roof is
// drawn on its roof and stays there).
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Meta } from '../../types';
import { bus, CAR, RapierCar, type CarBuild, type CarEvent, type CarInput } from './car';
import { CHUNK, RapierTerrain, WORLD_GROUPS, chunkShapes } from './terrain';

export const STEP = 1 / 60;
const MAX_STEPS = 4;
const OBSTACLE_R = 40; // m: traffic within this of the car is in the world

// something on the road the car meets (a traffic car or bus): its ground point and heading, length, kind
export interface Obstacle { key: object; x: number; y: number; z: number; h: number; len: number; bus: boolean }
interface Kin { body: RAPIER.RigidBody; from: THREE.Vector3; fromH: number; to: THREE.Vector3; toH: number; seen: boolean; lift: number }

// The drawn pose: the ground point under the body's origin (as a traffic car's rp), heading, pitch (nose up), roll
export interface DrawnPose { x: number; y: number; z: number; h: number; pitch: number; roll: number }

// what is driven, for a traffic car or bus of `len` m
export const buildFor = (isBus: boolean, len: number): CarBuild => (isBus ? bus(len) : CAR);

let loading: Promise<RapierDrive> | null = null;

// Rapier, warmed up, and the drive's world (once per page; `focus`: where to decode a first tile)
export function loadRapierDrive(meta: Meta, focus: { x: number; z: number }) {
  return loading ??= (async () => {
    const t0 = performance.now();
    await RAPIER.init();
    const t1 = performance.now();
    warmUp();
    const t2 = performance.now();
    const d = new RapierDrive(meta, focus);
    await d.warmTerrain(focus);
    const t3 = performance.now();
    // (how long each part took: Rapier's init (the wasm compiled), its first step, the first tile fetched and decoded)
    (window as unknown as { __rapierLoad: object }).__rapierLoad = { initMs: t1 - t0, warmMs: t2 - t1, tileMs: t3 - t2, decodeMs: d.terrain.stats.decodeMsMax };
    return d;
  })();
}

// The first step of a world with voxels in it costs ~100 ms (and more in a busy page) once, whatever is in it: taken
// here, in a throwaway world, with the load, instead of as a hitch on the first frame the car drives.
export function warmUp() {
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const vox: number[] = [];
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) vox.push(x, 0, z, x, x === 7 ? 1 : 0, z);
  w.createCollider(RAPIER.ColliderDesc.voxels(new Int32Array(vox), { x: 1, y: 1, z: 1 }));
  w.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array([0, 1, 0, 8, 1, 0, 8, 1, 8]), new Uint32Array([0, 2, 1])));
  const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(3, 1.5, 3));
  const col = w.createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.45, 2), b);
  const k = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(6, 1.5, 6));
  w.createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.7, 2), k);
  const c = w.createVehicleController(b);
  c.addWheel({ x: 0, y: -0.2, z: 0 }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, 0.35, 0.36);
  for (let i = 0; i < 3; i++) {
    c.updateVehicle(1 / 60);
    w.castShape(b.translation(), b.rotation(), { x: 1, y: 0, z: 0 }, col.shape, 0.02, 2, false, undefined, undefined, col);
    k.setNextKinematicTranslation({ x: 6, y: 1.5, z: 6 + i * 0.1 });
    w.step();
  }
  w.free();
}

export class RapierDrive {
  readonly world: RAPIER.World;
  readonly terrain: RapierTerrain;
  readonly origin: { x: number; z: number };
  car: RapierCar | null = null;
  private pending: { pose: DrawnPose; speed: number; build: CarBuild } | null = null;
  private acc = 0;
  private readonly prevP = new THREE.Vector3();
  private readonly curP = new THREE.Vector3();
  private readonly prevQ = new THREE.Quaternion();
  private readonly curQ = new THREE.Quaternion();
  private readonly kin = new Map<object, Kin>();
  readonly stats = { stepMs: 0, stepMsMax: 0, frameMs: 0, frameMsMax: 0 };

  constructor(private readonly meta: Meta, focus: { x: number; z: number }) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.origin = { x: Math.floor(focus.x / CHUNK) * CHUNK, z: Math.floor(focus.z / CHUNK) * CHUNK };
    this.terrain = new RapierTerrain(RAPIER, this.world, meta, this.origin);
    (window as unknown as { __rapierDrive: RapierDrive }).__rapierDrive = this;
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
  }

  get waiting() { return !!this.pending; }

  // One frame: the colliders near the car, the traffic near it, the fixed steps. Returns what happened in them, or
  // 'loading' (the car's ground not built yet: held still).
  update(dt: number, input: CarInput, obstacles: Obstacle[]): CarEvent[] | 'loading' {
    const f0 = performance.now();
    const at = this.car ? this.toWorld(this.car.body.translation()) : this.pending ? new THREE.Vector3(this.pending.pose.x, 0, this.pending.pose.z) : null;
    if (!at) return [];
    const v = this.car?.body.linvel();
    const [ready] = this.terrain.update([{ x: at.x, z: at.z, vx: v?.x, vz: v?.z }]);
    if (!ready) { this.acc = 0; return 'loading'; }
    if (this.pending) this.place();
    const car = this.car!;
    this.obstacles(obstacles, at);
    const events: CarEvent[] = [];
    this.acc += Math.min(dt, 0.25);
    const n = Math.min(MAX_STEPS, Math.floor(this.acc / STEP));
    this.acc = n === MAX_STEPS ? 0 : this.acc - n * STEP;
    for (let i = 0; i < n; i++) {
      this.prevP.copy(this.curP); this.prevQ.copy(this.curQ);
      for (const k of this.kin.values()) {
        const t = (i + 1) / n, p = k.from.clone().lerp(k.to, t);
        let dh = k.toH - k.fromH;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        k.body.setNextKinematicTranslation({ x: p.x - this.origin.x, y: p.y + k.lift, z: p.z - this.origin.z });
        k.body.setNextKinematicRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), k.fromH + dh * t));
      }
      const s0 = performance.now();
      car.step(input, STEP);
      this.world.step();
      const ev = car.afterStep(STEP);
      if (ev) events.push(ev);
      const ms = performance.now() - s0;
      this.stats.stepMs = ms;
      this.stats.stepMsMax = Math.max(this.stats.stepMsMax, ms);
      this.toWorld(car.body.translation(), this.curP);
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
    this.acc = 0;
    this.prevP.copy(this.curP); this.prevQ.copy(this.curQ);
  }

  // the car as drawn now (between its last two steps)
  drawn(): DrawnPose | null {
    if (!this.car) return null;
    const a = Math.min(1, this.acc / STEP);
    const p = this.prevP.clone().lerp(this.curP, a), q = this.prevQ.clone().slerp(this.curQ, a);
    p.add(new THREE.Vector3(0, -this.car.build.ride, 0).applyQuaternion(q));
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    return { x: p.x, y: p.y, z: p.z, h: e.y, pitch: -e.x, roll: e.z };
  }

  // is the car on its wheels, upright?
  get onWheels() {
    const c = this.car;
    if (!c || c.wheelsInContact() < 3) return false;
    const r = c.body.rotation();
    return 1 - 2 * (r.x * r.x + r.z * r.z) > 0.9;
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
    this.acc = 0;
  }

  // the traffic near the car as kinematic boxes, moved over the frame's steps from where they were to where they are
  private obstacles(list: Obstacle[], at: THREE.Vector3) {
    for (const k of this.kin.values()) k.seen = false;
    for (const o of list) {
      if (Math.abs(o.x - at.x) > OBSTACLE_R || Math.abs(o.z - at.z) > OBSTACLE_R) continue;
      let k = this.kin.get(o.key);
      if (!k) {
        const half = o.bus ? { x: 1.25, y: 1.3, z: o.len / 2 } : { x: 0.85, y: 0.65, z: o.len / 2 - 0.1 };
        const lift = half.y + 0.15;
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(o.x - this.origin.x, o.y + lift, o.z - this.origin.z)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), o.h)));
        this.world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(0.3).setCollisionGroups(WORLD_GROUPS), body);
        k = { body, from: new THREE.Vector3(o.x, o.y, o.z), fromH: o.h, to: new THREE.Vector3(), toH: o.h, seen: true, lift };
        this.kin.set(o.key, k);
      }
      k.to.set(o.x, o.y, o.z);
      k.toH = o.h;
      k.seen = true;
    }
    for (const [key, k] of this.kin) if (!k.seen) { this.world.removeRigidBody(k.body); this.kin.delete(key); }
  }
}
