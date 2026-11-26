import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Picked, StreetLife } from '../view/life';
import type { SimClient } from '../client/sim-client';
import type { Pose } from '../sim/contract/pose';
import type { TileStreamer } from '../stream';
import type { View } from '../core/meta';
import { clamp, coarsePointer } from '../util';
import type { World } from '../core/world';
import type { PlayerCraft } from './craft';
import { Foot, type Stick } from './foot';
import { Glide } from './glide';
import { gameKey, onFocusLoss } from './input';
import { MoveKeys } from './move-keys';
import { OrbitInput } from './orbit';
import { Rider } from './ride';
import { EYE, findStreet, openSpot, walkNet } from './spots';
import { stickAxis, TouchSticks } from './touch-sticks';
import { HEAD } from './walk';

// Orbit, walk and ride share one set of keys (W/S forward and back, A/D turn, Q/E nose up and down, Shift faster;
// arrows alike: move-keys.ts) and one gesture language for mouse, trackpad and touch:
//   orbit: drag moves the map, right-drag turns and tilts, wheel zooms at the cursor, double-click flies there
//   walk:  first person; a click takes the mouse (pointer lock) and it looks, Space jumps, Esc flies up
//   walk on touch: the left thumb is a stick that walks (up ahead, sideways steps; pushed far, runs), the right thumb
//          drags to look (touch-sticks.ts, as the drive mode's); two fingers close together pinch to zoom
//   ride:  following a pedestrian or a car; move keys walk as that person, or get out of a vehicle
//   craft: a craft (craft.ts: the drone, the boat, the plane) owns the camera and the input; Nav leaves the keys, the
//          pointer and the wheel to it. The car driven is a craft too, but on the ride's camera (mode ride)
//
// Nav is the mode machine and routes the input to the mode on: the map's own input is orbit.ts, on foot foot.ts, the
// ride and its camera ride.ts (following, walking as the person followed); the crafts are their own (craft.ts).
export type Mode = 'orbit' | 'walk' | 'ride' | 'craft';
export interface Ride extends Picked {
  view: 'eyes' | 'behind';
  dyaw: number;
  dpitch: number;
  idle: number;
  /** how far out the camera is (wheel, pinch): behind, a factor on the chase distance; at the eyes, on the field of view */
  zoom: number;
}
export interface WalkOpts { at?: THREE.Vector3; exact?: boolean; facing?: THREE.Vector3; pitch?: number; ms?: number; deckOK?: boolean }

// On foot the camera stands a step from walls: the walk's side probes keep 0.4 m, less in a doorway or a narrow
// aisle. The map camera's near plane (0.5 m, main.ts) cut into them there; on foot it comes in to WALK_NEAR -- its
// frustum's corners ~0.33 m out at the walk's field of view -- and goes back on leaving. (The FPV drone takes 0.15 m alike, fpv.ts: the depth buffer's precision far off, ~d^2 /
// (near x 2^24), is then 2.5 x coarser than the map camera's, as the drone's has always been.)
const WALK_NEAR = 0.2;

