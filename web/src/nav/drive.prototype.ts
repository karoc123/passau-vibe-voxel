import { Vector3 } from 'three';
import type { StreetLife } from '../sim/life';
import type { Car, Pose } from '../sim/types';
import type { Meta } from '../types';
import { clamp, el } from '../util';
import type { PhysicsWorld } from '../physics/body';
import { ArcadeCar, carsOverlap, type DriveInput, type RoadContact } from './arcade-car';
import type { Nav, Ride } from './nav';
import { stickAxis, TouchSticks } from './touch-sticks';
import { VoxelCollision } from './voxel-collision';
import { airWorld, carGround, STEP } from './car-contact';
import type { Obstacle, RapierDrive, Walker } from '../physics/rapier/drive';
import './drive.prototype.css';

// The car's physics: Rapier's (physics/rapier/drive.ts, loaded in the background once the city is shown) unless
// ?physics=a: variant A (arcade-car.ts with physics/body.ts in the air)
const PHYSICS: 'rapier' | 'a' = new URLSearchParams(location.search).get('physics') === 'a' ? 'a' : 'rapier';
const RAPIER_AFTER_MS = 1500; // after the city is shown, Rapier is loaded (~1.7 MB gzip) when the page is idle

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']);
const HANDBRAKE_THRESHOLD = 0.75;
const MAX_TILT = 0.4; // rad: pitch and roll from the wheels' ground
const SINK_MS = 2000; // in the river this long, then back on the road
const CRASH_MS = 1100; // after a crash landing: shaken, no input
const NO_INPUT: DriveInput = { gas: 0, brake: 0, steer: 0, handbrake: false };

interface Driving {
  ride: Ride;
  life: StreetLife;
  car: Car;
  motion: ArcadeCar; // variant A's (not stepped on Rapier)
  rapier: RapierDrive | null; // Rapier's world, the car in it
  displayHeight: number;
  pitch: number;
  roll: number;
  squash: number; // m the body dips on its springs after a landing
  squashV: number;
  safe: { pose: Pose; t: number }[]; // recent poses on the road, to come back to from the river
  sinkUntil: number;
  crashUntil: number;
}

export class DrivePrototype {
  private readonly tiles: VoxelCollision;
  private readonly touch: TouchSticks;
  private readonly keys = new Set<string>();
  private readonly position = new Vector3();
  private readonly velocity = new Vector3();
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
  private driving: Driving | null = null;
  private accumulator = 0;
  private feedbackUntil = 0;
  private feedback = 'Contact';
  private waiting = false;
  private readonly air: PhysicsWorld;
  private rapier: RapierDrive | null = null;
  private rapierLoad: Promise<void> | null = null;
  private rapierMod: typeof import('../physics/rapier/drive') | null = null;
  private lastInput: DriveInput = NO_INPUT;

