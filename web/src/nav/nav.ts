import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Picked, StreetLife } from '../sim/life';
import type { Person, Pose } from '../sim/types';
import type { TileStreamer } from '../stream';
import type { View } from '../types';
import { clamp, coarsePointer, ease } from '../util';
import type { World } from '../world';
import { rideCamera } from './ride';
import { follow } from './chase-rig';
import { gameKey, onFocusLoss } from './input';
import type { PlayerCraft } from './craft';
import { Pedestrian } from './pedestrian';
import { backOff, EYE, findStreet, openSpot, walkNet } from './spots';
import { stickAxis, TouchSticks } from './touch-sticks';
import { HEAD, STEP, walkStep } from './walk';

// Orbit, walk and ride share one set of keys (W/S forward and back, A/D turn, Q/E nose up and down, Shift faster;
// arrows alike) and one gesture language for mouse, trackpad and touch:
//   orbit: drag moves the map, right-drag turns and tilts, wheel zooms at the cursor, double-click flies there
//   walk:  drag looks, click walks there, wheel steps, Space jumps, Esc flies up
//   walk on touch: the left thumb is a stick that walks (up ahead, sideways steps; pushed far, runs), the right thumb
//          drags to look; a tap without a drag still walks there (touch-sticks.ts, as the drive mode's); two fingers
//          close together pinch to zoom
//   ride:  following a pedestrian or a car; move keys walk as that person, or get out of a vehicle
//   craft: a craft (craft.ts: the drone, the boat, the plane) owns the camera and the input; Nav leaves the keys, the
//          pointer and the wheel to it. The car driven is a craft too, but on the ride's camera (mode ride)
export type Mode = 'orbit' | 'walk' | 'ride' | 'pedestrian' | 'craft';
export interface Ride extends Picked {
  view: 'eyes' | 'behind';
  dyaw: number;
  dpitch: number;
  idle: number;
  /** how far out the camera is (wheel, pinch): behind, a factor on the chase distance; at the eyes, on the field of view */
  zoom: number;
}
interface WalkOpts { at?: THREE.Vector3; exact?: boolean; facing?: THREE.Vector3; pitch?: number; ms?: number; deckOK?: boolean; thirdPerson?: boolean }
interface Transition { from: THREE.Vector3; fromQ: THREE.Quaternion; fromFov: number; t0: number; ms: number }

type Action = 'f' | 'b' | 'tl' | 'tr' | 'tu' | 'td';
const KEYMAP: Record<string, Action> = {
  KeyW: 'f', KeyS: 'b', KeyA: 'tl', KeyD: 'tr', KeyQ: 'tu', KeyE: 'td',
  ArrowUp: 'f', ArrowDown: 'b', ArrowLeft: 'tl', ArrowRight: 'tr',
};
const GRAV = 16, TILT = Math.PI * 0.48, WALK_FOV = 65;
// On foot the camera stands a step from walls: the walk's side probes keep 0.4 m, the third-person boom 0.32 m (0.22
// at the least, pedestrian.ts), less in a doorway or a narrow aisle. The map camera's near plane (0.5 m, main.ts) cut
// into them there; on foot it comes in to WALK_NEAR -- its frustum's corners ~0.33 m out at the walk's field of view --
// and goes back on leaving. (The FPV drone takes 0.15 m alike, fpv.ts: the depth buffer's precision far off, ~d^2 /
// (near x 2^24), is then 2.5 x coarser than the map camera's, as the drone's has always been.)
const WALK_NEAR = 0.2;

