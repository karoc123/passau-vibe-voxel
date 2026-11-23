// The FPV drone as WorldSim steps it (craft-core.ts): its flight (fpv-flight.ts FpvFlight) at 1/120 s (a frame counts
// for at most 0.1 s), moved through its collision's cube: stopped a hair short of what it meets, sliding along it when
// it comes in slowly, bounced (and its pilot told: events, 'impact') when fast. Disarmed (input null: before arming,
// out of focus) it holds still where it is; an empty seat cuts the throttle (it falls and comes to rest). No three.js,
// no DOM (tools/core-deps.mjs).
import { FixedStep } from '../../core/fixed-step';
import { add, addScaled, component, copy, length, lengthSq, scale, setComponent, vec3, type Quat, type Vec3 } from '../../core/vec';
import type { CraftCore, CraftSpot } from './craft-core';
import { FpvFlight, REBOUND_SPEED, type FlightInput } from './fpv-flight';
import type { ImpactKind, Sweep } from './sweep';
import type { VoxelCollision } from './voxel-collision';

const SURFACE_CLEARANCE = 0.002;

/** the sticks, or null: disarmed (it holds still) */
export type DroneInput = FlightInput | null;
/** a hit at speed (m/s into what it met) */
export interface DroneEvent { kind: 'impact'; hit: ImpactKind; speed: number }
export interface DroneDrawn { position: Vec3; attitude: Quat }

export class DroneCore implements CraftCore<DroneInput, DroneEvent, DroneDrawn> {
  readonly flight = new FpvFlight();
  readonly clock = new FixedStep(1 / 120, Infinity, 0.1);
  readonly reach = {};
  readonly neutral: DroneInput = Object.freeze({ roll: 0, pitch: 0, yaw: 0, throttle: 0 });
  readonly events: DroneEvent[] = [];
  /** the last step waited for a tile */
  waiting = false;
  private col: VoxelCollision | null = null;
  private readonly next = vec3();
  private readonly glide = vec3();

  // (its yaw: the camera looks along -z, so heading h is yaw h + pi)
  reset(spot: CraftSpot) {
    this.flight.reset({ x: spot.x, y: spot.y ?? 0, z: spot.z }, spot.h + Math.PI);
    this.waiting = false;
  }

  step(input: DroneInput, dt: number, col: VoxelCollision) {
    if (!input) return false;
    this.col = col;
    return this.flight.step(input, dt, this.move);
  }

  get pose() {
    const { x, y, z } = this.flight.position, q = this.flight.attitude;
    // the horizontal components of the drone's forward vector (attitude rotating -z)
    const dx = -2 * (q.x * q.z + q.w * q.y), dz = -1 + 2 * (q.x ** 2 + q.y ** 2);
    return { x, y, z, h: Math.atan2(dx, dz) };
  }

  get velocity() { return this.flight.velocity; }
  // (as drawn at the last step)
  drawn(_alpha: number): DroneDrawn { return { position: this.flight.position, attitude: this.flight.attitude }; }

  private readonly move = (position: Vec3, displacement: Vec3, velocity: Vec3) => {
    const col = this.col!, collision = col.sweep(position, displacement);
    this.waiting = collision === 'loading';
    if (collision === 'loading') return false;
    if (!collision.hit) {
      add(position, displacement);
      return true;
    }

    const fraction = clearance(collision.fraction, displacement);
    addScaled(copy(this.next, position), displacement, fraction);
    // At low normal speed, use the remaining part of the step to slide along the surface.
    const axis = Math.abs(collision.axis) - 1;
    const approach = -component(velocity, axis) * Math.sign(collision.axis);
    let nextContact: Exclude<Sweep, 'loading'> | null = null;
    if (approach < REBOUND_SPEED) {
      setComponent(scale(copy(this.glide, displacement), 1 - fraction), axis, 0);
      if (lengthSq(this.glide) > 1e-10) {
        const slideHit = col.sweep(this.next, this.glide);
        if (slideHit === 'loading') {
          this.waiting = true;
          return false;
        }
        addScaled(this.next, this.glide, slideHit.hit ? clearance(slideHit.fraction, this.glide) : slideHit.fraction);
        nextContact = slideHit;
      }
    }

    copy(position, this.next);
    this.contact(collision.hit, collision.axis);
    if (nextContact?.hit) this.contact(nextContact.hit, nextContact.axis);
    return true;
  };

  private contact(hit: ImpactKind, axis: number) {
    const speed = this.flight.bounce(axis);
    if (speed >= REBOUND_SPEED) this.events.push({ kind: 'impact', hit, speed });
  }
}

function clearance(fraction: number, travel: Vec3) {
  const distance = length(travel);
  return distance > 0 ? Math.max(0, fraction - SURFACE_CLEARANCE / distance) : fraction;
}
