import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { View } from '../core/meta';
import { clamp } from '../util';
import type { World } from '../core/world';
import type { MoveKeys } from './move-keys';
import type { WalkOpts } from './nav';

const TILT = Math.PI * 0.48;

/** a hit on the map under a point of the screen (nav.ts hitAt) */
export type ScreenHit = { p: THREE.Vector3; axis: number; dir: THREE.Vector3 } | null;

export interface OrbitHost {
  world(): World | null;
  hitAt(cx: number, cy: number): ScreenHit;
  flyTo(v: Pick<View, 'pos' | 'target'>): void;
  /** down to the street (nav.ts setWalk) */
  land(opts?: WalkOpts): void;
}

// The map's input (nav.ts mode orbit) beyond what OrbitControls does: the keys turn in place and fly along the view,
// a two-finger twist turns the map, a press pivots on what is under it, a double-click dives there, and zooming onto
// the street (or flying into it) lands you there.
export class OrbitInput {
  /** turning in place with the keys: the focus is off, put back on release (retarget) */
  turned = false;
  /** last zoomed or flown with the keys (ms): a landing follows only a zoom */
  zoomT = 0;
  private landT = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly controls: OrbitControls,
    private readonly keys: MoveKeys, private readonly host: OrbitHost) {
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.maxPolarAngle = TILT;
  }

  private dir() { return new THREE.Vector3().subVectors(this.controls.target, this.camera.position); }

  // rotating pivots on the axis of view at the depth of what is under the cursor, so nothing jumps
  pivotAt(cx: number, cy: number) {
    const hit = this.host.hitAt(cx, cy);
    if (!hit) return;
    const v = this.camera.getWorldDirection(new THREE.Vector3()), dd = hit.p.clone().sub(this.camera.position).dot(v);
    if (dd > 5 && dd < 2500) this.controls.target.copy(this.camera.position).addScaledVector(v, dd);
  }

  diveTo(cx: number, cy: number) {
    const world = this.host.world();
    if (!world) return;
    const hit = this.host.hitAt(cx, cy);
    if (!hit) return;
    const cam = this.camera.position, dist = cam.distanceTo(hit.p);
    const pos = hit.p.clone().addScaledVector(hit.dir, -Math.max(25, dist * 0.4));
    pos.y = Math.max(pos.y, world.groundAt(pos.x, pos.z) + 2);
    this.host.flyTo({ pos: pos.toArray(), target: hit.p.toArray() });
  }

  // the nose moves, the camera stays (A/D, Q/E). Above level too: OrbitControls' tilt limit follows the keys, so it
  // never swings the camera to get the focus back below it; clamp() restores it once you look down again.
  private turnInPlace(dyaw: number, dpitch: number) {
    const d = this.dir(), len = d.length() || 1;
    const yaw = Math.atan2(d.x, d.z) + dyaw, pitch = clamp(Math.asin(clamp(d.y / len, -1, 1)) + dpitch, -1.5, 1.2);
    this.controls.maxPolarAngle = Math.max(TILT, Math.PI / 2 + pitch + 0.02);
    const c = this.camera.position;
    this.controls.target.set(c.x + len * Math.sin(yaw) * Math.cos(pitch), c.y + len * Math.sin(pitch), c.z + len * Math.cos(yaw) * Math.cos(pitch));
  }

  orbitBy(dyaw: number) {
    const t = this.controls.target, off = this.camera.position.clone().sub(t), s = new THREE.Spherical().setFromVector3(off);
    s.theta += dyaw;
    s.phi = clamp(s.phi, 0.05, this.controls.maxPolarAngle);
    this.camera.position.copy(t).add(off.setFromSpherical(s));
  }

  // the focus goes onto what is in the middle of the screen (kept on the map), so turning pivots on it
  retarget() {
    const w = this.host.world();
    if (!w) return;
    const c = this.camera.position, d = this.dir().normalize(), t = w.raycast(c, d, 3000);
    let len = isFinite(t) ? Math.max(5, t) : Math.min(this.dir().length(), 800);
    const onMap = (L: number) => { const x = c.x + d.x * L, z = c.z + d.z * L; return w.inside(x - 61, z - 61) && w.inside(x + 61, z + 61); };
    while (len > 5 && !onMap(len)) len *= 0.85;
    this.controls.target.copy(c).addScaledVector(d, len);
  }

  // A/D/Q/E turn in place; W/S fly along the view, faster higher up; reaching the street lands you on it
  update(dt: number) {
    const K = this.keys, tr = K.axis('tr', 'tl'), tp = K.axis('tu', 'td');
    if (tr || tp) { this.turnInPlace(-tr * (K.shift ? 2.4 : 1.2) * dt, tp * 0.8 * dt); this.turned = true; }
    const go = K.axis('f', 'b'), w = this.host.world();
    if (!go || !w) return;
    const cam = this.camera.position, len0 = this.dir().length(), look = this.dir().normalize();
    const h = Math.max(3, cam.y - w.groundAt(cam.x, cam.z));
    let step = go * (K.shift ? 3 : 1) * Math.min(400, 8 + h * 0.9) * dt;
    const ahead = w.raycast(cam, look, 4000);
    if (go > 0 && ahead < 8) { this.host.land(); return; }
    if (go > 0) step = Math.min(step, ahead - 6);
    if (step * look.y > 0 && h + step * look.y > 3600) return;
    cam.addScaledVector(look, step);
    this.controls.target.copy(cam).addScaledVector(look, isFinite(ahead) ? Math.max(5, ahead - step) : len0);
    this.zoomT = performance.now();
  }

  // after OrbitControls: above the ground, the tilt limit back once you look down, and zoomed onto the street: land
  clamp() {
    const w = this.host.world();
    if (!w) return;
    if (this.controls.maxPolarAngle > TILT && !this.turned && this.controls.getPolarAngle() <= TILT) this.controls.maxPolarAngle = TILT;
    const p = this.camera.position, g = w.groundAt(p.x, p.z) + 1.2;
    if (p.y < g) { p.y = g; this.camera.lookAt(this.controls.target); }
    const t = this.controls.target, tg = w.groundAt(t.x, t.z);
    const close = p.y - g < 3 || (p.distanceTo(t) < this.controls.minDistance * 2.5 && t.y - tg < 3);
    const now = performance.now();
    if (close && now - this.zoomT < 700 && now - this.landT > 1500) {
      this.landT = now;
      const at = new THREE.Vector3(t.x, tg, t.z), f = this.dir().setY(0);
      if (!w.blocked(at.x, at.z, tg, tg + 2)) this.host.land({ at, exact: true, facing: f.lengthSq() > 1e-6 ? f : undefined, pitch: 0.1, ms: 500 });
    }
  }
}
