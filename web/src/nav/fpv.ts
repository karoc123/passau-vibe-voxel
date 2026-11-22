import * as THREE from 'three';
import { VoxelCollision, type ImpactKind, type Sweep } from './voxel-collision';
import { viewerTileCache } from '../viewer-tiles';
import { FixedStep } from '../core/fixed-step';
import { add, component, copy, length, set, type Vec3 } from '../core/vec';
import { FpvFlight, HOVER_THROTTLE, REBOUND_SPEED, type FlightInput } from './fpv-flight';
import { FpvInput } from './fpv-input';
import { FpvTouch } from './fpv-touch';
import type { Nav } from './nav';
import type { CraftContext, CraftSpot, PlayerCraft } from './craft';
import { clamp, el } from '../util';
import { gameKey, HeldKeys, inFocus, onFocusLoss } from './input';
import { modeButton, ModePanel } from './mode-panel';
import './fpv.css';

const FIXED_STEP = 1 / 120;
const ARM_THROTTLE = 0.06;
const IMPACT_MESSAGE_MS = 950;
const SURFACE_CLEARANCE = 0.002;
const CAMERA_PITCH_AXIS = new THREE.Vector3(1, 0, 0);
const FLIGHT_KEYS: ReadonlySet<string> = new Set(['KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyQ', 'KeyE', 'KeyR', 'KeyF']);
type Phase = 'loading' | 'ready' | 'flying' | 'paused';
type InputSource = 'controller' | 'keyboard' | 'touch';

// The viewer owns the camera and render loop; this mode supplies the flight pose. Out of focus it pauses and wants
// arming again (input.ts: the radio's throttle may have moved meanwhile).
export class FpvMode implements PlayerCraft {
  readonly id = 'fpv';
  readonly view = 'own';
  private readonly nav: Nav;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly target: THREE.Vector3;
  private on = false;
  private readonly radio = new FpvInput();
  private readonly touch: FpvTouch;
  private readonly hasTouch = navigator.maxTouchPoints > 0;
  private readonly collision: VoxelCollision;
  private readonly flight = new FpvFlight();
  private readonly keys = new HeldKeys(FLIGHT_KEYS);
  private readonly spawn = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly nextPosition = new THREE.Vector3();
  private readonly slide = new THREE.Vector3();
  private readonly tilt = new THREE.Quaternion();
  private readonly impactTint = el('div', 'fpv-impact-tint');
  private readonly panel: ModePanel;
  private readonly telemetry: HTMLDivElement;
  private readonly enterExit: HTMLButtonElement;
  private readonly armRadio: HTMLButtonElement;
  private readonly armKeys: HTMLButtonElement;
  private readonly armTouch: HTMLButtonElement;
  private readonly reset: HTMLButtonElement;
  private readonly options: HTMLDivElement;

  private phase: Phase = 'loading';
  private source: InputSource = 'controller';
  private device: string | null = null;
  private controller: FlightInput | null = null;
  private spawnYaw = 0;
  private savedNear: number | null = null;
  private readonly clock = new FixedStep(FIXED_STEP, Infinity, 0.1);
  private nextStatus = 0;
  private waitingForTile = false;
  private impact: { at: number; strength: number; message: string } | null = null;
  private notice = '';

  constructor({ nav, camera, target, meta, host, canvas }: CraftContext) {
    this.nav = nav; this.camera = camera; this.target = target;
    this.collision = new VoxelCollision(meta, viewerTileCache(meta.tiles.N));
    // a pinch while flying with touch: the camera's field of view (spread to zoom in), as on foot in first person
    this.touch = new FpvTouch(canvas, () => this.pause('Touch interrupted. Choose Fly with touch to resume.'), ratio => {
      this.camera.fov = clamp(this.camera.fov * ratio, 45, 100);
      this.camera.updateProjectionMatrix();
    });
    this.impactTint.setAttribute('aria-hidden', 'true');
    const P = this.panel = new ModePanel(host, 'fpv', 'FPV Acro');
    this.enterExit = P.button('FPV Acro', () => this.toggle());
    this.telemetry = P.line('telemetry');
    const actions = P.line('actions');
    this.armTouch = modeButton('Fly with touch', () => this.arm('touch'), actions);
    this.armRadio = modeButton('Arm controller', () => this.arm('controller'), actions);
    this.armKeys = modeButton('Fly with keyboard', () => this.arm('keyboard'), actions);
    this.reset = modeButton('Reset flight', () => this.restart(), actions);
    this.options = P.line('options');
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
    onFocusLoss(() => this.pause('Window lost focus. Arm again to resume.'));
    this.renderPanel();
  }

