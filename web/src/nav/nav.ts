import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Picked, StreetLife } from '../view/life';
import type { SimClient } from '../client/sim-client';
import type { Pose, WalkPose } from '../sim/contract/pose';
import type { TileStreamer } from '../stream';
import type { View } from '../core/meta';
import { clamp, coarsePointer } from '../util';
import type { World } from '../core/world';
import { aloft, mouseTurns, type CraftSpot, type PlayerCraft } from './craft';
import { Arms } from './arms';
import { Foot } from './foot';
import { Glide } from './glide';
import { gameKey, onFocusLoss } from './input';
import { MoveKeys } from './move-keys';
import { OrbitInput } from './orbit';
import { Rider } from './ride';
import { EYE } from '../sim/figure';
import { findStreet, openSpot, walkNet } from './spots';
import { HEAD } from '../sim/walk';
import { canopyOpens } from '../sim/walker';
import { besideSolids, craftMeets, craftSolids, meetShapes, type Solid } from '../sim/solids';
import { letGo } from '../sim/walk-bounds';
import { FootTouch } from '../touch/foot';
import { HookLine } from './hook-line';

// Orbit, walk and ride share one set of keys (W/S forward and back, A/D turn or on foot step sideways, Q/E nose up and
// down, Shift faster; arrows forward, back, turn: move-keys.ts) and one gesture language for mouse, trackpad and touch:
//   orbit: drag moves the map, right-drag turns and tilts, wheel zooms at the cursor, double-click flies there
//   walk:  first person; a click takes the mouse (pointer lock) and it looks, Space jumps, Esc flies up; 1, 2 and the
//          wheel choose a weapon, the left button fires (held: again at its rate), the right fires the
//          grappling hook (foot.ts hookShot)
//   walk on touch: the left thumb is a stick that walks (up ahead, sideways steps; pushed far, runs), the right thumb
//          drags to look, taps to fire once, held still fires on (touch/foot.ts)
//   ride:  following a pedestrian or a car; move keys step off onto foot (off a person: where they stood)
//   craft: a craft (craft.ts: the drone, the boat, the plane) owns the camera and the input; Nav leaves the keys, the
//          pointer to it. The car driven is a craft too, but on the ride's camera (mode ride)
//
// Nav is the mode machine and routes the input to the mode on: the map's own input is orbit.ts, on foot foot.ts, the
// ride and its camera ride.ts (following); the crafts are their own (craft.ts).
export type Mode = 'orbit' | 'walk' | 'ride' | 'craft';
export interface Ride extends Picked {
  view: 'eyes' | 'behind';
  dyaw: number;
  dpitch: number;
  idle: number;
}
export interface WalkOpts { at?: THREE.Vector3; exact?: boolean; facing?: THREE.Vector3; pitch?: number; ms?: number; deckOK?: boolean }

// On foot the camera stands a step from walls: the eyes keep 0.4 m from what is drawn of them (walk.ts eyeRoom). The
// map camera's near plane (0.5 m, main.ts) cut into them there; on foot it comes in to WALK_NEAR -- its frustum's
// corners ~0.33 m out at the walk's field of view, inside the 0.4 m -- and goes back on leaving. (The FPV drone takes 0.15 m alike, fpv.ts: the depth buffer's precision far off, ~d^2 /
// (near x 2^24), is then 2.5 x coarser than the map camera's, as the drone's has always been.)
const WALK_NEAR = 0.2;
// m between a craft left in the air and the top of the paraglider opened under it; m/s the paraglider flies at as
// it opens there (not the aircraft's: a jet's would be no glide)
const CANOPY_CLEAR = 0.5, BAIL_SPEED = 16;
// m a vehicle may stand over the ground beside it and still be stepped out of onto it; higher, it is in the air
const STEP_DOWN = 1.7;

