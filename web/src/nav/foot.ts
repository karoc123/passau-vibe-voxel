import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { clamp } from '../util';
import type { World } from '../core/world';
import type { Glide } from './glide';
import type { MoveKeys } from './move-keys';
import { EYE } from '../sim/figure';
import { backOff } from './spots';
import type { Solid } from '../sim/solids';
import { stride } from '../sim/walk';
import { Walker } from '../sim/walker';

// aiming (the right mouse button) narrows the view to AIM_FOV; let go, it widens back to the field of view before
const WALK_FOV = 65, AIM_FOV = 32;

/** the keys on foot: W/S forward and back, A/D a step sideways (right +1), the arrows left and right turn (the mouse
 * turns too, but a keyboard alone still can) */
export const footKeys = (K: MoveKeys) => ({ go: K.axis('f', 'b'), side: K.axis('sr', 'sl'), turn: K.axis('tr', 'tl') });

/** the left touch stick on foot: [forward, right] in -1..1 */
export type Stick = [number, number] | null;

// On foot (nav.ts mode walk): the player's walker (its body the host's NPCs have too) with the camera at the eyes,
// the keys and the stick turned into its stride, aiming. Nav feeds the input.
export class Foot extends Walker<THREE.Vector3> {
  pitch = 0;
  /** the right mouse button held: the view narrowed */
  aim = false;
  private fovBack: number | null = null;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly controls: OrbitControls,
    private readonly keys: MoveKeys, private readonly glide: Glide, world: () => World | null,
    private readonly solids: (near: { x: number; z: number }) => readonly Solid[]) {
    super(new THREE.Vector3(), world);
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
    this.on = null;
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
  override fallAt(at: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }, yaw: number) {
    super.fallAt(at, v, yaw);
    this.pitch = -0.3;
    this.aim = false;
    this.fovBack = null;
  }

  // the arrows turn, Q/E look, W/S walk, A/D step sideways (Shift runs), else the stick
  updateWalk(dt: number, stick: Stick) {
    const K = this.keys, { go, side, turn } = footKeys(K), tp = K.axis('tu', 'td');
    if (turn || tp) this.look(-turn * (K.shift ? 2.6 : 1.8) * dt, tp * dt);
    this.move(dt, this.solids(this.pos), K.shift ? 20 : 6, (yaw, pace) => {
      if (go || side) return stride(yaw, go, side, pace);
      if (!stick) return null;
      const [f, r] = stick;
      return { x: (Math.sin(yaw) * f - Math.cos(yaw) * r) * pace, z: (Math.cos(yaw) * f + Math.sin(yaw) * r) * pace };
    });
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
}
