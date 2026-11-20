import * as THREE from 'three';
import { VoxelCollision, type ImpactKind, type Sweep } from './voxel-collision';
import { FpvFlight, HOVER_THROTTLE, REBOUND_SPEED, type FlightInput } from './fpv-flight';
import { FpvInput } from './fpv-input';
import { FpvTouch } from './fpv-touch';
import type { Nav } from './nav';
import type { Meta } from '../types';
import { clamp, el } from '../util';
import './fpv.css';

const FIXED_STEP = 1 / 120;
const ARM_THROTTLE = 0.06;
const IMPACT_MESSAGE_MS = 950;
const SURFACE_CLEARANCE = 0.002;
const CAMERA_PITCH_AXIS = new THREE.Vector3(1, 0, 0);
const FLIGHT_KEYS = ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyQ', 'KeyE', 'KeyR', 'KeyF'];
type Phase = 'loading' | 'ready' | 'flying' | 'paused';
type InputSource = 'controller' | 'keyboard' | 'touch';

function button(label: string, run: () => void) {
  const node = document.createElement('button');
  node.className = 'mode-button';
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', () => { run(); node.blur(); });
  return node;
}

// The viewer owns the camera and render loop; this mode supplies the flight pose.
export class FpvMode {
  private readonly radio = new FpvInput();
  private readonly touch: FpvTouch;
  private readonly hasTouch = navigator.maxTouchPoints > 0;
  private readonly collision: VoxelCollision;
  private readonly flight = new FpvFlight();
  private readonly keys = new Set<string>();
  private readonly spawn = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly nextPosition = new THREE.Vector3();
  private readonly slide = new THREE.Vector3();
  private readonly tilt = new THREE.Quaternion();
  private readonly impactTint = el('div', 'fpv-impact-tint');
  private readonly panel = document.createElement('aside');
  private readonly details = el('div', 'mode-detail', '', this.panel);
  private readonly status = el('div', 'fpv-status', '', this.details);
  private readonly telemetry = el('div', 'fpv-telemetry', '', this.details);
  private readonly actions = el('div', 'fpv-actions', '', this.details);
  private readonly enterExit = button('FPV Acro', () => this.toggle());
  private readonly armRadio = button('Arm controller', () => this.arm('controller'));
  private readonly armKeys = button('Fly with keyboard', () => this.arm('keyboard'));
  private readonly armTouch = button('Fly with touch', () => this.arm('touch'));
  private readonly reset = button('Reset flight', () => this.restart());
  private readonly options = el('div', 'fpv-options', '', this.details);

  private phase: Phase = 'loading';
  private source: InputSource = 'controller';
  private device: string | null = null;
  private controller: FlightInput | null = null;
  private spawnYaw = 0;
  private savedNear: number | null = null;
  private accumulator = 0;
  private nextStatus = 0;
  private waitingForTile = false;
  private impact: { at: number; strength: number; message: string } | null = null;
  private notice = '';

  constructor(private readonly nav: Nav, private readonly camera: THREE.PerspectiveCamera,
    private readonly target: THREE.Vector3, meta: Meta, host: HTMLElement, canvas: HTMLCanvasElement) {
    this.collision = new VoxelCollision(meta);
    this.touch = new FpvTouch(canvas, () => this.pause('Touch interrupted. Choose Fly with touch to resume.'));
    this.impactTint.setAttribute('aria-hidden', 'true');
    this.panel.className = 'fpv-mode';
    this.panel.setAttribute('aria-label', 'FPV Acro');
    this.panel.prepend(this.enterExit);
    host.append(this.panel);
    this.status.setAttribute('role', 'status');
    this.actions.append(this.armTouch, this.armRadio, this.armKeys, this.reset);
    this.options.append(this.radio.element);
    const angle = el('label', 'row fpv-camera-angle', '', this.options);
    const value = el('span', 'val', '', angle);
    const track = el('span', 'track', '', angle);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '45';
    range.value = '20';
    range.setAttribute('aria-label', 'Camera tilt');
    track.append(range);
    const setTilt = () => {
      this.tilt.setFromAxisAngle(CAMERA_PITCH_AXIS, THREE.MathUtils.degToRad(+range.value));
      value.textContent = 'Camera tilt ' + range.value + '°';
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
      this.touch.reset();
      this.phase = 'loading';
      this.notice = '';
      this.renderPanel();
    }
    this.controller = this.radio.update();
    if (active) {
      const p = this.phase === 'loading' ? this.spawn : this.flight.position;
      this.collision.prefetch(p, this.flight.velocity);
      if (this.phase === 'loading') this.prepare();
      if (this.phase === 'flying') this.advance(dt);
      this.applyCamera();
    }
    const now = performance.now();
    if (this.impact && now - this.impact.at >= IMPACT_MESSAGE_MS) this.impact = null;
    this.impactTint.style.opacity = active && this.impact
      ? String(this.impact.strength * Math.exp(-0.012 * (now - this.impact.at))) : '0';
    if (now >= this.nextStatus) {
      this.nextStatus = now + 100;
      this.renderPanel();
    }
  }