export class Nav {
  mode: Mode = 'orbit';
  /** the player is down (their health at 0): the walk and the arms held still till the host has them back */
  held = false;
  /** the craft the player is in (craft.ts): in mode craft, or the car driven in mode ride */
  craft: PlayerCraft | null = null;
  readonly actors = new THREE.Group();
  world: World | null = null;
  streamer: TileStreamer | null = null;
  // the map's corner in the project grid (meta.origin): ?cam= links are in the project grid's coordinates
  origin: [number, number] = [0, 0];
  cancelFly: () => void = () => {};
  /** the mouse's lock taken by the browser (Esc while walking): the page opens its menu */
  onLockLost: () => void = () => {};
  /** the mouse taken again for the walk (the menu's Resume: a click on the button is the gesture it needs) */
  resumeMouse() { if (this.wantsMouse) this.requestMouse(); }
  /** the mouse taken (on foot, in a vehicle that takes it: PlayerCraft.mouse), unless the last input was a
   * finger or pen. The browser grants it only within a key press or click (a few seconds after one in Chrome);
   * refused, the next click on the view takes it */
  takeMouse() { if (this.mouseLast) this.requestMouse(); }
  // on foot or in a vehicle: the mouse aims or turns the view
  private get wantsMouse() { return this.onFoot || !!this.craft?.mouse; }
  // the vehicle that takes the mouse, as last seen (null: none): here alone the lock follows it, so a craft only says
  // whether it takes it (PlayerCraft.mouse) and none takes or gives back the mouse itself
  private craftMouse: PlayerCraft | null = null;
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
  /** while a vehicle is being got out of (getOut): where its shell asks the host to put the player down on foot, in
   * the same command that leaves the seat (leaveSeat's pose) */
  stepOut: WalkPose | null = null;
  /** the weapons on foot */
  readonly arms = new Arms();
  /** the paraglider's shell (main.ts): opened over the player's feet out of an aircraft (from) or a fall on foot,
   * folded away in the air (each false: not now); its grappling hook fired or let go */
  wing: (PlayerCraft & { open(at: Required<CraftSpot> & { speed: number }, from?: PlayerCraft): boolean; fold(): boolean; hookShot(): void }) | null = null;
  private hoverT = 0;
  private cursor: { x: number; y: number } | null = null; // the mouse over the map, for Ctrl+C (copySpot)
  private quietT = 0;
  private wheelT = 0;
  private walkStart: object | null = null;
  private mouseLook: { locked: boolean } | null = null;
  // the last input a key or the mouse (not a finger or pen: no mouse to take, the view is dragged)
  private mouseLast = true;
  private mapNear: number | null = null; // the camera's near plane before it went on foot (fitNear)
  private readonly footTouch: FootTouch;
  /** the grappling hook's line, drawn for the walk here and for the paraglider by its shell */
  readonly hookLine = new HookLine();

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly controls: OrbitControls, private readonly dom: HTMLElement,
    private readonly flyTo: (v: Pick<View, 'pos' | 'target'>) => void, private readonly onMode: (m: Mode, r: Ride | null) => void) {
    this.glide = new Glide(camera);
    this.orbit = new OrbitInput(camera, controls, this.keys, {
      world: () => this.world, hitAt: (cx, cy) => this.hitAt(cx, cy), flyTo: (v) => this.flyTo(v), land: (opts) => { this.setWalk(opts); },
    });
    dom.style.cursor = 'grab';
    this.foot = new Foot(camera, controls, this.keys, this.glide, () => this.world, (near) => this.life?.solids(near) ?? []);
    this.rider = new Rider({
      camera, controls, glide: this.glide, life: () => this.life, sim: () => this.sim, world: () => this.world,
    });
    this.actors.add(this.hookLine.mesh);
    this.bindKeys();
    this.bindPointer();
    this.footTouch = new FootTouch(dom, {
      start: () => this.cancelFly(),
      look: (dx, dy) => {
        const k = 2.4 * (this.camera.fov * Math.PI / 180) / innerHeight;
        // a stick, not a drag of the scene: right turns right (yaw grows to the left), up looks up
        this.look(-dx * k, dy * k * 0.7);
      },
      tap: (x, y) => this.tap(x, y),
      fire: () => this.arms.pull(),
    });
  }

  /** Space on foot (the touch Jump button) */
  jump() {
    if (this.onFoot) this.foot.jump();
  }

  /** the grappling hook fired on foot (the right button, the touch button) */
  hookShot() {
    if (this.onFoot && !this.held && this.world) this.foot.hookShot(this.world);
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
  // a touch on the screen is the drive's sticks' (drive.ts), but a passenger's: their seat has none, so it looks round
  // in a craft or at a car's wheel or seat: what takes the mouse (PlayerCraft.mouse)
  private get inVehicle() { return this.craftView || this.driving; }
  private get onSticks() { return this.driving && this.craft?.id !== 'passenger'; }
  /** a craft owns the camera and the input */
  get craftView() { return this.mode === 'craft'; }

  private bindKeys() {
    const K = this.keys;
    addEventListener('keydown', (e) => {
      if (!gameKey(e)) return;
      K.shift = e.shiftKey;
      // (Esc opens the menu, main.ts; a walk still coming is given up)
      if (e.code === 'Escape') { if (this.walkStart) this.releaseMouse(); return; }
      if (this.craftView || this.driving) return;
      if (this.onFoot && /^Digit\d$/.test(e.code)) { this.arms.select(+e.code.slice(5)); e.preventDefault(); return; }
      if (e.code === 'Space' && this.onFoot) { this.foot.jump(); e.preventDefault(); return; }
      const k = MoveKeys.of(e.code);
      if (!k) return;
      K.add(k);
      if (this.ride) this.hopOff();
      this.cancelFly();
      e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      K.shift = e.shiftKey;
      const k = MoveKeys.of(e.code);
      if (k) K.delete(k);
      if (this.orbit.turned && !K.turning) { this.orbit.turned = false; if (this.onMap) this.orbit.retarget(); }
    });
    onFocusLoss(() => { K.clear(); this.arms.trigger = false; });
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

  /** the mouse given back (out of a view that aims with it) */
  releaseMouse() {
    this.walkStart = null;
    this.mouseLook = null;
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  private lookWithMouse(e: MouseEvent) {
    // (a narrower view: the mouse turns it as much on the screen)
    const scale = 0.0027 * this.camera.fov / 65;
    // (yaw grows to the left: the mouse right turns right, up looks up)
    this.look(-e.movementX * scale, -e.movementY * scale * 0.8);
  }

  private bindPointer() {
    const dom = this.dom, ptrs = new Map<number, { x: number; y: number }>();
    let press: { x: number; y: number; t: number; button: number; moved: boolean } | null = null;
    let twist: number | null = null;
    const two = () => [...ptrs.values()];
    addEventListener('pointerdown', (e) => { this.mouseLast = e.pointerType === 'mouse'; }, { capture: true });
    addEventListener('keydown', () => { this.mouseLast = true; }, { capture: true });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === dom) {
        if (this.mouseLook) this.mouseLook.locked = true;
        else document.exitPointerLock();
      } else if (this.mouseLook?.locked) {
        this.releaseMouse();
        // the browser takes Esc to end the lock (the page may never see the key): the menu opens instead; a tab switch
        // or alt-tab also takes the lock, and must not. Focus and visibility settle a moment after the lock goes,
        // hence the wait.
        setTimeout(() => { if (document.hasFocus() && !document.hidden) this.onLockLost(); }, 150);
      }
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.mouseLook && !this.mouseLook.locked) this.mouseLook = null;
    });
    // (mouse events, not pointer events: a second button pressed while one is held is no pointerdown)
    dom.addEventListener('mousedown', (e) => {
      if (!this.onFoot || document.pointerLockElement !== dom) return;
      if (e.button === 0) this.arms.trigger = true;
      else if (e.button === 2) this.hookShot();
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.arms.trigger = false; });
    dom.addEventListener('mousemove', e => {
      if (document.pointerLockElement !== dom) return;
      if (this.onFoot) this.lookWithMouse(e);
      else if (this.craft && this.inVehicle) {
        // (a car's view is the ride's: turned as on foot, the mouse right to the right)
        if (this.craft.view === 'ride') this.lookWithMouse(e);
        else if (mouseTurns(this.craft)) this.craft.turnView?.(e.movementX, e.movementY);
      }
    });
    dom.addEventListener('pointerdown', (e) => {
      // (in a vehicle that takes the mouse: a click not yet locked takes it, the craft's own handler still fires)
      const locked = document.pointerLockElement === dom;
      if (this.inVehicle && this.craft?.mouse && e.pointerType === 'mouse' && !locked) this.requestMouse();
      if (this.craftView || ((this.onFoot || this.driving) && locked)) return;
      // on foot (back from another tab, or the lock refused): a click takes the mouse and is not lost: its button
      // fires at once
      if (this.onFoot && e.pointerType === 'mouse') {
        this.requestMouse();
        if (e.button === 0) this.arms.trigger = true;
        else if (e.button === 2) this.hookShot();
        return;
      }
      if ((this.onSticks || this.onFoot) && e.pointerType === 'touch') return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.onMap && (e.button === 2 || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) || ptrs.size === 2)) this.orbit.pivotAt(e.clientX, e.clientY);
      if (ptrs.size === 2) { const [a, b] = two(); twist = Math.atan2(b.y - a.y, b.x - a.x); }
      press = ptrs.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, moved: false } : null;
      if (!this.onMap) dom.setPointerCapture(e.pointerId);
      else dom.style.cursor = 'grabbing';
      this.cancelFly();
    });
    dom.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.cursor = { x: e.clientX, y: e.clientY };
      if ((this.onSticks || this.onFoot) && e.pointerType === 'touch') return;
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
      if (press && !press.moved) return;
      const k = (e.pointerType === 'touch' ? 2.4 : 1.2) * (this.camera.fov * Math.PI / 180) / innerHeight;
      this.look(dx * k, dy * k * 0.7);
    });
    const up = (e: PointerEvent) => {
      if (!ptrs.delete(e.pointerId)) return;
      if (ptrs.size < 2) twist = null;
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
    // (a trackpad sends a burst of small wheel events for one swipe: one slot each 200 ms)
    const now = performance.now();
    if (this.onFoot && e.deltaY && now - this.wheelT > 200) { this.wheelT = now; this.arms.cycle(Math.sign(e.deltaY)); }
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
    if (this.orbitFov) { this.camera.fov = this.orbitFov; this.camera.updateProjectionMatrix(); }
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
      // (the mouse kept: the craft taken over says whether it takes it, followCraftMouse)
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
    // (from foot: got in walking up to it, the seat already the host's: board.ts)
    if (!this.canStartCraft && !this.onFoot) return false;
    this.rememberSky();
    if (this.riding) {
      this.leaveRide(); // (the car driven parked: dropCraft)
      this.glide.stop();
    }
    this.toCraft(c);
    return true;
  }

  /** falling on foot high enough to open a canopy (Foot.canOpen) */
  get canOpen() { return this.onFoot && this.foot.canOpen; }

  // Out of the fall into a craft that opens over it (the paraglider). The craft's own request moves the player's seat
  // from the body to it in one command, so the body is not left (no leaveSeat). false: not falling high enough
  openCanopy(c: PlayerCraft) {
    if (!this.canOpen || c.view !== 'own') return false;
    this.body = null;
    this.glide.stop();
    this.toCraft(c);
    return true;
  }

  /** in the air on foot high enough (canOpen: a fall, a long jump off something high): the paraglider opened over
   * the body, flying the way the body went across (the opening takes the fall's speed down); false: not now */
  openWing() {
    if (!this.canOpen) return false;
    const f = this.foot, speed = Math.hypot(f.carry.x, f.carry.z);
    return !!this.wing?.open({ x: f.pos.x, y: f.feet, z: f.pos.z, h: speed > 1 ? Math.atan2(f.carry.x, f.carry.z) : f.yaw, speed });
  }

  // Out of the vehicle sat in (the paraglider let go, an aircraft left) into a free fall on foot from feet at `at` with velocity v,
  // facing yaw: at once, as the craft is gone this frame; the tiles where it lands asked for meanwhile
  fall(at: THREE.Vector3, v: { x: number; y: number; z: number }, yaw: number) {
    if (!this.inVehicle || !this.world) return false;
    this.foot.fallAt(at, v, yaw);
    this.streamer?.ensure(at.x, at.z, 200).catch(() => {});
    this.glide.start(250);
    this.mode = 'walk';
    this.leaveRide();
    this.controls.enabled = false;
    this.dom.style.cursor = 'default';
    this.onMode(this.mode, null);
    return true;
  }

  private toCraft(c: PlayerCraft) {
    this.cancelFly();
    this.keys.clear();
    this.orbit.turned = false;
    this.mode = 'craft';
    this.craft = c;
    this.controls.enabled = false;
    this.dom.style.cursor = 'default';
    this.onMode(this.mode, null);
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
      await this.setWalk(exitFrom(world, pose, ride.ref.kind === 'person' ? 0 : 2));
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

  /** out of the vehicle driven or the craft piloted onto foot beside it, the host putting the body down there as the
   * seat is left (stepOut), so the others see the player step out; in the air under a paraglider where one opens,
   * else falling from beside it; out of the paraglider by folding it away (a fall on foot); false: in none */
  getOut() {
    const w = this.world, c = this.craft, ride = this.driving ? this.ride : null;
    if (c && c === this.wing) return this.wing.fold();
    const pose = c && (ride ? this.life?.pose(ride.ref) : c.mapPose);
    if (!w || !c || !pose || this.walkPending) return false;
    if (this.underCanopy(w, c)) return true;
    const opts = exitFrom(w, pose, ride ? 2 : 3), at = opts.at!;
    if (!opts.exact && this.fallBeside(w, pose)) return true;
    this.stepOut = { x: at.x, y: at.y, z: at.z, h: Math.atan2(opts.facing!.x, opts.facing!.z), moving: false };
    // (the mouse taken within the key press or click that got out, as before boarding; kept from a gun)
    const entry = {};
    this.walkStart = entry;
    this.takeMouse();
    this.dropCraft();
    this.stepOut = null;
    void this.setWalk(opts).finally(() => {
      if (this.walkStart === entry) this.walkStart = null;
      if (!this.onFoot) this.releaseMouse();
    });
    return true;
  }

  // Out of an aircraft in the air (any seat in it: ALOFT) where a canopy would open on a fall: under a paraglider
  // opened just under it (its canopy clear of the craft's lowest box), as it flies on (owner 2026-11-27). Lower,
  // or with a wall in the canopy's way, a fall from beside it (fallBeside)
  private underCanopy(w: World, c: PlayerCraft) {
    const sim = this.sim, s = sim?.seat(), v = s?.entity.kind === 'craft' ? sim!.crafts().find((q) => q.id === s.entity.id) : null;
    if (!v || !aloft(v)) return false;
    const p = v.core.pose, under = Math.min(...craftSolids(v.type, p).map((b) => b.y)), top = Math.max(...meetShapes('paraglider').map((b) => b.top));
    const feet = under - CANOPY_CLEAR - top;
    return canopyOpens(w, p.x, p.z, feet) && !!this.wing?.open({ x: p.x, y: feet, z: p.z, h: p.h, speed: BAIL_SPEED }, c);
  }

  // Out of a vehicle in the air where no canopy opens (too low, a wall, no aircraft): beside it at its height and
  // falling from there with its velocity, never set down on the ground under it (owner 2026-11-28: "putting you
  // somewhere is wrong"). false: beside it the ground or the water is a step down, or there is no room round it
  private fallBeside(w: World, pose: Pose) {
    const sim = this.sim, e = sim?.seat()?.entity, v = e?.kind === 'craft' ? sim!.crafts().find((q) => q.id === e.id) : null;
    const boxes: Solid[] = v ? craftMeets(v.type, v.core.pose) : e?.kind === 'car' ? (this.life?.solids(pose) ?? []).filter((q) => q.id === `car${e.id}`) : [];
    const at = besideSolids(w, boxes, (x, z) => w.inside(x, z));
    if (!at || at.y - Math.max(w.support(at.x, at.z, at.y + 0.01), w.waterColumn(at.x, at.z)?.water ?? -Infinity) < STEP_DOWN) return false;
    this.stepOut = { ...at, h: pose.h, moving: false };
    // (the mouse taken within the key press or click that got out, as onto the ground)
    this.takeMouse();
    const out = this.fall(new THREE.Vector3(at.x, at.y, at.z), letGo(v?.core.velocity ?? { x: 0, y: 0, z: 0 }), pose.h);
    this.stepOut = null;
    return out;
  }

  /** the host has moved the player from their body on foot into a seat (board.ts): the body is not to be left again */
  tookSeat() { this.body = null; }

  startRide(ag: Picked) {
    // (the body on foot left before the ride's own seat is asked for: a seat taken from foot is the host's to reach)
    if (this.body) { this.body = null; this.sim?.send({ kind: 'leaveSeat' }); }
    this.rememberSky();
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
    this.footTouch.setActive(this.onFoot);
    this.fitNear();
    // (off foot: the body gone before a ride's own seat is asked for)
    if (!this.onFoot && this.body) { this.body = null; this.sim?.send({ kind: 'leaveSeat' }); }
    // (down: the line lets go)
    if (this.held) this.foot.unhook();
    if (this.onFoot && !this.held) this.foot.updateWalk(dt, this.footTouch.move);
    else if (this.onMap) this.orbit.update(dt);
    if (!this.craftView) this.hookLine.show(this.onFoot && this.foot.hook ? this.hand() : null, this.foot.anchor);
    if (this.onFoot) this.walkBody();
    this.dom.classList.toggle('underwater', this.onFoot && this.foot.under);
    this.followCraftMouse();
    // (after the walk's pose: the host fires from where it has just put the body)
    if (this.onFoot && !this.held) this.arms.update(dt, this.sim, this.foot.yaw, this.foot.pitch, this.camera, this.footTouch.trigger());
    else this.arms.trigger = false;
  }

  // where the line leaves the player on foot: low and right of the eyes, out of the crosshair's way
  private hand() {
    const cam = this.camera, dir = cam.getWorldDirection(new THREE.Vector3()), right = new THREE.Vector3().crossVectors(dir, cam.up).normalize();
    return cam.position.clone().addScaledVector(right, 0.25).addScaledVector(dir, 0.4).addScaledVector(new THREE.Vector3().crossVectors(right, dir), -0.3);
  }

  // (taken on the frame a vehicle takes it, still within the key press or click that brought it there, kept from
  // foot into a vehicle; given back off foot where nothing takes it, but not on the way out onto foot, which aims
  // with it too: getOut)
  private followCraftMouse() {
    // (each vehicle taken over asks again: a seat switched to by a key is the gesture a lock refused before needs)
    const m = this.inVehicle && this.craft?.mouse ? this.craft : null;
    if (m !== this.craftMouse) { this.craftMouse = m; if (m) this.takeMouse(); }
    if (!m && !this.onFoot && !this.walkStart && document.pointerLockElement === this.dom) this.releaseMouse();
  }

  // On foot the player is a body the world knows (an avatar: the others see it walk), moved by this walk: put down
  // when the walk starts, again after a jump of the walk (a landing elsewhere) or with a new session (the host
  // reconnected), then the walk's pose every frame; the walk stays this page's own, so it answers at once
  private walkBody() {
    const sim = this.sim;
    if (!sim) return;
    sim.results('walk');
    const f = this.foot, B = this.body, x = f.pos.x, z = f.pos.z;
    const pose = { x, y: f.feet, z, h: f.yaw, moving: !!B && Math.hypot(x - B.x, z - B.z) > 1e-3, arm: this.arms.slot, ...(f.swimming ? { swim: true } : {}), ...(f.hook ? { hook: f.hook } : {}) };
    if (!B || B.player !== sim.player || Math.hypot(x - B.x, z - B.z) > 5) sim.send({ kind: 'request', request: { kind: 'walk', pose } });
    else {
      const roof = f.roof();
      sim.send({ kind: 'seatInput', role: 'walker', input: roof ? { ...pose, roof } : pose });
    }
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
    else if (next) { const { view } = this.ride!; this.startRide(next); this.ride!.view = view; }
  }
}

// where to step out of what stands at pose: a side free to stand on (side m out from its middle, either side), else
// where it is (side 0: a person's place)
function exitFrom(world: World, pose: Pose, side: number): WalkOpts {
  const facing = new THREE.Vector3(Math.sin(pose.h), 0, Math.cos(pose.h));
  const at = new THREE.Vector3(pose.x, pose.y, pose.z);
  const out = new THREE.Vector3(-facing.z, 0, facing.x);
  const exits = side ? [at.clone().addScaledVector(out, side), at.clone().addScaledVector(out, -side)] : [at];
  const clear = exits.find(p => {
    const y = world.support(p.x, p.z, p.y + 1.02);
    // (from the voxel over the one stood on: a road's cap stands within its voxel, which is solid)
    return world.inside(p.x, p.z) && p.y - y < STEP_DOWN && !world.blocked(p.x, p.z, Math.ceil(y - 0.01), y + HEAD);
  });
  return clear ? { at: clear, exact: true, facing, ms: 540 } : { at, facing, ms: 650 };
}