  update(dt: number) {
    const active = this.on;
    // (the radio read, and its setup drawn, only while the drone is on)
    this.controller = active ? this.radio.update() : null;
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

  // the panel's button: in (where the camera is) or out
  private toggle() {
    if (this.on) {
      this.touch.setActive(false);
      this.nav.flyUp();
      return;
    }
    this.enter();
  }

  // into the drone at a spot (heading h: the way it faces), else where the camera is, facing the way it looks
  enter(at?: CraftSpot) {
    if (this.on || !this.nav.enterCraft(this)) return false;
    this.on = true;
    const position = this.camera.position, offset = this.target.clone().sub(position);
    const x = at?.x ?? position.x, z = at?.z ?? position.z;
    this.spawn.set(clamp(x, 16, this.collision.width - 16), at?.y ?? position.y, clamp(z, 16, this.collision.depth - 16));
    // (the drone's yaw: its camera looks along -z)
    this.spawnYaw = at ? at.h + Math.PI : Math.atan2(-offset.x, -offset.z);
    this.savedNear = this.camera.near;
    this.camera.near = 0.15;
    this.camera.fov = 74;
    this.camera.updateProjectionMatrix();
    this.restart();
    return true;
  }

  leave() {
    this.on = false;
    this.collision.release();
    if (this.savedNear !== null) {
      this.camera.near = this.savedNear;
      this.camera.updateProjectionMatrix();
      this.savedNear = null;
    }
    this.keys.clear();
    this.touch.reset();
    this.phase = 'loading';
    this.notice = '';
    this.renderPanel();
  }

  private restart() {
    this.keys.clear();
    this.touch.reset();
    set(this.flight.velocity, 0, 0, 0);
    this.clock.acc = 0;
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
    if (!this.on || (this.phase !== 'ready' && this.phase !== 'paused')) return;
    if (source === 'controller' && (!this.controller || this.controller.throttle > ARM_THROTTLE)) return;
    this.source = source;
    this.touch.setActive(source === 'touch');
    this.device = source === 'controller' ? this.radio.deviceKey : null;
    this.phase = 'flying';
    this.notice = '';
    this.clock.acc = 0;
    this.keys.clear();
    this.renderPanel();
  }

  private pause(reason: string) {
    this.keys.clear();
    this.touch.reset();
    if (!this.on || this.phase !== 'flying') return;
    this.phase = 'paused';
    this.notice = reason;
    this.waitingForTile = false;
    this.clock.acc = 0;
    this.renderPanel();
  }

  private advance(dt: number) {
    const input = this.flightInput();
    if (!input) return;
    this.clock.run(dt, (step) => this.flight.step(input, step, this.move));
  }

  private flightInput(): FlightInput | null {
    if (!inFocus()) {
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

  private readonly move = (position: Vec3, displacement: Vec3, velocity: Vec3) => {
    const collision = this.collision.sweep(position, displacement);
    this.waitingForTile = collision === 'loading';
    if (collision === 'loading') return false;
    if (!collision.hit) {
      add(position, displacement);
      return true;
    }

    const fraction = this.clearanceFraction(collision.fraction, displacement);
    this.nextPosition.copy(position).addScaledVector(displacement, fraction);
    // At low normal speed, use the remaining part of the step to slide along the surface.
    const axis = Math.abs(collision.axis) - 1;
    const approach = -component(velocity, axis) * Math.sign(collision.axis);
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

    copy(position, this.nextPosition);
    this.resolveContact(collision.hit, collision.axis);
    if (nextContact?.hit) this.resolveContact(nextContact.hit, nextContact.axis);
    return true;
  };

  private clearanceFraction(fraction: number, travel: Vec3) {
    const distance = length(travel);
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
    if (!this.on || !gameKey(e)) return;
    if (e.code === 'KeyT' && !e.repeat) this.restart();
    else if (e.code === 'Enter' && !e.repeat) this.arm(this.source);
    else if (!(this.source === 'keyboard' && this.phase === 'flying' && this.keys.press(e))) return;
    e.preventDefault();
  };

  private renderPanel() {
    const active = this.on, flying = active && this.phase === 'flying';
    const flyingWithTouch = flying && this.source === 'touch';
    const P = this.panel, canArm = active && (this.phase === 'ready' || this.phase === 'paused');
    P.active = active;
    P.el.classList.toggle('flying', flying); // (style.css: the compact strip while it flies)
    P.details.hidden = !active;
    this.enterExit.textContent = active ? 'Exit FPV' : 'FPV Acro';
    this.enterExit.disabled = !active && !this.nav.canStartCraft;
    this.armRadio.hidden = !canArm;
    this.armRadio.disabled = !this.controller || this.controller.throttle > ARM_THROTTLE;
    this.armKeys.hidden = !canArm;
    this.armTouch.hidden = !canArm || !this.hasTouch;
    this.reset.hidden = !active || this.phase === 'ready' || this.phase === 'loading';
    this.options.hidden = !active || flying;
    P.status.hidden = !active;
    this.telemetry.hidden = !active || this.phase === 'loading';
    if (!active) return;

    const controls = this.hasTouch ? 'Touch: left for throttle and yaw, right for pitch and roll, pinch to zoom.' :
      'Keyboard: W/S pitch · Q/E roll · A/D yaw · R/F throttle · T reset · Esc exit';
    const content = this.notice || (this.phase === 'loading' ? 'Loading collision tiles near the start…' :
      this.waitingForTile ? 'Waiting for the next collision tile…' :
      flying ? (this.impact?.message ?? '') :
      this.controller && this.controller.throttle > ARM_THROTTLE ? 'Lower throttle to arm the controller.' : controls);
    ModePanel.text(P.status, content);

    const p = this.flight.position;
    const terrain = this.collision.surface(p.x, p.z);
    const altitude = terrain ? `${Math.round(p.y - terrain.ground)} m AGL` : `${Math.round(p.y)} m`;
    const throttle = flyingWithTouch ? ` · ${this.touch.throttlePercent}% throttle` : '';
    this.telemetry.textContent = `${altitude} · ${Math.round(length(this.flight.velocity) * 3.6)} km/h${throttle}`;
  }
}
