// Rapier car: a drivable car on Rapier's DynamicRayCastVehicleController (raycast wheels on a chassis), with what the
// voxel city needs on top of it (each switchable in CarTuning, for the scenarios in scenarios.ts):
// - ground: the car drives on the surface drawn, as every body does (terrain.ts: the voxels, and the caps of sloped
//   streets and bridge decks, core/surface.ts); its wheels' rays see the caps, not their voxels' tops; its dampers
//   the drawn surface's slope, not its facets' 1/64 m kinks (dampers()).
// - steps: a riser of up to STEP_MAX that is not the ground's (a platform, a low wall) ahead of the moving car, up or
//   down, gets an invisible wedge on its low side, laid before the front wheels reach its foot (prisms on a smoothstep
//   profile on the ground of the low side, as wide as the car's crossing needs, that only the car collides with and its
//   wheels ride on), so it drives up or down as on a ramp instead of hitting the riser or dropping off it; higher is a
//   wall (or a drop).
// - walls: the chassis has no friction or bounce against the world, so it glances along a wall instead of sticking to
//   it; touching a wall turns the car towards the wall's direction (the way it slides).
// - air: no wheel touching, the roll and pitch are damped and gently righted (the heading left alone).
// - water: the chassis' centre down at the water's top at its column ends the drive (status 'water').
// - landing: touching down from the air faster than crashSpeed() into the ground (a fall of ~8 m) is a crash (an event:
//   the driver is shaken).
// No three.js, no DOM (plain maths: core/vec.ts; tools/core-deps.mjs): the car steps the same headless and on a server.
// The shared world publishes its pose. StreetLife draws the vehicle model.
import RAPIER from '@dimforge/rapier3d-compat';
import { axisAngle, cross, dot, quat, rotate, vec3 } from '../../core/vec';
import { CAR_GROUPS, CAR_ONLY_GROUPS, WHEEL_GROUPS, type RapierTerrain } from './terrain';
import { CAR, createVehicle, MAX_SUSPENSION_FORCE, REST, RIDE, rideOf, WHEEL_R, type CarBuild } from './vehicle';

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

