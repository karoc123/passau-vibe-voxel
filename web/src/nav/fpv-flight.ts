import * as THREE from 'three';

export interface FlightInput {
  roll: number;
  pitch: number;
  yaw: number;
  throttle: number;
}

const GRAVITY = 9.81;
export const HOVER_THROTTLE = 0.39;
export const REBOUND_SPEED = 1.2;
const MAX_ROLL_RATE = THREE.MathUtils.degToRad(720);
const MAX_PITCH_RATE = THREE.MathUtils.degToRad(680);
const MAX_YAW_RATE = THREE.MathUtils.degToRad(460);

function rate(stick: number, maxRate: number) {
  const value = THREE.MathUtils.clamp(stick, -1, 1);
  return maxRate * value * (0.34 + 0.66 * value * value);
}

// Body axes in three.js are +X right, +Y up and -Z forward.
export class FpvFlight {
  readonly position = new THREE.Vector3();
  readonly attitude = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  private readonly rotationAxis = new THREE.Vector3();
  private readonly rotationDelta = new THREE.Quaternion();
  private readonly acceleration = new THREE.Vector3();
  private readonly displacement = new THREE.Vector3();
  private readonly impactNormal = new THREE.Vector3();
  private readonly impactSpin = new THREE.Vector3();
  private readonly priorAttitude = new THREE.Quaternion();
  private readonly priorVelocity = new THREE.Vector3();

  reset(position: THREE.Vector3, yaw: number) {
    this.position.copy(position);
    this.attitude.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    this.velocity.set(0, 0, 0);
    this.impactSpin.set(0, 0, 0);
  }

  step(input: FlightInput, dt: number,
    move: (position: THREE.Vector3, displacement: THREE.Vector3, velocity: THREE.Vector3) => boolean) {
    this.priorAttitude.copy(this.attitude);
    this.priorVelocity.copy(this.velocity);
    this.rotationAxis.set(-rate(input.pitch, MAX_PITCH_RATE), -rate(input.yaw, MAX_YAW_RATE),
      -rate(input.roll, MAX_ROLL_RATE));
    const angularSpeed = this.rotationAxis.length();
    if (angularSpeed > 0) {
      this.rotationAxis.divideScalar(angularSpeed);
      this.rotationDelta.setFromAxisAngle(this.rotationAxis, angularSpeed * dt);
      this.attitude.multiply(this.rotationDelta).normalize();
    }

    const spin = this.impactSpin.length();
    if (spin > 1e-4) {
      this.rotationAxis.copy(this.impactSpin).divideScalar(spin);
      this.rotationDelta.setFromAxisAngle(this.rotationAxis, spin * dt);
      this.attitude.premultiply(this.rotationDelta).normalize();
    }

    const throttle = THREE.MathUtils.clamp(input.throttle, 0, 1);
    const thrust = GRAVITY * (throttle / HOVER_THROTTLE) ** 1.35;
    this.acceleration.set(0, thrust, 0).applyQuaternion(this.attitude);
    this.acceleration.y -= GRAVITY;
    // Drag grows with airspeed and keeps the top speed finite.
    const drag = 0.12 + 0.009 * this.velocity.length();
    this.velocity.multiplyScalar(Math.exp(-drag * dt)).addScaledVector(this.acceleration, dt);
    this.displacement.copy(this.velocity).multiplyScalar(dt);
    if (!move(this.position, this.displacement, this.velocity)) {
      this.attitude.copy(this.priorAttitude);
      this.velocity.copy(this.priorVelocity);
      return false;
    }
    this.impactSpin.multiplyScalar(Math.exp(-13 * dt));
    return true;
  }

  // Resolve the normal impulse while the motors and pilot remain active.
  bounce(axis: number) {
    const normal = this.impactNormal.set(0, 0, 0).setComponent(Math.abs(axis) - 1, Math.sign(axis));
    const approach = Math.max(0, -this.velocity.dot(normal));
    if (approach < REBOUND_SPEED) {
      this.velocity.addScaledVector(normal, approach);
      if (axis === 2) this.velocity.multiplyScalar(0.97);
      return approach;
    }

    this.rotationAxis.crossVectors(normal, this.velocity).multiplyScalar(0.18);
    this.impactSpin.add(this.rotationAxis)
      .addScaledVector(this.rotationAxis.set(0.68, 0.2, -0.46).applyQuaternion(this.attitude), approach * 0.45)
      .clampLength(0, 7);
    this.velocity.multiplyScalar(0.68).addScaledVector(normal, approach * (0.68 + 0.32));
    return approach;
  }
}
