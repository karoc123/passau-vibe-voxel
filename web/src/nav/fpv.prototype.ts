import * as THREE from 'three';
import { FpvCollision, type Sweep } from './fpv-collision';
import { FpvFlight, HOVER_THROTTLE, type FlightInput } from './fpv-flight';
import { FpvInput } from './fpv-input';
import type { Nav } from './nav';
import type { Meta } from '../types';
import { clamp, el } from '../util';
import './fpv.prototype.css';

const FIXED_STEP = 1 / 120;
const ARM_THROTTLE = 0.06;
const CAMERA_PITCH_AXIS = new THREE.Vector3(1, 0, 0);
const FLIGHT_KEYS = ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyQ', 'KeyE', 'KeyR', 'KeyF'];
type Phase = 'loading' | 'ready' | 'flying' | 'crashed' | 'paused';
type InputSource = 'controller' | 'keyboard';

function button(label: string, run: () => void) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', () => { run(); node.blur(); });
  return node;
}

// Opt-in Acro prototype. The viewer still owns the camera, render loop and all other navigation modes.
export class FpvPrototype {
  private readonly radio = new FpvInput();
  private readonly collision: FpvCollision;
  private readonly flight = new FpvFlight();
  private readonly keys = new Set<string>();
  private readonly spawn = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly priorAttitude = new THREE.Quaternion();
  private readonly priorVelocity = new THREE.Vector3();
  private readonly tilt = new THREE.Quaternion();
  private readonly panel = el('aside', 'fpv-prototype');
  private readonly status = el('div', 'fpv-status', '', this.panel);
  private readonly telemetry = el('div', 'fpv-telemetry', '', this.panel);
  private readonly actions = el('div', 'fpv-actions', '', this.panel);
  private readonly enterExit = button('Open FPV Acro', () => this.toggle());
  private readonly armRadio = button('Arm controller', () => this.arm('controller'));
  private readonly armKeys = button('Fly with keyboard', () => this.arm('keyboard'));
  private readonly reset = button('Reset flight', () => this.restart());
  private readonly options = el('div', 'fpv-options', '', this.panel);

  private phase: Phase = 'loading';
  private source: InputSource = 'controller';
  private device: string | null = null;
  private controller: FlightInput | null = null;
  private spawnYaw = 0;
  private savedNear: number | null = null;
  private accumulator = 0;
  private nextStatus = 0;
  private waitingForTile = false;
  private notice = '';

