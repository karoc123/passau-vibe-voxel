import { clamp } from '../../core/num';
import {
  add, addScaled, axisAngle, clampLength, copy, copyQuat, cross, divide, dot, length, quat, quatMul, quatNormalize, rotate,
  scale, set, setComponent, setQuat, vec3, type Vec3,
} from '../../core/vec';

// The FPV drone's flight (fpv.ts reads the input, moves it through the collision and draws it). No DOM, no scene, no
// three.js (plain { x, y, z } and { x, y, z, w }: core/vec.ts; tools/core-deps.mjs).

export interface FlightInput {
  roll: number;
  pitch: number;
  yaw: number;
  throttle: number;
}

const GRAVITY = 9.81;
export const HOVER_THROTTLE = 0.39;
export const REBOUND_SPEED = 1.2;
const DEG = Math.PI / 180;
const MAX_ROLL_RATE = 720 * DEG;
const MAX_PITCH_RATE = 680 * DEG;
const MAX_YAW_RATE = 460 * DEG;

function rate(stick: number, maxRate: number) {
  const value = clamp(stick, -1, 1);
  return maxRate * value * (0.34 + 0.66 * value * value);
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

  reset(position: Vec3, yaw: number) {
    copy(this.position, position);
    setQuat(this.attitude, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    set(this.velocity, 0, 0, 0);
    set(this.impactSpin, 0, 0, 0);
  }

  step(input: FlightInput, dt: number, move: (position: Vec3, displacement: Vec3, velocity: Vec3) => boolean) {
    copyQuat(this.priorAttitude, this.attitude);
    copy(this.priorVelocity, this.velocity);
    set(this.rotationAxis, -rate(input.pitch, MAX_PITCH_RATE), -rate(input.yaw, MAX_YAW_RATE), -rate(input.roll, MAX_ROLL_RATE));
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
    const thrust = GRAVITY * (throttle / HOVER_THROTTLE) ** 1.35;
    rotate(set(this.acceleration, 0, thrust, 0), this.attitude);
    this.acceleration.y -= GRAVITY;
    // Drag grows with airspeed and keeps the top speed finite.
    const drag = 0.12 + 0.009 * length(this.velocity);
    addScaled(scale(this.velocity, Math.exp(-drag * dt)), this.acceleration, dt);
    scale(copy(this.displacement, this.velocity), dt);
    if (!move(this.position, this.displacement, this.velocity)) {
      copyQuat(this.attitude, this.priorAttitude);
      copy(this.velocity, this.priorVelocity);
      return false;
    }
    scale(this.impactSpin, Math.exp(-13 * dt));
    return true;
  }

  // Resolve the normal impulse while the motors and pilot remain active.
  bounce(axis: number) {
    const normal = setComponent(set(this.impactNormal, 0, 0, 0), Math.abs(axis) - 1, Math.sign(axis));
    const approach = Math.max(0, -dot(this.velocity, normal));
    if (approach < REBOUND_SPEED) {
      addScaled(this.velocity, normal, approach);
      if (axis === 2) scale(this.velocity, 0.97);
      return approach;
    }

    scale(cross(this.rotationAxis, normal, this.velocity), 0.18);
    add(this.impactSpin, this.rotationAxis);
    addScaled(this.impactSpin, rotate(set(this.rotationAxis, 0.68, 0.2, -0.46), this.attitude), approach * 0.45);
    clampLength(this.impactSpin, 0, 7);
    addScaled(scale(this.velocity, 0.68), normal, approach * (0.68 + 0.32));
    return approach;
  }
}
