import * as THREE from 'three';
import { ease } from '../util';
import { follow } from './chase-rig';

// Nav's camera on foot and on a ride (nav.ts, foot.ts): put where the mode wants it, gliding there from where it was
// over a transition when the mode starts (a landing, a ride's start). The crafts have their own (chase-rig.ts).
export class Glide {
  private from: { pos: THREE.Vector3; q: THREE.Quaternion; fov: number; t0: number; ms: number } | null = null;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /** a glide from where the camera is now over ms */
  start(ms: number) {
    const cam = this.camera;
    this.from = { pos: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, t0: performance.now(), ms };
  }

  stop() { this.from = null; }

  // the camera to (pos, q, fov), gliding there over the transition; settle: then ease back to fov (rate 6.3/s: a tenth
  // of the way a frame at 60 fps)
  place(pos: THREE.Vector3, q: THREE.Quaternion, fov: number, settle: boolean, dt: number) {
    const cam = this.camera, L = this.from;
    if (L) {
      const t = Math.min(1, (performance.now() - L.t0) / L.ms), e = ease(t);
      cam.position.lerpVectors(L.pos, pos, e);
      cam.quaternion.slerpQuaternions(L.q, q, e);
      cam.fov = L.fov + (fov - L.fov) * e;
      if (t >= 1) this.from = null;
    } else {
      cam.position.copy(pos);
      cam.quaternion.copy(q);
      if (settle && Math.abs(cam.fov - fov) > 0.01) cam.fov += (fov - cam.fov) * follow(6.3, dt);
    }
    cam.updateProjectionMatrix();
  }
}
