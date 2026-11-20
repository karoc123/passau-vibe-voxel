import type { Vector3 } from 'three';
import type { Meta } from '../types';
import { clamp, el } from '../util';
import type { CarInput } from '../physics/rapier/car';
import type { RapierDrive } from '../physics/rapier/drive-world';
import type { Nav, Ride } from './nav';
import { CRASH_MS, DriveSession, SINK_MS } from './drive-session';
import { stickAxis, TouchSticks } from './touch-sticks';
import './drive.css';

// The drive mode: the player takes the wheel of a traffic car, driven on Rapier (physics/rapier/drive-world.ts,
// loaded in the background once the city is shown; drive-session.ts: one drive). Here: the panel, the input, the
// camera's shake.
const RAPIER_AFTER_MS = 1500; // after the city is shown, Rapier is loaded (~1.7 MB gzip) when the page is idle

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']);
const HANDBRAKE_THRESHOLD = 0.75;

export class DriveMode {
  private readonly touch: TouchSticks;
  private readonly keys = new Set<string>();
  private readonly panel = document.createElement('aside');
  private readonly action = el('button', 'mode-button', '', this.panel);
  private readonly details = el('div', 'mode-detail', '', this.panel);
  private readonly status = el('div', 'drive-status', '', this.details);
  private readonly speed = el('div', 'drive-speed', '', this.details);
  private readonly help = el('div', 'drive-help', `
    <span class="drive-help-keys">W/S accelerate and brake/reverse · A/D steer · Space handbrake · Esc exit</span>
    <span class="drive-help-touch">Drag left thumb up for gas or down to brake/reverse. Drag right thumb sideways to steer or down for the handbrake.</span>
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
    this.touch = new TouchSticks(canvas);
    this.panel.className = 'drive-mode';
    this.panel.setAttribute('aria-label', 'Drive a car');
    host.append(this.panel);
    this.status.setAttribute('role', 'status');
    this.action.type = 'button';
    this.action.addEventListener('click', () => { this.activate(); this.action.blur(); });
    addEventListener('keydown', e => {
      if (!this.driving || !KEYS.has(e.code) || e.ctrlKey || e.metaKey || e.altKey ||
          (e.target as Element).closest?.('input, textarea, select, button, [contenteditable]')) return;
      this.keys.add(e.code);
      e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    const clearInput = () => { this.keys.clear(); this.touch.clear(); };
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
      session.present();
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
    if (this.nav.mode === 'fpv') return;
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
    // (a car parked on its side or roof is taken as it lies)
    const at = car.rp ?? pose;
    const start = { x: at.x, y: at.y, z: at.z, h: car.rh ?? pose.h, pitch: car.pitch ?? 0, roll: car.roll ?? 0 };
    this.driving = { ride, session: new DriveSession(life, car, rap, m.buildFor(car.bus, car.len), start, performance.now()) };
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
    this.touch.setActive(false);
  }

  private loadRapier() {
    if (this.rapierLoad) return;
    const t0 = performance.now();
    this.rapierLoad = import('../physics/rapier/drive-world').then(async (m) => {
      this.rapierMod = m;
      const f = this.focus;
      this.rapier = await m.loadRapierDrive(this.meta, { x: f.x, z: f.z });
      (window as unknown as { __rapierLoadMs: number }).__rapierLoadMs = performance.now() - t0;
    }).catch((e) => { console.warn('rapier', e); });
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
    const { left, right } = this.touch;
    const pedal = left ? clamp(stickAxis(left.dy, left.radius), -1, 1) : 0;
    const steering = right ? clamp(stickAxis(right.dx, right.radius), -1, 1) : 0;
    const handbrake = !!right && stickAxis(-right.dy, right.radius) >= HANDBRAKE_THRESHOLD;
    return {
      gas: Math.max(pressed('KeyW', 'ArrowUp'), pad?.buttons[7]?.value ?? 0, pedal),
      brake: Math.max(pressed('KeyS', 'ArrowDown'), pad?.buttons[6]?.value ?? 0, -pedal),
      steer: clamp(pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft') + stick + steering, -1, 1),
      handbrake: this.keys.has('Space') || !!pad?.buttons[0]?.pressed || handbrake,
    };
  }

  private draw() {
    const active = this.driving, following = this.nav.ride?.obj.kind === 'car';
    this.panel.hidden = this.nav.mode === 'fpv';
    document.body.classList.toggle('driving', !!active);
    this.panel.classList.toggle('mode-active', !!(active || this.pending));
    const label = active ? 'Park car' : 'Take the wheel';
    if (this.action.textContent !== label) this.action.textContent = label;
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