  private toggle() {
    if (this.nav.mode === 'fpv') {
      this.touch.setActive(false);
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
    this.touch.reset();
    this.flight.velocity.set(0, 0, 0);
    this.accumulator = 0;
    this.waitingForTile = false;
    this.notice = '';
    this.impact = null;
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
    this.touch.setActive(source === 'touch');
    this.device = source === 'controller' ? this.radio.deviceKey : null;
    this.phase = 'flying';
    this.notice = '';
    this.accumulator = 0;
    this.keys.clear();
    this.renderPanel();
  }

  private pause(reason: string) {
    this.keys.clear();
    this.touch.reset();
    if (this.nav.mode !== 'fpv' || this.phase !== 'flying') return;
    this.phase = 'paused';
    this.notice = reason;
    this.waitingForTile = false;
    this.accumulator = 0;
    this.renderPanel();
  }

  private advance(dt: number) {
    const input = this.flightInput();
    if (!input) return;
    this.accumulator += clamp(dt, 0, 0.1);
    while (this.accumulator >= FIXED_STEP) {
      this.accumulator -= FIXED_STEP;
      if (!this.flight.step(input, FIXED_STEP, this.move)) {
        this.accumulator = 0;
        break;
      }
    }
  }

  private flightInput(): FlightInput | null {
    if (!document.hasFocus() || document.hidden) {
      this.pause('Window lost focus. Arm again to resume.');
      return null;
    }
    if (this.source === 'controller' && (!this.controller || this.radio.deviceKey !== this.device)) {
      this.pause('Controller disconnected or unavailable. Arm again to resume.');
      return null;
    }
    if (this.source === 'touch') return this.touch.read();
    return this.source === 'keyboard' ? this.keyboard() : this.controller;
  }

  private readonly move = (position: THREE.Vector3, displacement: THREE.Vector3, velocity: THREE.Vector3) => {
    const collision = this.collision.sweep(position, displacement);
    this.waitingForTile = collision === 'loading';
    if (collision === 'loading') return false;
    if (!collision.hit) {
      position.add(displacement);
      return true;
    }

    const fraction = this.clearanceFraction(collision.fraction, displacement);
    this.nextPosition.copy(position).addScaledVector(displacement, fraction);
    // At low normal speed, use the remaining part of the step to slide along the surface.
    const axis = Math.abs(collision.axis) - 1;
    const approach = -velocity.getComponent(axis) * Math.sign(collision.axis);
    let nextContact: Exclude<Sweep, 'loading'> | null = null;
    if (approach < REBOUND_SPEED) {
      this.slide.copy(displacement).multiplyScalar(1 - fraction).setComponent(axis, 0);
      if (this.slide.lengthSq() > 1e-10) {
        const slideHit = this.collision.sweep(this.nextPosition, this.slide);
        if (slideHit === 'loading') {
          this.waitingForTile = true;
          return false;
        }
        this.nextPosition.addScaledVector(this.slide,
          slideHit.hit ? this.clearanceFraction(slideHit.fraction, this.slide) : slideHit.fraction);
        nextContact = slideHit;
      }
    }

    position.copy(this.nextPosition);
    this.resolveContact(collision.hit, collision.axis);
    if (nextContact?.hit) this.resolveContact(nextContact.hit, nextContact.axis);
    return true;
  };

  private clearanceFraction(fraction: number, travel: THREE.Vector3) {
    const distance = travel.length();
    return distance > 0 ? Math.max(0, fraction - SURFACE_CLEARANCE / distance) : fraction;
  }

  private resolveContact(hit: ImpactKind, axis: number) {
    const speed = this.flight.bounce(axis);
    if (speed < REBOUND_SPEED) return;
    this.impact = {
      at: performance.now(),
      strength: clamp(speed / 26, 0.22, 0.75),
      message: `Impact with ${hit} at ${Math.round(speed * 3.6)} km/h · Armed`,
    };
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
    const flyingWithTouch = flying && this.source === 'touch';
    document.body.classList.toggle('fpv-flying', flying);
    const canArm = active && (this.phase === 'ready' || this.phase === 'paused');
    this.panel.classList.toggle('mode-active', active);
    this.details.hidden = !active;
    this.enterExit.textContent = active ? 'Exit FPV' : 'FPV Acro';
    this.enterExit.disabled = !active && this.nav.mode !== 'orbit';
    this.armRadio.hidden = !canArm;
    this.armRadio.disabled = !this.controller || this.controller.throttle > ARM_THROTTLE;
    this.armKeys.hidden = !canArm;
    this.armTouch.hidden = !canArm || !this.hasTouch;
    this.reset.hidden = !active || this.phase === 'ready' || this.phase === 'loading';
    this.options.hidden = !active || flying;
    this.status.hidden = !active;
    this.telemetry.hidden = !active || this.phase === 'loading';
    if (!active) return;

    const controls = this.hasTouch ? 'Touch: left for throttle and yaw, right for pitch and roll.' :
      'Keyboard: W/S pitch · Q/E roll · A/D yaw · R/F throttle · T reset · Esc exit';
    const content = this.notice || (this.phase === 'loading' ? 'Loading collision tiles near the start…' :
      this.waitingForTile ? 'Waiting for the next collision tile…' :
      flying ? (this.impact?.message ?? '') :
      this.controller && this.controller.throttle > ARM_THROTTLE ? 'Lower throttle to arm the controller.' : controls);
    if (this.status.textContent !== content) this.status.textContent = content;

    const p = this.flight.position;
    const terrain = this.collision.surface(p.x, p.z);
    const altitude = terrain ? `${Math.round(p.y - terrain.ground)} m AGL` : `${Math.round(p.y)} m`;
    const throttle = flyingWithTouch ? ` · ${this.touch.throttlePercent}% throttle` : '';
    this.telemetry.textContent = `${altitude} · ${Math.round(this.flight.velocity.length() * 3.6)} km/h${throttle}`;
  }
}
