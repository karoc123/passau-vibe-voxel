import { Vector3 } from 'three';
import { Body, type PhysicsWorld } from '../physics/body';
import type { Pose } from '../sim/types';

export interface DriveInput { gas: number; brake: number; steer: number; handbrake: boolean }
export type RoadContact = { height: number; blocked: boolean; water?: boolean } | null;
export type StepStatus = 'moved' | 'impact' | 'loading' | 'water';

// Vertical motion: on the ground the car follows the road (ramps smoothly, steps of up to a metre at once, as before);
// where the ground falls away faster than gravity could follow -- over a ramp's crest, or off an edge -- it flies.
export const GRAVITY = 12; // m/s², a little over g: arcade jumps that don't float
const STEP_DOWN = 1.45; // m: a drop the car steps down at once (a 1 m kerb or terrace), more is an edge to fly off
const HOP_VY = 1.5; // m/s: climbing at least this fast, a crest throws the car (a hop) instead of being followed
const HOP_GAP = 0.025; // m: ... when the road falls away under its path by more than this in a step
const MAX_SLOPE = 0.6; // the steepest road whose rise counts as the car's vertical speed
const SLOPE_TIME = 0.2; // s: the vertical speed follows the road's slope this smoothly
const AIR_ENTER = 0.4; // m: a hop higher than this is flight proper: no steering, a body (physics/body.ts) in the air
const AIR_YAW = 0.5; // rad/s: the little turn the steering still gives in the air
export const CRASH_SPEED = Math.sqrt(2 * GRAVITY * 8); // m/s into the ground: a fall of ~8 m

export type CarMode = 'ground' | 'hop' | 'air';
export interface Landing { impact: number; crash: boolean }

export class ArcadeCar {
  readonly pose: Pose;
  vx: number;
  vz: number;
  brake = false;
  private steer = 0;
  private turnRate = 0;
  private grip = 7.7;
  private readonly trial: Pose;
  vy = 0;
  mode: CarMode = 'ground';
  landing: Landing | null = null; // set by the step that touched down after a flight
  wall = 0; // m/s into a wall in the air this step
  private body: Body | null = null;

  constructor(pose: Pose, speed: number, readonly bus: boolean, readonly length = bus ? 12 : 4.4, readonly height = bus ? 2.55 : 1.48) {
    this.pose = { ...pose };
    this.trial = { ...pose };
    this.vx = Math.sin(pose.h) * speed;
    this.vz = Math.cos(pose.h) * speed;
  }

  get speed() { return Math.hypot(this.vx, this.vz); }
  get airborne() { return this.mode === 'air'; }

