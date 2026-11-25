import * as THREE from 'three';
import { length } from '../core/vec';
import { HOVER_THROTTLE } from '../sim/craft/fpv-flight';
import type { FlightInput } from '../sim/contract/inputs';
import { FpvInput } from './fpv-input';
import { FpvTouch } from './fpv-touch';
import type { Nav } from './nav';
import { CraftLink, type CraftContext, type CraftSpot, type PlayerCraft } from './craft';
import type { CraftView } from '../client/sim-client';
import { clamp, el } from '../util';
import { gameKey, HeldKeys, inFocus, onFocusLoss } from './input';
import { modeButton, ModePanel } from './mode-panel';
import './fpv.css';

const ARM_THROTTLE = 0.06;
const IMPACT_MESSAGE_MS = 950;
const STILL = { x: 0, y: 0, z: 0 };
const CAMERA_PITCH_AXIS = new THREE.Vector3(1, 0, 0);
const FLIGHT_KEYS: ReadonlySet<string> = new Set(['KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyQ', 'KeyE', 'KeyR', 'KeyF']);
type Phase = 'loading' | 'ready' | 'flying' | 'paused';
type InputSource = 'controller' | 'keyboard' | 'touch';

// The viewer owns the camera and render loop; this mode supplies the flight pose. The drone is a craft of the world
// sim's (CraftLink: its core, sim/craft/drone-core.ts, stepped on the world's clock with its collision), the local
// player its pilot. Disarmed (before arming, paused) its input is null: it holds still. Out of focus it is
// disarmed and wants arming again (input.ts: the radio's throttle may have moved meanwhile). Left, the drone stays in
// the world, its throttle cut (it falls and comes to rest); board: back in, disarmed.
export class FpvMode implements PlayerCraft {
  readonly id = 'fpv';
  readonly view = 'own';
  readonly boards = ['drone'] as const;
  private readonly nav: Nav;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly target: THREE.Vector3;
  private on = false;
  private readonly radio = new FpvInput();
  private readonly touch: FpvTouch;
  private readonly hasTouch = navigator.maxTouchPoints > 0;
  // the drone in the world sim while the player is in it (its client, its own collision)
  private readonly link: CraftLink<'drone'>;
  private readonly keys = new HeldKeys(FLIGHT_KEYS);
  private readonly spawn = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
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
  private nextStatus = 0;
  private impact: { at: number; strength: number; message: string } | null = null;
  private notice = '';

  constructor(ctx: CraftContext) {
    const { nav, camera, target, host, canvas } = ctx;
    this.nav = nav; this.camera = camera; this.target = target;
    this.link = new CraftLink(ctx, 'drone');
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

  private get craft() { return this.on ? this.link.craft : null; }

  // (before the sim's update, main.ts: the input sent, what happened to it; the frame it is put down it is not in yet)
  update() {
    const active = this.on, col = this.link.col;
    const now = performance.now();
    // (the radio read, and its setup drawn, only while the drone is on)
    this.controller = active ? this.radio.update() : null;
    if (active && col) {
      if (this.phase === 'loading') {
        col.prefetch(this.spawn, STILL);
        this.prepare();
      }
      if (this.link.refused()) { this.toggle(); return; }
      this.link.input(this.phase === 'flying' ? this.flightInput() : null);
      this.link.frame();
      for (const e of this.link.events()) {
        this.impact = { at: now, strength: clamp(e.speed / 26, 0.22, 0.75), message: `Impact with ${e.hit} at ${Math.round(e.speed * 3.6)} km/h · Armed` };
      }
    }
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
    if (this.on || !this.link.sim || !this.nav.enterCraft(this)) return false;
    const col = this.open();
    const position = this.camera.position, offset = this.target.clone().sub(position);
    const x = at?.x ?? position.x, z = at?.z ?? position.z;
    this.spawn.set(clamp(x, 16, col.width - 16), at?.y ?? position.y, clamp(z, 16, col.depth - 16));
    // (the drone's yaw: its camera looks along -z)
    this.spawnYaw = at ? at.h + Math.PI : Math.atan2(-offset.x, -offset.z);
    this.restart();
    return true;
  }

  // into a drone left in the world: disarmed where it is ("Reset flight": put down again over where it was)
  board(craft: CraftView) {
    if (this.on || !this.link.sim || !this.nav.enterCraft(this)) return false;
    this.open();
    this.link.board(craft.id);
    const p = craft.core.pose;
    this.spawn.set(p.x, p.y, p.z);
    this.spawnYaw = p.h + Math.PI;
    this.keys.clear();
    this.touch.reset();
    this.phase = 'ready';
    this.renderPanel();
    return true;
  }

  private open() {
    this.on = true;
    const col = this.link.open();
    this.savedNear = this.camera.near;
    this.camera.near = 0.15;
    this.camera.fov = 74;
    this.camera.updateProjectionMatrix();
    return col;
  }

  leave() {
    this.on = false;
    this.link.close();
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
    this.notice = '';
    this.impact = null;
    this.phase = 'loading';
    this.prepare();
    this.renderPanel();
  }

  // put down once the tiles round the start are in: 12..35 m over the highest column round it
  private prepare() {
    const { x, z } = this.spawn, col = this.link.col;
    if (!col) return;
    let top = 0;
    for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const surface = col.surface(x + dx, z + dz);
      if (!surface) return;
      top = Math.max(top, surface.top);
    }
    this.link.put({ x, y: clamp(this.spawn.y, top + 12, top + 35), z, h: this.spawnYaw - Math.PI });
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
    this.keys.clear();
    this.renderPanel();
  }

  private pause(reason: string) {
    this.keys.clear();
    this.touch.reset();
    if (!this.on || this.phase !== 'flying') return;
    this.phase = 'paused';
    this.notice = reason;
    this.renderPanel();
  }

  get mapPose() {
    if (this.phase === 'loading') return null;
    return this.craft?.core.pose ?? null;
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

  // (after the sim's update: the camera where the drone is drawn this frame)
  place() {
    if (!this.on || !this.link.col || this.phase === 'loading' || !this.craft) return;
    const { core } = this.craft, d = core.drawn(this.link.alpha);
    this.camera.position.copy(d.position);
    this.camera.quaternion.copy(d.attitude).multiply(this.tilt);
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
    this.enterExit.disabled = !active && (!this.nav.canStartCraft || !this.link.sim);
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
      flying && this.craft?.core.waiting ? 'Waiting for the next collision tile…' :
      flying ? (this.impact?.message ?? '') :
      this.controller && this.controller.throttle > ARM_THROTTLE ? 'Lower throttle to arm the controller.' : controls);
    ModePanel.text(P.status, content);

    const core = this.craft?.core, p = core?.flight.position;
    if (!core || !p) return;
    const terrain = this.link.col?.surface(p.x, p.z);
    const altitude = terrain ? `${Math.round(p.y - terrain.ground)} m AGL` : `${Math.round(p.y)} m`;
    const throttle = flyingWithTouch ? ` · ${this.touch.throttlePercent}% throttle` : '';
    this.telemetry.textContent = `${altitude} · ${Math.round(length(core.flight.velocity) * 3.6)} km/h${throttle}`;
  }
}
