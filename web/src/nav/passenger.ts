import * as THREE from 'three';
import { clamp } from '../core/num';
import type { SimClient } from '../client/sim-client';
import type { EntityRef } from '../sim/contract/ids';
import type { Pose } from '../sim/contract/pose';
import { CORES } from '../sim/craft/cores';
import { CRAFT_SCALE, type CraftKind } from '../sim/craft/craft-motion';
import { VoxelCollision } from '../sim/craft/voxel-collision';
import { ChaseRig, clearShare, followAngle } from './chase-rig';
import type { CraftContext, PlayerCraft } from './craft';
import { gameKey } from './input';
import { ModePanel } from './mode-panel';
import { SEAT_NEAR, seatEye, seatPlace } from '../view/seats';
import { mountOf, mountPoint, SEATS, type Mount } from '../sim/seats';
import { weaponById } from '../sim/weapons';
import { aimDir } from '../sim/weapons/weapon';
import { aimPoint, GunAim } from './gunner';
import { HOLD, SLOP } from '../touch/foot';
import './special-craft.css';

// Riding along in another player's car or craft (a passenger's seat, taken from foot: board.ts). The input steers
// nothing: the host takes no seat input of a passenger's. In a craft this shell owns the camera (its chase view or
// the seat's, looked round by dragging); in a car Nav's ride camera follows the car. The seat lost under it (the craft
// taken away: the host has put the player on foot beside it) ends the ride on foot there. A seat with a mount is a
// gunner's: the seat view only, aimed with the mouse taken (a drag on touch, a tap fires), the left button fires.

const CS = CRAFT_SCALE.helicopter, UP = new THREE.Vector3(0, 1, 0);
// the chase camera's distances as the pilot's (special-craft.ts)
const VIEW: Record<string, { back: number; up: number; look: number }> = {
  hovercraft: { back: 22, up: 7.5, look: 1.8 },
  helicopter: { back: 17 * CS, up: 6 * CS, look: 1.2 * CS },
  gunship: { back: 22, up: 7.5, look: 1.5 },
  boat: { back: 9.5, up: 3.4, look: 1 },
};
// the seat not seen held for this long after boarding: refused late or lost before the first snapshot
const SEAT_MS = 2500;

type Riding = { ref: EntityRef & { kind: 'car' | 'craft' }; type: string; label: string; at: number; seen: boolean };

export class PassengerMode implements PlayerCraft {
  readonly id = 'passenger';
  private readonly panel: ModePanel;
  private readonly help: HTMLDivElement;
  private readonly gunHelp: HTMLDivElement;
  private readonly rig: ChaseRig;
  private sim: SimClient | null = null;
  private riding: Riding | null = null;
  // the seat gone under the player: on foot near the last pose (the walk's tiles awaited)
  private out = false;
  private col: VoxelCollision | null = null;
  private last: Pose | null = null;
  private seatView = false;
  // the camera's near plane before the seat view shortened it
  private savedNear: number | null = null;
  private yaw = 0;
  private dyaw = 0;
  private dpitch = 0;
  private zoom = 1;
  // (x0, y0, t: where and when it went down; held: a thumb on the gun's trigger)
  private drag: { id: number; x: number; y: number; x0: number; y0: number; t: number; touch: boolean; moved: boolean; held: boolean } | null = null;
  private readonly pos = new THREE.Vector3();
  private readonly at = new THREE.Vector3();
  private readonly off = new THREE.Vector3();
  // the mount at the seat held (null: none), the aim on it, the mouse's trigger
  private gun: Mount | null = null;
  private readonly aim = new GunAim();
  private trigger = false;

