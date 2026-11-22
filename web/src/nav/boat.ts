import * as THREE from 'three';
import type { Meta } from '../types';
import { clamp, el, fetchJson } from '../util';
import { viewerTileCache } from '../viewer-tiles';
import { VoxelCollision } from './voxel-collision';
import { FixedStep } from '../core/fixed-step';
import { BoatMotion, downstream, findSpawn, nearestRiver, NO_BOAT_INPUT, type BoatInput, type BoatWorld } from './boat-motion';
import { BoatModel } from './boat-model';
import type { Nav } from './nav';
import { stickAxis, TouchSticks } from './touch-sticks';
import './boat.css';

// The boat mode: a speedboat of the player's own on the rivers, driven like the car (W/S throttle and reverse, A/D
// steer, Space drift, T unstick, Esc exit; the same touch stick and handbrake button; the gamepad as the car's). Put
// down on the water nearest the map's focus, facing downstream; the motion in boat-motion.ts (pure, fixed step), the
// model in boat-model.ts; the collision tiles round it through VoxelCollision (as the drone's). Here: the panel, the
// input, the chase camera.

const STEP = 1 / 120, MAX_STEPS = 12;
const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']);
const STEER_CURVE = 1.7; // the touch stick's steering: |x|^STEER_CURVE (as the car's)
const SPAWN_REACH = 48; // m round the river point nearest the focus searched for a spot the hull fits
const GIVE_UP_MS = 8000;
const BACK = 9.5, UP = 3.4, AHEAD = 8; // the chase camera: behind and over the boat, looking at a point ahead of it
const INTRO_MS = 900;

type Phase = 'off' | 'finding' | 'on';

export class BoatMode {
  private readonly collision: VoxelCollision;
  private readonly world: BoatWorld;
  private readonly motion = new BoatMotion();
  private readonly model: BoatModel;
  private readonly touch: TouchSticks;
  private readonly driftButton = el('button', '', 'Drift');
  private readonly driftHeld = new Set<number>();
  private readonly keys = new Set<string>();
  private readonly panel = document.createElement('aside');
  private readonly action = el('button', 'mode-button', 'Boat', this.panel);
  private readonly details = el('div', 'mode-detail', '', this.panel);
  private readonly status = el('div', 'boat-status', '', this.details);
  private readonly speed = el('div', 'boat-speed', '', this.details);
  private readonly help = el('div', 'boat-help', `
    <span class="boat-help-keys">W/S throttle and reverse · A/D steer · Space drift · T unstick · Esc exit</span>
    <span class="boat-help-touch">Left thumb: drag up for throttle, down to reverse, sideways to steer. Hold the right button to drift. Pinch on the right to zoom.</span>
  `, this.details);
  private phase: Phase = 'off';
  private river: number[] | null = null;
  private riverLoad: Promise<void> | null = null;
  private start: { x: number; z: number; h: number; t0: number } | null = null;
  private readonly clock = new FixedStep(STEP, MAX_STEPS, 0.1);
  private zoom = 1;
  private camYaw = 0;
  private camY = 0;
  private intro: { pos: THREE.Vector3; q: THREE.Quaternion; fov: number; t0: number } | null = null;
  private note = '';
  private noteUntil = 0;
  private shakeUntil = 0;
  private shakeA = 0;
  private savedFov = 0;
  private readonly look = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly mat = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();

