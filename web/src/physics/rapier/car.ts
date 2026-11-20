// Rapier car: a drivable car on Rapier's DynamicRayCastVehicleController (raycast wheels on a chassis), with what the
// voxel city needs on top of it (each switchable in CarTuning, for the scenarios in scenarios.ts):
// - ground: the car drives on its own surface where the ground goes up or down in steps of a metre (terrain.ts
//   DRIVE: the ground's 1 m terraces as ramps, paved or not, and smoother than the ramps as drawn); its wheels'
//   rays see that, not the voxels' tops there.
// - steps: a riser of up to STEP_MAX that is not the ground's (a platform, a low wall) ahead of the moving car, up or
//   down, gets an invisible wedge on its low side, laid before the front wheels reach its foot (prisms on a smoothstep
//   profile, as wide as the car's crossing needs, that only the car collides with and its wheels ride on), so it
//   drives up or down as on a ramp instead of hitting the riser or dropping off it; higher is a wall (or a drop).
// - walls: the chassis has no friction or bounce against the world, so it glances along a wall instead of sticking to
//   it; touching a wall turns the car towards the wall's direction (the way it slides).
// - air: no wheel touching, the roll and pitch are damped and gently righted (the heading left alone).
// - water: the chassis' centre down at the water's top at its column ends the drive (status 'water').
// - landing: touching down from the air faster than crashSpeed() into the ground (a fall of ~8 m) is a crash (an event:
//   the driver is shaken, as variant A's).
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CAR_GROUPS, CAR_ONLY_GROUPS, WHEEL_GROUPS, type RapierTerrain } from './terrain';

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

// what is driven: the chassis' half extents (m), its mass (kg), the wheels (chassis space), the engine's force per
// driven (rear) wheel (N), the brakes, the top speed (m/s); ride: the ground's height under the body's origin at rest
export interface CarBuild {
  half: { x: number; y: number; z: number }; mass: number; wheels: { x: number; z: number; front: boolean }[];
  engine: number; brake: number; top: number; ride: number;
}
const wheels4 = (x: number, zf: number, zr: number) => [
  { x, z: zf, front: true }, { x: -x, z: zf, front: true }, { x, z: zr, front: false }, { x: -x, z: zr, front: false },
];
export const CAR: CarBuild = { half: { x: 0.9, y: 0.45, z: 2.1 }, mass: 1200, wheels: wheels4(0.82, 1.35, -1.3), engine: 2600, brake: 45, top: 22, ride: 0.84 };
// a bus of `len` m (the traffic's: 12): its chassis as high as its body (the traffic's 2.55 m less the wheels)
export const bus = (len: number): CarBuild => ({
  half: { x: 1.25, y: 0.95, z: len / 2 - 0.1 }, mass: 11000, wheels: wheels4(1.1, len / 2 - 2.4, -(len / 2 - 3)),
  engine: 14000, brake: 400, top: 17, ride: 0.84,
});
const WHEEL_R = 0.36;
const REST = 0.35;
// The ride. Rapier's raycast wheels have no mass of their own: each pushes the chassis with
// mass * (stiffness * compression - damping * its speed) (damping: `compression` while it is pushed in, `relaxation`
// while it extends), never pulls, and leaves the ground once its spring is back at its rest length, so it hangs only
// as far as the car sags on it (g * gravity / (4 stiffness): a stiffer spring loses the ground sooner over a crest).
// - stiffness, compression, relaxation: per wheel (heave ~sqrt(stiffness) / pi Hz, damping ratio ~damping /
//   sqrt(stiffness))
// - gravity: the car's own gravity (a multiple of g: variant A has 12 m/s^2): how fast it comes back down over a crest
// - downforce: pressed onto its wheels' ground (along its own down) by this many g at 50 km/h, with the speed squared
//   (at most twice that), while a wheel touches: more grip and a body that stays on the road over crests at speed
// - gripFront, gripRear: the tyres' frictionSlip (the most force per load); side: their lateral stiffness
// - com: the centre of mass' drop under the body's origin (m)
// tools/rapier-car.mjs --set key=value,... runs the scenarios with others.
export const RIDE = {
  stiffness: 28, compression: 3.5, relaxation: 4.5, gravity: 1, downforce: 0, gripFront: 1.6, gripRear: 1.5, side: 1, com: 0.45,
};
// m/s into the ground: a fall of ~8 m (under the car's gravity)
export const crashSpeed = () => Math.sqrt(2 * 9.81 * RIDE.gravity * 8);
const MAX_STEER = 0.55;
const STEP_MIN = 0.25, STEP_MAX = 1.15; // m: risers the wedge helps up
// m: the wedge's run, its profile in this many planes along a smoothstep (a 1 m step: ~17° at its steepest; shorter
// ones launch the car off their top and drop its front at their foot: tools/rapier-car.mjs terrace_*)
const WEDGE_LEN = 5, WEDGE_SEG = 3;
const WEDGE_W_MAX = 6; // m: at most this far either side of the car's crossing along the riser
// (the wedges are CAR_ONLY_GROUPS: only the car meets them; other bodies and queries use WORLD_GROUPS: terrain.ts)