export class Nav {
  mode: Mode = 'orbit';
  ride: Ride | null = null;
  /** the craft the player is in (craft.ts): in mode craft, or the car driven in mode ride */
  craft: PlayerCraft | null = null;
  // the driven car's camera: shaken by a crash, dipped by a splash (nav/drive.ts); its height followed smoothly
  readonly rideShake = new THREE.Vector3();
  private rideY: number | null = null;
  readonly actors = new THREE.Group();
  world: World | null = null;
  streamer: TileStreamer | null = null;
  // the map's corner in the project grid (meta.origin): ?cam= links are in the project grid's coordinates
  origin: [number, number] = [0, 0];
  cancelFly: () => void = () => {};
  private lifeRef: StreetLife | null = null;
  private net: ReturnType<typeof walkNet> | null = null;
  private readonly keys = new Set<Action>();
  private shift = false;
  private turned = false;
  private yaw = 0;
  private pitch = 0;
  private feet = 0;
  private vy = 0;
  private walkPos = new THREE.Vector3();
  private goal: { x: number; z: number; stuck: number } | null = null;
  private landing: Transition | null = null;
  private landmark: THREE.Vector3 | null = null;
  private skyView: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private orbitFov = 0;
  private possessed: Person | null = null; // the person walked by the player (their ctl set) while riding them
  private jumpAsked = false;
  private walkPending = false;
  private zoomT = 0;
  private landT = 0;
  private hoverT = 0;
  private cursor: { x: number; y: number } | null = null; // the mouse over the map, for Ctrl+C (copySpot)
  private quietT = 0;
  private wheelBack = 0;
  private wheelBackT = 0;
  private readonly marker: THREE.Mesh;
  private pedestrian: Pedestrian | null = null;
  private jumpBuffer = 0;
  private groundGrace = 0;
  private pedestrianStart: object | null = null;
  private mouseLook: { locked: boolean } | null = null;
  private mapNear: number | null = null; // the camera's near plane before it went on foot (fitNear)
  // touch on foot: left thumb walks, right thumb looks (the drag since the last move)
  private readonly footSticks: TouchSticks;
  private lookFrom = { dx: 0, dy: 0 };

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly controls: OrbitControls, private readonly dom: HTMLElement,
    scene: THREE.Scene, private readonly flyTo: (v: Pick<View, 'pos' | 'target'>) => void, private readonly onMode: (m: Mode, r: Ride | null) => void) {
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.maxPolarAngle = TILT;
    dom.style.cursor = 'grab';
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.62, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    scene.add(this.marker);
    this.bindKeys();
    this.bindPointer();
    this.footSticks = new TouchSticks(dom, {
      onStart: () => { this.lookFrom = { dx: 0, dy: 0 }; this.goal = null; this.marker.visible = false; this.cancelFly(); },
      onMove: (side, s) => {
        if (side !== 'right') return;
        const k = 2.4 * (this.camera.fov * Math.PI / 180) / innerHeight;
        this.look((s.dx - this.lookFrom.dx) * k, -(s.dy - this.lookFrom.dy) * k * 0.7);
        this.lookFrom = { dx: s.dx, dy: s.dy };
      },
      // a short touch that hardly moved: a tap (walk there, as with one finger elsewhere)
      onEnd: (_side, s) => {
        if (Math.hypot(s.dx, s.dy) < 8 && performance.now() - s.t < 600) this.tap(s.startX + s.dx, s.startY - s.dy);
      },
      // two fingers close together: the third-person camera's distance (the wheel's), in first person the field of view
      onPinch: (ratio) => {
        if (this.mode === 'pedestrian') this.pedestrian?.zoom(Math.log(ratio));
        else this.setFov(this.camera.fov * ratio);
      },
    });
  }

  /** the left touch stick while on foot: [forward, right] in -1..1, or null */
  private footStick(): [number, number] | null {
    const s = this.footSticks.left;
    if (!s) return null;
    const f = clamp(stickAxis(s.dy, s.radius), -1, 1), r = clamp(stickAxis(s.dx, s.radius), -1, 1);
    return f || r ? [f, r] : null;
  }

  /** Space on foot (the touch Jump button) */
  jump() {
    if (this.mode === 'pedestrian') this.jumpBuffer = 0.14;
    else if (this.mode === 'walk' && this.vy === 0) this.vy = 5.2;
  }


  get life() { return this.lifeRef; }
  set life(l: StreetLife | null) { this.lifeRef = l; this.net = null; }
  // turning in place with the keys: the focus is off on its own, put back on release
  get turning() { return this.turned; }

  // ------------------------------------------------------------------ input
  get enteringWalk() { return this.walkPending; }

  private get pedestrianActive() { return this.mode === 'pedestrian'; }
  private get onFoot() { return this.mode === 'walk' || this.mode === 'pedestrian'; }
  private get driving() { return this.craft !== null && this.mode === 'ride'; }
  /** a craft owns the camera and the input */
  get craftView() { return this.mode === 'craft'; }

  private axis(pos: Action, neg: Action) { return (this.keys.has(pos) ? 1 : 0) - (this.keys.has(neg) ? 1 : 0); }

  private bindKeys() {
    addEventListener('keydown', (e) => {
      if (!gameKey(e)) return;
      this.shift = e.shiftKey;
      if (e.code === 'Escape') {
        if (this.pedestrianStart) this.releasePedestrianMouse();
        if (this.mode !== 'orbit') this.flyUp();
        return;
      }
      if (this.craftView || this.driving) return;
      if (e.code === 'Space' && (this.onFoot || this.ride?.kind === 'person')) { // following someone: become them, then jump
        if (this.mode === 'pedestrian') {
          if (!e.repeat) this.jumpBuffer = 0.14;
        } else if (this.mode === 'walk') {
          if (this.vy === 0) this.vy = 5.2;
        } else this.jumpAsked = true;
        e.preventDefault(); return;
      }
      const k = KEYMAP[e.code];
      if (!k) return;
      this.keys.add(k);
      if (this.ride && this.ride.kind !== 'person') this.hopOff();
      this.goal = null;
      this.cancelFly();
      e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.shift = e.shiftKey;
      const k = KEYMAP[e.code];
      if (k) this.keys.delete(k);
      if (this.turned && ![...this.keys].some((a) => a[0] === 't')) { this.turned = false; this.retarget(); }
    });
    onFocusLoss(() => this.keys.clear());
  }

  private requestPedestrianMouse() {
    if (!this.dom.requestPointerLock || document.pointerLockElement) return;
    const request = { locked: false };
    this.mouseLook = request;
    const reject = () => { if (this.mouseLook === request) this.mouseLook = null; };
    try {
      // Browsers expose either a promise or the original event-only API.
      this.dom.requestPointerLock()?.catch(reject);
    } catch { reject(); }
  }

  private releasePedestrianMouse() {
    this.pedestrianStart = null;
    this.mouseLook = null;
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  private lookWithMouse(e: MouseEvent) {
    const scale = 0.0027;
    this.look(e.movementX * scale, e.movementY * scale * 0.8);
    this.marker.visible = false;
  }

  private bindPointer() {
    const dom = this.dom, ptrs = new Map<number, { x: number; y: number }>();
    let press: { x: number; y: number; t: number; button: number; moved: boolean } | null = null;
    let pinch0: { d: number; fov: number } | null = null, twist: number | null = null;
    const two = () => [...ptrs.values()];
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === dom) {
        if (this.mouseLook) this.mouseLook.locked = true;
        else document.exitPointerLock();
      } else if (this.mouseLook?.locked) {
        this.releasePedestrianMouse();
        if (this.pedestrianActive) this.flyUp();
      }
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.mouseLook && !this.mouseLook.locked) this.mouseLook = null;
    });
    dom.addEventListener('mousemove', e => {
      if (this.pedestrianActive && document.pointerLockElement === dom) this.lookWithMouse(e);
    });
    dom.addEventListener('pointerdown', (e) => {
      if (this.craftView || (this.pedestrianActive && document.pointerLockElement === dom)) return;
      if ((this.driving || this.onFoot) && e.pointerType === 'touch') return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.mode === 'orbit' && (e.button === 2 || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) || ptrs.size === 2)) this.pivotAt(e.clientX, e.clientY);
      if (ptrs.size === 2) { const [a, b] = two(); twist = Math.atan2(b.y - a.y, b.x - a.x); }
      press = ptrs.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, moved: false } : null;
      if (ptrs.size === 2 && this.mode !== 'orbit') { const [a, b] = two(); pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: this.camera.fov }; }
      if (this.mode !== 'orbit') dom.setPointerCapture(e.pointerId);
      else dom.style.cursor = 'grabbing';
      this.cancelFly();
    });
    dom.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.cursor = { x: e.clientX, y: e.clientY };
      if ((this.driving || this.onFoot) && e.pointerType === 'touch') return;
      const p = ptrs.get(e.pointerId);
      if (this.pedestrianActive && e.pointerType === 'mouse') {
        if (document.pointerLockElement !== dom) {
          this.lookWithMouse(e);
          if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
        }
        return;
      }
      if (!p) { this.hover(e.clientX, e.clientY, e.pointerType); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
      if (this.mode === 'orbit') {
        if (ptrs.size === 2 && twist !== null) { // two-finger twist turns the map
          this.zoomT = performance.now();
          const [a, b] = two(), ang = Math.atan2(b.y - a.y, b.x - a.x);
          this.orbitBy(Math.atan2(Math.sin(ang - twist), Math.cos(ang - twist)));
          twist = ang;
        }
        return;
      }
      if (ptrs.size === 2 && pinch0) {
        const [a, b] = two(), d = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
        if (this.mode === 'pedestrian' || this.mode === 'ride') {
          if (this.mode === 'ride') this.zoomRide(pinch0.d / d); else this.pedestrian?.zoom(Math.log(pinch0.d / d));
          pinch0.d = d;
        } else this.setFov(pinch0.fov * pinch0.d / d);
        return;
      }
      if (press && !press.moved) return;
      const k = (e.pointerType === 'touch' ? 2.4 : 1.2) * (this.camera.fov * Math.PI / 180) / innerHeight;
      this.look(dx * k, dy * k * 0.7);
      this.marker.visible = false;
    });
    const up = (e: PointerEvent) => {
      if (!ptrs.delete(e.pointerId)) return;
      if (ptrs.size < 2) { pinch0 = null; twist = null; }
      this.quietT = performance.now();
      if (this.mode === 'orbit') dom.style.cursor = 'grab';
      if (press && !press.moved && e.type === 'pointerup' && performance.now() - press.t < 600 && press.button === 0) this.tap(e.clientX, e.clientY);
      if (!ptrs.size) press = null;
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('pointerleave', () => { this.marker.visible = false; this.cursor = null; });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    dom.addEventListener('dblclick', (e) => this.diveTo(e.clientX, e.clientY));
  }

  // rotating pivots on the axis of view at the depth of what is under the cursor, so nothing jumps
  private pivotAt(cx: number, cy: number) {
    const hit = this.hitAt(cx, cy);
    if (!hit) return;
    const v = this.camera.getWorldDirection(new THREE.Vector3()), dd = hit.p.clone().sub(this.camera.position).dot(v);
    if (dd > 5 && dd < 2500) this.controls.target.copy(this.camera.position).addScaledVector(v, dd);
  }

  private wheel(e: WheelEvent) {
    if (this.craftView) return;
    if (this.mode === 'orbit') { this.zoomT = performance.now(); return; }
    e.preventDefault();
    if (this.mode === 'pedestrian') { this.pedestrian?.zoom(clamp(e.deltaY * 0.003, -0.4, 0.4)); return; }
    if (this.mode === 'ride') { this.zoomRide(Math.exp(e.deltaY * 0.004)); return; }
    if (e.ctrlKey) { this.setFov(this.camera.fov * Math.exp(e.deltaY * 0.004)); return; }
    if (e.deltaY > 0) { // keep scrolling back and you rise to the bird's-eye view
      const now = performance.now();
      this.wheelBack = (now - this.wheelBackT < 600 ? this.wheelBack : 0) + e.deltaY;
      this.wheelBackT = now;
      if (this.wheelBack > 900) { this.wheelBack = 0; this.flyUp(); return; }
    }
    const from = this.goal ? new THREE.Vector3(this.goal.x, 0, this.goal.z) : this.walkPos.clone();
    from.addScaledVector(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), -Math.sign(e.deltaY) * Math.min(4, Math.abs(e.deltaY) / 30));
    this.goal = { x: from.x, z: from.z, stuck: 0 };
  }

  private diveTo(cx: number, cy: number) {
    if (this.mode !== 'orbit' || !this.world) return;
    const hit = this.hitAt(cx, cy);
    if (!hit) return;
    const cam = this.camera.position, dist = cam.distanceTo(hit.p);
    const pos = hit.p.clone().addScaledVector(hit.dir, -Math.max(25, dist * 0.4));
    pos.y = Math.max(pos.y, this.world.groundAt(pos.x, pos.z) + 2);
    this.flyTo({ pos: pos.toArray(), target: hit.p.toArray() });
  }

  // Ctrl+C over the map: what is under the mouse (or the middle of the view) as text to paste into a note or a
  // prompt -- the voxel hit (grid x, height, grid z; three's axes) and a link whose ?cam= looks at it from here
  spotText() {
    const cx = this.cursor?.x ?? innerWidth / 2, cy = this.cursor?.y ?? innerHeight / 2;
    const hit = this.hitAt(cx, cy);
    if (!hit) return null;
    // (in the project grid's coordinates, as ?cam= is read: map cells + meta.origin)
    const [ox, oz] = this.origin, f = (v: number) => +v.toFixed(1), c = this.camera.position, p = hit.p;
    const u = new URL(location.href);
    u.searchParams.set('cam', [c.x + ox, c.y, c.z + oz, p.x + ox, p.y, p.z + oz].map(f).join(','));
    u.searchParams.delete('view');
    return `voxel ${Math.floor(p.x + ox)},${Math.floor(p.y)},${Math.floor(p.z + oz)}  ${u.href}`;
  }

  private hitAt(cx: number, cy: number, maxDist = 4000) {
    if (!this.world) return null;
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1), this.camera);
    const t = this.world.raycast(r.ray.origin, r.ray.direction, maxDist);
    if (!isFinite(t)) return null;
    return { p: r.ray.origin.clone().addScaledVector(r.ray.direction, t), axis: this.world.hitAxis, dir: r.ray.direction };
  }

  private pickAgent(cx: number, cy: number, px: number, minPx: number) {
    const life = this.life, world = this.world;
    if (!life?.group.visible || !world) return null;
    return life.pick(this.camera, cx, cy, px, minPx, (to) => { const L = to.length(); return world.raycast(this.camera.position, to.divideScalar(L), L) >= L - 2.5; }, this.ride?.obj ?? null);
  }

  // what a click would do here: a hand over people and vehicles, a ring on the street where you would walk
  private hover(cx: number, cy: number, type: string) {
    if (this.craftView) return;
    const now = performance.now();
    if (type === 'touch' || now - this.hoverT < 60 || now - this.quietT < 350) return;
    this.hoverT = now;
    const air = this.mode === 'orbit', ag = this.mode === 'pedestrian' ? null : this.pickAgent(cx, cy, air ? 14 : 3, air ? 7 : 0);
    this.dom.style.cursor = ag ? 'pointer' : air ? 'grab' : 'default';
    const g = this.onFoot && !ag ? this.walkTarget(cx, cy) : null;
    this.marker.visible = !!g;
    if (g) this.marker.position.set(g.x, g.y + 0.06, g.z);
  }

  // where a click at street level walks to: that spot, or the foot of the wall clicked
  private walkTarget(cx: number, cy: number) {
    const hit = this.hitAt(cx, cy, 250);
    if (!hit || !this.world) return null;
    const p = hit.p.clone();
    if (hit.axis !== 1 || hit.p.y > this.feet + 3) p.addScaledVector(new THREE.Vector3(hit.dir.x, 0, hit.dir.z).normalize(), -0.8);
    p.y = this.world.support(p.x, p.z, this.feet + 3);
    return p;
  }

  // a person or vehicle under the click is followed (generous from the air, tight on the street); else walk there
  private tap(cx: number, cy: number) {
    if (this.craftView || this.driving) return;
    const coarse = coarsePointer(), air = this.mode === 'orbit';
    const ag = this.mode === 'pedestrian' ? null : this.pickAgent(cx, cy, air ? (coarse ? 26 : 16) : coarse ? 24 : 12, air ? 5 : 0);
    if (ag) { this.startRide(ag); return; }
    if (this.mode === 'ride') { this.hopOff(); return; }
    if (!this.onFoot) return;
    const g = this.walkTarget(cx, cy);
    if (!g) return;
    this.goal = { x: g.x, z: g.z, stuck: 0 };
    this.marker.position.set(g.x, g.y + 0.06, g.z);
    this.marker.visible = true;
  }

  // ------------------------------------------------------------------ the view
  private dir() { return new THREE.Vector3().subVectors(this.controls.target, this.camera.position); }

  private setFov(f: number) { this.camera.fov = clamp(f, 20, 80); this.camera.updateProjectionMatrix(); }

  /** riding or driving: the camera out (ratio > 1) or in, as the wheel and a pinch (drive.ts) do (ride.ts rideCamera) */
  zoomRide(ratio: number) {
    if (this.ride) this.ride.zoom = clamp(this.ride.zoom * ratio, 0.5, 2.2);
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

  private orbitBy(dyaw: number) {
    const t = this.controls.target, off = this.camera.position.clone().sub(t), s = new THREE.Spherical().setFromVector3(off);
    s.theta += dyaw;
    s.phi = clamp(s.phi, 0.05, this.controls.maxPolarAngle);
    this.camera.position.copy(t).add(off.setFromSpherical(s));
  }

  // the focus goes onto what is in the middle of the screen (kept on the map), so turning pivots on it
  private retarget() {
    const w = this.world;
    if (!w || this.mode !== 'orbit') return;
    const c = this.camera.position, d = this.dir().normalize(), t = w.raycast(c, d, 3000);
    let len = isFinite(t) ? Math.max(5, t) : Math.min(this.dir().length(), 800);
    const onMap = (L: number) => { const x = c.x + d.x * L, z = c.z + d.z * L; return w.inside(x - 61, z - 61) && w.inside(x + 61, z + 61); };
    while (len > 5 && !onMap(len)) len *= 0.85;
    this.controls.target.copy(c).addScaledVector(d, len);
  }

  private look(dyaw: number, dpitch: number) {
    if (this.mode === 'pedestrian') this.pedestrian?.look(dyaw, dpitch);
    else if (this.mode === 'walk') { this.yaw += dyaw; this.pitch = clamp(this.pitch + dpitch, -1.4, 1.45); }
    else if (this.ride) { const R = this.ride; R.dyaw += dyaw; R.dpitch = clamp(R.dpitch + dpitch, -1.2, 1.2); R.idle = performance.now(); }
  }

  private rememberSky() {
    if (this.mode !== 'orbit') return;
    this.orbitFov = this.camera.fov;
    this.skyView = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
  }

  private transition(ms: number): Transition {
    return { from: this.camera.position.clone(), fromQ: this.camera.quaternion.clone(), fromFov: this.camera.fov, t0: performance.now(), ms };
  }

  // ------------------------------------------------------------------ modes
  // back up to a bird's-eye view: the one you came down from, or one over where you look
  flyUp() {
    const from = this.camera.position.clone(), f = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const S = this.skyView;
    this.setOrbit();
    if (S && Math.hypot(S.target.x - from.x, S.target.z - from.z) < 120) { this.flyTo({ pos: S.pos.toArray(), target: S.target.toArray() }); return; }
    const tgt = from.clone().addScaledVector(f, 60);
    tgt.y = this.world ? this.world.groundAt(tgt.x, tgt.z) + 5 : from.y;
    const pos = tgt.clone().addScaledVector(f, -380);
    pos.y = tgt.y + 330;
    this.flyTo({ pos: pos.toArray(), target: tgt.toArray() });
  }

  setOrbit() {
    this.releasePedestrianMouse();
    if (this.mode === 'orbit') return;
    if (this.mode === 'pedestrian') { this.keys.clear(); this.shift = false; }
    this.mode = 'orbit';
    this.pedestrian?.hide();
    this.leaveRide();
    this.marker.visible = false;
    this.controls.enabled = true;
    if (this.orbitFov) this.setFov(this.orbitFov);
    this.controls.target.copy(this.camera.position).add(this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(30));
    this.retarget();
    this.dom.style.cursor = 'grab';
    this.onMode(this.mode, null);
  }

  /** a craft that owns the camera could be entered now: from the map or a ride */
  get canStartCraft() {
    return this.world !== null && !this.walkPending && (this.mode === 'orbit' || this.mode === 'ride');
  }

  // Into a craft (craft.ts). One that owns the camera: from the map or a ride, keeping the current view for its
  // spawn. The car: it takes the ride followed. false: not now
  enterCraft(c: PlayerCraft) {
    if (c.view === 'ride') {
      if (this.mode !== 'ride' || !this.ride) return false;
      if (this.craft !== c) this.dropCraft();
      this.craft = c;
      return true;
    }
    if (!this.canStartCraft) return false;
    this.rememberSky();
    if (this.mode === 'ride') {
      this.leaveRide(); // (the car driven parked: dropCraft)
      this.landing = null;
    }
    this.cancelFly();
    this.keys.clear();
    this.turned = false;
    this.mode = 'craft';
    this.craft = c;
    this.controls.enabled = false;
    this.marker.visible = false;
    this.dom.style.cursor = 'default';
    this.onMode(this.mode, null);
    return true;
  }

  // out of the craft (the car's Park): it lets go. One that owns the camera leaves to the map
  leaveCraft() {
    const own = this.craftView;
    this.dropCraft();
    if (own) this.setOrbit();
  }

  // whatever leaves the craft (the map, a ride, a walk, another craft): it is told once (leave())
  private dropCraft() {
    const c = this.craft;
    if (!c) return;
    this.craft = null;
    c.leave();
  }

  async togglePedestrian(captureMouse: boolean) {
    if (this.mode === 'pedestrian') { this.flyUp(); return; }
    if (!this.world || this.walkPending || this.craftView) return;
    const entry = {};
    this.pedestrianStart = entry;
    if (captureMouse) this.requestPedestrianMouse();
    try {
      await this.startPedestrian(this.world);
    } finally {
      if (this.pedestrianStart === entry) this.pedestrianStart = null;
      if (!this.pedestrianActive) this.releasePedestrianMouse();
    }
  }

  private async startPedestrian(world: World) {
    this.cancelFly();
    if (this.mode === 'walk') {
      this.landing = this.transition(420);
      this.enterPedestrian();
      this.onMode(this.mode, null);
      return;
    }

    const ride = this.ride, pose = ride && this.life?.pose(ride.kind, ride.obj);
    if (pose) {
      const facing = new THREE.Vector3(Math.sin(pose.h), 0, Math.cos(pose.h));
      const at = new THREE.Vector3(pose.x, pose.y, pose.z);
      const side = new THREE.Vector3(-facing.z, 0, facing.x);
      const room = world;
      const exits = ride.kind === 'person' ? [at] : [at.clone().addScaledVector(side, 2), at.clone().addScaledVector(side, -2)];
      const clear = exits.find(p => {
        const y = room.support(p.x, p.z, p.y + 1.02);
        return room.inside(p.x, p.z) && p.y - y < 1.7 && !room.blocked(p.x, p.z, y, y + HEAD);
      });
      if (clear) {
        await this.setWalk({ at: clear, exact: true, facing, ms: 540, thirdPerson: true });
        return;
      }
      await this.setWalk({ at, facing, ms: 650, thirdPerson: true });
      return;
    }
    const facing = this.camera.getWorldDirection(new THREE.Vector3()).setY(0);
    await this.setWalk({ deckOK: true, facing: facing.lengthSq() > 1e-6 ? facing : undefined, thirdPerson: true });
  }

  private enterPedestrian() {
    this.pedestrian ??= new Pedestrian(this.actors);
    this.pedestrian.start(this.yaw);
    this.keys.clear();
    this.shift = false;
    this.jumpBuffer = this.groundGrace = 0;
    this.mode = 'pedestrian';
  }

  // down to street level at (or facing) a spot; waits for the full-detail tiles there
  async setWalk(opts: WalkOpts = {}) {
    const w = this.world;
    if (!w || this.walkPending) return;
    const target = opts.at ?? this.controls.target;
    const t = opts.thirdPerson ? target.clone() : target;
    const mode = this.mode, ride = this.ride, entry = this.pedestrianStart;
    if (this.streamer) {
      this.walkPending = true;
      await this.streamer.ensure(t.x, t.z, 200).finally(() => { this.walkPending = false; });
    }
    if (opts.thirdPerson && (mode !== this.mode || ride !== this.ride || (entry && entry !== this.pedestrianStart))) return;
    if (!opts.exact && opts.deckOK) { const deck = w.deckAt(t.x, t.z); if (deck != null) opts = { ...opts, exact: true, at: new THREE.Vector3(t.x, deck, t.z) }; }
    let spot: [number, number] | null;
    this.landmark = null;
    if (opts.exact) spot = [Math.floor(t.x), Math.floor(t.z)];
    else {
      if (this.life && !this.net) this.net = walkNet(w, this.life.peds);
      const s = openSpot(w, this.net, t.x, t.z);
      this.landmark = s?.landmark ?? null;
      spot = s?.at ?? findStreet(w, this.camera.position.x, this.camera.position.z);
    }
    if (!spot) return;
    let f = opts.facing, pitch = opts.pitch ?? 0.05;
    if (!f) { // face what was in focus, tilted up towards its top
      const lm = this.landmark ?? t, to = new THREE.Vector3(lm.x - spot[0] - 0.5, 0, lm.z - spot[1] - 0.5), L = to.length();
      if (L > 4) {
        f = to;
        const top = this.landmark ? this.landmark.y : w.top(Math.floor(t.x), Math.floor(t.z)), eye = w.groundAt(spot[0], spot[1]) + EYE;
        pitch = clamp(Math.atan2(top - eye, L) * 0.6, 0.05, 0.5);
      } else f = this.camera.getWorldDirection(new THREE.Vector3());
    }
    this.rememberSky();
    this.yaw = Math.atan2(f.x, f.z);
    this.pitch = pitch;
    this.vy = 0;
    if (opts.exact) {
      this.walkPos.set(t.x, 0, t.z);
      this.feet = w.support(t.x, t.z, t.y + 1.5);
    } else {
      this.feet = w.groundAt(spot[0], spot[1]);
      const b = backOff(w, this.walkPos.set(spot[0] + 0.5, 0, spot[1] + 0.5), this.feet, f);
      this.walkPos.set(b.x, 0, b.z);
      this.feet = b.feet;
    }
    this.walkPos.y = this.feet + EYE;
    this.goal = null;
    this.marker.visible = false;
    this.landing = this.transition(opts.ms ?? 900);
    if (opts.thirdPerson) this.enterPedestrian();
    else { this.mode = 'walk'; this.pedestrian?.hide(); this.releasePedestrianMouse(); }
    this.leaveRide();
    this.controls.enabled = false;
    this.dom.style.cursor = 'default';
    this.onMode(this.mode, null);
  }

  startRide(ag: Picked) {
    this.rememberSky();
    this.releasePedestrianMouse();
    this.pedestrian?.hide();
    this.release();
    this.dropCraft();
    this.ride = { ...ag, view: 'behind', dyaw: 0, dpitch: 0, idle: 0, zoom: 1 };
    this.landing = this.transition(1100);
    this.mode = 'ride';
    if (this.life) this.life.keep = ag.obj;
    this.controls.enabled = false;
    this.goal = null;
    this.marker.visible = false;
    this.dom.style.cursor = 'default';
    this.onMode(this.mode, this.ride);
  }

  private leaveRide() {
    this.dropCraft();
    this.ride = null;
    this.rideY = null;
    this.jumpAsked = false;
    this.release();
    if (this.life) this.life.keep = null;
  }

  // off the person walked: back to the crowd's own walk (sim/traffic.ts no longer keeps them), and following them
  // again starts afresh from where they are (possess' init) instead of moving them to walkPos
  private release() {
    if (this.possessed) delete this.possessed.ctl;
    this.possessed = null;
  }

  // out of the vehicle (a step to its side) or off the person, onto the street
  private hopOff() {
    const R = this.ride, pose = R && this.life?.pose(R.kind, R.obj);
    const f = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const p = pose ? new THREE.Vector3(pose.x, pose.y, pose.z) : this.camera.position.clone();
    if (R && pose && R.kind !== 'person') p.addScaledVector(new THREE.Vector3(Math.cos(pose.h), 0, -Math.sin(pose.h)), 2.0);
    this.setWalk({ at: p, facing: f, pitch: 0.05, ms: 500, exact: R?.kind === 'person' });
  }

  // ------------------------------------------------------------------ every frame
  update(dt: number) {
    dt = Math.min(dt, 0.1);
    this.footSticks.setActive(this.onFoot);
    this.fitNear();
    if (this.mode === 'walk') this.updateWalk(dt);
    else if (this.mode === 'pedestrian') this.updatePedestrian(dt);
    else if (this.mode === 'ride') this.updateRide(dt);
    else if (this.mode === 'orbit') this.updateOrbit(dt);
  }

  // the near plane on foot (WALK_NEAR) and back
  private fitNear() {
    const cam = this.camera;
    if (this.onFoot && this.mapNear === null) { this.mapNear = cam.near; cam.near = Math.min(cam.near, WALK_NEAR); cam.updateProjectionMatrix(); }
    else if (!this.onFoot && this.mapNear !== null) { cam.near = this.mapNear; this.mapNear = null; cam.updateProjectionMatrix(); }
  }

  // A/D/Q/E turn in place; W/S fly along the view, faster higher up; reaching the street lands you on it
  private updateOrbit(dt: number) {
    const tr = this.axis('tr', 'tl'), tp = this.axis('tu', 'td');
    if (tr || tp) { this.turnInPlace(-tr * (this.shift ? 2.4 : 1.2) * dt, tp * 0.8 * dt); this.turned = true; }
    const go = this.axis('f', 'b'), w = this.world;
    if (!go || !w) return;
    const cam = this.camera.position, len0 = this.dir().length(), look = this.dir().normalize();
    const h = Math.max(3, cam.y - w.groundAt(cam.x, cam.z));
    let step = go * (this.shift ? 3 : 1) * Math.min(400, 8 + h * 0.9) * dt;
    const ahead = w.raycast(cam, look, 4000);
    if (go > 0 && ahead < 8) { this.setWalk(); return; }
    if (go > 0) step = Math.min(step, ahead - 6);
    if (step * look.y > 0 && h + step * look.y > 3600) return;
    cam.addScaledVector(look, step);
    this.controls.target.copy(cam).addScaledVector(look, isFinite(ahead) ? Math.max(5, ahead - step) : len0);
    this.zoomT = performance.now();
  }

  // after OrbitControls: above the ground, the tilt limit back once you look down, and zoomed onto the street: land
  clamp() {
    const w = this.world;
    if (!w || this.mode !== 'orbit') return;
    if (this.controls.maxPolarAngle > TILT && !this.turned && this.controls.getPolarAngle() <= TILT) this.controls.maxPolarAngle = TILT;
    const p = this.camera.position, g = w.groundAt(p.x, p.z) + 1.2;
    if (p.y < g) { p.y = g; this.camera.lookAt(this.controls.target); }
    const t = this.controls.target, tg = w.groundAt(t.x, t.z);
    const close = p.y - g < 3 || (p.distanceTo(t) < this.controls.minDistance * 2.5 && t.y - tg < 3);
    const now = performance.now();
    if (close && now - this.zoomT < 700 && now - this.landT > 1500) {
      this.landT = now;
      const at = new THREE.Vector3(t.x, tg, t.z), f = this.dir().setY(0);
      if (!w.blocked(at.x, at.z, tg, tg + 2)) this.setWalk({ at, exact: true, facing: f.lengthSq() > 1e-6 ? f : undefined, pitch: 0.1, ms: 500 });
    }
  }

  // one collision-checked horizontal step, sliding along walls; true if it moved
  private stepBy(m: THREE.Vector3) {
    return walkStep(this.world!, this.walkPos, this.feet, m, this.mode === 'pedestrian');
  }

  // on whatever is underfoot: up kerbs and stairs, off ledges, jumps
  private stand(dt: number) {
    const P = this.walkPos, sup = this.world!.support(P.x, P.z, this.feet + STEP);
    if (this.vy !== 0 || this.feet > sup + 0.01) {
      this.vy -= GRAV * dt;
      this.feet += this.vy * dt;
      if (this.feet <= sup) { this.feet = sup; this.vy = 0; }
    } else this.feet = sup > this.feet ? Math.min(sup, this.feet + 6 * dt) : sup;
    P.y = this.feet + EYE;
  }

  private updateWalk(dt: number) {
    const tr = this.axis('tr', 'tl'), tp = this.axis('tu', 'td'), go = this.axis('f', 'b');
    if (tr || tp) this.look(-tr * (this.shift ? 2.6 : 1.8) * dt, tp * dt);
    const stick = this.footStick();
    if (go) this.stepBy(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(go * (this.shift ? 20 : 6) * dt));
    else if (stick) {
      const [f, r] = stick, sx = Math.sin(this.yaw), sz = Math.cos(this.yaw);
      this.stepBy(new THREE.Vector3(sx * f - sz * r, 0, sz * f + sx * r).multiplyScalar(6 * dt));
    } else if (this.goal) this.walkToGoal(dt);
    this.stand(dt);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw + Math.PI, 0, 'YXZ'));
    this.place(this.walkPos, q, WALK_FOV, false, dt);
    const look = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.controls.target.copy(this.camera.position).addScaledVector(look, 10);
  }

  private updatePedestrian(dt: number) {
    const pedestrian = this.pedestrian!, world = this.world!, p = this.walkPos;
    const x = p.x, z = p.z, right = this.axis('tr', 'tl'), forward = this.axis('f', 'b');
    const pitch = this.axis('td', 'tu');
    if (pitch) pedestrian.look(0, pitch * dt);
    const grounded = this.vy === 0 && this.feet <= world.support(x, z, this.feet + STEP) + 0.04;
    this.groundGrace = grounded ? 0.1 : Math.max(0, this.groundGrace - dt);
    if (this.jumpBuffer > 0 && this.groundGrace > 0) {
      this.vy = 6.2;
      this.jumpBuffer = this.groundGrace = 0;
    } else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    const stick = this.footStick();
    if (right || forward) this.stepBy(pedestrian.move(forward, right, this.shift, dt));
    else if (stick) { // analog: up to a walk, pushed to the rim a run
      const push = Math.min(1, Math.hypot(...stick));
      this.stepBy(pedestrian.move(stick[0], stick[1], push > 0.92, dt).multiplyScalar(push > 0.92 ? 1 : Math.max(0.35, push)));
    } else if (this.goal) this.walkToGoal(dt, 2.4);

    if (this.vy > 0) {
      const rise = this.vy * dt + 0.08;
      if (world.raycast({ x: p.x, y: this.feet + 1.75, z: p.z }, { x: 0, y: 1, z: 0 }, rise) < rise) this.vy = 0;
    }
    this.stand(dt);
    const view = pedestrian.frame(p.x, this.feet, p.z, p.x - x, p.z - z, this.vy !== 0, dt, world);
    this.place(view.position, view.rotation, view.fov, false, dt);
    this.controls.target.copy(view.target);
  }

  // click-to-walk: glide there, faster for far goals, around a post; give up when a wall stops us
  private walkToGoal(dt: number, maxSpeed = 22) {
    const G = this.goal!, P = this.walkPos, d = new THREE.Vector3(G.x - P.x, 0, G.z - P.z), L = d.length();
    if (L < 0.15) { this.goal = null; this.marker.visible = false; return; }
    const step = d.multiplyScalar(Math.min(L, Math.min(L * 2.2, Math.min(maxSpeed, Math.max(4, L * 0.9))) * dt) / L), up = new THREE.Vector3(0, 1, 0);
    if ([0, 0.6, -0.6, 1.2, -1.2].some((a) => this.stepBy(step.clone().applyAxisAngle(up, a)))) return;
    G.stuck += dt;
    if (G.stuck > 0.4) { this.goal = null; this.marker.visible = false; }
  }

  // the camera to (pos, q, fov), gliding there over the landing transition; settle: then ease back to fov (rate 6.3/s:
  // a tenth of the way a frame at 60 fps)
  private place(pos: THREE.Vector3, q: THREE.Quaternion, fov: number, settle: boolean, dt: number) {
    const cam = this.camera, L = this.landing;
    if (L) {
      const t = Math.min(1, (performance.now() - L.t0) / L.ms), e = ease(t);
      cam.position.lerpVectors(L.from, pos, e);
      cam.quaternion.slerpQuaternions(L.fromQ, q, e);
      cam.fov = L.fromFov + (fov - L.fromFov) * e;
      if (t >= 1) this.landing = null;
    } else {
      cam.position.copy(pos);
      cam.quaternion.copy(q);
      if (settle && Math.abs(cam.fov - fov) > 0.01) cam.fov += (fov - cam.fov) * follow(6.3, dt);
    }
    cam.updateProjectionMatrix();
  }

  private updateRide(dt: number) {
    const R = this.ride!, life = this.life;
    if (R.kind === 'person' && (this.keys.size || this.jumpAsked || this.possessed === R.obj)) this.possess(dt);
    const pose = life?.pose(R.kind, R.obj);
    if (!pose) { // it left the map: the nearest one of the same kind, else on foot
      const next = life?.nearest(R.kind, { x: this.camera.position.x, z: this.camera.position.z }, R.obj);
      if (next) { const { view, zoom } = R; this.startRide(next); Object.assign(this.ride!, { view, zoom }); } else this.hopOff();
      return;
    }
    if (this.driving && R.view === 'behind') {
      // through jumps, drops and landings the chase camera's height follows the car with a short lag
      const y = this.rideY;
      this.rideY = y == null || Math.abs(pose.y - y) > 40 ? pose.y : y + (pose.y - y) * (1 - Math.exp(-9 * dt));
      pose.y = this.rideY;
    } else this.rideY = null;
    const { pos, look, fov } = rideCamera(R, pose, this.world, dt);
    if (this.driving) pos.add(this.rideShake);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, pos.clone().add(look), new THREE.Vector3(0, 1, 0)));
    this.place(pos, q, fov, true, dt);
    this.controls.target.copy(this.camera.position).addScaledVector(look, 10);
  }

  // walking as the person followed: W/S walk, A/D turn them, Q/E look, through their eyes; they stay where left
  // while the ride lasts (release(): back to their own walk after)
  private possess(dt: number) {
    const R = this.ride!, o = R.obj, life = this.life;
    if (o.kind !== 'person' || !life) return;
    if (this.possessed !== o) {
      const p: Pose | null = life.pose('person', o);
      if (!p) return;
      this.release();
      this.possessed = o;
      o.ctl = { x: p.x, y: p.y, z: p.z, h: p.h, moving: false };
      Object.assign(R, { label: 'you', view: 'eyes', dyaw: 0, dpitch: 0, zoom: 1 });
      this.landing = this.transition(1100);
      this.onMode(this.mode, R);
      this.walkPos.set(p.x, p.y + EYE, p.z);
      this.feet = p.y; this.vy = 0; this.yaw = p.h;
    }
    if (this.jumpAsked) { if (this.vy === 0) this.vy = 5.2; this.jumpAsked = false; }
    const C = o.ctl!, P = this.walkPos, tp = this.axis('tu', 'td'), go = this.axis('f', 'b');
    this.yaw -= this.axis('tr', 'tl') * (this.shift ? 2.6 : 1.8) * dt;
    if (tp) R.dpitch = clamp(R.dpitch + tp * dt, -1.2, 1.2);
    this.yaw += R.dyaw;
    R.dyaw = 0;
    C.moving = !!go && this.stepBy(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(go * (this.shift ? 7 : 2.2) * dt));
    this.stand(dt);
    Object.assign(C, { x: P.x, y: this.feet, z: P.z, h: this.yaw });
  }
}