  constructor(private readonly nav: Nav, private readonly camera: THREE.PerspectiveCamera, private readonly target: THREE.Vector3,
    private readonly meta: Meta, host: HTMLElement, canvas: HTMLCanvasElement,
    private readonly night: () => number = () => 0, private readonly level: () => number = () => 0) {
    Object.assign(window, { __boat: this });
    this.collision = new VoxelCollision(meta, viewerTileCache(meta.tiles.N));
    this.world = this.collision;
    this.model = new BoatModel(nav.actors);
    this.touch = new TouchSticks(canvas, { onPinch: (r) => { this.zoom = clamp(this.zoom * r, 0.5, 2.2); }, camera: 'right' });
    const db = this.driftButton;
    db.id = 'boat-drift-button';
    db.type = 'button';
    db.setAttribute('aria-label', 'Drift (hold)');
    db.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      db.setPointerCapture(e.pointerId);
      this.driftHeld.add(e.pointerId);
      db.classList.add('held');
    });
    const release = (e: PointerEvent) => { this.driftHeld.delete(e.pointerId); db.classList.toggle('held', this.driftHeld.size > 0); };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) db.addEventListener(type, release);
    db.addEventListener('contextmenu', (e) => e.preventDefault());
    this.panel.className = 'boat-mode';
    this.panel.setAttribute('aria-label', 'Drive a boat');
    host.append(this.panel);
    this.status.setAttribute('role', 'status');
    this.action.type = 'button';
    this.action.addEventListener('click', () => { this.toggle(); this.action.blur(); });
    addEventListener('keydown', (e) => {
      if (this.nav.mode !== 'boat' || e.ctrlKey || e.metaKey || e.altKey ||
          (e.target as Element).closest?.('input, textarea, select, button, [contenteditable]')) return;
      if (e.code === 'KeyT') { if (!e.repeat) this.unstick(); }
      else if (KEYS.has(e.code)) this.keys.add(e.code);
      else return;
      e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    canvas.addEventListener('wheel', (e) => {
      if (this.nav.mode !== 'boat') return;
      e.preventDefault();
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.004), 0.5, 2.2);
    }, { passive: false });
    const clearInput = () => { this.keys.clear(); this.touch.clear(); this.driftHeld.clear(); db.classList.remove('held'); };
    addEventListener('blur', clearInput);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); });
    this.draw();
  }

  get pose() { return this.phase === 'on' ? this.motion.pose : null; }

  // into the boat (from the map), or out of it
  toggle() {
    if (this.phase !== 'off') { this.nav.flyUp(); return; }
    if (this.nav.mode !== 'orbit' || !this.nav.startCraft('boat')) return;
    this.loadRiver();
    this.start = null;
    this.phase = 'finding';
    this.savedFov = this.camera.fov;
    this.note = '';
    this.draw();
  }

  // for tools: into the boat at (x, z) heading h (0: +z, pi/2: +x), else where the toggle would put it
  enter(at?: { x: number; z: number; h: number }) {
    this.toggle();
    if (this.phase === 'finding' && at) this.start = { ...at, t0: performance.now() };
  }

  update(dt: number) {
    const active = this.nav.mode === 'boat';
    if (!active && this.phase !== 'off') this.leave();
    if (active && this.phase === 'finding') this.find();
    if (active && this.phase === 'on') {
      const m = this.motion;
      this.collision.prefetch(new THREE.Vector3(m.x, m.y, m.z), new THREE.Vector3(m.vx, 0, m.vz));
      const input = document.hasFocus() && !document.hidden ? this.input() : NO_BOAT_INPUT;
      this.clock.run(dt, (step) => {
        const ev = m.step(input, step, this.world);
        if (ev === 'loading') return false;
        for (const e of ev) {
          this.say(e.speed > 5 ? 'Crash!' : 'Bump!', 600);
          this.shakeUntil = performance.now() + 450;
          this.shakeA = clamp(e.speed / 20, 0.08, 0.5);
        }
        return true;
      });
      const d = m.drawn(), lift = Math.max(0, this.level());
      d.y += lift;
      this.model.update(d, m.speed, this.night(), m.t);
      this.chase(dt, lift);
    }
    this.draw();
  }

  // the river's points (flood.json: every 24 m over the rivers), to find the water nearest the focus
  private loadRiver() {
    this.riverLoad ??= fetchJson<{ river?: number[] }>('data/flood.json')
      .then((f) => { this.river = f.river ?? []; })
      .catch(() => { this.river = []; });
  }

  private find() {
    const now = performance.now();
    if (!this.start) {
      if (!this.river) return;
      const f = this.target, at = nearestRiver(this.river, f.x, f.z) ?? { x: f.x, z: f.z };
      const eck = this.meta.views?.eck?.target;
      this.start = { ...at, h: downstream(this.river, at.x, at.z, eck && { x: eck[0], z: eck[2] }), t0: now };
    }
    const s = this.start, here = new THREE.Vector3(s.x, 0, s.z);
    this.collision.prefetch(here, new THREE.Vector3());
    // (the 3 x 3 nodes round it in: what the search reaches)
    const N = this.meta.tiles.N;
    const ready = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].every(([i, j]) => {
      const x = clamp(s.x + i * N, 0, this.meta.W - 1), z = clamp(s.z + j * N, 0, this.meta.D - 1);
      return this.collision.surface(x, z) !== null;
    });
    if (!ready) {
      if (now - s.t0 > GIVE_UP_MS) { this.say('No water found near here.', 2500); this.nav.flyUp(); }
      return;
    }
    const at = findSpawn(this.world, s.x, s.z, s.h, SPAWN_REACH);
    if (!at) { this.say('No open water near here.', 2500); this.nav.flyUp(); return; }
    this.motion.reset(at);
    this.clock.acc = 0;
    this.zoom = 1;
    this.camYaw = at.h;
    this.camY = at.y;
    this.phase = 'on';
    this.model.visible = true;
    this.touch.setActive(true);
    this.keys.clear();
    this.intro = { pos: this.camera.position.clone(), q: this.camera.quaternion.clone(), fov: this.camera.fov, t0: now };
  }

  private leave() {
    this.phase = 'off';
    this.model.visible = false;
    this.touch.setActive(false);
    this.keys.clear();
    this.driftHeld.clear();
    this.driftButton.classList.remove('held');
    this.intro = null;
    if (this.savedFov) { this.camera.fov = this.savedFov; this.camera.updateProjectionMatrix(); }
  }

  private unstick() {
    if (this.phase === 'on' && this.motion.unstick(this.world)) this.say('Back on open water', 900);
  }

  private say(text: string, ms: number) {
    this.note = text;
    this.noteUntil = performance.now() + ms;
  }

  private input(): BoatInput {
    const pressed = (...codes: string[]) => Number(codes.some((c) => this.keys.has(c)));
    let pad: Gamepad | undefined;
    try { pad = Array.from(navigator.getGamepads?.() ?? []).find((p) => p?.connected && p.mapping === 'standard') ?? undefined; }
    catch { /* the keyboard still works when Gamepad API access is blocked */ }
    const raw = pad?.axes[0] ?? 0;
    const stick = Math.sign(raw) * clamp((Math.abs(raw) - 0.12) / 0.88, 0, 1);
    const left = this.touch.left;
    const pedal = left ? clamp(stickAxis(left.dy, left.radius), -1, 1) : 0;
    const sx = left ? clamp(stickAxis(left.dx, left.radius), -1, 1) : 0;
    const gas = Math.max(pressed('KeyW', 'ArrowUp'), pad?.buttons[7]?.value ?? 0, pedal);
    const back = Math.max(pressed('KeyS', 'ArrowDown'), pad?.buttons[6]?.value ?? 0, -pedal);
    return {
      throttle: clamp(gas - back, -1, 1),
      steer: clamp(pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft') + stick + Math.sign(sx) * Math.abs(sx) ** STEER_CURVE, -1, 1),
      drift: this.keys.has('Space') || !!pad?.buttons[0]?.pressed || this.driftHeld.size > 0,
    };
  }

  // behind the boat along a heading that follows its own with a lag (a turn shows it a little from the side), over the
  // water; pulled in where the collision meets something between the boat and the camera
  private chase(dt: number, lift: number) {
    const m = this.motion, now = performance.now();
    let dh = m.h - this.camYaw;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.camYaw += dh * (1 - Math.exp(-3.2 * dt));
    this.camY += (m.y - this.camY) * (1 - Math.exp(-3 * dt));
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw), base = this.camY + lift;
    const eye = new THREE.Vector3(m.x, base + 1.6, m.z);
    const off = new THREE.Vector3(-fx * BACK * this.zoom, UP * this.zoom - 1.6, -fz * BACK * this.zoom);
    const s = this.collision.sweep(eye, off);
    const k = s === 'loading' || !s.hit ? 1 : Math.max(0.25, s.fraction - 0.4 / off.length());
    const pos = this.pos.copy(eye).addScaledVector(off, k);
    if (now < this.shakeUntil) {
      const a = this.shakeA * (this.shakeUntil - now) / 450;
      pos.x += Math.sin(now * 0.071) * a; pos.y += Math.sin(now * 0.093 + 1) * a; pos.z += Math.sin(now * 0.057 + 2) * a;
    }
    const at = new THREE.Vector3(m.x + Math.sin(m.h) * AHEAD, base + 1.2, m.z + Math.cos(m.h) * AHEAD);
    const q = this.q.setFromRotationMatrix(this.mat.lookAt(pos, at, THREE.Object3D.DEFAULT_UP));
    const fov = 60 + 8 * clamp(Math.abs(m.speed) / 18.5, 0, 1);
    const cam = this.camera;
    const I = this.intro;
    if (I) {
      const t = Math.min(1, (now - I.t0) / INTRO_MS), e = t * t * (3 - 2 * t);
      cam.position.lerpVectors(I.pos, pos, e);
      cam.quaternion.slerpQuaternions(I.q, q, e);
      cam.fov = I.fov + (fov - I.fov) * e;
      if (t >= 1) this.intro = null;
    } else {
      cam.position.copy(pos);
      cam.quaternion.copy(q);
      cam.fov += (fov - cam.fov) * (1 - Math.exp(-2 * dt));
    }
    cam.updateProjectionMatrix();
    // (the shadow fit and the fog read the target: as the ride's)
    this.target.copy(cam.position).addScaledVector(cam.getWorldDirection(this.look), 10);
  }

  private draw() {
    const on = this.phase === 'on', active = this.phase !== 'off';
    document.body.classList.toggle('boating', active);
    this.panel.classList.toggle('mode-active', active);
    const label = active ? 'Exit boat' : 'Boat';
    if (this.action.textContent !== label) this.action.textContent = label;
    this.action.disabled = !active && this.nav.mode !== 'orbit';
    this.details.hidden = !active && performance.now() >= this.noteUntil;
    this.speed.hidden = this.help.hidden = !on;
    const message = this.phase === 'finding' ? 'Looking for water…' : on && this.motion.waiting ? 'Loading collision tiles…' :
      performance.now() < this.noteUntil ? this.note : '';
    if (this.status.textContent !== message) this.status.textContent = message;
    if (on) {
      const speed = Math.round(Math.abs(this.motion.kmh)) + ' km/h';
      if (this.speed.textContent !== speed) this.speed.textContent = speed;
    }
  }
}
