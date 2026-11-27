import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { clamp } from '../util';
import type { World } from '../core/world';
import type { Glide } from './glide';
import type { MoveKeys } from './move-keys';
import { backOff, EYE } from './spots';
import type { Solid } from '../sim/solids';
import { CLIMB_OUT, FLOAT, SWIM_DEPTH, Wet } from './swim';
import { footKeys, STEP, stride, walkFrame } from './walk';

// aiming (the right mouse button) narrows the view to AIM_FOV; let go, it widens back to the field of view before
const GRAV = 16, WALK_FOV = 65, AIM_FOV = 32;
// A body's free fall (off the paraglider): a skydiver's belly-down terminal speed, under the host's walk bound (80 m/s,
// sim/walk-bounds.ts) so a long fall is not clamped; the air takes the speed across at that rate
const TERMINAL = 55, AIR_DRAG = GRAV / TERMINAL;
/** m over what is under the feet from which a canopy may open again: higher than a jump goes */
export const CANOPY_DROP = 4;
// Afloat the water holds the body at FLOAT (a spring of BUOY per s², damped by DAMP per s) and brakes a fall into it
// as the square of its speed (DRAG per m): from a paraglider's 55 m/s it is down to a swimmer's in about 2 m, the eyes
// a little under, and back up in a second or two
const BUOY = 14, DAMP = 5, DRAG = 1.4;
// m/s afloat (no running in the water), and the most a wade slows to (waist deep) of the walk's
const SWIM = 1.8, WADE = 0.45;

/** the left touch stick on foot: [forward, right] in -1..1 */
export type Stick = [number, number] | null;

// On foot (nav.ts mode walk): where the feet are, the steps (walk.ts, up kerbs
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
  /** afloat in water too deep to stand in (others see the walker swim: the pose's swim) */
  swimming = false;
  /** the eyes under the water's top (the view tinted) */
  under = false;
  /** the voxels as the walk feels them, water in */
  readonly wet: Wet;
  // this frame's step up and the most ground climbed (out of the water: to CLIMB_OUT over it)
  private step = STEP;
  private top = Infinity;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly controls: OrbitControls,
    private readonly keys: MoveKeys, private readonly glide: Glide, private readonly world: () => World | null,
    private readonly solids: (near: { x: number; z: number }) => readonly Solid[]) {
    this.wet = new Wet(world);
  }

  /** Space: a jump, at once if standing (afloat there is nothing to push off) */
  jump() {
    if (this.vy === 0 && !this.swimming) this.vy = 5.2;
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
    return walkFrame(this.wet, this.pos, this.feet, m, this.solids(this.pos), this.step, this.top);
  }

  // in water (its top over the soles): a bank up to CLIMB_OUT over it climbed out onto, no higher; the pace's share
  // of the walk's (afloat: SWIM m/s whatever the walk's pace), and whether running is out
  private wade(pace: number) {
    const water = this.wet.surface(this.pos.x, this.pos.z), d = water === null ? 0 : water - this.feet;
    this.step = d > 0 ? Math.max(STEP, d + CLIMB_OUT) : STEP;
    this.top = d > 0 ? water! + CLIMB_OUT : Infinity;
    if (this.swimming) return SWIM;
    return d > 0 ? pace * (1 - (1 - WADE) * Math.min(1, d / SWIM_DEPTH)) : pace;
  }

  // on whatever is underfoot: up kerbs and stairs (and out of the water), off ledges, jumps; afloat in deep water
  private stand(dt: number) {
    const P = this.pos, sup = this.wet.support(P.x, P.z, this.feet + this.step), top = this.wet.surface(P.x, P.z);
    const water = top !== null && top > sup ? top : null, was = this.swimming;
    this.swimming = water !== null && water - sup > SWIM_DEPTH && this.feet < water;
    // (out of the deep water the float's bob is no jump: up a bank it climbs)
    if (was && !this.swimming) this.vy = Math.min(this.vy, 0);
    if (this.swimming) {
      // (no landing in the water, never under its bed)
      this.vy /= 1 + (DAMP + DRAG * Math.abs(this.vy)) * dt;
      this.vy += BUOY * (water! - FLOAT - this.feet) * dt;
      this.feet += this.vy * dt;
      if (this.feet <= sup) { this.feet = sup; this.vy = Math.max(0, this.vy); }
    } else if (this.feet < sup - 0.01 && this.vy <= 0.5) {
      this.vy = 0;
      this.feet = Math.min(sup, this.feet + 6 * dt);
    } else if (this.vy !== 0 || this.feet > sup + 0.01) {
      this.vy = Math.max(this.vy - GRAV * dt, -TERMINAL);
      this.feet += this.vy * dt;
      // a hard landing is only a landing: there is no health to take
      if (this.feet <= sup) { this.feet = sup; this.vy = 0; this.carry.x = this.carry.z = 0; }
    } else this.feet = sup;
    P.y = this.feet + EYE;
    this.under = water !== null && P.y < water;
  }

  // the speed across carried through the air, slowing; a wall or a solid thing stops it
  private drift(dt: number) {
    const C = this.carry;
    if (!C.x && !C.z) return;
    // (the water stops it within a metre or two)
    const k = Math.exp(-(this.swimming ? 3 : AIR_DRAG) * dt);
    C.x *= k; C.z *= k;
    if (!this.stepBy({ x: C.x * dt, z: C.z * dt }) || Math.hypot(C.x, C.z) < 0.05) C.x = C.z = 0;
  }

  // the arrows turn, Q/E look, W/S walk, A/D step sideways (Shift runs), else the stick
  updateWalk(dt: number, stick: Stick) {
    const K = this.keys, { go, side, turn } = footKeys(K), tp = K.axis('tu', 'td');
    if (turn || tp) this.look(-turn * (K.shift ? 2.6 : 1.8) * dt, tp * dt);
    const pace = this.wade(K.shift ? 20 : 6) * dt;
    if (go || side) this.stepBy(stride(this.yaw, go, side, pace));
    else if (stick) {
      const [f, r] = stick;
      this.stepBy({ x: (Math.sin(this.yaw) * f - Math.cos(this.yaw) * r) * pace, z: (Math.cos(this.yaw) * f + Math.sin(this.yaw) * r) * pace });
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
}
