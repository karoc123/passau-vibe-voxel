// Rapier spike: a drivable car on Rapier's DynamicRayCastVehicleController (raycast wheels on a box chassis).
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export interface CarInput { gas: number; brake: number; steer: number; handbrake: boolean }

const HALF = { x: 0.9, y: 0.45, z: 2.1 };
const MASS = 1200;
const WHEEL_R = 0.36;
const REST = 0.35;
const WHEELS = [
  { x: 0.82, z: 1.35, front: true }, { x: -0.82, z: 1.35, front: true },
  { x: 0.82, z: -1.3, front: false }, { x: -0.82, z: -1.3, front: false },
];
const ENGINE = 2600; // N per driven wheel (rear)
const BRAKE = 45;
const MAX_STEER = 0.55;
const TOP_SPEED = 22; // m/s (~80 km/h)

export class RapierCar {
  readonly body: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly mesh = new THREE.Group();
  readonly wheels: THREE.Mesh[] = [];
  private steer = 0;

  constructor(R: typeof RAPIER, world: RAPIER.World, at: { x: number; y: number; z: number }, heading: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(q)
      .setCanSleep(false).setCcdEnabled(true).setAngularDamping(0.4));
    // (the centre of mass low, under the floor: it rolls less)
    world.createCollider(R.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z).setMassProperties(MASS, { x: 0, y: -0.45, z: 0 },
      { x: MASS * (HALF.y ** 2 + HALF.z ** 2) / 3, y: MASS * (HALF.x ** 2 + HALF.z ** 2) / 3, z: MASS * (HALF.x ** 2 + HALF.y ** 2) / 3 }, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.3).setActiveEvents(R.ActiveEvents.COLLISION_EVENTS), this.body);
    const c = world.createVehicleController(this.body);
    c.indexUpAxis = 1;
    c.setIndexForwardAxis = 2;
    for (const w of WHEELS) {
      c.addWheel({ x: w.x, y: -0.2, z: w.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, REST, WHEEL_R);
      const i = c.numWheels() - 1;
      c.setWheelSuspensionStiffness(i, 28);
      c.setWheelSuspensionCompression(i, 2.6);
      c.setWheelSuspensionRelaxation(i, 3.2);
      c.setWheelMaxSuspensionTravel(i, 0.35);
      c.setWheelMaxSuspensionForce(i, 60000);
      c.setWheelFrictionSlip(i, w.front ? 1.6 : 1.5);
      c.setWheelSideFrictionStiffness(i, 1.0);
    }
    this.controller = c;

    const paint = new THREE.MeshStandardMaterial({ color: 0xc8302a, roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.2 });
    const tyre = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(HALF.x * 2, HALF.y * 2, HALF.z * 2), paint);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(HALF.x * 1.7, 0.55, HALF.z * 1.0), glass);
    cabin.position.set(0, HALF.y + 0.27, -0.2);
    this.mesh.add(box, cabin);
    for (const m of [box, cabin]) { m.castShadow = true; m.receiveShadow = true; }
    const wg = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.28, 16).rotateZ(Math.PI / 2);
    for (let i = 0; i < WHEELS.length; i++) {
      const wm = new THREE.Mesh(wg, tyre);
      wm.castShadow = true;
      this.wheels.push(wm);
      this.mesh.add(wm);
    }
  }

  // km/h along the chassis' forward axis
  get kmh() { return this.controller.currentVehicleSpeed() * 3.6; }

  step(input: CarInput, dt: number) {
    const c = this.controller, v = c.currentVehicleSpeed();
    // steering eased, less of it at speed
    const target = -input.steer * MAX_STEER / (1 + Math.abs(v) / 14);
    this.steer += (target - this.steer) * Math.min(1, dt * 8);
    let engine = 0, brake = 0;
    if (input.gas > 0) engine = v > -0.5 ? input.gas * ENGINE * (v < TOP_SPEED ? 1 : 0) : 0;
    if (input.brake > 0) {
      if (v > 0.8) brake = input.brake * BRAKE;
      else engine = -input.brake * ENGINE * 0.6 * (v > -8 ? 1 : 0); // reverse
    }
    if (input.gas > 0 && v < -0.5) brake = input.gas * BRAKE;
    if (!input.gas && !input.brake) brake = 1.2; // rolling resistance
    for (let i = 0; i < 4; i++) {
      const front = WHEELS[i].front;
      c.setWheelSteering(i, front ? this.steer : 0);
      c.setWheelEngineForce(i, front ? 0 : engine);
      c.setWheelBrake(i, input.handbrake && !front ? BRAKE * 2 : brake);
    }
    c.updateVehicle(dt);
  }

  // wheel meshes in chassis space, from the controller's state (render after the body's pose is set)
  syncWheels() {
    const c = this.controller;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], len = c.wheelSuspensionLength(i) ?? REST;
      const p = WHEELS[i];
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
    world.removeVehicleController(this.controller);
    world.removeRigidBody(this.body);
    this.mesh.removeFromParent();
  }
}
