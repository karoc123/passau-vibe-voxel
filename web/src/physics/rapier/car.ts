// Rapier car: a drivable car on Rapier's DynamicRayCastVehicleController (raycast wheels on a chassis), with what the
// voxel city needs on top of it (each switchable in CarTuning, for the scenarios in scenarios.ts):
// - steps: a riser of up to STEP_MAX (a 1 m terrace or kerb) ahead of the moving car gets a short invisible wedge in
//   front of it (a convex prism only the car collides with and its wheels ride on), so it drives up as on a steep
//   ramp instead of hitting the riser; higher is a wall.
// - walls: the chassis has no friction or bounce against the world, so it glances along a wall instead of sticking to
//   it; touching a wall turns the car towards the wall's direction (the way it slides).
// - air: no wheel touching, the roll and pitch are damped and gently righted (the heading left alone).
// - water: the chassis' centre down at the water's top at its column ends the drive (status 'water').
// - landing: touching down from the air faster than CRASH_SPEED into the ground (a fall of ~8 m) is a crash (an event:
//   the driver is shaken, as variant A's).
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { RapierTerrain } from './terrain';

export interface CarInput { gas: number; brake: number; steer: number; handbrake: boolean }
export type CarStatus = 'ok' | 'water';
// what happened in a step: a wall hit (speed lost), a landing (speed into the ground; crash: a hard one), a step's
// wedge laid (its rise)
export interface CarEvent { kind: 'impact' | 'landing' | 'step'; speed: number; crash?: boolean }

export interface CarTuning {
  steps: boolean;
  walls: boolean;
  air: boolean;
}
export const TUNED: CarTuning = { steps: true, walls: true, air: true };
export const SPIKE: CarTuning = { steps: false, walls: false, air: false };

const HALF = { x: 0.9, y: 0.45, z: 2.1 };
const MASS = 1200;
const WHEEL_R = 0.36;
const REST = 0.35;
const WHEELS = [
  { x: 0.82, z: 1.35, front: true }, { x: -0.82, z: 1.35, front: true },
  { x: 0.82, z: -1.3, front: false }, { x: -0.82, z: -1.3, front: false },
];
const ENGINE = 2600; // N per driven wheel (rear)
const BRAKE = 45;
const MAX_STEER = 0.55;
const TOP_SPEED = 22; // m/s (~80 km/h)
export const CRASH_SPEED = Math.sqrt(2 * 9.81 * 8); // m/s into the ground: a fall of ~8 m
const STEP_MIN = 0.25, STEP_MAX = 1.15; // m: risers the wedge helps up
const WEDGE_LEN = 2.8; // m: the wedge's run (a 1 m riser: ~20°)
const WEDGE_W = 3.2; // m: its width along the riser
// interaction groups (membership << 16 | filter): the car's chassis is in G_CAR, the wedges in G_WEDGE and meet only
// G_CAR; other bodies (and queries that should not see the wedges) use WORLD_GROUPS, in neither
const G_CAR = 1 << 0, G_WEDGE = 1 << 1;
const CAR_GROUPS = (G_CAR << 16) | 0xffff;
const WEDGE_GROUPS = (G_WEDGE << 16) | G_CAR;
export const WORLD_GROUPS = ((0xffff & ~(G_CAR | G_WEDGE)) << 16) | 0xffff;

interface Wedge { collider: RAPIER.Collider; x: number; z: number; key: string; bornAt: number }

export class RapierCar {
  readonly body: RAPIER.RigidBody;
  readonly chassis: RAPIER.Collider;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly mesh = new THREE.Group();
  readonly wheels: THREE.Mesh[] = [];
  status: CarStatus = 'ok';
  airTime = 0;
  private steer = 0;
  private readonly wedges: Wedge[] = [];
  private readonly shape: RAPIER.Shape;
  private prevV = { x: 0, y: 0, z: 0 };
  private time = 0;
  private event: CarEvent | null = null;

