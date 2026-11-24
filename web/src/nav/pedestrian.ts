import * as THREE from 'three';
import { clamp, wrapAngle } from '../util';
import type { World } from '../core/world';

const WALK_SPEED = 2.4;
const RUN_SPEED = 5.7;
const UP = new THREE.Vector3(0, 1, 0);
const FOV = 57;

function part(parent: THREE.Object3D, material: THREE.Material, size: [number, number, number], x: number, y: number, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
}

function joint(parent: THREE.Object3D, x: number, y: number) {
  const group = new THREE.Group();
  group.position.set(x, y, 0);
  parent.add(group);
  return group;
}

/** The walking controller supplies a foot position; this rig adds the character and its chase camera. */
export class Pedestrian {
  private readonly avatar = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly arms: THREE.Group[] = [];
  private readonly legs: THREE.Group[] = [];
  private readonly knees: THREE.Group[] = [];
  private readonly motion = new THREE.Vector3();
  private readonly pivot = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly ray = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private readonly rotation = new THREE.Quaternion();
  private yaw = 0;
  private pitch = 0.24;
  private heading = 0;
  private distance = 4.5;
  private boom = 4.5;
  private cycle = 0;
  private gait = 0;

  get facing() { return this.heading; }

  constructor(scene: THREE.Object3D) {
    const material = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    const jacket = material(0x984837), collar = material(0x723a2f), trousers = material(0x343a49);
    const shoes = material(0x302923), skin = material(0xd8a07c), hair = material(0x4b3328);
    this.avatar.name = 'pedestrian-avatar';
    this.avatar.visible = false;
    this.avatar.add(this.torso);
    part(this.torso, jacket, [0.42, 0.46, 0.26], 0, 1.13);
    part(this.torso, collar, [0.31, 0.09, 0.28], 0, 1.34);
    part(this.torso, skin, [0.15, 0.12, 0.15], 0, 1.41);
    part(this.torso, skin, [0.27, 0.28, 0.25], 0, 1.58);
    part(this.torso, hair, [0.28, 0.09, 0.26], 0, 1.69);
    part(this.torso, hair, [0.27, 0.16, 0.06], 0, 1.60, -0.106);
    for (const side of [-1, 1]) {
      const leg = joint(this.avatar, side * 0.112, 0.90);
      this.legs.push(leg);
      part(leg, trousers, [0.19, 0.44, 0.20], 0, -0.21);
      const knee = joint(leg, 0, -0.43);
      this.knees.push(knee);
      part(knee, trousers, [0.17, 0.37, 0.18], 0, -0.17);
      part(knee, shoes, [0.18, 0.10, 0.26], 0, -0.42, 0.04);
      const arm = joint(this.torso, side * 0.259, 1.30);
      this.arms.push(arm);
      part(arm, jacket, [0.14, 0.43, 0.174], 0, -0.19);
      part(arm, skin, [0.13, 0.13, 0.145], 0, -0.45);
    }
    scene.add(this.avatar);
  }

  start(yaw: number) {
    this.yaw = this.heading = yaw;
    this.pitch = 0.24;
    this.boom = this.distance = 4.5;
    this.cycle = this.gait = 0;
  }

  hide() { this.avatar.visible = false; }

  look(dx: number, dy: number) {
    this.yaw = wrapAngle(this.yaw - dx);
    this.pitch = clamp(this.pitch + dy, -0.17, 1.10);
  }

  zoom(delta: number) {
    this.distance = clamp(this.distance * Math.exp(delta), 2.4, 7.5);
  }

  move(forward: number, right: number, running: boolean, dt: number) {
    const sx = Math.sin(this.yaw), sz = Math.cos(this.yaw);
    return this.motion.set(sx * forward - sz * right, 0, sz * forward + sx * right)
      .normalize().multiplyScalar((running ? RUN_SPEED : WALK_SPEED) * dt);
  }

  frame(x: number, feet: number, z: number, dx: number, dz: number, airborne: boolean, dt: number, world: World) {
    const traveled = Math.hypot(dx, dz);
    if (traveled > 1e-5) {
      const desired = Math.atan2(dx, dz);
      this.heading += wrapAngle(desired - this.heading) * (1 - Math.exp(-18 * dt));
    }
    const speed = traveled / Math.max(dt, 0.001), run = clamp((speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED), 0, 1);
    this.gait += ((airborne ? 0 : clamp(speed / WALK_SPEED, 0, 1)) - this.gait) * (1 - Math.exp(-13 * dt));
    this.cycle = wrapAngle(this.cycle + traveled * Math.PI * 2 / (1.12 + run * 0.58));
    const stride = Math.sin(this.cycle), swing = stride * this.gait * (0.42 + 0.35 * run);
    this.avatar.position.set(x, feet + Math.abs(stride) * this.gait * (0.025 + run * 0.045), z);
    this.avatar.rotation.y = this.heading;
    this.torso.rotation.x = run * this.gait * 0.13;
    for (let i = 0; i < 2; i++) {
      const leg = i === 0 ? swing : -swing;
      this.legs[i].rotation.x = airborne ? -0.28 + i * 0.35 : leg;
      this.knees[i].rotation.x = airborne ? 0.42 : Math.max(0, leg) * 0.65;
      this.arms[i].rotation.x = airborne ? -0.38 : -leg * 0.82;
    }

    const sx = Math.sin(this.yaw), sz = Math.cos(this.yaw), horizontal = Math.cos(this.pitch);
    this.pivot.set(x, feet + 1.25, z);
    this.direction.set(-sx * horizontal, Math.sin(this.pitch), -sz * horizontal);
    let free = this.distance;
    for (const offset of [0, -0.24, 0.24]) {
      this.ray.copy(this.pivot).addScaledVector(this.motion.set(sz, 0, -sx), offset);
      free = Math.min(free, world.raycast(this.ray, this.direction, this.distance));
    }
    const room = Math.max(0.22, free < this.distance ? free - 0.32 : free);
    this.boom = Math.min(room, this.boom + (room - this.boom) * (1 - Math.exp(-dt * 7)));
    this.position.copy(this.pivot).addScaledVector(this.direction, this.boom);
    this.target.copy(this.pivot).addScaledVector(this.motion.set(sx, 0, sz), 0.9);
    this.rotation.setFromRotationMatrix(this.matrix.lookAt(this.position, this.target, UP));
    this.avatar.visible = this.boom > 0.9;
    return { position: this.position, target: this.target, rotation: this.rotation, fov: FOV };
  }
}