  step(input: DriveInput, dt: number, contact: (pose: Pose) => RoadContact, air: PhysicsWorld): StepStatus {
    this.landing = null;
    this.wall = 0;
    if (this.body) return this.fly(input, dt, air);
    const p = this.pose;
    let sx = Math.sin(p.h), sz = Math.cos(p.h);
    const speed = this.speed, oldLong = this.vx * sx + this.vz * sz;
    const steer = this.steer + (input.steer - this.steer) * (1 - Math.exp(-12 * dt));
    const targetGrip = input.handbrake && speed > 3 ? 1.75 : 7.7;
    const grip = this.grip + (targetGrip - this.grip) * (1 - Math.exp(-(input.handbrake ? 15 : 7) * dt));
    // Positive steering turns screen-right. With +Z forward, this is a negative heading delta.
    const yaw = -steer * Math.sign(oldLong) * Math.min(Math.abs(oldLong) * 0.44, 1.85)
      * (0.48 + 0.52 / (1 + (speed / 24) ** 2)) * (input.handbrake && speed > 3 ? 1.42 : 1) * (this.bus ? 0.7 : 1);
    const turn = this.turnRate + (yaw - this.turnRate) * (1 - Math.exp(-9 * dt));
    const h = p.h + turn * dt;
    sx = Math.sin(h);
    sz = Math.cos(h);

    let longitudinal = this.vx * sx + this.vz * sz, lateral = this.vx * sz - this.vz * sx;
    const gas = input.gas, brake = input.brake;
    const targetSpeed = this.bus ? 22 : 38;
    if (brake > 0 && longitudinal > 0.3) longitudinal = Math.max(0, longitudinal - brake * 15 * dt);
    else if (gas > 0 && longitudinal < -0.3) longitudinal = Math.min(0, longitudinal + gas * 13 * dt);
    else if (gas > 0 && brake === 0) longitudinal += (this.bus ? 5.1 : 8.7) * gas * Math.max(0, 1 - (longitudinal / targetSpeed) ** 2) * dt;
    else if (brake > 0) longitudinal = Math.max(-8, longitudinal - 5.5 * brake * dt);
    const resistance = (gas > 0 || brake > 0 ? 0.055 : 0.38) + (input.handbrake ? 0.85 : 0);
    longitudinal *= Math.exp(-resistance * dt);
    lateral *= Math.exp(-grip * dt);
    if (Math.abs(longitudinal) < 0.06 && !gas && !brake) longitudinal = 0;

    const vx = sx * longitudinal + sz * lateral, vz = sz * longitudinal - sx * lateral;
    const next = Object.assign(this.trial, { x: p.x + vx * dt, y: p.y, z: p.z + vz * dt, h });
    let surface = contact(next);
    if (!surface) return 'loading';
    const impact = surface.blocked;
    let slide: 'x' | 'z' | null = null;
    if (impact) {
      // Prefer the larger component, then try the other tangent before rebounding.
      const axes = Math.abs(vx) > Math.abs(vz) ? ['x', 'z'] as const : ['z', 'x'] as const;
      for (const axis of axes) {
        const remaining = (axis === 'x' ? vx : vz) * dt;
        if (Math.abs(remaining) < 1e-5) continue;
        next.x = p.x;
        next.z = p.z;
        next[axis] += remaining;
        next.h = p.h;
        const candidate = contact(next);
        if (!candidate) return 'loading';
        if (!candidate.blocked) {
          surface = candidate;
          slide = axis;
          break;
        }
      }
    }
    this.steer = steer;
    this.grip = grip;
    this.turnRate = impact ? 0 : turn;
    this.brake = brake > 0 || input.handbrake || impact;
    let launch = false;
    if (!surface.blocked) {
      const y = this.vertical(surface, p.y, speed, dt);
      launch = y === null;
      next.y = y ?? p.y;
      Object.assign(p, next);
    } else if (this.mode !== 'ground') {
      // against a wall in a hop: still coming down where it is
      const here = contact(p);
      if (here && !here.blocked) {
        const y = this.vertical(here, p.y, speed, dt);
        launch = y === null;
        if (y !== null) p.y = y;
      } else if (here) { this.mode = 'ground'; this.vy = 0; }
    }
    if (!impact) {
      this.vx = vx;
      this.vz = vz;
    } else if (!surface.blocked) {
      this.vx = slide === 'x' ? vx * 0.7 : 0;
      this.vz = slide === 'z' ? vz * 0.7 : 0;
    } else {
      this.vx = -vx * 0.13;
      this.vz = -vz * 0.13;
    }
    if (launch) this.takeOff();
    return impact ? 'impact' : 'moved';
  }