// a wedge: its collider, its centre (physics coordinates), the riser it is on (grid plane, axis, low side, cells lo..hi
// along it) and its half diagonal
interface Wedge { colliders: RAPIER.Collider[]; x: number; z: number; ax: boolean; plane: number; sgn: number; lo: number; hi: number; reach: number; bornAt: number }

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
  private readonly half: CarBuild['half'];

  // heading: radians about y (0: +z), or a whole rotation
  constructor(private readonly R: typeof RAPIER, private readonly world: RAPIER.World, at: { x: number; y: number; z: number }, heading: number | RAPIER.Rotation,
    private readonly terrain: RapierTerrain | null = null, readonly tuning: CarTuning = TUNED, readonly build: CarBuild = CAR) {
    const q = typeof heading === 'number' ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading) : heading;
    this.body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(q)
      .setCanSleep(false).setCcdEnabled(true).setAngularDamping(0.4).setGravityScale(RIDE.gravity));
    const HALF = this.half = build.half, MASS = build.mass;
    const inertia = { x: MASS * (HALF.y ** 2 + HALF.z ** 2) / 3, y: MASS * (HALF.x ** 2 + HALF.z ** 2) / 3, z: MASS * (HALF.x ** 2 + HALF.y ** 2) / 3 };
    const walls = tuning.walls;
    // (a plain box: a rounded one (roundCuboid) glances no better and costs 3x the contact time against voxels; its
    // bottom 0.25 m over the wheels' axles)
    const desc = R.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z).setTranslation(0, HALF.y - 0.45, 0);
    // (the centre of mass low, under the floor: it rolls less)
    desc.setMassProperties(MASS, { x: 0, y: -RIDE.com - (HALF.y - 0.45), z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS).setCollisionGroups(CAR_GROUPS);
    if (walls) desc.setFriction(0).setFrictionCombineRule(R.CoefficientCombineRule.Min).setRestitution(0).setRestitutionCombineRule(R.CoefficientCombineRule.Min);
    else desc.setFriction(0.3);
    this.chassis = world.createCollider(desc, this.body);
    this.shape = this.chassis.shape;
    const c = world.createVehicleController(this.body);
    c.indexUpAxis = 1;
    c.setIndexForwardAxis = 2;
    for (const w of build.wheels) {
      c.addWheel({ x: w.x, y: -0.2, z: w.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, REST, WHEEL_R);
      const i = c.numWheels() - 1;
      c.setWheelSuspensionStiffness(i, RIDE.stiffness);
      c.setWheelSuspensionCompression(i, RIDE.compression);
      c.setWheelSuspensionRelaxation(i, RIDE.relaxation);
      c.setWheelMaxSuspensionTravel(i, 0.35);
      c.setWheelMaxSuspensionForce(i, 60000);
      c.setWheelFrictionSlip(i, w.front ? RIDE.gripFront : RIDE.gripRear);
      c.setWheelSideFrictionStiffness(i, RIDE.side);
    }
    this.controller = c;

    const paint = new THREE.MeshStandardMaterial({ color: 0xc8302a, roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.2 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(HALF.x * 2, HALF.y * 2, HALF.z * 2), paint);
    box.position.y = HALF.y - 0.45;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(HALF.x * 1.7, 0.55, HALF.z * 1.0), glass);
    cabin.position.set(0, HALF.y + 0.27, -0.2);
    this.mesh.add(box, cabin);
    for (const m of [box, cabin]) { m.castShadow = true; m.receiveShadow = true; }
    const wg = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.28, 16).rotateZ(Math.PI / 2);
    for (let i = 0; i < build.wheels.length; i++) {
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
    const B = this.build, BRAKE = B.brake;
    if (input.gas > 0) engine = v > -0.5 ? input.gas * B.engine * (v < B.top ? 1 : 0) : 0;
    if (input.brake > 0) {
      if (v > 0.8) brake = input.brake * BRAKE;
      else engine = -input.brake * B.engine * 0.6 * (v > -8 ? 1 : 0); // reverse
    }
    if (input.gas > 0 && v < -0.5) brake = input.gas * BRAKE;
    if (!input.gas && !input.brake) brake = BRAKE * 0.027; // rolling resistance
    for (let i = 0; i < 4; i++) {
      const front = B.wheels[i].front;
      c.setWheelSteering(i, front ? this.steer : 0);
      c.setWheelEngineForce(i, front ? 0 : engine);
      c.setWheelBrake(i, input.handbrake && !front ? BRAKE * 2 : brake);
    }
    // (the velocity before the springs' impulses: a landing's speed into the ground)
    const lv = this.body.linvel();
    this.prevV = { x: lv.x, y: lv.y, z: lv.z };
    c.updateVehicle(dt, undefined, WHEEL_GROUPS);
    if (RIDE.downforce && this.wheelsInContact()) {
      const r = this.body.rotation(), up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
      const f = -RIDE.downforce * this.body.mass() * 9.81 * Math.min(2, (v / 13.9) ** 2) * dt;
      this.body.applyImpulse({ x: up.x * f, y: up.y * f, z: up.z * f }, true);
    }
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
      if (this.airTime > 0.25 && pv.y < -2) this.event = { kind: 'landing', speed: -pv.y, crash: -pv.y >= crashSpeed() };
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
      const top = this.terrain.solidTop(p.x + o.x, p.y, p.z + o.z, true);
      if (top >= 0) {
        b.setTranslation({ x: p.x, y: top + 1, z: p.z }, true);
        b.setLinvel({ x: v.x, y: Math.max(0, v.y), z: v.z }, true);
      }
    }
    // wedges the car has left
    for (let i = this.wedges.length - 1; i >= 0; i--) {
      const w = this.wedges[i], p = b.translation();
      // (a slow climb may take a while: a wedge goes when the car is well clear of it)
      if ((Math.hypot(p.x - w.x, p.z - w.z) > w.reach + this.half.z + 2 && this.time - w.bornAt > 0.5) || this.time - w.bornAt > 30) {
        for (const c of w.colliders) this.world.removeCollider(c, false);
        this.wedges.splice(i, 1);
      }
    }
    return this.event;
  }

  private isWedge(c: RAPIER.Collider) { return this.wedges.some((w) => w.colliders.includes(c)); }

  // is the chassis touching anything (the world or the wedges)?
  private touchingWorld() {
    let any = false;
    this.world.contactPairsWith(this.chassis, (other) => {
      if (any) return;
      this.world.contactPair(this.chassis, other, (m) => { if (m.numContacts() > 0) any = true; });
    });
    return any;
  }

  // A step ahead, up (a riser the chassis' cast along its horizontal velocity meets) or down (an edge the ground
  // drops off by a step along the wheels' tracks): a wedge on its low side.
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
      dx = f.x; dz = f.z; hs = 0;
    }
    const d = Math.hypot(dx, dz);
    dx /= d; dz /= d;
    // (moving: far enough that the wedge is there before the front wheels reach its foot)
    const reach = hs ? WEDGE_LEN - (this.half.z - this.build.wheels[0].z) + 0.3 + Math.min(hs, 25) * dt * 3 : 1;
    // the ground under the car: its lowest wheel contact
    let low = Infinity;
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) low = Math.min(low, this.controller.wheelContactPoint(i)!.y);
    if (low === Infinity) low = p.y - 1.3; // (no wheel down: the chassis' belly is on something about here)
    if (!this.stepUp(p, r, dx, dz, reach, low) && hs) this.stepDown(p, dx, dz, reach, low);
  }

  private stepUp(p: RAPIER.Vector, r: RAPIER.Rotation, dx: number, dz: number, reach: number, low: number) {
    const terrain = this.terrain!;
    // (from a little higher: not the ground the belly may rest on, only what stands in the way)
    const hit = this.world.castShape({ x: p.x, y: p.y + 0.1, z: p.z }, r, { x: dx, y: 0, z: dz }, this.shape, 0.02, reach, false,
      undefined, CAR_GROUPS, this.chassis, this.body, (col) => !this.isWedge(col));
    if (!hit) return false;
    // the riser's face: axis-aligned (voxels); its column and the one in front of it. A face hit square on gives it;
    // an edge (the riser's top edge against the chassis' bottom: the normal mostly up) the way the car goes
    const n = hit.normal1, face = Math.abs(n.y) < 0.5;
    const ax = face ? Math.abs(n.x) > Math.abs(n.z) : Math.abs(dx) > Math.abs(dz);
    const nx = ax ? (face ? Math.sign(n.x) : -Math.sign(dx)) : 0, nz = ax ? 0 : (face ? Math.sign(n.z) : -Math.sign(dz));
    if (nx * dx + nz * dz > -0.2) return false; // grazing it, not into it
    const o = terrain.origin, w = hit.witness1;
    const wx = w.x + o.x, wz = w.z + o.z;
    // (just either side of the riser's plane on the grid: a smooth ramp (ramps.ts) has no rise there, a riser all of it)
    const plane = ax ? Math.round(wx) : Math.round(wz);
    const gx = ax ? plane : wx, gz = ax ? wz : plane;
    const below = terrain.groundAt(gx + nx * 0.05, gz + nz * 0.05, low + STEP_MAX + 0.05, true);
    const top = below === null ? null : terrain.groundAt(gx - nx * 0.05, gz - nz * 0.05, below + STEP_MAX + 0.05, true);
    if (below === null || top === null) return false;
    // (the riser's foot: the ground the lowest wheel is on, or a step above it under the belly)
    if (below < low - 0.35 || below > low + STEP_MAX) return false;
    return this.wedge(ax, plane, nx || nz, below, top, p, dx, dz);
  }

  private stepDown(p: RAPIER.Vector, dx: number, dz: number, reach: number, low: number) {
    const terrain = this.terrain!, o = terrain.origin;
    const len = this.half.z + reach, sx = -dz, sz = dx, wx = this.build.wheels[0].x;
    for (const side of [0, -wx, wx]) {
      let x = p.x + o.x + sx * side, z = p.z + o.z + sz * side;
      let g = terrain.groundAt(x, z, low + 0.4, true);
      if (g === null || Math.abs(g - low) > 0.4) continue;
      for (let s = 0; s < len; s += 0.2) {
        const x1 = x + dx * 0.2, z1 = z + dz * 0.2;
        const cxd = Math.floor(x1) !== Math.floor(x), czd = Math.floor(z1) !== Math.floor(z);
        const g1 = terrain.groundAt(x1, z1, g + 0.4, true);
        if (g1 === null) break;
        if ((cxd || czd) && g - g1 >= STEP_MIN) {
          if (g - g1 > STEP_MAX) break; // a drop: no wedge
          // (the edge crossed: the grid line between the two columns; the low side the way the car goes)
          const ax = cxd && (!czd || Math.abs(dx) > Math.abs(dz));
          const plane = ax ? Math.max(Math.floor(x), Math.floor(x1)) : Math.max(Math.floor(z), Math.floor(z1));
          const sgn = ax ? Math.sign(dx) : Math.sign(dz);
          const below = terrain.groundAt(ax ? plane + sgn * 0.05 : x1, ax ? z1 : plane + sgn * 0.05, g + 0.05, true);
          if (below === null) break;
          return this.wedge(ax, plane, sgn, below, g, p, dx, dz);
        }
        if (g1 - g > 0.4) break; // up: the cast's
        x = x1; z = z1; g = g1;
      }
    }
    return false;
  }

  // A wedge on the low side of the riser in grid plane `plane` (x = plane if ax, else z = plane), the low side towards
  // `sgn` along that axis, from `below` up to `top`: as wide as the car's crossing needs, over the riser's cells that
  // are the same step (the same foot and top, room on top), its slope running out WEDGE_LEN.
  private wedge(ax: boolean, plane: number, sgn: number, below: number, top: number, p: RAPIER.Vector, dx: number, dz: number) {
    const terrain = this.terrain!, o = terrain.origin;
    const rise = top - below;
    if (rise < STEP_MIN || rise > STEP_MAX) return false;
    const nx = ax ? sgn : 0, nz = ax ? 0 : sgn;
    // where the car's path crosses the plane, along the riser
    const px = p.x + o.x, pz = p.z + o.z;
    const dn = ax ? dx : dz, t = Math.abs(dn) > 0.05 ? ((plane - (ax ? px : pz)) / dn) : 0;
    const along0 = ax ? pz + dz * t : px + dx * t;
    const cos = Math.max(0.2, Math.abs(dn)), sin = Math.sqrt(1 - Math.min(1, cos * cos));
    const halfW = Math.min(WEDGE_W_MAX, (this.half.x + 0.4) / cos + this.half.z * sin);
    const same = (k: number) => {
      const lx = ax ? plane + nx * 0.05 : k + 0.5, lz = ax ? k + 0.5 : plane + nz * 0.05;
      const ux = ax ? plane - nx * 0.05 : k + 0.5, uz = ax ? k + 0.5 : plane - nz * 0.05;
      const b = terrain.groundAt(lx, lz, below + 0.3, true), u = terrain.groundAt(ux, uz, top + 0.05, true);
      return b !== null && u !== null && Math.abs(b - below) < 0.15 && Math.abs(u - top) < 0.15
        && terrain.clear(ax ? plane - nx * 0.5 : k + 0.5, ax ? k + 0.5 : plane - nz * 0.5, top, 2);
    };
    const k0 = Math.floor(along0);
    if (!same(k0)) return false;
    let lo = k0, hi = k0;
    while (lo > along0 - halfW && same(lo - 1)) lo--;
    while (hi + 1 < along0 + halfW && same(hi + 1)) hi++;
    // (one wedge per stretch of riser and side)
    if (this.wedges.some((w) => w.ax === ax && w.plane === plane && w.sgn === sgn && w.lo <= hi && w.hi >= lo)) return false;
    // the prism: the riser's foot at `below`, its top edge at `top`, the slope running out WEDGE_LEN along n
    const colliders: RAPIER.Collider[] = [], K = WEDGE_SEG;
    const h = (t: number) => { const u = 1 - t / WEDGE_LEN; return below + rise * (K > 1 ? u * u * (3 - 2 * u) : u); };
    for (let i = 0; i < K; i++) {
      const t0 = WEDGE_LEN * i / K, t1 = WEDGE_LEN * (i + 1) / K;
      const pts: number[] = [];
      for (const k of [lo, hi + 1]) {
        const ex = ax ? plane : k, ez = ax ? k : plane;
        for (const [t, y] of [[t0, h(t0)], [t0, below - 0.02], [t1, below - 0.02], [t1, h(t1)]]) pts.push(ex + nx * t - o.x, y, ez + nz * t - o.z);
      }
      const desc = this.R.ColliderDesc.convexHull(new Float32Array(pts));
      if (desc) colliders.push(this.world.createCollider(desc.setCollisionGroups(CAR_ONLY_GROUPS).setFriction(0.9)));
    }
    if (!colliders.length) return false;
    const mid = (lo + hi + 1) / 2;
    const cx = (ax ? plane + nx * WEDGE_LEN / 2 : mid) - o.x, cz = (ax ? mid : plane + nz * WEDGE_LEN / 2) - o.z;
    this.wedges.push({ colliders, x: cx, z: cz, ax, plane, sgn, lo, hi, reach: Math.hypot(WEDGE_LEN, hi + 1 - lo) / 2, bornAt: this.time });
    this.event = { kind: 'step', speed: rise };
    return true;
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
      // (walls: not the wedges, not what moves by itself -- a ragdoll, a wreck)
      if (this.isWedge(other) || other.parent()?.isDynamic()) return;
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
      const p = this.build.wheels[i];
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
    for (const w of this.wedges) for (const c of w.colliders) world.removeCollider(c, false);
    this.wedges.length = 0;
    world.removeVehicleController(this.controller);
    world.removeRigidBody(this.body);
    this.mesh.removeFromParent();
  }
}