  constructor(private readonly nav: Nav, private readonly camera: THREE.PerspectiveCamera,
    private readonly target: THREE.Vector3, meta: Meta) {
    this.collision = new FpvCollision(meta);
    this.panel.setAttribute('aria-label', 'FPV Acro');
    this.status.setAttribute('role', 'status');
    this.actions.append(this.enterExit, this.armRadio, this.armKeys, this.reset);
    this.options.append(this.radio.element);
    const angle = el('label', 'fpv-camera-angle', '', this.options);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '45';
    range.value = '20';
    const value = document.createElement('span');
    angle.append('Camera tilt ', range, value);
    const setTilt = () => {
      this.tilt.setFromAxisAngle(CAMERA_PITCH_AXIS, THREE.MathUtils.degToRad(+range.value));
      value.textContent = range.value + '°';
    };
    range.addEventListener('input', setTilt);
    setTilt();
    addEventListener('keydown', this.keyDown);
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.pause('Window lost focus. Arm again to resume.'));
    this.renderPanel();
  }

  update(dt: number) {
    const active = this.nav.mode === 'fpv';
    if (!active && this.savedNear !== null) {
      this.camera.near = this.savedNear;
      this.camera.updateProjectionMatrix();
      this.savedNear = null;
      this.keys.clear();
      this.phase = 'loading';
      this.notice = '';
    }
    this.controller = this.radio.update();
    if (active) {
      const p = this.phase === 'loading' ? this.spawn : this.flight.position;
      this.collision.prefetch(p, this.flight.velocity);
      if (this.phase === 'loading') this.prepare();
      if (this.phase === 'flying') this.updateFlight(dt);
      this.applyCamera();
    }
    const now = performance.now();
    if (now >= this.nextStatus) {
      this.nextStatus = now + 100;
      this.renderPanel();
    }
  }

  private toggle() {
    if (this.nav.mode === 'fpv') {
      this.nav.flyUp();
      return;
    }
    if (!this.nav.startFpv()) return;
    const position = this.camera.position, offset = this.target.clone().sub(position);
    this.spawn.set(clamp(position.x, 16, this.collision.width - 16), position.y,
      clamp(position.z, 16, this.collision.depth - 16));
    this.spawnYaw = Math.atan2(-offset.x, -offset.z);
    this.savedNear = this.camera.near;
    this.camera.near = 0.15;
    this.camera.fov = 74;
    this.camera.updateProjectionMatrix();
    this.restart();
  }

  private restart() {
    this.keys.clear();
    this.flight.velocity.set(0, 0, 0);
    this.accumulator = 0;
    this.waitingForTile = false;
    this.notice = '';
    this.phase = 'loading';
    this.prepare();
    this.renderPanel();
  }

  private prepare() {
    const { x, z } = this.spawn;
    let top = 0;
    for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const surface = this.collision.surface(x + dx, z + dz);
      if (!surface) return;
      top = Math.max(top, surface.top);
    }
    const position = this.spawn.clone();
    position.y = clamp(position.y, top + 12, top + 35);
    this.flight.reset(position, this.spawnYaw);
    this.phase = 'ready';
  }

  private arm(source: InputSource) {
    if (this.nav.mode !== 'fpv' || (this.phase !== 'ready' && this.phase !== 'paused')) return;
    if (source === 'controller' && (!this.controller || this.controller.throttle > ARM_THROTTLE)) return;
    this.source = source;
    this.device = source === 'controller' ? this.radio.deviceKey : null;
    this.phase = 'flying';
    this.notice = '';
    this.accumulator = 0;
    this.keys.clear();
    this.renderPanel();
  }

  private pause(reason: string) {
    this.keys.clear();
    if (this.nav.mode !== 'fpv' || this.phase !== 'flying') return;
    this.phase = 'paused';
    this.notice = reason;
    this.waitingForTile = false;
    this.accumulator = 0;
    this.renderPanel();
  }

  private updateFlight(dt: number) {
    if (!document.hasFocus() || document.hidden) {
      this.pause('Window lost focus. Arm again to resume.');
      return;
    }
    if (this.source === 'controller' && (!this.controller || this.radio.deviceKey !== this.device)) {
      this.pause('Controller disconnected or unavailable. Arm again to resume.');
      return;
    }
    const input = this.source === 'keyboard' ? this.keyboard() : this.controller!;
    this.accumulator += clamp(dt, 0, 0.1);
    while (this.accumulator >= FIXED_STEP && this.phase === 'flying') {
      this.accumulator -= FIXED_STEP;
      this.priorAttitude.copy(this.flight.attitude);
      this.priorVelocity.copy(this.flight.velocity);
      this.flight.step(input, FIXED_STEP, this.move);
      if (this.waitingForTile) {
        this.flight.attitude.copy(this.priorAttitude);
        this.flight.velocity.copy(this.priorVelocity);
        this.accumulator = 0;
        break;
      }
    }
  }

  private readonly move = (position: THREE.Vector3, displacement: THREE.Vector3, velocity: THREE.Vector3) => {
    const collision = this.collision.sweep(position, displacement);
    this.waitingForTile = collision === 'loading';
    if (collision === 'loading') return;
    const distance = displacement.length();
    const fraction = collision.hit && distance > 0 ? Math.max(0, collision.fraction - 0.002 / distance) : collision.fraction;
    position.addScaledVector(displacement, fraction);
    if (collision.hit) this.crash(collision.hit, velocity.length());
  };

  private crash(hit: NonNullable<Exclude<Sweep, string>['hit']>, speed: number) {
    this.phase = 'crashed';
    this.notice = `Impact with ${hit} at ${Math.round(speed * 3.6)} km/h. Reset to fly again.`;
    this.flight.velocity.set(0, 0, 0);
    this.renderPanel();
  }

  private applyCamera() {
    if (this.phase === 'loading') return;
    this.camera.position.copy(this.flight.position);
    this.camera.quaternion.copy(this.flight.attitude).multiply(this.tilt);
    this.camera.getWorldDirection(this.look);
    this.target.copy(this.camera.position).addScaledVector(this.look, 180);
  }

  private keyboard(): FlightInput {
    const axis = (positive: string, negative: string) => 0.42 * (Number(this.keys.has(positive)) - Number(this.keys.has(negative)));
    return {
      roll: axis('KeyE', 'KeyQ'),
      pitch: axis('KeyW', 'KeyS'),
      yaw: axis('KeyD', 'KeyA'),
      throttle: HOVER_THROTTLE + (this.keys.has('KeyR') ? 0.38 : 0) - (this.keys.has('KeyF') ? HOVER_THROTTLE : 0),
    };
  }

  private readonly keyDown = (e: KeyboardEvent) => {
    if (this.nav.mode !== 'fpv' || e.metaKey || e.ctrlKey || e.altKey ||
        (e.target as Element).closest?.('input, select, textarea, button, [contenteditable]')) return;
    if (e.code === 'KeyT' && !e.repeat) this.restart();
    else if (e.code === 'Enter' && !e.repeat) this.arm(this.source);
    else if (FLIGHT_KEYS.includes(e.code) && this.source === 'keyboard' && this.phase === 'flying') this.keys.add(e.code);
    else return;
    e.preventDefault();
  };

  private renderPanel() {
    const active = this.nav.mode === 'fpv', flying = active && this.phase === 'flying';
    const canArm = active && (this.phase === 'ready' || this.phase === 'paused');
    this.panel.classList.toggle('in-flight', flying);
    this.enterExit.textContent = active ? 'Exit FPV' : 'Open FPV Acro';
    this.enterExit.disabled = !active && this.nav.mode !== 'orbit';
    this.armRadio.hidden = !canArm;
    this.armRadio.disabled = !this.controller || this.controller.throttle > ARM_THROTTLE;
    this.armKeys.hidden = !canArm;
    this.reset.hidden = !active || this.phase === 'ready' || this.phase === 'loading';
    this.options.hidden = flying;
    this.status.hidden = !active;
    this.telemetry.hidden = !active || this.phase === 'loading';
    if (!active) return;

    const content = this.notice || (this.phase === 'loading' ? 'Loading collision tiles near the start…' :
      this.waitingForTile ? 'Waiting for the next collision tile…' :
      flying ? (this.source === 'keyboard' ? 'W/S pitch · Q/E roll · A/D yaw · R/F throttle · T reset · Esc exit' : 'Acro · T reset · Esc exit') :
      this.controller && this.controller.throttle > ARM_THROTTLE ? 'Lower throttle to arm.' : 'Choose a controller or keyboard to fly.');
    if (this.status.textContent !== content) this.status.textContent = content;

    const p = this.flight.position;
    const terrain = this.collision.surface(p.x, p.z);
    const altitude = terrain ? `${Math.round(p.y - terrain.ground)} m AGL` : `${Math.round(p.y)} m`;
    this.telemetry.textContent = `${altitude} · ${Math.round(this.flight.velocity.length() * 3.6)} km/h`;
  }
}
