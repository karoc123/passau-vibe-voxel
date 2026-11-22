import type { Vector3 } from 'three';
import type { Meta } from '../types';
import { clamp } from '../util';
import type { CarInput } from '../physics/rapier/car';
import type { RapierDrive } from '../physics/rapier/drive-world';
import type { Nav, Ride } from './nav';
import type { CraftContext, PlayerCraft } from './craft';
import { CRASH_MS, DriveSession, SINK_MS } from './drive-session';
import { stickAxis, TouchSticks } from './touch-sticks';
import { VEHICLE_IDS, VEHICLES, vehicleOf, type VehicleId } from '../sim/vehicles';
import { gameKey, gamepad, HeldKeys, inFocus, onFocusLoss, padAxis, PAUSED } from './input';
import { shake } from './chase-rig';
import { HoldButton, ModePanel } from './mode-panel';
import './drive.css';

// The drive mode: the player takes the wheel of a traffic car, driven on Rapier (physics/rapier/drive-world.ts,
// loaded in the background once the city is shown; drive-session.ts: one drive). Here: the panel, the input, the
// camera's shake. A craft on the ride's camera (craft.ts): Nav follows the car taken and tells it when it is left (the
// car parks). Out of focus it holds still (input.ts).
const RAPIER_AFTER_MS = 1500; // after the city is shown, Rapier is loaded (~1.7 MB gzip) when the page is idle

const KEYS: ReadonlySet<string> = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']);
// what the player takes the wheel of (the type button, V): 'any', the traffic vehicle as it is, or a type of the
// catalog (sim/vehicles.ts) the vehicle taken becomes; remembered
const CHOICES: ('any' | VehicleId)[] = ['any', ...VEHICLE_IDS];
const CHOICE_KEY = 'voxel.drive.vehicle';
const readChoice = (): 'any' | VehicleId => {
  try { const v = localStorage.getItem(CHOICE_KEY); return CHOICES.includes(v as VehicleId) ? v as VehicleId : 'any'; } catch { return 'any'; }
};
// the touch stick's steering: |x|^STEER_CURVE, so a small deflection steers gently and the full one locks
const STEER_CURVE = 1.7;

export class DriveMode implements PlayerCraft {
  readonly id = 'drive';
  readonly view = 'ride';
  private readonly nav: Nav;
  private readonly focus: Vector3;
  private readonly meta: Meta;
  private readonly touch: TouchSticks;
  // on a touch screen: one stick on the left (up gas, down brake then reverse, sideways steer), the handbrake under the
  // right thumb (held), and the right side's fingers pinch the camera (style.css #handbrake-button)
  private readonly handbrake = new HoldButton('handbrake-button', 'Hand<br>brake', 'Handbrake (hold)');
  private readonly keys = new HeldKeys(KEYS);
  private readonly panel: ModePanel;
  private readonly action: HTMLButtonElement;
  private readonly typeButton: HTMLButtonElement;
  private choice = readChoice();
  private readonly speed: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private pending: Ride | null = null;
  private driving: { ride: Ride; session: DriveSession } | null = null;
  private rapier: RapierDrive | null = null;
  private rapierLoad: Promise<void> | null = null;
  private rapierMod: typeof import('../physics/rapier/drive-world') | null = null;

