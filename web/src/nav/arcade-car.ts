import type { Pose } from '../sim/types';

export interface DriveInput { gas: number; brake: number; steer: number; handbrake: boolean }
export type RoadContact = { height: number; blocked: boolean } | null;

export class ArcadeCar {
  readonly pose: Pose;
  vx: number;
  vz: number;
  brake = false;
  private steer = 0;
  private turnRate = 0;
  private readonly trial: Pose;

  constructor(pose: Pose, speed: number, readonly bus: boolean) {
    this.pose = { ...pose };
    this.trial = { ...pose };
    this.vx = Math.sin(pose.h) * speed;
    this.vz = Math.cos(pose.h) * speed;
  }

  get speed() { return Math.hypot(this.vx, this.vz); }

  step(input: DriveInput, dt: number, contact: (pose: Pose) => RoadContact): 'moved' | 'impact' | 'loading' {
    const p = this.pose;
    let sx = Math.sin(p.h), sz = Math.cos(p.h);
    const speed = this.speed, oldLong = this.vx * sx + this.vz * sz;
    const steer = this.steer + (input.steer - this.steer) * (1 - Math.exp(-12 * dt));
    const grip = input.handbrake ? 1.7 : 7.7;
    const yaw = steer * Math.sign(oldLong) * Math.min(Math.abs(oldLong) * 0.44, 1.85)
      * (0.48 + 0.52 / (1 + (speed / 24) ** 2)) * (input.handbrake ? 1.48 : 1) * (this.bus ? 0.7 : 1);
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
    const resistance = (gas > 0 || brake > 0 ? 0.055 : 0.38) + (input.handbrake ? 1.25 : 0);
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
    this.turnRate = impact ? 0 : turn;
    this.brake = brake > 0 || input.handbrake || impact;
    if (!surface.blocked) {
      next.y = surface.height;
      Object.assign(p, next);
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
    return impact ? 'impact' : 'moved';
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
