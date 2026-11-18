import { Vector3 } from 'three';
import type { StreetLife } from '../sim/life';
import type { Car, Pose } from '../sim/types';
import type { Meta } from '../types';
import { clamp, el } from '../util';
import { ArcadeCar, carsOverlap, type DriveInput, type RoadContact } from './arcade-car';
import type { Nav, Ride } from './nav';
import { VoxelCollision } from './voxel-collision';
import './drive.prototype.css';

const STEP = 1 / 90;
const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']);
const FOOTPRINT = [-1, 0, 1];
interface Driving {
  ride: Ride;
  life: StreetLife;
  car: Car;
  motion: ArcadeCar;
  displayHeight: number;
}

export class DrivePrototype {
  private readonly tiles: VoxelCollision;
  private readonly keys = new Set<string>();
  private readonly position = new Vector3();
  private readonly velocity = new Vector3();
  private readonly panel = document.createElement('aside');
  private readonly action = el('button', 'mode-button', '', this.panel);
  private readonly details = el('div', 'mode-detail', '', this.panel);
  private readonly status = el('div', 'drive-status', '', this.details);
  private readonly speed = el('div', 'drive-speed', '', this.details);
  private readonly help = el('div', 'drive-help', 'W/S accelerate and brake/reverse · A/D steer · Space handbrake · Esc exit', this.details);
  private pending: Ride | null = null;
  private driving: Driving | null = null;
  private accumulator = 0;
  private feedbackUntil = 0;
  private waiting = false;

  constructor(private readonly nav: Nav, private readonly focus: Vector3, meta: Meta, host: HTMLElement) {
    this.tiles = new VoxelCollision(meta);
    this.panel.className = 'drive-prototype';
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
    addEventListener('blur', () => this.keys.clear());
    this.draw();
  }

  update(dt: number) {
    if (this.driving && this.nav.ride !== this.driving.ride) this.park();
    if (this.pending) this.prepare(this.pending);
    const active = this.driving;
    if (active) {
      const { motion, car } = active;
      const { pose } = motion;
      this.position.set(pose.x, pose.y, pose.z);
      this.velocity.set(motion.vx, 0, motion.vz);
      this.tiles.prefetch(this.position, this.velocity);
      if (document.hasFocus() && !document.hidden) this.advance(active, dt);
      active.displayHeight += (pose.y - active.displayHeight) * (1 - Math.exp(-16 * dt));
      car.rp!.set(pose.x, active.displayHeight, pose.z);
      car.rh = pose.h;
      car.v = motion.vx * Math.sin(pose.h) + motion.vz * Math.cos(pose.h);
      car.brake = +motion.brake;
    }
    this.draw();
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

  private prepare(ride: Ride) {
    const life = this.nav.life, car = ride.obj;
    if (!life || ride !== this.nav.ride || car.kind !== 'car') { this.pending = null; return; }
    const pose = life.pose('car', car);
    if (!pose) { this.pending = null; return; }
    this.position.set(pose.x, pose.y, pose.z);
    this.tiles.prefetch(this.position, this.velocity.set(0, 0, 0));
    if (!this.tiles.roadSurface(pose.x, pose.z, pose.y, 1.45)) return;
    this.pending = null;
    if (!life.takeWheel(car)) return;
    this.driving = { ride, life, car, motion: new ArcadeCar(pose, car.v, car.bus), displayHeight: pose.y };
    this.nav.controlledRide = ride;
    this.keys.clear();
    this.accumulator = 0;
    this.feedbackUntil = 0;
    this.waiting = false;
  }

  park() {
    if (!this.driving) return;
    this.driving.car.v = 0;
    this.driving.car.brake = 1;
    this.driving = null;
    this.nav.controlledRide = null;
    this.keys.clear();
    this.waiting = false;
  }

  private advance(active: Driving, dt: number) {
    const { life, car, motion } = active;
    const p = motion.pose;
    const nearby: { pose: Pose; len: number }[] = [];
    for (const other of life.roadVehicles()) {
      const q = other.rp;
      if (other === car || !q || Math.abs(q.x - p.x) > 22 || Math.abs(q.z - p.z) > 22) continue;
      nearby.push({ pose: { x: q.x, y: q.y, z: q.z, h: other.rh ?? 0 }, len: other.len });
    }
    const input = this.input();
    const contact = (pose: Pose): RoadContact => {
      const ground = this.ground(pose, car);
      if (!ground || ground.blocked) return ground;
      for (const other of nearby) {
        if (!carsOverlap(pose, car.len, other.pose, other.len)) continue;
        // If an AI car nudges into ours, leave room to drive away from the overlap.
        const distance = (from: Pose) => (from.x - other.pose.x) ** 2 + (from.z - other.pose.z) ** 2;
        if (carsOverlap(p, car.len, other.pose, other.len) && distance(pose) > distance(p)) continue;
        return { height: ground.height, blocked: true };
      }
      return ground;
    };
    this.accumulator += clamp(dt, 0, 0.1);
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      const result = motion.step(input, STEP, contact);
      this.waiting = result === 'loading';
      if (this.waiting) { this.accumulator = 0; break; }
      if (result === 'impact') this.feedbackUntil = performance.now() + 350;
    }
  }

  private ground(p: Pose, car: Car): RoadContact {
    const clearance = car.bus ? 2.55 : 1.48;
    const center = this.tiles.roadSurface(p.x, p.z, p.y, clearance);
    if (!center || center.blocked) return center;
    if (p.y - center.height > 3) return { height: center.height, blocked: true };
    const sx = Math.sin(p.h), sz = Math.cos(p.h);
    const half = car.len / 2 - 0.17;
    for (const f of FOOTPRINT) for (const r of FOOTPRINT) {
      if (f === 0 && r === 0) continue;
      const x = p.x + f * sx * half + r * sz * 0.86;
      const z = p.z + f * sz * half - r * sx * 0.86;
      const sample = this.tiles.roadSurface(x, z, center.height, clearance);
      if (!sample) return null;
      if (sample.blocked) return { height: center.height, blocked: true };
    }
    return center;
  }

  private input(): DriveInput {
    const pressed = (...codes: string[]) => Number(codes.some(code => this.keys.has(code)));
    let pad: Gamepad | undefined;
    try { pad = Array.from(navigator.getGamepads?.() ?? []).find(p => p?.connected && p.mapping === 'standard') ?? undefined; }
    catch { /* The keyboard still works when Gamepad API access is blocked. */ }
    const raw = pad?.axes[0] ?? 0;
    const stick = Math.sign(raw) * clamp((Math.abs(raw) - 0.12) / 0.88, 0, 1);
    return {
      gas: Math.max(pressed('KeyW', 'ArrowUp'), pad?.buttons[7]?.value ?? 0),
      brake: Math.max(pressed('KeyS', 'ArrowDown'), pad?.buttons[6]?.value ?? 0),
      steer: clamp(pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft') + stick, -1, 1),
      handbrake: this.keys.has('Space') || !!pad?.buttons[0]?.pressed,
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
    const message = this.pending || this.waiting ? 'Loading road collision tiles…' :
      performance.now() < this.feedbackUntil ? 'Contact' : '';
    if (this.status.textContent !== message) this.status.textContent = message;
    if (active) {
      const speed = Math.round(active.motion.speed * 3.6) + ' km/h';
      if (this.speed.textContent !== speed) this.speed.textContent = speed;
    }
  }
}
