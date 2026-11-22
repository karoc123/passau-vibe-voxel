import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Person } from '../sim/types';
import { clamp } from '../util';
import type { World } from '../world';
import type { Glide } from './glide';
import type { MoveKeys } from './move-keys';
import type { Ride } from './nav';
import { Pedestrian } from './pedestrian';
import { backOff, EYE } from './spots';
import { STEP, walkStep } from './walk';

const GRAV = 16, WALK_FOV = 65;

/** the left touch stick on foot: [forward, right] in -1..1 */
export type Stick = [number, number] | null;

// On foot (nav.ts modes walk and pedestrian, and walking as the person followed): where the feet are, the steps
// (walk.ts, up kerbs and stairs, sliding along walls), gravity and jumps, click-to-walk with its ring, and the camera:
// first person (walk) or the walker's figure and chase camera (pedestrian.ts). Nav says which and feeds the input.
export class Foot {
  yaw = 0;
  pitch = 0;
  feet = 0;
  vy = 0;
  /** at the eyes (EYE over the feet) */
  readonly pos = new THREE.Vector3();
  /** click-to-walk's goal; the ring shows it (and, hovering, where a click would walk) */
  goal: { x: number; z: number; stuck: number } | null = null;
  readonly marker: THREE.Mesh;
  /** the walker's figure and its chase camera (third person), made when first walked */
  pedestrian: Pedestrian | null = null;
  private jumpBuffer = 0;
  private groundGrace = 0;

  constructor(scene: THREE.Scene, private readonly actors: THREE.Group, private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls, private readonly keys: MoveKeys, private readonly glide: Glide,
    private readonly world: () => World | null) {
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.62, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    scene.add(this.marker);
  }

  /** Space: third person, a jump asked for a moment (taken once on the ground); first person, at once if standing */
  jump(third: boolean) {
    if (third) this.jumpBuffer = 0.14;
    else if (this.vy === 0) this.vy = 5.2;
  }

  look(dyaw: number, dpitch: number, third: boolean) {
    if (third) this.pedestrian?.look(dyaw, dpitch);
    else { this.yaw += dyaw; this.pitch = clamp(this.pitch + dpitch, -1.4, 1.45); }
  }

  /** the third-person walker on, facing the way the walk faced */
  startPedestrian() {
    this.pedestrian ??= new Pedestrian(this.actors);
    this.pedestrian.start(this.yaw);
    this.jumpBuffer = this.groundGrace = 0;
  }

  hide() { this.pedestrian?.hide(); }

  /** the goal reached or given up: no ring */
  stop() { this.goal = null; this.marker.visible = false; }

  // down at t (exact: there; else the street spot, backed off a wall), facing f, the nose up by pitch
  setAt(w: World, t: THREE.Vector3, spot: [number, number], exact: boolean | undefined, f: THREE.Vector3, pitch: number) {
    this.yaw = Math.atan2(f.x, f.z);
    this.pitch = pitch;
    this.vy = 0;
    if (exact) {
      this.pos.set(t.x, 0, t.z);
      this.feet = w.support(t.x, t.z, t.y + 1.5);
    } else {
      this.feet = w.groundAt(spot[0], spot[1]);
      const b = backOff(w, this.pos.set(spot[0] + 0.5, 0, spot[1] + 0.5), this.feet, f);
      this.pos.set(b.x, 0, b.z);
      this.feet = b.feet;
    }
    this.pos.y = this.feet + EYE;
    this.stop();
  }

  // one collision-checked horizontal step, sliding along walls; true if it moved
  private stepBy(m: THREE.Vector3, third: boolean) {
    return walkStep(this.world()!, this.pos, this.feet, m, third);
  }

  // on whatever is underfoot: up kerbs and stairs, off ledges, jumps
  private stand(dt: number) {
    const P = this.pos, sup = this.world()!.support(P.x, P.z, this.feet + STEP);
    if (this.vy !== 0 || this.feet > sup + 0.01) {
      this.vy -= GRAV * dt;
      this.feet += this.vy * dt;
      if (this.feet <= sup) { this.feet = sup; this.vy = 0; }
    } else this.feet = sup > this.feet ? Math.min(sup, this.feet + 6 * dt) : sup;
    P.y = this.feet + EYE;
  }

