import type { Vector3 } from 'three';
import type { Meta } from '../types';
import { clamp, el } from '../util';
import type { CarInput } from '../physics/rapier/car';
import type { RapierDrive } from '../physics/rapier/drive-world';
import { flying, type Nav, type Ride } from './nav';
import { CRASH_MS, DriveSession, SINK_MS } from './drive-session';
import { stickAxis, TouchSticks } from './touch-sticks';
import { VEHICLE_IDS, VEHICLES, vehicleOf, type VehicleId } from '../sim/vehicles';
import './drive.css';

// The drive mode: the player takes the wheel of a traffic car, driven on Rapier (physics/rapier/drive-world.ts,
// loaded in the background once the city is shown; drive-session.ts: one drive). Here: the panel, the input, the
// camera's shake.
const RAPIER_AFTER_MS = 1500; // after the city is shown, Rapier is loaded (~1.7 MB gzip) when the page is idle

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']);
// what the player takes the wheel of (the type button, V): 'any', the traffic vehicle as it is, or a type of the
// catalog (sim/vehicles.ts) the vehicle taken becomes; remembered
const CHOICES: ('any' | VehicleId)[] = ['any', ...VEHICLE_IDS];
const CHOICE_KEY = 'voxel.drive.vehicle';
const readChoice = (): 'any' | VehicleId => {
  try { const v = localStorage.getItem(CHOICE_KEY); return CHOICES.includes(v as VehicleId) ? v as VehicleId : 'any'; } catch { return 'any'; }
};
// the touch stick's steering: |x|^STEER_CURVE, so a small deflection steers gently and the full one locks
const STEER_CURVE = 1.7;

export class DriveMode {
  private readonly touch: TouchSticks;
  // on a touch screen: one stick on the left (up gas, down brake then reverse, sideways steer), the handbrake under the
  // right thumb (held), and the right side's fingers pinch the camera (style.css #handbrake-button)
  private readonly handbrakeButton = el('button', '', 'Hand<br>brake');
  private readonly handbrakeHeld = new Set<number>();
  private readonly keys = new Set<string>();
  private readonly panel = document.createElement('aside');
  private readonly action = el('button', 'mode-button', '', this.panel);
  private readonly typeButton = el('button', 'mode-button drive-type', '', this.panel);
  private choice = readChoice();
  private readonly details = el('div', 'mode-detail', '', this.panel);
  private readonly status = el('div', 'drive-status', '', this.details);
  private readonly speed = el('div', 'drive-speed', '', this.details);
  private readonly help = el('div', 'drive-help', `
    <span class="drive-help-keys">W/S accelerate and brake/reverse · A/D steer · Space handbrake · T back on the road · Esc exit</span>
    <span class="drive-help-touch">Left thumb: drag up for gas, down to brake/reverse, sideways to steer. Hold the right button for the handbrake. Pinch on the right to zoom.</span>
  `, this.details);
  private pending: Ride | null = null;
  private driving: { ride: Ride; session: DriveSession } | null = null;
  private feedbackUntil = 0;
  private feedback = 'Contact';
  private rapier: RapierDrive | null = null;
  private rapierLoad: Promise<void> | null = null;
  private rapierMod: typeof import('../physics/rapier/drive-world') | null = null;

