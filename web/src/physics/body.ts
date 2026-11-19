import { Quaternion, Vector3 } from 'three';

// A dynamic body for arcade physics against the voxel city: something thrown, a car in the air, a person knocked
// flying. Fixed-step, no engine: gravity, a box cast per step (with slides along what it hits), and a surface query to
// land on. The world behind it is the narrow PhysicsWorld below, so a real engine (e.g. Rapier with colliders built
// only around the active bodies) could take over the internals without the callers changing.

// The world as a body sees it.
export interface PhysicsWorld {
  // Moves a box (centre, half extents) by `move`: how far it gets (0..1) and the face it meets (normal as a signed
  // one-based axis index: +2 = a floor below it). Voxels whose top is at or below `above` are stepped over (left to
  // `ground`). What the box already overlaps does not stop it (so it can always get out). 'loading': the collision data
  // there is not in yet.
  cast(center: Vector3, half: Vector3, move: Vector3, above: number): { fraction: number; axis: number } | null | 'loading';
  // The surface to stand on at (x, z), at or a little above `top`: its height and whether it is water. null: loading.
  ground(x: number, z: number, top: number): { height: number; water: boolean } | null;
}

// a box of the body: its centre relative to the body's position (which is at its bottom), turned with the body's
// heading; boxes stay axis-aligned (a car is a few of them along its length)
export interface BodyBox { offset: Vector3; half: Vector3 }

export interface BodyOptions {
  boxes: BodyBox[];
  gravity?: number; // m/s²
  restitution?: number; // the share of the speed into a wall (or the floor, from bounceFrom up) it bounces back with
  bounceFrom?: number; // m/s: slower landings stick
  friction?: number; // 1/s: horizontal damping while on the ground
  drag?: number; // 1/s: air drag
  stepHeight?: number; // m: what it steps over (or lands on top of) instead of hitting it
}

export interface StepResult {
  status: 'moved' | 'loading';
  landed: boolean; // touched down this step
  impact: number; // m/s: the speed into the ground at touchdown
  wall: number; // m/s: the speed into walls this step
  water: boolean; // it is in water
}

const EPS = 1e-3;
const UP = new Vector3(0, 1, 0);

export class Body {
  readonly position = new Vector3(); // at its bottom
  readonly velocity = new Vector3();
  readonly angularVelocity = new Vector3(); // rad/s, world axes
  readonly quaternion = new Quaternion();
  onGround = false;
  inWater = false;
  airTime = 0;
  gravity: number;
  restitution: number;
  bounceFrom: number;
  friction: number;
  drag: number;
  stepHeight: number;
  private readonly boxes: BodyBox[];
  private readonly center = new Vector3();
  private readonly move = new Vector3();
  private readonly rest = new Vector3();
  private readonly spin = new Quaternion();
  private hitBox: BodyBox | null = null;
  private readonly result: StepResult = { status: 'moved', landed: false, impact: 0, wall: 0, water: false };

  constructor(options: BodyOptions) {
    this.boxes = options.boxes;
    this.gravity = options.gravity ?? 9.81;
    this.restitution = options.restitution ?? 0.25;
    this.bounceFrom = options.bounceFrom ?? 4;
    this.friction = options.friction ?? 4;
    this.drag = options.drag ?? 0.02;
    this.stepHeight = options.stepHeight ?? 0.3;
  }

  // heading about +Y (as the street life's: 0 = +Z)
  get yaw() {
    const q = this.quaternion;
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
  }

  set yaw(h: number) { this.quaternion.setFromAxisAngle(UP, h); }

  // One fixed step. On 'loading' nothing moved.
  step(dt: number, world: PhysicsWorld): StepResult {
    const r = this.result, v = this.velocity, p = this.position;
    r.status = 'moved'; r.landed = false; r.impact = 0; r.wall = 0; r.water = this.inWater;
    const wasOnGround = this.onGround;
    if (!this.onGround) v.y -= this.gravity * dt;
    v.multiplyScalar(Math.exp(-this.drag * dt));
    if (this.onGround) {
      const f = Math.exp(-this.friction * dt);
      v.x *= f; v.z *= f;
    }

    // Up to three casts: each hit takes that axis out of the rest of the move (a slide).
    this.move.copy(v).multiplyScalar(dt);
    const above = p.y + this.stepHeight;
    let floor: BodyBox | null = null;
    for (let k = 0; k < 3 && this.move.lengthSq() > 1e-12; k++) {
      const hit = this.cast(world, this.move, above);
      if (hit === 'loading') { r.status = 'loading'; return r; }
      const t = hit ? Math.max(0, hit.fraction - EPS / Math.max(EPS, this.move.length())) : 1;
      p.addScaledVector(this.move, t);
      if (!hit) break;
      const axis = Math.abs(hit.axis) - 1, into = -v.getComponent(axis) * Math.sign(hit.axis);
      this.rest.copy(this.move).multiplyScalar(1 - t).setComponent(axis, 0);
      this.move.copy(this.rest);
      if (axis === 1) {
        if (hit.axis > 0) floor = this.hitBox;
        v.y = 0;
        continue;
      }
      if (into > 0) {
        r.wall += into;
        v.setComponent(axis, v.getComponent(axis) + into * (1 + this.restitution) * Math.sign(hit.axis));
        // a little friction along the wall
        const along = axis === 0 ? 2 : 0;
        v.setComponent(along, v.getComponent(along) * Math.max(0, 1 - 0.15 * into / Math.max(1, Math.abs(v.getComponent(along)))));
      }
    }

    // The surface under it: land (or step up onto it), else fall.
    const g = world.ground(p.x, p.z, p.y + this.stepHeight);
    if (!g) { r.status = 'loading'; return r; }
    this.inWater = g.water && p.y <= g.height + 0.05;
    r.water = this.inWater;
    if (floor && p.y > g.height + this.stepHeight && floor.offset.x ** 2 + floor.offset.z ** 2 > 0.01) {
      // Hanging over an edge on one end (a car's nose on a roof): tip off it, away from that end.
      this.rest.copy(floor.offset).applyQuaternion(this.quaternion).setY(0).normalize();
      v.addScaledVector(this.rest, -6 * dt);
      v.y = 0;
      this.onGround = false;
    } else if (p.y <= g.height + EPS || floor) {
      if (p.y < g.height) p.y = g.height;
      if (!wasOnGround) {
        r.impact = Math.max(0, -v.y);
        r.landed = true;
      }
      if (-v.y > this.bounceFrom && !this.inWater) { v.y = -v.y * this.restitution; this.onGround = false; }
      else { v.y = 0; this.onGround = true; }
    } else if (p.y > g.height + 0.05) this.onGround = false;
    this.airTime = this.onGround ? 0 : this.airTime + dt;

    // Spin: integrated as given, damped on the ground.
    const w = this.angularVelocity, a = w.length();
    if (a > 1e-6) {
      this.spin.setFromAxisAngle(this.rest.copy(w).divideScalar(a), a * dt);
      this.quaternion.premultiply(this.spin).normalize();
      if (this.onGround) w.multiplyScalar(Math.exp(-6 * dt));
    }
    return r;
  }

  // the earliest hit of any of its boxes
  private cast(world: PhysicsWorld, move: Vector3, above: number) {
    let best: { fraction: number; axis: number } | null = null;
    for (const box of this.boxes) {
      this.center.copy(box.offset).applyQuaternion(this.quaternion).add(this.position);
      const hit = world.cast(this.center, box.half, move, above);
      if (hit === 'loading') return 'loading';
      if (hit && (!best || hit.fraction < best.fraction)) { best = hit; this.hitBox = box; }
    }
    return best;
  }
}