  // The height after this step over ground `surface` (from height y), null: it takes off.
  private vertical(surface: { height: number; water?: boolean }, y: number, speed: number, dt: number): number | null {
    const H = surface.height, ballistic = y + this.vy * dt - GRAVITY * dt * dt / 2;
    if (this.mode === 'ground') {
      if (surface.water || y - H > STEP_DOWN) return null;
      if (H < ballistic - HOP_GAP && this.vy >= HOP_VY) {
        this.mode = 'hop';
        this.vy -= GRAVITY * dt;
        return ballistic;
      }
      // following the road: its slope as vertical speed, averaged over a few metres (the ramps' 1 m facets are no
      // crests); a jump steeper than a road's (a step, the edge of a ramp) is no speed
      const dh = H - y;
      if (Math.abs(dh) > Math.max(0.02, MAX_SLOPE * speed * dt)) this.vy *= 0.8;
      else this.vy += (dh / dt - this.vy) * (1 - Math.exp(-dt / SLOPE_TIME));
      return H;
    }
    if (H >= ballistic) {
      this.mode = 'ground';
      if (-this.vy > 2) this.landing = { impact: -this.vy, crash: false };
      this.vy = 0;
      return H;
    }
    if (surface.water || ballistic - H > AIR_ENTER) return null;
    this.vy -= GRAVITY * dt;
    return ballistic;
  }

  // Off the ground: a body in the air keeps the car's velocity.
  private takeOff() {
    const p = this.pose, half = this.height / 2 - 0.15;
    const n = Math.max(2, Math.ceil((this.length - 1.72) / 1.6) + 1), reach = this.length / 2 - 0.86;
    const boxes = Array.from({ length: n }, (_, i) => ({
      offset: new Vector3(0, 0.3 + half, -reach + (2 * reach * i) / (n - 1)),
      half: new Vector3(0.86, half, 0.86),
    }));
    const b = this.body = new Body({ boxes, gravity: GRAVITY, restitution: 0.2, bounceFrom: Infinity, drag: 0.03, stepHeight: 1 });
    b.position.set(p.x, p.y, p.z);
    b.velocity.set(this.vx, this.vy, this.vz);
    b.yaw = p.h;
    this.mode = 'air';
    this.turnRate = 0;
  }

  private fly(input: DriveInput, dt: number, air: PhysicsWorld): StepStatus {
    const b = this.body!, p = this.pose;
    b.angularVelocity.y = -input.steer * AIR_YAW;
    const r = b.step(dt, air);
    if (r.status === 'loading') return 'loading';
    p.x = b.position.x; p.y = b.position.y; p.z = b.position.z; p.h = b.yaw;
    this.vx = b.velocity.x; this.vy = b.velocity.y; this.vz = b.velocity.z;
    this.wall = r.wall;
    this.brake = input.brake > 0 || input.handbrake;
    if (r.water) {
      this.body = null;
      this.mode = 'ground';
      return 'water';
    }
    if (b.onGround) {
      // Touchdown: the suspension takes some of the speed, a hard one all of it.
      const crash = r.impact >= CRASH_SPEED, keep = crash ? 0 : Math.max(0.35, 1 - r.impact * 0.035);
      this.landing = { impact: r.impact, crash };
      this.vx *= keep;
      this.vz *= keep;
      this.vy = 0;
      this.body = null;
      this.mode = 'ground';
    }
    return r.wall > 1 ? 'impact' : 'moved';
  }
}

export function carsOverlap(a: Pose, aLength: number, b: Pose, bLength: number) {
  if (Math.abs(a.y - b.y) > 1.65) return false;
  const x = b.x - a.x, z = b.z - a.z, reach = (aLength + bLength) / 2 + 1.8;
  if (x * x + z * z > reach * reach) return false;
  const af = [Math.sin(a.h), Math.cos(a.h)], bf = [Math.sin(b.h), Math.cos(b.h)];
  const ar = [af[1], -af[0]], br = [bf[1], -bf[0]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1];
  const radius = (axis: number[], f: number[], r: number[], length: number) =>
    Math.abs(dot(axis, f)) * (length / 2 - 0.15) + Math.abs(dot(axis, r)) * 0.86;
  return [af, ar, bf, br].every(axis => Math.abs(axis[0] * x + axis[1] * z) <
    radius(axis, af, ar, aLength) + radius(axis, bf, br, bLength));
}