  constructor(private readonly nav: Nav, private readonly focus: Vector3, private readonly meta: Meta, host: HTMLElement, canvas: HTMLCanvasElement) {
    Object.assign(window, { __drive: this });
    setTimeout(() => {
      const idle = (window as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      if (idle) idle(() => this.loadRapier(), { timeout: 3000 }); else this.loadRapier();
    }, RAPIER_AFTER_MS);
    // two fingers close together pinch the chase camera in and out (at the eyes, the field of view; nav.ts zoomRide)
    // (the right side is the camera's: no stick, only the pinch, so a drive never steers from the right thumb)
    this.touch = new TouchSticks(canvas, { onPinch: ratio => this.nav.zoomRide(ratio), camera: 'right' });
    const hb = this.handbrakeButton;
    hb.id = 'handbrake-button';
    hb.type = 'button';
    hb.setAttribute('aria-label', 'Handbrake (hold)');
    hb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      hb.setPointerCapture(e.pointerId);
      this.handbrakeHeld.add(e.pointerId);
      hb.classList.add('held');
    });
    const release = (e: PointerEvent) => { this.handbrakeHeld.delete(e.pointerId); hb.classList.toggle('held', this.handbrakeHeld.size > 0); };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) hb.addEventListener(type, release);
    hb.addEventListener('contextmenu', (e) => e.preventDefault());
    this.panel.className = 'drive-mode';
    this.panel.setAttribute('aria-label', 'Drive a car');
    host.append(this.panel);
    this.status.setAttribute('role', 'status');
    this.action.type = 'button';
    this.action.addEventListener('click', () => { this.activate(); this.action.blur(); });
    this.typeButton.type = 'button';
    this.typeButton.title = 'What to drive (V)';
    this.typeButton.addEventListener('click', () => { this.cycleType(); this.typeButton.blur(); });
    addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as Element).closest?.('input, textarea, select, button, [contenteditable]')) return;
      if (e.code === 'KeyV' && !this.driving && !this.panel.hidden && !e.repeat) { this.cycleType(); e.preventDefault(); return; }
      if (!this.driving) return;
      if (e.code === 'KeyT') { if (!e.repeat) this.driving.session.reset(); e.preventDefault(); return; }
      if (!KEYS.has(e.code)) return;
      this.keys.add(e.code);
      e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    const clearInput = () => { this.keys.clear(); this.touch.clear(); this.handbrakeHeld.clear(); hb.classList.remove('held'); };
    addEventListener('blur', clearInput);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); });
    this.draw();
  }

  update(dt: number) {
    if (this.driving && this.nav.ride !== this.driving.ride) this.park();
    if (this.pending) this.prepare(this.pending);
    const session = this.driving?.session;
    if (session) {
      const now = performance.now();
      if (document.hasFocus() && !document.hidden) for (const n of session.update(dt, this.input(), now)) this.say(n.text, n.ms);
      session.present(now);
      this.shake(session, now);
    }
    this.draw();
  }

  // the camera shaken by a crash and dipped by a splash
  private shake(session: DriveSession, now: number) {
    const shake = this.nav.rideShake.set(0, 0, 0);
    const crash = (session.crashUntil - now) / CRASH_MS;
    if (crash > 0) {
      const a = 0.45 * crash * crash;
      shake.set(Math.sin(now * 0.071) * a, Math.sin(now * 0.093 + 1) * a, Math.sin(now * 0.057 + 2) * a);
    }
    const sink = (session.sinkUntil - now) / SINK_MS;
    if (sink > 0) shake.y -= 1.6 * Math.sin(Math.min(1, (1 - sink) * 4) * Math.PI / 2);
  }

  private activate() {
    if (this.driving) { this.park(); return; }
    if (flying(this.nav.mode)) return;
    if (this.nav.ride?.obj.kind !== 'car') {
      const life = this.nav.life;
      if (!life?.group.visible) return;
      const choice = life.nearest('car', this.focus, null);
      if (choice) this.nav.startRide(choice);
      else {
        const car = life.roadVehicles().find(c => c.rp);
        if (car) this.nav.startRide({ kind: 'car', obj: car, label: car.bus ? 'bus' : 'car' });
      }
    }
    if (this.nav.ride?.obj.kind === 'car') this.pending = this.nav.ride;
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
    this.nav.controlledRide = ride;
    this.touch.setActive(true);
    this.keys.clear();
    this.feedbackUntil = 0;
  }

  park() {
    if (!this.driving) return;
    this.driving.session.park();
    this.nav.rideShake.set(0, 0, 0);
    this.driving = null;
    this.nav.controlledRide = null;
    this.keys.clear();
    this.handbrakeHeld.clear();
    this.handbrakeButton.classList.remove('held');
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

  private say(message: string, ms: number) {
    this.feedback = message;
    this.feedbackUntil = performance.now() + ms;
  }

  private input(): CarInput {
    const pressed = (...codes: string[]) => Number(codes.some(code => this.keys.has(code)));
    let pad: Gamepad | undefined;
    try { pad = Array.from(navigator.getGamepads?.() ?? []).find(p => p?.connected && p.mapping === 'standard') ?? undefined; }
    catch { /* The keyboard still works when Gamepad API access is blocked. */ }
    const raw = pad?.axes[0] ?? 0;
    const stick = Math.sign(raw) * clamp((Math.abs(raw) - 0.12) / 0.88, 0, 1);
    // the one touch stick: up gas, down brake (below ~0.8 m/s reverse, car.ts), sideways steer on a curve
    const left = this.touch.left;
    const pedal = left ? clamp(stickAxis(left.dy, left.radius), -1, 1) : 0;
    const sx = left ? clamp(stickAxis(left.dx, left.radius), -1, 1) : 0;
    const steering = Math.sign(sx) * Math.abs(sx) ** STEER_CURVE;
    const handbrake = this.handbrakeHeld.size > 0;
    return {
      gas: Math.max(pressed('KeyW', 'ArrowUp'), pad?.buttons[7]?.value ?? 0, pedal),
      brake: Math.max(pressed('KeyS', 'ArrowDown'), pad?.buttons[6]?.value ?? 0, -pedal),
      steer: clamp(pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft') + stick + steering, -1, 1),
      handbrake: this.keys.has('Space') || !!pad?.buttons[0]?.pressed || handbrake,
    };
  }

  private draw() {
    const active = this.driving, following = this.nav.ride?.obj.kind === 'car';
    this.panel.hidden = flying(this.nav.mode);
    document.body.classList.toggle('driving', !!active);
    this.panel.classList.toggle('mode-active', !!(active || this.pending));
    const label = active ? `Park ${active.ride.obj.kind === 'car' ? vehicleOf(active.ride.obj).name.toLowerCase() : 'car'}` : 'Take the wheel';
    if (this.action.textContent !== label) this.action.textContent = label;
    this.typeButton.hidden = !!active || !!this.pending;
    const type = `Vehicle: ${this.choice === 'any' ? 'any' : VEHICLES[this.choice].name}`;
    if (this.typeButton.textContent !== type) this.typeButton.textContent = type;
    const life = this.nav.life;
    this.action.disabled = !!this.pending || (!active && (!life?.group.visible ||
      (!following && !life.roadVehicles().some(c => c.rp))));
    this.details.hidden = !active && !this.pending;
    this.speed.hidden = this.help.hidden = !active;
    this.status.hidden = !this.pending && !active;
    const message = this.pending && !this.rapier ? 'Loading physics…' :
      this.pending || active?.session.waiting ? 'Loading road collision tiles…' :
      performance.now() < this.feedbackUntil ? this.feedback : '';
    if (this.status.textContent !== message) this.status.textContent = message;
    if (active) {
      const speed = Math.round(Math.abs(active.session.kmh)) + ' km/h';
      if (this.speed.textContent !== speed) this.speed.textContent = speed;
    }
  }
}