  constructor({ nav, target, meta, host, canvas }: CraftContext) {
    this.nav = nav; this.focus = target; this.meta = meta;
    Object.assign(window, { __drive: this });
    setTimeout(() => {
      const idle = (window as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      if (idle) idle(() => this.loadRapier(), { timeout: 3000 }); else this.loadRapier();
    }, RAPIER_AFTER_MS);
    // two fingers close together pinch the chase camera in and out (at the eyes, the field of view; nav.ts zoomRide)
    // (the right side is the camera's: no stick, only the pinch, so a drive never steers from the right thumb)
    this.touch = new TouchSticks(canvas, { onPinch: ratio => this.nav.zoomRide(ratio), camera: 'right' });
    const P = this.panel = new ModePanel(host, 'drive', 'Drive a car');
    this.action = P.button('', () => this.toggle());
    this.typeButton = P.button('', () => this.cycleType(), 'drive-type');
    this.typeButton.title = 'What to drive (V)';
    this.speed = P.line('speed');
    this.help = P.help('W/S accelerate and brake/reverse · A/D steer · Space handbrake · T back on the road · Esc exit',
      'Left thumb: drag up for gas, down to brake/reverse, sideways to steer. Hold the right button for the handbrake. Pinch on the right to zoom.');
    addEventListener('keydown', e => {
      if (!gameKey(e)) return;
      if (e.code === 'KeyV' && !this.driving && !this.nav.craftView && !e.repeat) { this.cycleType(); e.preventDefault(); return; }
      if (!this.driving) return;
      if (e.code === 'KeyT') { if (!e.repeat) this.driving.session.reset(); e.preventDefault(); return; }
      if (this.keys.press(e)) e.preventDefault();
    });
    onFocusLoss(() => this.touch.clear());
    this.draw();
  }

  update(dt: number) {
    if (this.pending) this.prepare(this.pending);
    const session = this.driving?.session;
    if (session) {
      const now = performance.now();
      if (inFocus()) for (const n of session.update(dt, this.input(), now)) this.panel.say(n.text, n.ms);
      session.present(now);
      this.shakeCamera(session, now);
    }
    this.draw();
  }

  // the camera shaken by a crash and dipped by a splash
  private shakeCamera(session: DriveSession, now: number) {
    const offset = this.nav.rideCamera.shake.set(0, 0, 0);
    const crash = (session.crashUntil - now) / CRASH_MS;
    if (crash > 0) shake(offset, 0.45 * crash * crash, now);
    const sink = (session.sinkUntil - now) / SINK_MS;
    if (sink > 0) offset.y -= 1.6 * Math.sin(Math.min(1, (1 - sink) * 4) * Math.PI / 2);
  }

  // the panel's button: take the wheel, or park
  private toggle() {
    if (this.driving) this.nav.leaveCraft();
    else this.enter();
  }

  // take the wheel of the car followed, else of the one nearest the focus (once Rapier is loaded: prepare)
  enter() {
    if (this.driving || this.nav.craftView) return false;
    if (this.nav.ride?.obj.kind !== 'car') {
      const life = this.nav.life;
      if (!life?.group.visible) return false;
      const choice = life.nearest('car', this.focus, null);
      if (choice) this.nav.startRide(choice);
      else {
        const car = life.roadVehicles().find(c => c.rp);
        if (car) this.nav.startRide({ kind: 'car', obj: car, label: car.bus ? 'bus' : 'car' });
      }
    }
    if (this.nav.ride?.obj.kind !== 'car') return false;
    this.pending = this.nav.ride;
    return true;
  }

  // takes the wheel once Rapier is loaded
  private prepare(ride: Ride) {
    const life = this.nav.life, car = ride.obj;
    if (!life || ride !== this.nav.ride || car.kind !== 'car') { this.pending = null; return; }
    const pose = life.pose('car', car);
    if (!pose) { this.pending = null; return; }
    const rap = this.rapier, m = this.rapierMod;
    if (!rap || !m) { this.loadRapier(); return; }
    this.pending = null;
    if (!life.takeWheel(car)) return;
    // (out of the traffic now: it becomes the type chosen)
    if (this.choice !== 'any') {
      const t = VEHICLES[this.choice];
      car.vt = t.id === 'car' || t.id === 'bus' ? undefined : t.id;
      car.bus = t.id === 'bus';
      car.len = t.len;
      if (t.paint) car.col = t.paint;
    }
    // (a car parked on its side or roof is taken as it lies)
    const at = car.rp ?? pose;
    const start = { x: at.x, y: at.y, z: at.z, h: car.rh ?? pose.h, pitch: car.pitch ?? 0, roll: car.roll ?? 0 };
    this.driving = { ride, session: new DriveSession(life, car, rap, m.buildOf(car), start, performance.now()) };
    this.nav.enterCraft(this);
    this.touch.setActive(true);
    this.keys.clear();
    this.panel.silence();
  }

  // left (Park, the map, a walk, another ride or craft): the car parks where it is
  leave() {
    if (!this.driving) return;
    this.driving.session.park();
    this.nav.rideCamera.shake.set(0, 0, 0);
    this.driving = null;
    this.keys.clear();
    this.handbrake.release();
    this.touch.setActive(false);
  }

  private loadRapier() {
    if (this.rapierLoad) return;
    this.rapierLoad = import('../physics/rapier/drive-world').then(async (m) => {
      this.rapierMod = m;
      const f = this.focus;
      this.rapier = await m.loadRapierDrive(this.meta, { x: f.x, z: f.z });
    }).catch((e) => { console.warn('rapier', e); });
  }

  private cycleType() {
    this.choice = CHOICES[(CHOICES.indexOf(this.choice) + 1) % CHOICES.length];
    try { localStorage.setItem(CHOICE_KEY, this.choice); } catch { /* not remembered */ }
    this.draw();
  }

  private input(): CarInput {
    const pressed = (...codes: string[]) => this.keys.any(...codes);
    const pad = gamepad(), stick = padAxis(pad?.axes[0]);
    // the one touch stick: up gas, down brake (below ~0.8 m/s reverse, car.ts), sideways steer on a curve
    const left = this.touch.left;
    const pedal = left ? clamp(stickAxis(left.dy, left.radius), -1, 1) : 0;
    const sx = left ? clamp(stickAxis(left.dx, left.radius), -1, 1) : 0;
    const steering = Math.sign(sx) * Math.abs(sx) ** STEER_CURVE;
    const handbrake = this.handbrake.held;
    return {
      gas: Math.max(pressed('KeyW', 'ArrowUp'), pad?.buttons[7]?.value ?? 0, pedal),
      brake: Math.max(pressed('KeyS', 'ArrowDown'), pad?.buttons[6]?.value ?? 0, -pedal),
      steer: clamp(pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft') + stick + steering, -1, 1),
      handbrake: this.keys.has('Space') || !!pad?.buttons[0]?.pressed || handbrake,
    };
  }

  private draw() {
    const active = this.driving, following = this.nav.ride?.obj.kind === 'car', P = this.panel;
    P.active = !!(active || this.pending);
    ModePanel.text(this.action, active ? `Park ${active.ride.obj.kind === 'car' ? vehicleOf(active.ride.obj).name.toLowerCase() : 'car'}` : 'Take the wheel');
    this.typeButton.hidden = !!active || !!this.pending;
    ModePanel.text(this.typeButton, `Vehicle: ${this.choice === 'any' ? 'any' : VEHICLES[this.choice].name}`);
    const life = this.nav.life;
    this.action.disabled = !!this.pending || (!active && (!life?.group.visible ||
      (!following && !life.roadVehicles().some(c => c.rp))));
    P.details.hidden = !active && !this.pending;
    this.speed.hidden = this.help.hidden = !active;
    P.status.hidden = !this.pending && !active;
    ModePanel.text(P.status, this.pending && !this.rapier ? 'Loading physics…' :
      this.pending || active?.session.waiting ? 'Loading road collision tiles…' :
      active && !inFocus() ? PAUSED : P.saying);
    if (active) ModePanel.text(this.speed, Math.round(Math.abs(active.session.kmh)) + ' km/h');
  }
}