  constructor(private readonly R: typeof RAPIER, private readonly world: RAPIER.World, at: { x: number; y: number; z: number }, heading: number,
    private readonly terrain: RapierTerrain | null = null, readonly tuning: CarTuning = TUNED) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(q)
      .setCanSleep(false).setCcdEnabled(true).setAngularDamping(0.4));
    const inertia = { x: MASS * (HALF.y ** 2 + HALF.z ** 2) / 3, y: MASS * (HALF.x ** 2 + HALF.z ** 2) / 3, z: MASS * (HALF.x ** 2 + HALF.y ** 2) / 3 };
    const walls = tuning.walls;
    // (a plain box: a rounded one (roundCuboid) glances no better and costs 3x the contact time against voxels)
    const desc = R.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z);
    // (the centre of mass low, under the floor: it rolls less)
    desc.setMassProperties(MASS, { x: 0, y: -0.45, z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS).setCollisionGroups(CAR_GROUPS);
    if (walls) desc.setFriction(0).setFrictionCombineRule(R.CoefficientCombineRule.Min).setRestitution(0).setRestitutionCombineRule(R.CoefficientCombineRule.Min);
    else desc.setFriction(0.3);
    this.chassis = world.createCollider(desc, this.body);
    this.shape = this.chassis.shape;
    const c = world.createVehicleController(this.body);
    c.indexUpAxis = 1;
    c.setIndexForwardAxis = 2;
    for (const w of WHEELS) {
      c.addWheel({ x: w.x, y: -0.2, z: w.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, REST, WHEEL_R);
      const i = c.numWheels() - 1;
      c.setWheelSuspensionStiffness(i, 28);
      c.setWheelSuspensionCompression(i, 2.6);
      c.setWheelSuspensionRelaxation(i, 3.2);
      c.setWheelMaxSuspensionTravel(i, 0.35);
      c.setWheelMaxSuspensionForce(i, 60000);
      c.setWheelFrictionSlip(i, w.front ? 1.6 : 1.5);
      c.setWheelSideFrictionStiffness(i, 1.0);
    }
    this.controller = c;

    const paint = new THREE.MeshStandardMaterial({ color: 0xc8302a, roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.2 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(HALF.x * 2, HALF.y * 2, HALF.z * 2), paint);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(HALF.x * 1.7, 0.55, HALF.z * 1.0), glass);
    cabin.position.set(0, HALF.y + 0.27, -0.2);
    this.mesh.add(box, cabin);
    for (const m of [box, cabin]) { m.castShadow = true; m.receiveShadow = true; }
    const wg = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.28, 16).rotateZ(Math.PI / 2);
    for (let i = 0; i < WHEELS.length; i++) {
      const wm = new THREE.Mesh(wg, tyre);
      wm.castShadow = true;
      this.wheels.push(wm);
      this.mesh.add(wm);
    }
  }

  // km/h along the chassis' forward axis
  get kmh() { return this.controller.currentVehicleSpeed() * 3.6; }

  // Before the world's step: the wheels' forces, the assists.
  step(input: CarInput, dt: number) {
    this.event = null;
    const c = this.controller, v = c.currentVehicleSpeed();
    // steering eased, less of it at speed
    const target = -input.steer * MAX_STEER / (1 + Math.abs(v) / 14);
    this.steer += (target - this.steer) * Math.min(1, dt * 8);
    let engine = 0, brake = 0;
    if (input.gas > 0) engine = v > -0.5 ? input.gas * ENGINE * (v < TOP_SPEED ? 1 : 0) : 0;
    if (input.brake > 0) {
      if (v > 0.8) brake = input.brake * BRAKE;
      else engine = -input.brake * ENGINE * 0.6 * (v > -8 ? 1 : 0); // reverse
    }
    if (input.gas > 0 && v < -0.5) brake = input.gas * BRAKE;
    if (!input.gas && !input.brake) brake = 1.2; // rolling resistance
    for (let i = 0; i < 4; i++) {
      const front = WHEELS[i].front;
      c.setWheelSteering(i, front ? this.steer : 0);
      c.setWheelEngineForce(i, front ? 0 : engine);
      c.setWheelBrake(i, input.handbrake && !front ? BRAKE * 2 : brake);
    }
    // (the velocity before the springs' impulses: a landing's speed into the ground)
    const lv = this.body.linvel();
    this.prevV = { x: lv.x, y: lv.y, z: lv.z };
    c.updateVehicle(dt);
    if (this.tuning.steps) this.stepAssist(input, dt);
    if (this.tuning.air && this.wheelsInContact() === 0) this.airAssist(dt);
  }

  // After the world's step: landings, wall hits, water. Returns what happened in this step.
  afterStep(dt: number): CarEvent | null {
    this.time += dt;
    const b = this.body, v = b.linvel(), pv = this.prevV;
    const wheels = this.wheelsInContact();
    const touching = wheels > 0 || this.touchingWorld();
    if (!touching) this.airTime += dt;
    else {
      // (the speed just before the first touch: the springs take the rest over a few steps)
      if (this.airTime > 0.25 && pv.y < -2) this.event = { kind: 'landing', speed: -pv.y, crash: -pv.y >= CRASH_SPEED };
      this.airTime = 0;
    }
    // a wall: horizontal speed lost in one step (more than the brakes could)
    const lost = Math.hypot(pv.x, pv.z) - Math.hypot(v.x, v.z);
    if (lost > 1.5 && this.event?.kind !== 'landing') this.event = { kind: 'impact', speed: lost / 1 };
    if (this.tuning.walls) this.wallTurn(dt);
    if (this.terrain) {
      const p = b.translation(), o = this.terrain.origin;
      const w = this.terrain.waterAt(p.x + o.x, p.z + o.z);
      // (sitting on the water's top its centre is ~0.9 m over it)
      if (w >= 0 && p.y < w + 1.2) this.status = 'water';
      // pushed into the ground (the colliders are a shell of voxels: a hard push can go through it): back on top
      const top = this.terrain.solidTop(p.x + o.x, p.y, p.z + o.z);
      if (top >= 0) {
        b.setTranslation({ x: p.x, y: top + 1, z: p.z }, true);
        b.setLinvel({ x: v.x, y: Math.max(0, v.y), z: v.z }, true);
      }
    }
    // wedges the car has left
    for (let i = this.wedges.length - 1; i >= 0; i--) {
      const w = this.wedges[i], p = b.translation();
      if (Math.hypot(p.x - w.x, p.z - w.z) > 7 || this.time - w.bornAt > 4) {
        this.world.removeCollider(w.collider, false);
        this.wedges.splice(i, 1);
      }
    }
    return this.event;
  }

  // is the chassis touching anything (the world or the wedges)?
  private touchingWorld() {
    let any = false;
    this.world.contactPairsWith(this.chassis, (other) => {
      if (any) return;
      this.world.contactPair(this.chassis, other, (m) => { if (m.numContacts() > 0) any = true; });
    });
    return any;
  }

  // A riser ahead (from the chassis' cast along its horizontal velocity): a wedge in front of it if it is a step.
  private stepAssist(input: CarInput, dt: number) {
    // (on its wheels, or hung on an edge by its belly: a staircase of terraces narrower than the wheelbase)
    if (!this.terrain || (this.wheelsInContact() < 2 && !this.touchingWorld())) return;
    const b = this.body, v = b.linvel(), p = b.translation(), r = b.rotation();
    let dx = v.x, dz = v.z, hs = Math.hypot(dx, dz);
    if (hs < 0.5) {
      // from rest, against the riser: the way the input pushes
      const dir = input.gas > 0 ? 1 : input.brake > 0 ? -1 : 0;
      if (!dir) return;
      const f = new THREE.Vector3(0, 0, dir).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
      dx = f.x; dz = f.z; hs = 1;
    }
    dx /= hs; dz /= hs;
    const reach = (hs === 1 ? 1 : 0.4) + Math.min(hs, 25) * dt * 6;
    // (from a little higher: not the ground the belly may rest on, only what stands in the way)
    const hit = this.world.castShape({ x: p.x, y: p.y + 0.1, z: p.z }, r, { x: dx, y: 0, z: dz }, this.shape, 0.02, reach, false,
      undefined, undefined, this.chassis, b, (col) => !this.wedges.some((w) => w.collider === col));
    if (!hit) return;
    // the riser's face: axis-aligned (voxels); its column and the one in front of it. A face hit square on gives it;
    // an edge (the riser's top edge against the chassis' bottom: the normal mostly up) the way the car goes
    const n = hit.normal1, face = Math.abs(n.y) < 0.5;
    const ax = face ? Math.abs(n.x) > Math.abs(n.z) : Math.abs(dx) > Math.abs(dz);
    const nx = ax ? (face ? Math.sign(n.x) : -Math.sign(dx)) : 0, nz = ax ? 0 : (face ? Math.sign(n.z) : -Math.sign(dz));
    if (nx * dx + nz * dz > -0.2) return; // grazing it, not into it
    const o = this.terrain.origin, w = hit.witness1;
    const wx = w.x + o.x, wz = w.z + o.z;
    // the ground under the car: its lowest wheel contact
    let low = p.y - 1.3; // (no wheel down: the chassis' belly is on something about here)
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) low = Math.min(low, this.controller.wheelContactPoint(i)!.y);
    const below = this.terrain.groundAt(wx + nx * 0.5, wz + nz * 0.5, low + STEP_MAX + 0.05);
    const top = below === null ? null : this.terrain.groundAt(wx - nx * 0.5, wz - nz * 0.5, below + STEP_MAX + 0.05);
    if (below === null || top === null) return;
    const rise = top - below;
    // (the riser's foot: the ground the lowest wheel is on, or a step above it under the belly)
    if (rise < STEP_MIN || rise > STEP_MAX || below < low - 0.35 || below > low + STEP_MAX) return;
    // room on top: nothing solid over the step for the car's height
    if (!this.terrain.clear(wx - nx * 0.5, wz - nz * 0.5, top, 2)) return;
    // the riser's plane (on the voxel grid) and a key for it (one wedge per riser cell and direction)
    const fx = ax ? Math.round(wx) : wx, fz = ax ? wz : Math.round(wz);
    const along = ax ? Math.round(wz) : Math.round(wx);
    const key = `${ax ? 'x' : 'z'}${ax ? fx : fz}:${along}:${nx || nz}`;
    if (this.wedges.some((q) => q.key === key)) return;
    // the prism: the riser's foot (fx, fz) at `below`, its top edge at `top`, the slope running out WEDGE_LEN along n
    const tx = -nz, tz = nx; // along the riser
    const pts: number[] = [];
    for (const s of [-WEDGE_W / 2, WEDGE_W / 2]) {
      const ex = fx + tx * s, ez = fz + tz * s;
      pts.push(ex, top, ez, ex, below - 0.02, ez, ex + nx * WEDGE_LEN, below - 0.02, ez + nz * WEDGE_LEN);
    }
    for (let i = 0; i < pts.length; i += 3) { pts[i] -= o.x; pts[i + 2] -= o.z; }
    const desc = this.R.ColliderDesc.convexHull(new Float32Array(pts));
    if (!desc) return;
    const collider = this.world.createCollider(desc.setCollisionGroups(WEDGE_GROUPS).setFriction(0.9));
    const cx = fx + nx * WEDGE_LEN / 2 - o.x, cz = fz + nz * WEDGE_LEN / 2 - o.z;
    this.wedges.push({ collider, x: cx, z: cz, key, bornAt: this.time });
    this.event = { kind: 'step', speed: rise };
  }

  // In the air: roll and pitch damped and gently righted (a car that flips on landing ends no drive, but it shouldn't
  // somersault off every ledge)
  private airAssist(dt: number) {
    const b = this.body, r = b.rotation(), w = b.angvel();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w), up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    // the axis that would right it, scaled by how far off it is
    const axis = up.clone().cross(new THREE.Vector3(0, 1, 0));
    const k = 1 - Math.exp(-2.5 * dt), right = 3;
    b.setAngvel({ x: w.x + (axis.x * right - w.x) * k, y: w.y, z: w.z + (axis.z * right - w.z) * k }, true);
  }

  // Against a wall the car's heading follows the wall a little (the way it slides along it), as a driver would steer.
  private wallTurn(dt: number) {
    const b = this.body;
    let nx = 0, nz = 0;
    this.world.contactPairsWith(this.chassis, (other) => {
      if (this.wedges.some((w) => w.collider === other)) return;
      this.world.contactPair(this.chassis, other, (m, flipped) => {
        if (m.numContacts() === 0) return;
        const n = m.normal();
        if (Math.abs(n.y) > 0.5) return;
        const s = flipped ? -1 : 1; // (the normal from the chassis outwards)
        nx += n.x * s; nz += n.z * s;
      });
    });
    const len = Math.hypot(nx, nz);
    if (len < 1e-3) return;
    nx /= len; nz /= len;
    const v = b.linvel(), hs = Math.hypot(v.x, v.z);
    if (hs < 2) return;
    // the heading wanted: the velocity with its part into the wall taken out
    const into = v.x * nx + v.z * nz;
    const tx = v.x - nx * Math.max(0, into), tz = v.z - nz * Math.max(0, into);
    const r = b.rotation(), q = new THREE.Quaternion(r.x, r.y, r.z, r.w), f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const sign = f.x * tx + f.z * tz >= 0 ? 1 : -1;
    const want = Math.atan2(tx * sign, tz * sign), have = Math.atan2(f.x, f.z);
    let d = want - have;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const w = b.angvel();
    b.setAngvel({ x: w.x, y: w.y + (d * 6 - w.y) * Math.min(1, dt * 10), z: w.z }, true);
  }

  // wheel meshes in chassis space, from the controller's state (render after the body's pose is set)
  syncWheels() {
    const c = this.controller;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], len = c.wheelSuspensionLength(i) ?? REST;
      const p = WHEELS[i];
      w.position.set(p.x, -0.2 - len, p.z);
      w.rotation.set(c.wheelRotation(i) ?? 0, c.wheelSteering(i) ?? 0, 0, 'YXZ');
    }
  }

  wheelsInContact() {
    let n = 0;
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) n++;
    return n;
  }

  dispose(world: RAPIER.World) {
    for (const w of this.wedges) world.removeCollider(w.collider, false);
    this.wedges.length = 0;
    world.removeVehicleController(this.controller);
    world.removeRigidBody(this.body);
    this.mesh.removeFromParent();
  }
}