  constructor(private readonly nav: Nav, private readonly focus: Vector3, private readonly meta: Meta, host: HTMLElement, canvas: HTMLCanvasElement) {
    this.tiles = new VoxelCollision(meta);
    this.air = airWorld(this.tiles);
    Object.assign(window, { __drive: this });
    if (PHYSICS === 'rapier') setTimeout(() => {
      const idle = (window as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      if (idle) idle(() => this.loadRapier(meta), { timeout: 3000 }); else this.loadRapier(meta);
    }, RAPIER_AFTER_MS);
    this.touch = new TouchSticks(canvas);
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
    const clearInput = () => { this.keys.clear(); this.touch.clear(); };
    addEventListener('blur', clearInput);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); });
    this.draw();
  }

  update(dt: number) {
    if (this.driving && this.nav.ride !== this.driving.ride) this.park();
    if (this.pending) this.prepare(this.pending);
    const active = this.driving;
    if (active?.rapier) {
      if (document.hasFocus() && !document.hidden) this.advanceRapier(active, active.rapier, dt);
      this.presentRapier(active, active.rapier);
    } else if (active) {
      const { motion } = active;
      const { pose } = motion;
      this.position.set(pose.x, pose.y, pose.z);
      this.velocity.set(motion.vx, 0, motion.vz);
      this.tiles.prefetch(this.position, this.velocity);
      if (document.hasFocus() && !document.hidden) this.advance(active, dt);
      this.present(active, clamp(dt, 0, 0.1));
    }
    this.draw();
  }

  // the drawn car: smoothed over steps, tilted by the ground under its wheels (or nosing down along its flight),
  // dipping on its springs after a landing; the camera shaken by a crash and dipped by a splash
  private present(active: Driving, dt: number) {
    const { motion, car } = active, pose = active.motion.pose, now = performance.now();
    const flying = motion.airborne || now < active.sinkUntil;
    if (flying) active.displayHeight = pose.y;
    else active.displayHeight += (pose.y - active.displayHeight) * (1 - Math.exp(-16 * dt));
    let pitch = 0, roll = 0, rate = 10;
    if (motion.airborne) {
      // the nose follows the flight path, slowly
      pitch = clamp(Math.atan2(motion.vy, Math.max(4, motion.speed)) * 0.8, -0.75, 0.35);
      rate = 2.2;
    } else if (now >= active.sinkUntil) {
      const tilt = this.tilt(pose, car);
      if (tilt) [pitch, roll] = tilt;
    } else { pitch = 0.3; rate = 1.5; }
    active.pitch += (pitch - active.pitch) * (1 - Math.exp(-rate * dt));
    active.roll += (roll - active.roll) * (1 - Math.exp(-rate * dt));
    // a spring for the suspension: ~3 Hz, damped (semi-implicit, in steps short enough to stay stable)
    for (let n = Math.ceil(dt * 120), h = dt / Math.max(1, n), i = 0; i < n; i++) {
      active.squashV += (-active.squash * 360 - active.squashV * 16) * h;
      active.squash += active.squashV * h;
    }
    active.squash = clamp(active.squash, -0.45, 0.2);
    car.rp!.set(pose.x, active.displayHeight + active.squash, pose.z);
    car.rh = pose.h;
    car.pitch = active.pitch;
    car.roll = active.roll;
    car.v = motion.vx * Math.sin(pose.h) + motion.vz * Math.cos(pose.h);
    car.brake = +motion.brake;
    this.shake(active, now);
  }

  // the camera shaken by a crash and dipped by a splash
  private shake(active: Driving, now: number) {
    const shake = this.nav.rideShake.set(0, 0, 0);
    const crash = (active.crashUntil - now) / CRASH_MS;
    if (crash > 0) {
      const a = 0.45 * crash * crash;
      shake.set(Math.sin(now * 0.071) * a, Math.sin(now * 0.093 + 1) * a, Math.sin(now * 0.057 + 2) * a);
    }
    const sink = (active.sinkUntil - now) / SINK_MS;
    if (sink > 0) shake.y -= 1.6 * Math.sin(Math.min(1, (1 - sink) * 4) * Math.PI / 2);
  }

  // pitch (nose up) and roll (left side up) from the road under the four wheels
  private tilt(p: Pose, car: Car): [number, number] | null {
    const sx = Math.sin(p.h), sz = Math.cos(p.h), half = car.len / 2 - 0.6, track = 0.75, h: number[] = [];
    for (const [f, r] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const s = this.tiles.roadSurface(p.x + f * sx * half + r * sz * track, p.z + f * sz * half - r * sx * track, p.y, 1);
      if (!s) return null;
      // (a step under a wheel -- a kerb, a roof's terrace -- tilts it a little, not as far as the step)
      h.push(s.blocked || s.water || Math.abs(s.height - p.y) > 1.1 ? p.y : p.y + clamp(s.height - p.y, -0.35, 0.35));
    }
    const pitch = Math.atan2((h[0] + h[1] - h[2] - h[3]) / 2, 2 * half);
    const roll = Math.atan2((h[0] + h[2] - h[1] - h[3]) / 2, 2 * track);
    return [clamp(pitch, -MAX_TILT, MAX_TILT), clamp(roll, -MAX_TILT, MAX_TILT)];
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
    if (PHYSICS === 'rapier') { this.prepareRapier(ride, life, car, pose); return; }
    this.position.set(pose.x, pose.y, pose.z);
    this.tiles.prefetch(this.position, this.velocity.set(0, 0, 0));
    if (!this.tiles.roadSurface(pose.x, pose.z, pose.y, 1.45)) return;
    this.pending = null;
    if (!life.takeWheel(car)) return;
    this.driving = {
      ride, life, car, motion: new ArcadeCar(pose, car.v, car.bus, car.len, car.bus ? 2.55 : 1.48), displayHeight: pose.y,
      pitch: car.pitch ?? 0, roll: 0, squash: 0, squashV: 0, safe: [], sinkUntil: 0, crashUntil: 0, rapier: null,
    };
    this.started(ride);
  }

  private started(ride: Ride) {
    this.nav.controlledRide = ride;
    this.touch.setActive(true);
    this.keys.clear();
    this.accumulator = 0;
    this.feedbackUntil = 0;
    this.waiting = false;
  }

  park() {
    if (!this.driving) return;
    const rap = this.driving.rapier;
    if (rap) {
      // (parked in the river: back on the road first; anywhere else it stays as it is, on its roof too)
      if (this.driving.sinkUntil || rap.car?.status === 'water') this.respawnRapier(this.driving, rap);
      else { rap.settle(); this.presentRapier(this.driving, rap); } // (parked in the air: where it comes to rest)
      rap.end();
    } else if (this.driving.motion.mode !== 'ground' || this.driving.sinkUntil) {
      // (parked in the air or the river: back on the road)
      this.respawn(this.driving);
      this.present(this.driving, 0);
    }
    this.driving.car.v = 0;
    this.driving.car.brake = 1;
    this.nav.rideShake.set(0, 0, 0);
    this.driving = null;
    this.nav.controlledRide = null;
    this.keys.clear();
    this.touch.setActive(false);
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
    const now = performance.now();
    if (now < active.sinkUntil) { this.sink(active, dt); return; }
    if (active.sinkUntil) { active.sinkUntil = 0; this.respawn(active); return; }
    const input = now < active.crashUntil ? NO_INPUT : this.input();
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
      const result = motion.step(input, STEP, contact, this.air);
      this.waiting = result === 'loading';
      if (this.waiting) { this.accumulator = 0; break; }
      if (result === 'impact') this.say('Contact', 350);
      if (result === 'water') {
        active.sinkUntil = now + SINK_MS;
        this.say('Splash! Back on the road in a moment…', SINK_MS);
        this.accumulator = 0;
        break;
      }
      const landing = motion.landing;
      if (landing) {
        active.squashV -= Math.min(4.5, landing.impact * 0.45);
        if (landing.crash) {
          active.crashUntil = now + CRASH_MS;
          this.say('Crash!', CRASH_MS);
        } else if (landing.impact > 6) this.say('Hard landing', 700);
      }
      if (motion.mode === 'ground' && (!active.safe.length || now - active.safe[active.safe.length - 1].t > 400)) {
        active.safe.push({ pose: { ...motion.pose }, t: now });
        if (active.safe.length > 16) active.safe.shift();
      }
    }
  }

  // ---- Rapier

  private loadRapier(meta: Meta) {
    if (this.rapierLoad) return;
    const t0 = performance.now();
    this.rapierLoad = import('../physics/rapier/drive').then(async (m) => {
      this.rapierMod = m;
      const f = this.focus;
      this.rapier = await m.loadRapierDrive(meta, { x: f.x, z: f.z });
      (window as unknown as { __rapierLoadMs: number }).__rapierLoadMs = performance.now() - t0;
    }).catch((e) => { console.warn('rapier', e); });
  }

  private prepareRapier(ride: Ride, life: StreetLife, car: Car, pose: Pose) {
    const rap = this.rapier, m = this.rapierMod;
    if (!rap || !m) { this.loadRapier(this.meta); return; }
    this.pending = null;
    if (!life.takeWheel(car)) return;
    // (a car parked on its side or roof is taken as it lies)
    const at = car.rp ?? new Vector3(pose.x, pose.y, pose.z);
    rap.begin({ x: at.x, y: at.y, z: at.z, h: car.rh ?? pose.h, pitch: car.pitch ?? 0, roll: car.roll ?? 0 }, car.v, m.buildFor(car.bus, car.len));
    this.driving = {
      ride, life, car, motion: new ArcadeCar(pose, car.v, car.bus, car.len, car.bus ? 2.55 : 1.48), displayHeight: pose.y,
      pitch: 0, roll: 0, squash: 0, squashV: 0, safe: [], sinkUntil: 0, crashUntil: 0, rapier: rap,
    };
    this.started(ride);
  }

  private advanceRapier(active: Driving, rap: RapierDrive, dt: number) {
    const { life, car } = active, now = performance.now();
    if (active.sinkUntil && now >= active.sinkUntil) { this.respawnRapier(active, rap); return; }
    const input = this.lastInput = now < active.sinkUntil || now < active.crashUntil ? NO_INPUT : this.input();
    const p = car.rp;
    const obstacles: Obstacle[] = [];
    for (const other of life.roadVehicles()) {
      const q = other.rp;
      if (other === car || !q || (p && (Math.abs(q.x - p.x) > 40 || Math.abs(q.z - p.z) > 40))) continue;
      obstacles.push({ key: other, x: q.x, y: q.y, z: q.z, h: other.rh ?? 0, len: other.len, bus: other.bus });
    }
    // the people near it, walking or cycling (not one being walked by the player)
    const walkers: Walker[] = [];
    for (const q of life.people) {
      if (!q.rp || q.ctl || (p && (Math.abs(q.rp.x - p.x) > 15 || Math.abs(q.rp.z - p.z) > 15))) continue;
      walkers.push({ key: q, x: q.rp.x, y: q.rp.y, z: q.rp.z, h: q.rh ?? 0, col: q.col });
    }
    rap.group = life.group;
    const events = rap.update(dt, input, obstacles, walkers);
    this.waiting = events === 'loading';
    if (events === 'loading') return;
    for (const e of events) {
      if (e.kind === 'knock') {
        // (out of the traffic: it lies where it is knocked to)
        life.takeWheel(e.key as Car);
        this.say('Crash!', 600);
      } else if (e.kind === 'person') {
        life.people = life.people.filter((q) => q !== e.key);
        this.say('Ouch!', 600);
      } else if (e.kind === 'impact' && e.speed > 2) this.say('Contact', 350);
      else if (e.kind === 'landing') {
        if (e.crash) { active.crashUntil = now + CRASH_MS; this.say('Crash!', CRASH_MS); }
        else if (e.speed > 6) this.say('Hard landing', 700);
      }
    }
    if (rap.car?.status === 'water' && !active.sinkUntil) {
      active.sinkUntil = now + SINK_MS;
      this.say('Splash! Back on the road in a moment…', SINK_MS);
    }
    // where it was last on its wheels, to come back to from the river
    const d = rap.drawn();
    if (d && rap.onWheels && rap.car?.status === 'ok' && (!active.safe.length || now - active.safe[active.safe.length - 1].t > 400)) {
      active.safe.push({ pose: { x: d.x, y: d.y, z: d.z, h: d.h }, t: now });
      if (active.safe.length > 16) active.safe.shift();
    }
  }

  private presentRapier(active: Driving, rap: RapierDrive) {
    const d = rap.drawn(), { car } = active;
    for (const [key, w] of rap.wrecks()) {
      const c = key as Car;
      (c.rp ??= new Vector3()).set(w.x, w.y, w.z);
      Object.assign(c, { rh: w.h, pitch: w.pitch, roll: w.roll, v: 0, brake: 1 });
    }
    if (d) {
      car.rp!.set(d.x, d.y, d.z);
      car.rh = d.h;
      car.pitch = d.pitch;
      car.roll = d.roll;
      car.v = (rap.car?.kmh ?? 0) / 3.6;
    }
    car.brake = this.lastInput.brake > 0 || this.lastInput.handbrake ? 1 : 0;
    this.shake(active, performance.now());
  }

  // back where the car last was on its wheels, some 12 m before where it left the road, standing still
  private respawnRapier(active: Driving, rap: RapierDrive) {
    const safe = active.safe, edge = safe.at(-1)?.pose;
    const i = edge ? safe.findLastIndex(s => Math.hypot(s.pose.x - edge.x, s.pose.z - edge.z) > 12) : -1;
    const pose = safe[Math.max(0, i)]?.pose ?? edge;
    active.safe = safe.slice(0, Math.max(1, i + 1));
    active.sinkUntil = 0;
    active.crashUntil = 0;
    if (!pose || !this.rapierMod) return;
    rap.begin({ ...pose, pitch: 0, roll: 0 }, 0, this.rapierMod.buildFor(active.car.bus, active.car.len));
    active.car.rp!.set(pose.x, pose.y, pose.z);
    Object.assign(active.car, { rh: pose.h, pitch: 0, roll: 0 });
  }

  private say(message: string, ms: number) {
    this.feedback = message;
    this.feedbackUntil = performance.now() + ms;
  }

  // in the river: drifting to a stop, going under
  private sink(active: Driving, dt: number) {
    const m = active.motion, p = m.pose, k = Math.exp(-2.5 * dt);
    m.vx *= k;
    m.vz *= k;
    p.x += m.vx * dt;
    p.z += m.vz * dt;
    p.y -= 1.3 * dt;
  }

  // back where the car last was on the road, some 12 m before the edge it left it at, standing still
  private respawn(active: Driving) {
    const safe = active.safe, edge = safe.at(-1)?.pose ?? active.motion.pose;
    const i = safe.findLastIndex(s => Math.hypot(s.pose.x - edge.x, s.pose.z - edge.z) > 12);
    const back = safe[Math.max(0, i)];
    const pose = back?.pose ?? edge;
    active.motion = new ArcadeCar(pose, 0, active.car.bus, active.car.len, active.motion.height);
    active.displayHeight = pose.y;
    active.pitch = active.roll = active.squash = active.squashV = 0;
    active.safe = safe.slice(0, Math.max(1, i + 1));
    active.sinkUntil = 0;
    active.crashUntil = 0;
    this.accumulator = 0;
  }

  private ground(p: Pose, car: Car): RoadContact {
    return carGround(this.tiles, p, car.len, car.bus);
  }

  private input(): DriveInput {
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
    const message = this.pending && PHYSICS === 'rapier' && !this.rapier ? 'Loading physics…' :
      this.pending || this.waiting ? 'Loading road collision tiles…' :
      performance.now() < this.feedbackUntil ? this.feedback : '';
    if (this.status.textContent !== message) this.status.textContent = message;
    if (active) {
      const kmh = active.rapier ? Math.abs(active.rapier.car?.kmh ?? 0) : active.motion.speed * 3.6;
      const speed = Math.round(kmh) + ' km/h';
      if (this.speed.textContent !== speed) this.speed.textContent = speed;
    }
  }
}