export { CAR, bus, RIDE, type CarBuild } from './vehicle';
// m/s into the ground: a fall of ~8 m (under the car's gravity)
export const crashSpeed = () => Math.sqrt(2 * 9.81 * RIDE.gravity * 8);
const MAX_STEER = 0.55, STEER_FALL = 14; // rad, m/s (CarBuild tune: steer, steerFall)
// a bike (CarBuild bike): drawn leaning into its turns, at most LEAN_MAX (rad), eased over LEAN_S; a wheelie of up to
// WHEELIE (rad) under full throttle from low speed; kept upright on its wheels (bike())
const LEAN_MAX = 0.7, LEAN_S = 0.12, WHEELIE = 0.16;
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
  status: CarStatus = 'ok';
  airTime = 0;
  private steer = 0;
  private readonly wedges: Wedge[] = [];
  private readonly shape: RAPIER.Shape;
  private prevV = { x: 0, y: 0, z: 0 };
  private time = 0;
  private event: CarEvent | null = null;
  private readonly half: CarBuild['half'];
  // the ground's height under the body's origin along its up, as its wheels hold it now (see afterStep)
  ride: number;
  // a bike's: drawn leaning into its turn (rad, left side up as a Car's roll), its front up in a wheelie (rad)
  lean = 0;
  wheelie = 0;

  // heading: radians about y (0: +z), or a whole rotation
  constructor(private readonly R: typeof RAPIER, private readonly world: RAPIER.World, at: { x: number; y: number; z: number }, heading: number | RAPIER.Rotation,
    private readonly terrain: RapierTerrain | null = null, readonly tuning: CarTuning = TUNED, readonly build: CarBuild = CAR, existing?: ReturnType<typeof createVehicle>) {
    const q = typeof heading === 'number' ? axisAngle(quat(), vec3(0, 1, 0), heading) : heading;
    const v = existing ?? createVehicle(R, world, at, q, build, tuning.walls);
    this.body = v.body; this.chassis = v.chassis; this.controller = v.controller;
    this.half = build.half;
    this.ride = build.ride;
    this.shape = this.chassis.shape;
  }

  // km/h along the chassis' forward axis
  get kmh() { return this.controller.currentVehicleSpeed() * 3.6; }

  // Before the world's step: the wheels' forces, the assists.
  step(input: CarInput, dt: number) {
    this.event = null;
    const c = this.controller, v = c.currentVehicleSpeed();
    // steering eased, less of it at speed
    const T = this.build.tune;
    const target = -input.steer * (T?.steer ?? MAX_STEER) / (1 + Math.abs(v) / (T?.steerFall ?? STEER_FALL));
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
    for (let i = 0, n = c.numWheels(); i < n; i++) {
      const front = B.wheels[i].front;
      c.setWheelSteering(i, front ? this.steer : 0);
      c.setWheelEngineForce(i, front ? 0 : engine);
      c.setWheelBrake(i, input.handbrake && !front ? BRAKE * 2 : brake);
    }
    // (the velocity before the springs' impulses: a landing's speed into the ground)
    const lv = this.body.linvel(), av = this.body.angvel(), com = this.body.worldCom();
    this.prevV = { x: lv.x, y: lv.y, z: lv.z };
    c.updateVehicle(dt, undefined, WHEEL_GROUPS);
    if (RIDE.patch > 0 && this.terrain) this.dampers(lv, av, com, dt);
    const downforce = rideOf(B, 'downforce');
    if (downforce && this.wheelsInContact()) {
      const up = rotate(vec3(0, 1, 0), this.body.rotation());
      const f = -downforce * this.body.mass() * 9.81 * Math.min(2, (v / 13.9) ** 2) * dt;
      this.body.applyImpulse({ x: up.x * f, y: up.y * f, z: up.z * f }, true);
    }
    if (this.tuning.steps) this.stepAssist(input, dt);
    if (this.tuning.air && this.wheelsInContact() === 0) this.airAssist(dt);
    if (B.bike) this.bike(input, v, dt);
  }

  // A bike on its wheels kept upright (its roll rate pulled to what rights it, firmly: no balance to keep), and drawn
  // leaning into its turn as far as its sideways acceleration (speed x yaw rate) asks; a wheelie under full throttle
  // from low speed. In the air: airAssist rights it, the lean eases off.
  private bike(input: CarInput, v: number, dt: number) {
    const b = this.body, q = b.rotation(), w = b.angvel();
    const ground = this.wheelsInContact() >= 2;
    if (ground) {
      const up = rotate(vec3(0, 1, 0), q), f = rotate(vec3(0, 0, 1), q);
      // (the roll error: about the forward axis, the turn that brings its up to the world's)
      const err = dot(cross(vec3(), up, vec3(0, 1, 0)), f), wf = w.x * f.x + w.y * f.y + w.z * f.z;
      const d = (err * 10 - wf) * Math.min(1, dt * 25);
      b.setAngvel({ x: w.x + f.x * d, y: w.y + f.y * d, z: w.z + f.z * d }, true);
    }
    // (turning left -- yaw rate up -- leans it left: its left side down, a negative roll)
    const lean = ground ? Math.max(-LEAN_MAX, Math.min(LEAN_MAX, -Math.atan(v * w.y / 9.81))) : 0;
    const k = 1 - Math.exp(-dt / LEAN_S);
    this.lean += (lean - this.lean) * k;
    const pull = ground && input.gas > 0.9 && v > 1 && v < 12 ? WHEELIE * (1 - v / 12) : 0;
    this.wheelie += (pull - this.wheelie) * (1 - Math.exp(-dt / (pull > this.wheelie ? 0.25 : 0.15)));
  }

  // The dampers on the ground's slope, not on its facets. Rapier's damper pushes on the chassis' speed at the wheel's
  // contact along the hit triangle's normal: the drawn surface is flat facets (two triangles a 1 m column, corners in
  // 1/64 m, core/surface.ts), so on a gentle grade the normal under a wheel steps by up to 1/64 per metre at a column's
  // edge (the grade rounded column by column: flat, flat, 1/64, flat ...), and at speed the damper takes each step whole
  // (at 70 km/h 0.3 m/s, a fifth of an axle's load: the body pitches on every 1.6 mm). So the damper here takes the
  // slope of the drawn surface over RIDE.patch m either side of the contact (central differences of its heights,
  // terrain.groundAt; one-sided at a riser, the facet's normal where neither side is the same surface or the wheel is
  // on something else, a wedge): Rapier's damping force replaced by the same along that normal. Only for the small
  // kinks: where the two normals differ by more than half of RIDE.kinkMax the facet's takes over (fully at kinkMax), so
  // a real edge -- a hole, a deck's end, a wedge's foot -- is damped as it comes. The contact (on the
  // drawn surface), the springs and the friction are Rapier's, the force along the facet's normal at the contact point
  // as Rapier applies it. lv, av, com: the body's velocities and centre of mass before updateVehicle (what it used).
  private dampers(lv: RAPIER.Vector, av: RAPIER.Vector, com: RAPIER.Vector, dt: number) {
    const c = this.controller, b = this.body, m = b.mass(), t = this.terrain!, o = t.origin, H = RIDE.patch;
    const down = rotate(vec3(0, -1, 0), b.rotation());
    const compression = rideOf(this.build, 'compression'), relaxation = rideOf(this.build, 'relaxation'), stiffness = rideOf(this.build, 'stiffness');
    for (let i = 0; i < this.build.wheels.length; i++) {
      if (!c.wheelIsInContact(i)) continue;
      const n = c.wheelContactNormal(i)!, p = c.wheelContactPoint(i)!;
      const x = p.x + o.x, z = p.z + o.z;
      // (a capped run's voxel top may be up to 60/64 m over its surface)
      const at = (dx: number, dz: number) => {
        const h = t.groundAt(x + dx, z + dz, p.y + 1);
        return h !== null && Math.abs(h - p.y) < 0.4 * H + 0.05 ? h : null;
      };
      const h0 = at(0, 0);
      if (h0 === null || Math.abs(h0 - p.y) > 0.02) continue; // (not on the drawn surface)
      const slope = (a: number | null, b: number | null) =>
        (a !== null && b !== null ? (a - b) / (2 * H) : a !== null ? (a - h0) / H : b !== null ? (h0 - b) / H : null);
      const gx = slope(at(H, 0), at(-H, 0)), gz = slope(at(0, H), at(0, -H));
      if (gx === null || gz === null) continue;
      const gl = Math.hypot(gx, 1, gz), ex = -gx / gl, ey = 1 / gl, ez = -gz / gl;
      // (as Rapier: the chassis' velocity at the contact along the normal, over the normal's cosine to the suspension)
      const den = n.x * down.x + n.y * down.y + n.z * down.z, deS = ex * down.x + ey * down.y + ez * down.z;
      if (den >= -0.1 || deS >= -0.1) continue;
      const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
      const vx = lv.x + av.y * rz - av.z * ry, vy = lv.y + av.z * rx - av.x * rz, vz = lv.z + av.x * ry - av.y * rx;
      const raw = (n.x * vx + n.y * vy + n.z * vz) / -den;
      const dn = Math.hypot(n.x - ex, n.y - ey, n.z - ez);
      const w = Math.max(0, Math.min(1, (RIDE.kinkMax - dn) / (RIDE.kinkMax * 0.5)));
      const soft = raw + w * ((ex * vx + ey * vy + ez * vz) / -deS - raw);
      const damp = (v: number) => (v < 0 ? compression : relaxation) * v;
      const spring = stiffness * (REST - (c.wheelSuspensionLength(i) ?? REST)) / -den;
      // (Rapier's force: never pulling, at most the wheel's maximum)
      const force = (d: number) => Math.min(MAX_SUSPENSION_FORCE, Math.max(0, (spring - d) * m));
      const dF = force(damp(soft)) - force(damp(raw));
      if (dF) b.applyImpulseAtPoint({ x: n.x * dF * dt, y: n.y * dF * dt, z: n.z * dF * dt }, p, true);
    }
  }

  // After the world's step: landings, wall hits, water. Returns what happened in this step.
  afterStep(dt: number): CarEvent | null {
    this.time += dt;
    const b = this.body, v = b.linvel(), pv = this.prevV;
    const wheels = this.wheelsInContact();
    this.updateRide(dt);
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
      const top = this.terrain.solidTop(p.x + o.x, p.y, p.z + o.z);
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
      const f = rotate(vec3(0, 0, dir), r);
      dx = f.x; dz = f.z; hs = 0;
    }
    const d = Math.hypot(dx, dz);
    dx /= d; dz /= d;
    // (moving: far enough that the wedge is there before the front wheels reach its foot)
    const reach = hs ? WEDGE_LEN - (this.half.z - this.build.wheels[0].z) + 0.3 + Math.min(hs, 25) * dt * 3 : 1;
    // the ground under the car: its lowest wheel contact
    let low = Infinity;
    for (let i = 0, n = this.controller.numWheels(); i < n; i++) if (this.controller.wheelIsInContact(i)) low = Math.min(low, this.controller.wheelContactPoint(i)!.y);
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
    // (just either side of the riser's plane on the grid: a cap (core/surface.ts) has no rise there, a riser all of it)
    const plane = ax ? Math.round(wx) : Math.round(wz);
    const gx = ax ? plane : wx, gz = ax ? wz : plane;
    const below = terrain.groundAt(gx + nx * 0.05, gz + nz * 0.05, low + STEP_MAX + 0.05);
    const top = below === null ? null : terrain.groundAt(gx - nx * 0.05, gz - nz * 0.05, below + STEP_MAX + 0.05);
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
      let g = terrain.groundAt(x, z, low + 0.4);
      if (g === null || Math.abs(g - low) > 0.4) continue;
      for (let s = 0; s < len; s += 0.2) {
        const x1 = x + dx * 0.2, z1 = z + dz * 0.2;
        const cxd = Math.floor(x1) !== Math.floor(x), czd = Math.floor(z1) !== Math.floor(z);
        const g1 = terrain.groundAt(x1, z1, g + 0.4);
        if (g1 === null) break;
        if ((cxd || czd) && g - g1 >= STEP_MIN) {
          if (g - g1 > STEP_MAX) break; // a drop: no wedge
          // (the edge crossed: the grid line between the two columns; the low side the way the car goes)
          const ax = cxd && (!czd || Math.abs(dx) > Math.abs(dz));
          const plane = ax ? Math.max(Math.floor(x), Math.floor(x1)) : Math.max(Math.floor(z), Math.floor(z1));
          const sgn = ax ? Math.sign(dx) : Math.sign(dz);
          const below = terrain.groundAt(ax ? plane + sgn * 0.05 : x1, ax ? z1 : plane + sgn * 0.05, g + 0.05);
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
      const b = terrain.groundAt(lx, lz, below + 0.3), u = terrain.groundAt(ux, uz, top + 0.05);
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
    // the prism: the riser's foot at `below`, its top edge at `top`, the slope running out WEDGE_LEN along n. Its top
    // the lower of that smoothstep over the foot's level and the same rise over the ground on the low side (a sloped
    // street's cap falling away from the riser: a wedge level with the foot would hang over it, its far end a wall in
    // the air the chassis hits), its bottom down to that ground (no gap under it): it lies on the ground it ramps
    const colliders: RAPIER.Collider[] = [], K = WEDGE_SEG;
    const s = (t: number) => { const u = 1 - t / WEDGE_LEN; return K > 1 ? u * u * (3 - 2 * u) : u; };
    const ground = (ex: number, ez: number, t: number) => {
      // (a run whose voxel top is up to a metre over the foot may have its cap under it)
      const g = terrain.groundAt(ex + nx * t, ez + nz * t, below + 1.2);
      return g === null || g > below ? below : Math.max(g, below - 1.5);
    };
    for (let i = 0; i < K; i++) {
      const t0 = WEDGE_LEN * i / K, t1 = WEDGE_LEN * (i + 1) / K;
      const pts: number[] = [];
      for (const k of [lo, hi + 1]) {
        const ex = ax ? plane : k, ez = ax ? k : plane;
        // (the ground just inside the wedge's end, a little off the riser's plane)
        const sx = ax ? ex : k === lo ? k + 0.05 : k - 0.05, sz = ax ? (k === lo ? k + 0.05 : k - 0.05) : ez;
        for (const t of [t0, t1]) {
          const g = ground(sx, sz, Math.max(t, 0.05)), y = g + rise * s(t);
          pts.push(ex + nx * t - o.x, y, ez + nz * t - o.z, ex + nx * t - o.x, g - 0.02, ez + nz * t - o.z);
        }
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
    const b = this.body, w = b.angvel(), up = rotate(vec3(0, 1, 0), b.rotation());
    // the axis that would right it, scaled by how far off it is
    const axis = cross(vec3(), up, vec3(0, 1, 0));
    const k = 1 - Math.exp(-2.5 * dt), right = 3;
    b.setAngvel({ x: w.x + (axis.x * right - w.x) * k, y: w.y, z: w.z + (axis.z * right - w.z) * k }, true);
  }

  // Against a wall the car's heading follows the wall a little (the way it slides along it), as a driver would steer.
  private wallTurn(dt: number) {
    const b = this.body;
    let nx = 0, nz = 0;
    this.world.contactPairsWith(this.chassis, (other) => {
      // (walls: not the wedges, not what moves by itself -- a wreck)
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
    const f = rotate(vec3(0, 0, 1), b.rotation());
    const sign = f.x * tx + f.z * tz >= 0 ? 1 : -1;
    const want = Math.atan2(tx * sign, tz * sign), have = Math.atan2(f.x, f.z);
    let d = want - have;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const w = b.angvel();
    b.setAngvel({ x: w.x, y: w.y + (d * 6 - w.y) * Math.min(1, dt * 10), z: w.z }, true);
  }

  // The ride height: the wheels' mount (0.2 under the origin), the touching wheels' mean suspension length and the
  // wheel's radius; with no wheel down, the build's ride. Eased (~50 ms) so a wheel lifting moves it smoothly.
  private updateRide(dt: number) {
    const c = this.controller;
    let n = 0, len = 0;
    for (let i = 0; i < c.numWheels(); i++) if (c.wheelIsInContact(i)) { n++; len += c.wheelSuspensionLength(i) ?? REST; }
    const target = n ? 0.2 + len / n + WHEEL_R : this.build.ride;
    this.ride += (target - this.ride) * (1 - Math.exp(-dt / 0.05));
  }

  wheelsInContact() {
    let n = 0;
    for (let i = 0, k = this.controller.numWheels(); i < k; i++) if (this.controller.wheelIsInContact(i)) n++;
    return n;
  }

  clearWedges() {
    for (const w of this.wedges) for (const c of w.colliders) this.world.removeCollider(c, false);
    this.wedges.length = 0;
  }

  dispose(world: RAPIER.World) {
    this.clearWedges();
    world.removeVehicleController(this.controller);
    world.removeRigidBody(this.body);
  }
}