  constructor(private readonly ctx: CraftContext) {
    const { canvas, host, camera, sim } = ctx;
    void sim.then((s) => { this.sim = s; }, () => {});
    this.rig = new ChaseRig(camera);
    this.panel = new ModePanel(host, 'passenger', 'Riding along');
    this.panel.el.classList.add('special-craft');
    this.help = this.panel.help('Drag: look around · Wheel: zoom · V: seat or chase view · E: get out · Esc: menu',
      'Drag to look around, pinch to zoom; the View button swaps the seat\'s view and the chase view, the Get out button leaves.');
    this.gunHelp = this.panel.help('Mouse: aim · Left button: fire (a click takes the mouse) · C: next seat · E: get out',
      'Drag to aim, tap to fire, hold to keep firing; the Get out button leaves.');
    addEventListener('keydown', (e) => {
      if (!this.riding || e.code !== 'KeyV' || e.repeat || !gameKey(e)) return;
      this.swapView();
      e.preventDefault();
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.ownsCamera || this.drag) return;
      // (at a gun a click fires, also the one that takes the mouse: Nav)
      if (this.gun && e.pointerType === 'mouse') {
        if (e.button === 0) this.trigger = true;
        return;
      }
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now(), touch: e.pointerType === 'touch', moved: false, held: false };
    });
    addEventListener('pointermove', (e) => {
      if (document.pointerLockElement === canvas) return;
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > SLOP) d.moved = true;
      if (this.gun) this.turnGun(-(e.clientX - d.x) * 0.005, -(e.clientY - d.y) * 0.004);
      else {
        this.dyaw -= (e.clientX - d.x) * 0.005;
        this.dpitch = clamp(this.dpitch - (e.clientY - d.y) * 0.004, -1.2, 1.2);
      }
      d.x = e.clientX; d.y = e.clientY;
    });
    addEventListener('pointerup', (e) => { if (e.button === 0) this.trigger = false; });
    const up = (e: PointerEvent) => {
      // (a tap at a gun: one shot)
      if (this.drag?.id === e.pointerId && this.gun && !this.drag.moved && !this.drag.held && e.type === 'pointerup') this.ctx.nav.arms.pull();
      if (this.drag?.id === e.pointerId) this.drag = null;
    };
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => {
      if (!this.ownsCamera) return;
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.004), 0.5, 2.5);
      e.preventDefault();
    }, { passive: false });
    this.draw();
  }

  /** the seat's view for the chase view or back (V, the touch button) */
  swapView() {
    if (!this.riding) return;
    const R = this.riding.ref.kind === 'car' ? this.ctx.nav.ride : null;
    if (R) R.view = R.view === 'eyes' ? 'behind' : 'eyes';
    else this.seatView = !this.seatView;
    this.dyaw = this.dpitch = 0;
  }

  /** in a car Nav's ride camera follows it; in a craft this shell's own */
  get view(): 'own' | 'ride' { return this.riding?.ref.kind === 'car' ? 'ride' : 'own'; }

  get inSeat() {
    const R = this.riding;
    return !!R && !this.out && (R.ref.kind === 'craft' ? this.seatView || !!this.gun : this.ctx.nav.ride?.view === 'eyes');
  }

  get mouse() { return !!this.riding && !this.out; }

  turnView(dx: number, dy: number) {
    if (this.gun) this.turnGun(-dx * 0.0025, -dy * 0.0025);
    else {
      this.dyaw -= dx * 0.005;
      this.dpitch = clamp(this.dpitch - dy * 0.004, -1.2, 1.2);
    }
  }

  private get ownsCamera() { return !!this.riding && this.riding.ref.kind === 'craft' && !this.out; }

  get mapPose(): Pose | null { return this.riding ? this.last : null; }

  /** only from foot, through ride(): there is no passenger's seat to start one from the map */
  enter() { return false; }

  /** in the seat the host has just given the player (board.ts): a car being followed already (Nav's ride), or a craft;
   * from: the shell of the seat held before in the same craft (a seat switch). false: not now */
  ride(ref: EntityRef & { kind: 'car' | 'craft' }, type: string, label: string, from?: PlayerCraft) {
    if (this.riding || !this.sim) return false;
    this.riding = { ref, type, label, at: performance.now(), seen: false };
    this.out = false;
    this.last = this.poseNow();
    if (!this.ctx.nav.enterCraft(this, from)) { this.riding = null; return false; }
    this.seatView = false;
    this.dyaw = this.dpitch = 0;
    this.zoom = 1;
    this.yaw = this.last?.h ?? 0;
    this.gun = null;
    if (ref.kind === 'craft') {
      const t = this.ctx.tiles;
      this.col = new VoxelCollision(t.meta, t.cache, t.now, CORES[type as CraftKind](this.sim!.tuning).reach);
      this.rig.begin(450);
    }
    this.panel.silence();
    this.draw();
    return true;
  }

  leave() {
    const R = this.riding;
    if (!R) return;
    // (put out by the host already: its walk is the body now, which a leaveSeat would take away)
    if (this.holds(R)) this.sim?.send({ kind: 'leaveSeat', pose: this.ctx.nav.stepOut ?? undefined });
    this.riding = null;
    this.out = false;
    this.drag = null;
    this.armGun(null);
    this.col?.release();
    this.col = null;
    if (R.ref.kind === 'craft') this.rig.end();
    this.near(false);
    this.draw();
  }

  update(dt: number) {
    const R = this.riding, sim = this.sim;
    if (R && !this.out) {
      const pose = this.poseNow();
      if (pose) this.last = pose;
      if (this.last && this.col) this.col.prefetch(this.last, { x: 0, y: 0, z: 0 });
      if (this.holds(R)) R.seen = true;
      else if (R.seen || performance.now() - R.at > SEAT_MS) this.putOut(R);
    }
    const s = R && !this.out && R.ref.kind === 'craft' && this.holds(R) ? sim!.seat() : null;
    this.armGun(s ? mountOf(SEATS.craft[R!.type as CraftKind], s) : null);
    const m = this.gun, p = this.last, w = m && weaponById(m.weapon);
    if (m && p && w && sim) {
      // a thumb held still past HOLD is on the trigger until it lifts, and may then drag to sweep: the gesture on foot
      const d = this.drag;
      if (d?.touch && !d.moved && performance.now() - d.t >= HOLD) d.held = true;
      this.aim.turn(m, p.h);
      const from = mountPoint(m, p), dir = aimDir(this.aim.h, this.aim.pitch), nav = this.ctx.nav;
      nav.arms.update(dt, sim, this.aim.h, this.aim.pitch, this.ctx.camera, this.trigger || !!d?.held, { slot: w.slot, to: () => aimPoint(sim, nav.world, from, dir) });
    }
    this.draw();
  }

  // the mount at the seat now held (null: none): on it, the seat view aimed along its middle and the crosshair shown
  private armGun(m: Mount | null) {
    if (m === this.gun) return;
    this.gun = m;
    this.trigger = false;
    if (m && this.last) this.aim.reset(m, this.last.h);
    document.body.classList.toggle('gunner', !!m);
    if (!m) document.body.classList.remove('gun-stop');
  }

  private turnGun(dh: number, dp: number) {
    if (this.gun && this.last) this.aim.turn(this.gun, this.last.h, dh, dp);
  }

  place(dt: number) {
    const R = this.riding;
    if (!R || R.ref.kind !== 'craft' || !this.last) return;
    const v = VIEW[R.type] ?? VIEW.hovercraft, p = this.last;
    this.yaw = followAngle(this.yaw, p.h, 4, dt);
    const yaw = this.yaw + this.dyaw, dir = this.off.set(Math.sin(yaw) * Math.cos(this.dpitch), Math.sin(this.dpitch), Math.cos(yaw) * Math.cos(this.dpitch));
    let fov = 58;
    const seat = this.sim?.passengers().find(([kind, id, player]) => kind === 'craft' && id === R.ref.id && player === this.sim?.player);
    const place = seat ? seatPlace('craft', R.type, seat[3]) : null;
    const gun = this.gun;
    this.near(this.seatView || !!gun);
    if (gun) {
      // (at the mount, where the host's shot leaves from, looking along the aim)
      const e = mountPoint(gun, p), a = aimDir(this.aim.h, this.aim.pitch);
      this.pos.set(e.x, e.y, e.z);
      this.at.copy(this.pos).add(this.off.set(a.x, a.y, a.z));
      fov = clamp(70 * this.zoom, 40, 90);
      document.body.classList.toggle('gun-stop', this.aim.stop);
    } else if (this.seatView) {
      // (at the own seat's eyes, turned with the craft's heading)
      const e = place ? seatEye(place) : { x: 0, y: v.look, z: 0 };
      this.pos.set(e.x, e.y, e.z).applyAxisAngle(UP, p.h).add(this.at.set(p.x, p.y, p.z));
      this.at.copy(this.pos).add(dir);
      fov = clamp(70 * this.zoom, 40, 90);
    } else {
      this.at.set(p.x, p.y + v.look, p.z);
      // (behind and over it, swung round by the drag)
      const back = this.off.set(-Math.sin(yaw) * v.back, v.up - Math.sin(this.dpitch) * v.back, -Math.cos(yaw) * v.back).multiplyScalar(this.zoom);
      this.pos.copy(this.at);
      this.pos.addScaledVector(back, this.col ? clearShare(this.col.sweep(this.pos, back), back, 0.12, 0.25) : 1);
    }
    const cam = this.rig.place(this.pos, this.rig.look(this.pos, this.at), fov, dt);
    this.ctx.target.copy(cam.position).addScaledVector(cam.getWorldDirection(this.off), 10);
  }

  // the seat view's near plane (seats.ts SEAT_NEAR) while on, the camera's own back once off
  private near(on: boolean) {
    const cam = this.ctx.camera;
    if (on && this.savedNear === null) this.savedNear = cam.near;
    else if (on || this.savedNear === null) return;
    cam.near = on ? SEAT_NEAR : this.savedNear;
    if (!on) this.savedNear = null;
    cam.updateProjectionMatrix();
  }

  // whether the host still has the player in R's passenger seat
  private holds(R: Riding) {
    const s = this.sim?.seat();
    return !!s && s.role === 'passenger' && s.entity.kind === R.ref.kind && s.entity.id === R.ref.id;
  }

  // where the car or craft is drawn this frame, or null when it is not seen
  private poseNow(): Pose | null {
    const R = this.riding, sim = this.sim;
    if (!R || !sim) return null;
    if (R.ref.kind === 'car') return this.ctx.nav.life?.pose({ kind: 'car', id: R.ref.id }) ?? null;
    const c = sim.crafts().find((q) => q.id === R.ref.id);
    if (!c) return null;
    const d = c.core.drawn(sim.time.alpha) as Pose;
    return { x: d.x, y: d.y, z: d.z, h: d.h };
  }

  // the seat gone: on foot on the ground near where it was last (the host has put the body there already)
  private putOut(R: Riding) {
    this.out = true;
    this.near(false);
    const nav = this.ctx.nav, p = this.last;
    this.panel.say(`Out of the ${R.label}: it is gone.`, 3000);
    if (!p) { nav.flyUp(); return; }
    const back = () => { if (this.riding === R) nav.flyUp(); };
    void nav.setWalk({ at: new THREE.Vector3(p.x, p.y, p.z), facing: new THREE.Vector3(Math.sin(p.h), 0, Math.cos(p.h)) }).then(back, back);
  }

  private draw() {
    const R = this.riding;
    this.panel.active = !!R;
    this.panel.el.hidden = !R && !this.panel.saying;
    this.help.hidden = !R || !!this.gun;
    this.gunHelp.hidden = !R || !this.gun;
    ModePanel.text(this.panel.status, this.panel.saying || (R ? this.gun ? `At the gun of the ${R.label}` : `Riding along in the ${R.label}` : ''));
  }
}