export class Nav {
  mode: Mode = 'orbit';
  /** the craft the player is in (craft.ts): in mode craft, or the car driven in mode ride */
  craft: PlayerCraft | null = null;
  readonly actors = new THREE.Group();
  world: World | null = null;
  streamer: TileStreamer | null = null;
  // the map's corner in the project grid (meta.origin): ?cam= links are in the project grid's coordinates
  origin: [number, number] = [0, 0];
  cancelFly: () => void = () => {};
  private lifeRef: StreetLife | null = null;
  private simRef: SimClient | null = null;
  private net: ReturnType<typeof walkNet> | null = null;
  private readonly keys = new MoveKeys();
  private readonly glide: Glide;
  private readonly orbit: OrbitInput;
  private readonly foot: Foot;
  private readonly mapDirection = new THREE.Vector3();
  private landmark: THREE.Vector3 | null = null;
  private skyView: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private orbitFov = 0;
  private readonly rider: Rider;
  private walkPending = false;
  // the avatar asked for on foot (walkBody): for which session's player, where the walk put it last
  private body: { player: string | null; x: number; z: number } | null = null;
  private hoverT = 0;
  private cursor: { x: number; y: number } | null = null; // the mouse over the map, for Ctrl+C (copySpot)
  private quietT = 0;
  private wheelBack = 0;
  private wheelBackT = 0;
  private walkStart: object | null = null;
  private mouseLook: { locked: boolean } | null = null;
  private mapNear: number | null = null; // the camera's near plane before it went on foot (fitNear)
  // touch on foot: left thumb walks, right thumb looks (the drag since the last move)
  private readonly footSticks: TouchSticks;
  private lookFrom = { dx: 0, dy: 0 };

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly controls: OrbitControls, private readonly dom: HTMLElement,
    private readonly flyTo: (v: Pick<View, 'pos' | 'target'>) => void, private readonly onMode: (m: Mode, r: Ride | null) => void) {
    this.glide = new Glide(camera);
    this.orbit = new OrbitInput(camera, controls, this.keys, {
      world: () => this.world, hitAt: (cx, cy) => this.hitAt(cx, cy), flyTo: (v) => this.flyTo(v), land: (opts) => { this.setWalk(opts); },
    });
    dom.style.cursor = 'grab';
    this.foot = new Foot(camera, controls, this.keys, this.glide, () => this.world);
    this.rider = new Rider({
      camera, controls, foot: this.foot, glide: this.glide, keys: this.keys, life: () => this.life, sim: () => this.sim, world: () => this.world,
      changed: (R) => this.onMode(this.mode, R),
    });
    this.bindKeys();
    this.bindPointer();
    this.footSticks = new TouchSticks(dom, {
      onStart: () => { this.lookFrom = { dx: 0, dy: 0 }; this.cancelFly(); },
      onMove: (side, s) => {
        if (side !== 'right') return;
        const k = 2.4 * (this.camera.fov * Math.PI / 180) / innerHeight;
        this.look((s.dx - this.lookFrom.dx) * k, -(s.dy - this.lookFrom.dy) * k * 0.7);
        this.lookFrom = { dx: s.dx, dy: s.dy };
      },
      // a short touch that hardly moved: a tap (follow who is there, as with one finger elsewhere)
      onEnd: (_side, s) => {
        if (Math.hypot(s.dx, s.dy) < 8 && performance.now() - s.t < 600) this.tap(s.startX + s.dx, s.startY - s.dy);
      },
      // two fingers close together: the field of view
      onPinch: (ratio) => this.setFov(this.camera.fov * ratio),
    });
  }

  /** the left touch stick while on foot: [forward, right] in -1..1, or null */
  private footStick(): Stick {
    const s = this.footSticks.left;
    if (!s) return null;
    const f = clamp(stickAxis(s.dy, s.radius), -1, 1), r = clamp(stickAxis(s.dx, s.radius), -1, 1);
    return f || r ? [f, r] : null;
  }

  /** Space on foot (the touch Jump button) */
  jump() {
    if (this.onFoot) this.foot.jump();
  }


  /** The controlled or followed entity's pose. In orbit mode, mark the map focus and view bearing. */
  readonly mapPose = (): Pose => {
    const craft = this.craft?.mapPose;
    if (craft) return craft;
    if (this.onFoot) {
      const foot = this.foot, { x, z } = foot.pos;
      return { x, y: foot.feet, z, h: foot.yaw };
    }
    const ride = this.ride;
    const followed = ride && this.life?.pose(ride.ref);
    if (followed) return followed;
    const { x, y, z } = this.onMap ? this.controls.target : this.camera.position;
    const f = this.camera.getWorldDirection(this.mapDirection);
    return { x, y, z, h: Math.atan2(f.x, f.z) };
  };

  /** what is followed (mode ride) */
  get ride() { return this.rider.ride; }
  /** the ride's camera; its shake is the driven car's (drive.ts) */
  get rideCamera() { return this.rider.camera; }

  get life() { return this.lifeRef; }
  set life(l: StreetLife | null) { this.lifeRef = l; this.net = null; }
  /** the world sim's client (main.ts: set with the street life) */
  get sim() { return this.simRef; }
  set sim(s: SimClient | null) { this.simRef = s; this.net = null; }
  // turning in place with the keys: the focus is off on its own, put back on release
  get turning() { return this.orbit.turned; }

  // ------------------------------------------------------------------ input
  get enteringWalk() { return this.walkPending; }

  /** on the map, the bird's-eye view (OrbitControls) */
  get onMap() { return this.mode === 'orbit'; }
  /** following a person or a vehicle (or driving one) */
  private get riding() { return this.mode === 'ride'; }
  get onFoot() { return this.mode === 'walk'; }
  private get driving() { return this.craft !== null && this.riding; }
  /** a craft owns the camera and the input */
  get craftView() { return this.mode === 'craft'; }

  private bindKeys() {
    const K = this.keys;
    addEventListener('keydown', (e) => {
      if (!gameKey(e)) return;
      K.shift = e.shiftKey;
      if (e.code === 'Escape') {
        if (this.walkStart) this.releaseMouse();
        if (!this.onMap) this.flyUp();
        return;
      }
      if (this.craftView || this.driving) return;
      if (e.code === 'Space' && (this.onFoot || this.ride?.ref.kind === 'person')) { // following someone: become them, then jump
        if (this.onFoot) this.foot.jump();
        else this.rider.jumpAsked = true;
        e.preventDefault(); return;
      }
      const k = MoveKeys.of(e.code);
      if (!k) return;
      K.add(k);
      if (this.ride && this.ride.ref.kind !== 'person') this.hopOff();
      this.cancelFly();
      e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      K.shift = e.shiftKey;
      const k = MoveKeys.of(e.code);
      if (k) K.delete(k);
      if (this.orbit.turned && !K.turning) { this.orbit.turned = false; if (this.onMap) this.orbit.retarget(); }
    });
    onFocusLoss(() => K.clear());
  }

  private requestMouse() {
    if (!this.dom.requestPointerLock || document.pointerLockElement) return;
    const request = { locked: false };
    this.mouseLook = request;
    const reject = () => { if (this.mouseLook === request) this.mouseLook = null; };
    try {
      // Browsers expose either a promise or the original event-only API.
      this.dom.requestPointerLock()?.catch(reject);
    } catch { reject(); }
  }

  private releaseMouse() {
    this.walkStart = null;
    this.mouseLook = null;
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  private lookWithMouse(e: MouseEvent) {
    const scale = 0.0027;
    this.look(e.movementX * scale, e.movementY * scale * 0.8);
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
        this.releaseMouse();
        // Esc ends the walk; a tab switch or alt-tab also takes the lock, and must not. Focus and visibility settle a
        // moment after the lock goes, hence the wait.
        setTimeout(() => { if (this.onFoot && document.hasFocus() && !document.hidden) this.flyUp(); }, 150);
      }
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.mouseLook && !this.mouseLook.locked) this.mouseLook = null;
    });
    dom.addEventListener('mousemove', e => {
      if (this.onFoot && document.pointerLockElement === dom) this.lookWithMouse(e);
    });
    dom.addEventListener('pointerdown', (e) => {
      if (this.craftView || (this.onFoot && document.pointerLockElement === dom)) return;
      // on foot (back from another tab, or landed from the map): a click takes the mouse; its press still picks who
      // to follow (tap)
      if (this.onFoot && e.pointerType === 'mouse') this.requestMouse();
      if ((this.driving || this.onFoot) && e.pointerType === 'touch') return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.onMap && (e.button === 2 || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) || ptrs.size === 2)) this.orbit.pivotAt(e.clientX, e.clientY);
      if (ptrs.size === 2) { const [a, b] = two(); twist = Math.atan2(b.y - a.y, b.x - a.x); }
      press = ptrs.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, moved: false } : null;
      if (ptrs.size === 2 && !this.onMap) { const [a, b] = two(); pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: this.camera.fov }; }
      if (!this.onMap) dom.setPointerCapture(e.pointerId);
      else dom.style.cursor = 'grabbing';
      this.cancelFly();
    });
    dom.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.cursor = { x: e.clientX, y: e.clientY };
      if ((this.driving || this.onFoot) && e.pointerType === 'touch') return;
      const p = ptrs.get(e.pointerId);
      if (!p) { this.hover(e.clientX, e.clientY, e.pointerType); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
      if (this.onMap) {
        if (ptrs.size === 2 && twist !== null) { // two-finger twist turns the map
          this.orbit.zoomT = performance.now();
          const [a, b] = two(), ang = Math.atan2(b.y - a.y, b.x - a.x);
          this.orbit.orbitBy(Math.atan2(Math.sin(ang - twist), Math.cos(ang - twist)));
          twist = ang;
        }
        return;
      }
      if (ptrs.size === 2 && pinch0) {
        const [a, b] = two(), d = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
        if (this.riding) {
          this.zoomRide(pinch0.d / d);
          pinch0.d = d;
        } else this.setFov(pinch0.fov * pinch0.d / d);
        return;
      }
      if (press && !press.moved) return;
      const k = (e.pointerType === 'touch' ? 2.4 : 1.2) * (this.camera.fov * Math.PI / 180) / innerHeight;
      this.look(dx * k, dy * k * 0.7);
    });
    const up = (e: PointerEvent) => {
      if (!ptrs.delete(e.pointerId)) return;
      if (ptrs.size < 2) { pinch0 = null; twist = null; }
      this.quietT = performance.now();
      if (this.onMap) dom.style.cursor = 'grab';
      if (press && !press.moved && e.type === 'pointerup' && performance.now() - press.t < 600 && press.button === 0) this.tap(e.clientX, e.clientY);
      if (!ptrs.size) press = null;
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('pointerleave', () => { this.cursor = null; });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    dom.addEventListener('dblclick', (e) => { if (this.onMap) this.orbit.diveTo(e.clientX, e.clientY); });
  }

  private wheel(e: WheelEvent) {
    if (this.craftView) return;
    if (this.onMap) { this.orbit.zoomT = performance.now(); return; }
    e.preventDefault();
    if (this.riding) { this.zoomRide(Math.exp(e.deltaY * 0.004)); return; }
    if (e.ctrlKey) { this.setFov(this.camera.fov * Math.exp(e.deltaY * 0.004)); return; }
    if (e.deltaY > 0) { // keep scrolling back and you rise to the bird's-eye view
      const now = performance.now();
      this.wheelBack = (now - this.wheelBackT < 600 ? this.wheelBack : 0) + e.deltaY;
      this.wheelBackT = now;
      if (this.wheelBack > 900) { this.wheelBack = 0; this.flyUp(); }
    }
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
    return life.pick(this.camera, cx, cy, px, minPx, (to) => { const L = to.length(); return world.raycast(this.camera.position, to.divideScalar(L), L) >= L - 2.5; }, this.ride?.ref ?? null);
  }

  // what a click would do here: a hand over people and vehicles
  private hover(cx: number, cy: number, type: string) {
    if (this.craftView) return;
    const now = performance.now();
    if (type === 'touch' || now - this.hoverT < 60 || now - this.quietT < 350) return;
    this.hoverT = now;
    const air = this.onMap, ag = this.pickAgent(cx, cy, air ? 14 : 3, air ? 7 : 0);
    this.dom.style.cursor = ag ? 'pointer' : air ? 'grab' : 'default';
  }

  // a person or vehicle under the click is followed (generous from the air, tight on the street)
  private tap(cx: number, cy: number) {
    if (this.craftView || this.driving) return;
    const coarse = coarsePointer(), air = this.onMap;
    const ag = this.pickAgent(cx, cy, air ? (coarse ? 26 : 16) : coarse ? 24 : 12, air ? 5 : 0);
    if (ag) this.startRide(ag);
    else if (this.riding) this.hopOff();
  }

  // ------------------------------------------------------------------ the view
  private setFov(f: number) { this.camera.fov = clamp(f, 20, 80); this.camera.updateProjectionMatrix(); }

  /** riding or driving: the camera out (ratio > 1) or in, as the wheel and a pinch (drive.ts) do (ride.ts) */
  zoomRide(ratio: number) {
    if (this.ride) this.ride.zoom = clamp(this.ride.zoom * ratio, 0.5, 2.2);
  }

  private look(dyaw: number, dpitch: number) {
    if (this.onFoot) this.foot.look(dyaw, dpitch);
    else if (this.ride) { const R = this.ride; R.dyaw += dyaw; R.dpitch = clamp(R.dpitch + dpitch, -1.2, 1.2); R.idle = performance.now(); }
  }

  private rememberSky() {
    if (!this.onMap) return;
    this.orbitFov = this.camera.fov;
    this.skyView = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
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
    this.releaseMouse();
    if (this.onMap) return;
    this.mode = 'orbit';
    this.leaveRide();
    this.controls.enabled = true;
    if (this.orbitFov) this.setFov(this.orbitFov);
    this.controls.target.copy(this.camera.position).add(this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(30));
    this.orbit.retarget();
    this.dom.style.cursor = 'grab';
    this.onMode(this.mode, null);
  }

  /** a craft that owns the camera could be entered now: from the map or a ride */
  get canStartCraft() {
    return this.world !== null && !this.walkPending && (this.onMap || this.riding);
  }

  // Into a craft (craft.ts). One that owns the camera: from the map or a ride, keeping the current view for its
  // spawn. The car: it takes the ride followed. false: not now
  enterCraft(c: PlayerCraft, from?: PlayerCraft) {
    if (from) {
      if (!this.craftView || this.craft !== from || c.view !== 'own' || from === c) return false;
      this.dropCraft();
      this.craft = c;
      this.keys.clear();
      this.onMode(this.mode, null);
      return true;
    }
    if (c.view === 'ride') {
      if (!this.riding || !this.ride) return false;
      if (this.craft !== c) this.dropCraft();
      this.craft = c;
      return true;
    }
    if (!this.canStartCraft) return false;
    this.rememberSky();
    if (this.riding) {
      this.leaveRide(); // (the car driven parked: dropCraft)
      this.glide.stop();
    }
    this.cancelFly();
    this.keys.clear();
    this.orbit.turned = false;
    this.mode = 'craft';
    this.craft = c;
    this.controls.enabled = false;
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

  /** the Walk button: on foot here (beside what is followed), or back up. captureMouse: take the mouse now, as a
   *  browser grants it only in the click's gesture */
  async toggleWalk(captureMouse: boolean) {
    if (this.onFoot) { this.flyUp(); return; }
    if (!this.world || this.walkPending || this.craftView) return;
    const entry = {};
    this.walkStart = entry;
    if (captureMouse) this.requestMouse();
    try {
      await this.startWalk(this.world);
    } finally {
      if (this.walkStart === entry) this.walkStart = null;
      if (!this.onFoot) this.releaseMouse();
    }
  }

  private async startWalk(world: World) {
    this.cancelFly();
    const ride = this.ride, pose = ride && this.life?.pose(ride.ref);
    if (pose) {
      const facing = new THREE.Vector3(Math.sin(pose.h), 0, Math.cos(pose.h));
      const at = new THREE.Vector3(pose.x, pose.y, pose.z);
      const side = new THREE.Vector3(-facing.z, 0, facing.x);
      const exits = ride.ref.kind === 'person' ? [at] : [at.clone().addScaledVector(side, 2), at.clone().addScaledVector(side, -2)];
      const clear = exits.find(p => {
        const y = world.support(p.x, p.z, p.y + 1.02);
        return world.inside(p.x, p.z) && p.y - y < 1.7 && !world.blocked(p.x, p.z, y, y + HEAD);
      });
      await this.setWalk(clear ? { at: clear, exact: true, facing, ms: 540 } : { at, facing, ms: 650 });
      return;
    }
    const facing = this.camera.getWorldDirection(new THREE.Vector3()).setY(0);
    await this.setWalk({ deckOK: true, facing: facing.lengthSq() > 1e-6 ? facing : undefined });
  }

  // down to street level at (or facing) a spot; waits for the full-detail tiles there
  async setWalk(opts: WalkOpts = {}) {
    const w = this.world;
    if (!w || this.walkPending) return;
    const target = opts.at ?? this.controls.target;
    const t = target.clone();
    const mode = this.mode, ride = this.ride, entry = this.walkStart;
    if (this.streamer) {
      this.walkPending = true;
      await this.streamer.ensure(t.x, t.z, 200).finally(() => { this.walkPending = false; });
    }
    // (given up while the tiles came: another mode, another ride, or Esc)
    if (mode !== this.mode || ride !== this.ride || (entry && entry !== this.walkStart)) return;
    if (!opts.exact && opts.deckOK) { const deck = w.deckAt(t.x, t.z); if (deck != null) opts = { ...opts, exact: true, at: new THREE.Vector3(t.x, deck, t.z) }; }
    let spot: [number, number] | null;
    this.landmark = null;
    if (opts.exact) spot = [Math.floor(t.x), Math.floor(t.z)];
    else {
      if (this.sim && !this.net) this.net = walkNet(w, this.sim.traffic.peds);
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
    this.foot.setAt(w, t, spot, opts.exact, f, pitch);
    this.glide.start(opts.ms ?? 900);
    this.mode = 'walk';
    this.leaveRide();
    this.controls.enabled = false;
    this.dom.style.cursor = 'default';
    this.onMode(this.mode, null);
  }

  startRide(ag: Picked) {
    this.rememberSky();
    this.releaseMouse();
    this.dropCraft();
    this.rider.start(ag);
    this.glide.start(1100);
    this.mode = 'ride';
    this.controls.enabled = false;
    this.dom.style.cursor = 'default';
    this.onMode(this.mode, this.ride);
  }

  private leaveRide() {
    this.dropCraft();
    this.rider.leave();
  }

  // out of the vehicle or off the person, onto the street
  private hopOff() { this.setWalk(this.rider.exit()); }

  // ------------------------------------------------------------------ every frame
  update(dt: number) {
    dt = Math.min(dt, 0.1);
    this.footSticks.setActive(this.onFoot);
    this.fitNear();
    // (off foot: the body gone before a ride's own seat is asked for)
    if (!this.onFoot && this.body) { this.body = null; this.sim?.send({ kind: 'leaveSeat' }); }
    if (this.onFoot) this.foot.updateWalk(dt, this.footStick());
    else if (this.riding) this.rider.control(dt);
    else if (this.onMap) this.orbit.update(dt);
    if (this.onFoot) this.walkBody();
  }

  // On foot the player is a body the world knows (an avatar: the others see it walk), moved by this walk: put down
  // when the walk starts, again after a jump of the walk (a landing elsewhere) or with a new session (the host
  // reconnected), then the walk's pose every frame; the walk stays this page's own, so it answers at once
  private walkBody() {
    const sim = this.sim;
    if (!sim) return;
    sim.results('walk');
    const f = this.foot, B = this.body, x = f.pos.x, z = f.pos.z;
    const pose = { x, y: f.feet, z, h: f.yaw, moving: !!B && Math.hypot(x - B.x, z - B.z) > 1e-3 };
    if (!B || B.player !== sim.player || Math.hypot(x - B.x, z - B.z) > 5) sim.send({ kind: 'request', request: { kind: 'walk', pose } });
    else sim.send({ kind: 'seatInput', role: 'walker', input: pose });
    this.body = { player: sim.player, x, z };
  }

  /** after the sim's update and the street's drawing (main.ts): the ride's camera on this frame's poses */
  place(dt: number) {
    if (this.riding) this.updateRide(Math.min(dt, 0.1));
  }

  // the near plane on foot (WALK_NEAR) and back
  private fitNear() {
    const cam = this.camera;
    if (this.onFoot && this.mapNear === null) { this.mapNear = cam.near; cam.near = Math.min(cam.near, WALK_NEAR); cam.updateProjectionMatrix(); }
    else if (!this.onFoot && this.mapNear !== null) { cam.near = this.mapNear; this.mapNear = null; cam.updateProjectionMatrix(); }
  }

  // after OrbitControls (main.ts, on the map): above the ground, the tilt limit back, zoomed onto the street: land
  clamp() {
    if (this.onMap) this.orbit.clamp();
  }

  private updateRide(dt: number) {
    const next = this.rider.place(dt, this.driving);
    if (next === 'off') this.hopOff();
    else if (next) { const { view, zoom } = this.ride!; this.startRide(next); Object.assign(this.ride!, { view, zoom }); }
  }
}
