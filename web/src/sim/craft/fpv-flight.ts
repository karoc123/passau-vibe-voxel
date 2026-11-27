import { frozen } from '../../core/frozen';
import { clamp } from '../../core/num';
import type { FpvFlightState } from '../contract/crafts';
import type { FlightInput } from '../contract/inputs';
import {
  add, addScaled, axisAngle, clampLength, copy, copyQuat, cross, divide, dot, length, quat, quatMul, quatNormalize, rotate,
  scale, set, setComponent, setQuat, vec3, type Vec3,
} from '../../core/vec';

// The FPV drone's flight (fpv.ts reads the input, moves it through the collision and draws it). No DOM, no scene, no
// three.js (plain { x, y, z } and { x, y, z, w }: core/vec.ts; tools/core-deps.mjs).

// (its input, FlightInput: contract/inputs.ts)

// all the numbers, in one place: read-only (DEFAULT_TUNING.drone, sim/tuning.ts); a drone given others differs
export const DRONE = frozen({
  gravity: 9.81, // m/s²
  hover: 0.39, // the throttle that holds it in the air (the sticks' rest: nav/fpv.ts)
  thrustCurve: 1.35, // thrust: gravity × (throttle / hover) ^ this
  rollRate: 720, pitchRate: 680, yawRate: 460, // °/s at full stick
  rateLinear: 0.34, rateCubic: 0.66, // a stick's rate: this much of it linear, this much cubic (expo)
  drag: 0.12, dragPerSpeed: 0.009, // /s, and /s more per m/s of airspeed (keeps the top speed finite)
  rebound: 1.2, // m/s into a surface from which it bounces (and its pilot is told: drone-core.ts); slower it slides
  floorKeep: 0.97, // of its speed kept sliding on a floor
  bounceKeep: 0.68, bounceBack: 0.32, // a bounce: of its speed kept; of the speed into the surface turned back on top of that
  hitSpin: 0.18, // rad/s of spin per m/s of speed along the surface
  kickSpin: 0.45, kickX: 0.68, kickY: 0.2, kickZ: -0.46, // rad/s more per m/s into it, about this body axis
  spinMax: 7, // rad/s
  spinDecay: 13, // /s
  clearance: 0.002, // m short of what it meets it stops (drone-core.ts)
});
export type DroneTuning = typeof DRONE;

const DEG = Math.PI / 180;

function rate(stick: number, maxRate: number, cfg: DroneTuning) {
  const value = clamp(stick, -1, 1);
  return maxRate * value * (cfg.rateLinear + cfg.rateCubic * value * value);
}

// Body axes as three.js has them: +X right, +Y up and -Z forward.
export class FpvFlight {
  readonly position = vec3();
  readonly attitude = quat();
  readonly velocity = vec3();
  private readonly rotationAxis = vec3();
  private readonly rotationDelta = quat();
  private readonly acceleration = vec3();
  private readonly displacement = vec3();
  private readonly impactNormal = vec3();
  private readonly impactSpin = vec3();
  private readonly priorAttitude = quat();
  private readonly priorVelocity = vec3();

  // cfg: its numbers (Tuning.drone)
  constructor(readonly cfg: DroneTuning = DRONE) {}

  /** its state on the wire (contract/crafts.ts); not: impactSpin (the steps' spin after a hit), the steps' scratch */
  save(): FpvFlightState { return { position: { ...this.position }, attitude: { ...this.attitude }, velocity: { ...this.velocity } }; }
  restore(s: FpvFlightState) {
    copy(this.position, s.position);
    copyQuat(this.attitude, s.attitude);
    copy(this.velocity, s.velocity);
  }

  reset(position: Vec3, yaw: number) {
    copy(this.position, position);
    setQuat(this.attitude, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    set(this.velocity, 0, 0, 0);
    set(this.impactSpin, 0, 0, 0);
  }

  step(input: FlightInput, dt: number, move: (position: Vec3, displacement: Vec3, velocity: Vec3) => boolean) {
    copyQuat(this.priorAttitude, this.attitude);
    copy(this.priorVelocity, this.velocity);
    const c = this.cfg;
    set(this.rotationAxis, -rate(input.pitch, c.pitchRate * DEG, c), -rate(input.yaw, c.yawRate * DEG, c), -rate(input.roll, c.rollRate * DEG, c));
    const angularSpeed = length(this.rotationAxis);
    if (angularSpeed > 0) {
      divide(this.rotationAxis, angularSpeed);
      axisAngle(this.rotationDelta, this.rotationAxis, angularSpeed * dt);
      quatNormalize(quatMul(this.attitude, this.attitude, this.rotationDelta));
    }

    const spin = length(this.impactSpin);
    if (spin > 1e-4) {
      divide(copy(this.rotationAxis, this.impactSpin), spin);
      axisAngle(this.rotationDelta, this.rotationAxis, spin * dt);
      quatNormalize(quatMul(this.attitude, this.rotationDelta, this.attitude));
    }

    const throttle = clamp(input.throttle, 0, 1);
    const thrust = c.gravity * (throttle / c.hover) ** c.thrustCurve;
    rotate(set(this.acceleration, 0, thrust, 0), this.attitude);
    this.acceleration.y -= c.gravity;
    const drag = c.drag + c.dragPerSpeed * length(this.velocity);
    addScaled(scale(this.velocity, Math.exp(-drag * dt)), this.acceleration, dt);
    scale(copy(this.displacement, this.velocity), dt);
    if (!move(this.position, this.displacement, this.velocity)) {
      copyQuat(this.attitude, this.priorAttitude);
      copy(this.velocity, this.priorVelocity);
      return false;
    }
    scale(this.impactSpin, Math.exp(-c.spinDecay * dt));
    return true;
  }

  // Resolve the normal impulse while the motors and pilot remain active.
  bounce(axis: number) {
    return this.bounceOff(setComponent(set(this.impactNormal, 0, 0, 0), Math.abs(axis) - 1, Math.sign(axis)), axis === 2);
  }

  /** off a face whose normal (a unit vector) is normal; floor: a floor's (slid along, it brakes) */
  bounceOff(normal: Vec3, floor = false) {
    const c = this.cfg;
    const approach = Math.max(0, -dot(this.velocity, normal));
    if (approach < c.rebound) {
      addScaled(this.velocity, normal, approach);
      if (floor) scale(this.velocity, c.floorKeep);
      return approach;
    }

    scale(cross(this.rotationAxis, normal, this.velocity), c.hitSpin);
    add(this.impactSpin, this.rotationAxis);
    addScaled(this.impactSpin, rotate(set(this.rotationAxis, c.kickX, c.kickY, c.kickZ), this.attitude), approach * c.kickSpin);
    clampLength(this.impactSpin, 0, c.spinMax);
    addScaled(scale(this.velocity, c.bounceKeep), normal, approach * (c.bounceKeep + c.bounceBack));
    return approach;
  }
}
