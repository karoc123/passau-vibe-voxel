import * as THREE from 'three';
import type { Sweep } from '../sim/craft/sweep';

// The chase camera's shared parts: smoothing that is the same at any frame rate,
// the pull-in where the collision meets something between the craft and the camera, the shake, and the glide in from
// where the map camera was. Each craft says where its camera wants to be (behind and over it, its own distances and
// lags); ChaseRig puts the camera there. The field of view is put back by Nav on leaving (its orbitFov).

/** the share of the way to a target covered in dt by a follower of rate k (/s): 1 - exp(-k dt), at any frame rate */
export const follow = (k: number, dt: number) => 1 - Math.exp(-k * dt);

/** angle a moved towards b by follow(k, dt), the short way round */
export const followAngle = (a: number, b: number, k: number, dt: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * follow(k, dt);

/** how much of the boom `off` (from the craft to the camera) is clear: 1, or pulled in to `margin` m before what the
 *  sweep hit, never under `min` of it (a tile not loaded: the whole boom) */
export function clearShare(hit: Sweep, off: THREE.Vector3, min: number, margin: number) {
  return hit === 'loading' || !hit.hit ? 1 : Math.max(min, hit.fraction - margin / off.length());
}

/** a shake of amplitude a (m) at time now (ms) added to p: the same wobble for a bump, a crash and a splash */
export function shake(p: THREE.Vector3, a: number, now: number) {
  p.x += Math.sin(now * 0.071) * a;
  p.y += Math.sin(now * 0.093 + 1) * a;
  p.z += Math.sin(now * 0.057 + 2) * a;
  return p;
}

export class ChaseRig {
  private intro: { pos: THREE.Vector3; q: THREE.Quaternion; fov: number; t0: number; ms: number } | null = null;
  private fov: number | null = null;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /** a craft starts: the camera glides from where it is now to the chase pose over ms */
  begin(ms: number) {
    const cam = this.camera;
    this.intro = { pos: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, t0: performance.now(), ms };
    this.fov = null;
  }

  /** the craft is left: the camera's up back to +y (Nav puts the map's field of view back) */
  end() {
    this.intro = null;
    this.camera.up.set(0, 1, 0);
  }

  /** the orientation looking from pos at `at` with `up` */
  look(pos: THREE.Vector3, at: THREE.Vector3, up: THREE.Vector3 = THREE.Object3D.DEFAULT_UP) {
    return this.q.setFromRotationMatrix(this.m.lookAt(pos, at, up));
  }

  /** the camera to pos and q; its field of view follows fov (rate 2/s); over the glide in, blended from the start.
   *  The camera returned */
  place(pos: THREE.Vector3, q: THREE.Quaternion, fov: number, dt: number) {
    const cam = this.camera, I = this.intro;
    this.fov = this.fov === null ? fov : this.fov + (fov - this.fov) * follow(2, dt);
    let f = this.fov;
    if (I) {
      const t = Math.min(1, (performance.now() - I.t0) / I.ms), e = t * t * (3 - 2 * t);
      cam.position.lerpVectors(I.pos, pos, e);
      cam.quaternion.slerpQuaternions(I.q, q, e);
      f = I.fov + (f - I.fov) * e;
      if (t >= 1) this.intro = null;
    } else {
      cam.position.copy(pos);
      cam.quaternion.copy(q);
    }
    if (Math.abs(cam.fov - f) > 0.01) { cam.fov = f; cam.updateProjectionMatrix(); }
    return cam;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
// rad per px of the mouse (a passenger's drag's); ms let be before the boom swings back, at /s
const PER_PX = 0.005, HOLD_MS = 1500, BACK_RATE = 1.5;

/** The chase boom swung by the mouse taken, as a passenger's drag swings theirs: round the craft and over it. Let be
 *  a moment, it swings back behind (the pilot steers by the view behind). */
export class MouseLook {
  private yaw = 0;
  private pitch = 0;
  private at = 0;

  /** the mouse moved by dx, dy px (right, down +) */
  move(dx: number, dy: number) {
    this.yaw -= dx * PER_PX;
    this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - dy * PER_PX * 0.8));
    this.at = performance.now();
  }

  reset() { this.yaw = this.pitch = 0; }

  /** off (the boom, from the craft to the camera) swung for this frame of dt s */
  swing(off: THREE.Vector3, dt: number) {
    if (performance.now() - this.at > HOLD_MS) { const k = follow(BACK_RATE, dt); this.yaw -= this.yaw * k; this.pitch -= this.pitch * k; }
    if (Math.abs(this.yaw) < 1e-4 && Math.abs(this.pitch) < 1e-4) return off;
    const L = off.length();
    return off.applyAxisAngle(UP, this.yaw).setY(off.y - Math.sin(this.pitch) * L);
  }
}
