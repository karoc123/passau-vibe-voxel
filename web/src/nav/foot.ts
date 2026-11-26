import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { WalkPose } from '../sim/contract/pose';
import { clamp } from '../util';
import type { World } from '../core/world';
import type { Glide } from './glide';
import type { MoveKeys } from './move-keys';
import type { Ride } from './nav';
import { backOff, EYE } from './spots';
import type { Solid } from '../sim/solids';
import { footKeys, STEP, stride, walkFrame } from './walk';

// aiming (the right mouse button) narrows the view to AIM_FOV; let go, it widens back to the field of view before
const GRAV = 16, WALK_FOV = 65, AIM_FOV = 32;
// A body's free fall (off the paraglider): a skydiver's belly-down terminal speed, under the host's walk bound (80 m/s,
// sim/walk-bounds.ts) so a long fall is not clamped; the air takes the speed across at that rate
const TERMINAL = 55, AIR_DRAG = GRAV / TERMINAL;
/** m over what is under the feet from which a canopy may open again: higher than a jump goes */
export const CANOPY_DROP = 4;

/** the left touch stick on foot: [forward, right] in -1..1 */
export type Stick = [number, number] | null;

// On foot (nav.ts mode walk, and walking as the person followed): where the feet are, the steps (walk.ts, up kerbs
// and stairs, sliding along walls and round the solid things near: solids), gravity and jumps, and the camera at the
// eyes. Nav feeds the input.
export class Foot {
  yaw = 0;
  pitch = 0;
  feet = 0;
  vy = 0;
  /** m/s across, carried through the air (a fall from a craft); gone on landing or a wall */
  readonly carry = { x: 0, z: 0 };
  /** the right mouse button held: the view narrowed */
  aim = false;
  private fovBack: number | null = null;
  /** at the eyes (EYE over the feet) */
  readonly pos = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly controls: OrbitControls,
    private readonly keys: MoveKeys, private readonly glide: Glide, private readonly world: () => World | null,
    private readonly solids: (near: { x: number; z: number }) => readonly Solid[]) {}

  /** Space: a jump, at once if standing */
  jump() {
    if (this.vy === 0) this.vy = 5.2;
  }

  look(dyaw: number, dpitch: number) {
    this.yaw += dyaw;
    this.pitch = clamp(this.pitch + dpitch, -1.4, 1.45);
  }

  // down at t (exact: there; else the street spot, backed off a wall), facing f, the nose up by pitch
  setAt(w: World, t: THREE.Vector3, spot: [number, number], exact: boolean | undefined, f: THREE.Vector3, pitch: number) {
    this.yaw = Math.atan2(f.x, f.z);
    this.pitch = pitch;
    this.vy = 0;
    this.carry.x = this.carry.z = 0;
    this.aim = false;
    this.fovBack = null;
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
  }

  /** falling from the feet at (x, y, z) with velocity v, facing yaw (out of a craft in the air) */
  fallAt(at: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }, yaw: number) {
    this.pos.set(at.x, at.y + EYE, at.z);
    this.feet = at.y;
    this.vy = Math.max(v.y, -TERMINAL);
    this.carry.x = v.x; this.carry.z = v.z;
    this.yaw = yaw;
    this.pitch = -0.3;
    this.aim = false;
    this.fovBack = null;
  }

  /** in the air high enough over what is under the feet for a canopy (CANOPY_DROP) */
  get canOpen() {
    const w = this.world();
    return !!w && this.feet - w.support(this.pos.x, this.pos.z, this.feet) >= CANOPY_DROP;
  }

  // pushed out of what moved into the walker, then one collision-checked horizontal step (none: null), sliding along
  // walls and cars; true if it stepped
  private stepBy(m: { x: number; z: number } | null) {
    return walkFrame(this.world()!, this.pos, this.feet, m, this.solids(this.pos));
  }

  // on whatever is underfoot: up kerbs and stairs, off ledges, jumps
  private stand(dt: number) {
    const P = this.pos, sup = this.world()!.support(P.x, P.z, this.feet + STEP);
    if (this.vy !== 0 || this.feet > sup + 0.01) {
      this.vy = Math.max(this.vy - GRAV * dt, -TERMINAL);
      this.feet += this.vy * dt;
      // a hard landing is only a landing: there is no health to take
      if (this.feet <= sup) { this.feet = sup; this.vy = 0; this.carry.x = this.carry.z = 0; }
    } else this.feet = sup > this.feet ? Math.min(sup, this.feet + 6 * dt) : sup;
    P.y = this.feet + EYE;
  }

  // the speed across carried through the air, slowing; a wall or a solid thing stops it
  private drift(dt: number) {
    const C = this.carry;
    if (!C.x && !C.z) return;
    const k = Math.exp(-AIR_DRAG * dt);
    C.x *= k; C.z *= k;
    if (!this.stepBy({ x: C.x * dt, z: C.z * dt }) || Math.hypot(C.x, C.z) < 0.05) C.x = C.z = 0;
  }

  // the arrows turn, Q/E look, W/S walk, A/D step sideways (Shift runs), else the stick
  updateWalk(dt: number, stick: Stick) {
    const K = this.keys, { go, side, turn } = footKeys(K), tp = K.axis('tu', 'td');
    if (turn || tp) this.look(-turn * (K.shift ? 2.6 : 1.8) * dt, tp * dt);
    if (go || side) this.stepBy(stride(this.yaw, go, side, (K.shift ? 20 : 6) * dt));
    else if (stick) {
      const [f, r] = stick;
      this.stepBy({ x: (Math.sin(this.yaw) * f - Math.cos(this.yaw) * r) * 6 * dt, z: (Math.cos(this.yaw) * f + Math.sin(this.yaw) * r) * 6 * dt });
    } else this.stepBy(null);
    this.drift(dt);
    this.stand(dt);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw + Math.PI, 0, 'YXZ'));
    let fov = WALK_FOV, settle = false;
    if (this.aim) { this.fovBack ??= this.camera.fov; fov = AIM_FOV; settle = true; }
    else if (this.fovBack !== null) {
      fov = this.fovBack; settle = true;
      if (Math.abs(this.camera.fov - fov) < 0.05) this.fovBack = null;
    }
    this.glide.place(this.pos, q, fov, settle, dt);
    const look = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.controls.target.copy(this.camera.position).addScaledVector(look, 10);
  }

  /** walking as the person followed starts where they stand */
  startAs(p: { x: number; y: number; z: number; h: number }) {
    this.pos.set(p.x, p.y + EYE, p.z);
    this.feet = p.y; this.vy = 0; this.yaw = p.h;
    this.carry.x = this.carry.z = 0;
  }

  /** the walk put back where the sim took it (a pose it clamped: sim/walk-bounds.ts) */
  correct(p: { x: number; y: number; z: number }) {
    this.pos.set(p.x, p.y + EYE, p.z);
    this.feet = p.y;
  }

  // walking as the person followed (the walk is the client's; where it puts them goes to the sim: ride.ts): W/S walk,
  // A/D step sideways, the arrows turn them, Q/E look; the ride camera at their eyes turns with them
  walkAs(R: Ride, dt: number): WalkPose {
    const P = this.pos, K = this.keys, tp = K.axis('tu', 'td'), { go, side, turn } = footKeys(K);
    this.yaw -= turn * (K.shift ? 2.6 : 1.8) * dt;
    if (tp) R.dpitch = clamp(R.dpitch + tp * dt, -1.2, 1.2);
    this.yaw += R.dyaw;
    R.dyaw = 0;
    const moving = this.stepBy(go || side ? stride(this.yaw, go, side, (K.shift ? 7 : 2.2) * dt) : null);
    this.stand(dt);
    return { x: P.x, y: this.feet, z: P.z, h: this.yaw, moving };
  }
}