  // first person: A/D/Q/E look, W/S walk (Shift runs), else the stick, else to the goal
  updateWalk(dt: number, stick: Stick) {
    const K = this.keys, tr = K.axis('tr', 'tl'), tp = K.axis('tu', 'td'), go = K.axis('f', 'b');
    if (tr || tp) this.look(-tr * (K.shift ? 2.6 : 1.8) * dt, tp * dt, false);
    if (go) this.stepBy(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(go * (K.shift ? 20 : 6) * dt), false);
    else if (stick) {
      const [f, r] = stick, sx = Math.sin(this.yaw), sz = Math.cos(this.yaw);
      this.stepBy(new THREE.Vector3(sx * f - sz * r, 0, sz * f + sx * r).multiplyScalar(6 * dt), false);
    } else if (this.goal) this.walkToGoal(dt, false);
    this.stand(dt);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw + Math.PI, 0, 'YXZ'));
    this.glide.place(this.pos, q, WALK_FOV, false, dt);
    const look = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.controls.target.copy(this.camera.position).addScaledVector(look, 10);
  }

  // third person: W/S/A/D walk relative to the camera (Shift runs), Q/E tilt it, Space jumps; the walker's chase camera
  updatePedestrian(dt: number, stick: Stick) {
    const pedestrian = this.pedestrian!, world = this.world()!, p = this.pos, K = this.keys;
    const x = p.x, z = p.z, right = K.axis('tr', 'tl'), forward = K.axis('f', 'b');
    const pitch = K.axis('td', 'tu');
    if (pitch) pedestrian.look(0, pitch * dt);
    const grounded = this.vy === 0 && this.feet <= world.support(x, z, this.feet + STEP) + 0.04;
    this.groundGrace = grounded ? 0.1 : Math.max(0, this.groundGrace - dt);
    if (this.jumpBuffer > 0 && this.groundGrace > 0) {
      this.vy = 6.2;
      this.jumpBuffer = this.groundGrace = 0;
    } else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (right || forward) this.stepBy(pedestrian.move(forward, right, K.shift, dt), true);
    else if (stick) { // analog: up to a walk, pushed to the rim a run
      const push = Math.min(1, Math.hypot(...stick));
      this.stepBy(pedestrian.move(stick[0], stick[1], push > 0.92, dt).multiplyScalar(push > 0.92 ? 1 : Math.max(0.35, push)), true);
    } else if (this.goal) this.walkToGoal(dt, true, 2.4);

    if (this.vy > 0) {
      const rise = this.vy * dt + 0.08;
      if (world.raycast({ x: p.x, y: this.feet + 1.75, z: p.z }, { x: 0, y: 1, z: 0 }, rise) < rise) this.vy = 0;
    }
    this.stand(dt);
    const view = pedestrian.frame(p.x, this.feet, p.z, p.x - x, p.z - z, this.vy !== 0, dt, world);
    this.glide.place(view.position, view.rotation, view.fov, false, dt);
    this.controls.target.copy(view.target);
  }

  // click-to-walk: glide there, faster for far goals, around a post; give up when a wall stops us
  private walkToGoal(dt: number, third: boolean, maxSpeed = 22) {
    const G = this.goal!, P = this.pos, d = new THREE.Vector3(G.x - P.x, 0, G.z - P.z), L = d.length();
    if (L < 0.15) { this.stop(); return; }
    const step = d.multiplyScalar(Math.min(L, Math.min(L * 2.2, Math.min(maxSpeed, Math.max(4, L * 0.9))) * dt) / L), up = new THREE.Vector3(0, 1, 0);
    if ([0, 0.6, -0.6, 1.2, -1.2].some((a) => this.stepBy(step.clone().applyAxisAngle(up, a), third))) return;
    G.stuck += dt;
    if (G.stuck > 0.4) this.stop();
  }

  /** walking as the person followed starts where they stand */
  startAs(p: { x: number; y: number; z: number; h: number }) {
    this.pos.set(p.x, p.y + EYE, p.z);
    this.feet = p.y; this.vy = 0; this.yaw = p.h;
  }

  // walking as the person followed (o.ctl, theirs while the ride lasts): W/S walk, A/D turn them, Q/E look; the ride
  // camera at their eyes turns with them
  walkAs(R: Ride, o: Person, dt: number) {
    const C = o.ctl!, P = this.pos, K = this.keys, tp = K.axis('tu', 'td'), go = K.axis('f', 'b');
    this.yaw -= K.axis('tr', 'tl') * (K.shift ? 2.6 : 1.8) * dt;
    if (tp) R.dpitch = clamp(R.dpitch + tp * dt, -1.2, 1.2);
    this.yaw += R.dyaw;
    R.dyaw = 0;
    C.moving = !!go && this.stepBy(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(go * (K.shift ? 7 : 2.2) * dt), false);
    this.stand(dt);
    Object.assign(C, { x: P.x, y: this.feet, z: P.z, h: this.yaw });
  }
}
