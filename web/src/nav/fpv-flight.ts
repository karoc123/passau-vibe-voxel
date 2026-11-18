import * as THREE from 'three';

export interface FlightInput {
  roll: number;
  pitch: number;
  yaw: number;
  throttle: number;
}

const GRAVITY = 9.81;
export const HOVER_THROTTLE = 0.39;
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
  private readonly tumble = new THREE.Vector3();

  reset(position: THREE.Vector3, yaw: number) {
    this.position.copy(position);
    this.attitude.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    this.velocity.set(0, 0, 0);
  }

  step(input: FlightInput, dt: number,
    move: (position: THREE.Vector3, displacement: THREE.Vector3, velocity: THREE.Vector3) => void) {
    this.rotationAxis.set(-rate(input.pitch, MAX_PITCH_RATE), -rate(input.yaw, MAX_YAW_RATE),
      -rate(input.roll, MAX_ROLL_RATE));
    const angularSpeed = this.rotationAxis.length();
    if (angularSpeed > 0) {
      this.rotationAxis.divideScalar(angularSpeed);
      this.rotationDelta.setFromAxisAngle(this.rotationAxis, angularSpeed * dt);
      this.attitude.multiply(this.rotationDelta).normalize();
    }

    const throttle = THREE.MathUtils.clamp(input.throttle, 0, 1);
    const thrust = GRAVITY * (throttle / HOVER_THROTTLE) ** 1.35;
    this.acceleration.set(0, thrust, 0).applyQuaternion(this.attitude);
    this.acceleration.y -= GRAVITY;
    // Drag grows with airspeed and keeps the top speed finite.
    const drag = 0.12 + 0.009 * this.velocity.length();
    this.velocity.multiplyScalar(Math.exp(-drag * dt)).addScaledVector(this.acceleration, dt);
    this.displacement.copy(this.velocity).multiplyScalar(dt);
    move(this.position, this.displacement, this.velocity);
  }

  bounce(axis: number, firstHit: boolean) {
    const normal = this.impactNormal.set(0, 0, 0).setComponent(Math.abs(axis) - 1, Math.sign(axis));
    const approach = Math.max(0, -this.velocity.dot(normal));
    if (firstHit) {
      // An off-centre hit spins the craft even on a straight drop.
      this.tumble.crossVectors(normal, this.velocity).multiplyScalar(0.24)
        .addScaledVector(this.rotationAxis.set(0.68, 0.2, -0.46).applyQuaternion(this.attitude), approach * 0.45)
        .clampLength(0.75, 12);
    }
    const restitution = firstHit ? 0.32 : 0.16;
    this.velocity.multiplyScalar(0.48).addScaledVector(normal, approach * (0.48 + restitution));
  }

  stepImpact(elapsed: number, dt: number,
    move: (position: THREE.Vector3, displacement: THREE.Vector3, velocity: THREE.Vector3) => void) {
    const spin = this.tumble.length();
    if (spin > 0) {
      this.rotationAxis.copy(this.tumble).divideScalar(spin);
      this.rotationDelta.setFromAxisAngle(this.rotationAxis, spin * Math.exp(-4 * elapsed) * dt);
      this.attitude.premultiply(this.rotationDelta).normalize();
    }
    this.velocity.multiplyScalar(Math.exp(-2.8 * dt));
    this.velocity.y -= GRAVITY * dt;
    this.displacement.copy(this.velocity).multiplyScalar(dt);
    move(this.position, this.displacement, this.velocity);
  }
}
