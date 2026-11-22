import * as THREE from 'three';
import type { Meta } from '../types';
import { clamp, el } from '../util';
import { viewerTileCache } from '../viewer-tiles';
import { flying, type Nav } from './nav';
import { collisionWorld, JET, PLANE, PlaneFlight, waterTop, type PlaneConfig, type PlaneInput, type PlanePose, type PlaneWorld } from './plane-flight';
import { PlaneModel } from './plane-model';
import { JetModel } from './jet-model';
import { stickAxis, TouchSticks } from './touch-sticks';
import { VoxelCollision } from './voxel-collision';
import './plane.css';

// The plane mode: the glue round plane-flight.ts (the flight, pure): the panel, the input (keyboard, touch, gamepad),
// the chase camera, the model, the crash's tint and shake. Two aircraft, picked by the panel's buttons: the floatplane
// (PLANE: in the air where the camera is, or afloat on the river nearest the view) and the aerobatic jet (JET: in the
// air only; the stick rolls and pitches it, the chase camera rolls with it through loops). Entered from orbit only.
//
// Keys: A/D turn, W/S nose down/up (flight convention; "Invert pitch" swaps), Shift or R throttle up, Space or F down
// (held, gradual; not Ctrl: Ctrl+W would close the tab), T back to the last safe point, Esc exit (nav.ts). Touch: the
// left thumb is a stick (sideways turn, up nose down), the throttle a slider on the right that stays where it is left,
// a pinch on the right zooms. Gamepad (standard mapping): left stick turn and pitch, RT/LT (or the right stick up/down)
// move the throttle.

const KEYS = new Set(['KeyA', 'KeyD', 'KeyW', 'KeyS', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ShiftLeft', 'ShiftRight', 'KeyR', 'KeyF', 'Space']);
const THROTTLE_RATE = 0.5; // /s the lever moves while a key is held (0 to full in 2 s)
const INVERT_KEY = 'plane-invert-v1';
const ENTER_MS = 600;
const CRASH_TINT_MS = 1200;
const DEAD = 0.12;

// the aircraft: the flight's numbers (plane-flight.ts, the same on a server) and what only the viewer needs
type Chase = { back: number; up: number; look: number; lag: number; rollLag: number; fov: (v: number) => number };
interface Aircraft { cfg: PlaneConfig; label: string; model: () => PlaneModel | JetModel; chase: Chase; help: [keys: string, touch: string] }
type AircraftId = 'floatplane' | 'jet';
const AIRCRAFT: Record<AircraftId, Aircraft> = {
  floatplane: { cfg: PLANE, label: 'plane', model: () => new PlaneModel(PLANE.FLOAT_H),
    chase: { back: 14, up: 4, look: 30, lag: 4, rollLag: 3, fov: (v) => clamp(56 + (v - 25) * 0.33, 56, 74) },
    help: ['A/D turn · W/S nose down/up · Shift/R throttle up · Space/F down · T last safe point · Esc exit',
      'Left thumb: sideways to turn, up/down for the nose. Right slider: throttle. Pinch on the right to zoom.'] },
  jet: { cfg: JET, label: 'jet', model: () => new JetModel(),
    chase: { back: 17, up: 3.5, look: 40, lag: 5, rollLag: 4, fov: (v) => clamp(60 + (v - 50) * 0.2, 60, 78) },
    help: ['A/D roll · W/S nose down/up (hold S for a loop) · let go: it holds its path · Shift/R throttle (top 15 %: afterburner) · Space/F less · T last safe point · Esc exit',
      'Left thumb: sideways to roll, up/down for the nose; let go and it holds its path. Right slider: throttle. Pinch on the right to zoom.'] },
};

export interface PlaneEnv {
  /** the river level slider, m over the survey day (flood.ts) */
  level: () => number;
  /** 0 by day .. 1 by night (daylight.ts) */
  night: () => number;
  /** the river's cells (flood.json river: x, z pairs), for a start on the water */
  river: () => number[] | null;
}

function button(label: string, run: () => void, parent: HTMLElement) {
  const b = el('button', 'mode-button', label, parent);
  b.type = 'button';
  b.addEventListener('click', () => { run(); b.blur(); });
  return b;
}

const readInvert = () => { try { return localStorage.getItem(INVERT_KEY) === '1'; } catch { return false; } };

export class PlaneMode {
  private type: Aircraft = AIRCRAFT.floatplane;
  // per aircraft (made when first flown): its flight, model, and collision (the fuselage's radius, the horizon)
  private readonly made = new Map<Aircraft, { flight: PlaneFlight; model: PlaneModel | JetModel; collision: VoxelCollision; world: PlaneWorld }>();
  private collision!: VoxelCollision;
  private world!: PlaneWorld;
  flight!: PlaneFlight;
  private model!: PlaneModel | JetModel;
  private readonly touch: TouchSticks;
  private readonly keys = new Set<string>();
  private readonly panel = document.createElement('aside');
  private readonly enter: HTMLButtonElement;
  private readonly enterWater: HTMLButtonElement;
  private readonly enterJet: HTMLButtonElement;
  private readonly details = el('div', 'mode-detail', '', this.panel);
  private readonly status = el('div', 'plane-status', '', this.details);
  private readonly telemetry = el('div', 'plane-telemetry', '', this.details);
  private readonly help = el('div', 'plane-help', '', this.details);
  private readonly invertBox: HTMLInputElement;
  private readonly tint = el('div', 'fpv-impact-tint plane-tint');
  private readonly slider = el('div', '', '<div class="fill"></div><div class="knob"></div><span class="val"></span>');
  private throttle = 0.6;
  private invert = readInvert();
  private phase: 'off' | 'loading' | 'flying' = 'off';
  private start: { x: number; z: number; y: number; heading: number; water: boolean } | null = null;
  private notice = '';
  private noticeUntil = 0;
  private crashAt = -1e9;
  private blurred = false;
  private scripted: PlaneInput | null = null;
  private zoom = 1;
  private enterFrom: { p: THREE.Vector3; q: THREE.Quaternion; fov: number; t0: number } | null = null;
  private readonly cam = { yaw: 0, pitch: 0, fov: 62, fwd: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) };
  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly v4 = new THREE.Vector3();
  private nextPanel = 0;
  private savedFov = 0;

  constructor(private readonly nav: Nav, private readonly camera: THREE.PerspectiveCamera, private readonly target: THREE.Vector3,
    private readonly meta: Meta, host: HTMLElement, canvas: HTMLCanvasElement, private readonly env: PlaneEnv) {
    this.use(AIRCRAFT.floatplane);
    this.panel.className = 'plane-mode';
    this.panel.setAttribute('aria-label', 'Plane');
    this.enter = button('Plane', () => this.toggle(false, AIRCRAFT.floatplane), this.panel);
    this.enterWater = button('Plane on the river', () => this.toggle(true, AIRCRAFT.floatplane), this.panel);
    this.enterJet = button('Jet', () => this.toggle(false, AIRCRAFT.jet), this.panel);
    this.panel.append(this.details);
    host.append(this.panel);
    this.status.setAttribute('role', 'status');
    const label = el('label', 'plane-invert', '<input type="checkbox"> Invert pitch', this.details);
    this.invertBox = label.querySelector('input')!;
    this.invertBox.checked = this.invert;
    this.invertBox.addEventListener('change', () => {
      this.invert = this.invertBox.checked;
      try { localStorage.setItem(INVERT_KEY, this.invert ? '1' : '0'); } catch { /* not remembered */ }
      this.invertBox.blur();
    });
    this.tint.setAttribute('aria-hidden', 'true');
    // the throttle slider (touch): where the finger is on it, the lever is; it stays when let go
    const sl = this.slider;
    sl.id = 'plane-throttle';
    sl.setAttribute('role', 'slider');
    sl.setAttribute('aria-label', 'Throttle');
    const setFrom = (e: PointerEvent) => {
      const r = sl.getBoundingClientRect();
      this.throttle = clamp((r.bottom - 12 - e.clientY) / (r.height - 24), 0, 1);
    };
    sl.addEventListener('pointerdown', (e) => { e.preventDefault(); sl.setPointerCapture(e.pointerId); setFrom(e); });
    sl.addEventListener('pointermove', (e) => { if (sl.hasPointerCapture(e.pointerId)) setFrom(e); });
    sl.addEventListener('contextmenu', (e) => e.preventDefault());
    this.touch = new TouchSticks(canvas, { onPinch: (ratio) => { this.zoom = clamp(this.zoom * ratio, 0.6, 2.2); }, camera: 'right' });
    canvas.addEventListener('wheel', (e) => {
      if (this.nav.mode !== 'plane') return;
      e.preventDefault();
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.004), 0.6, 2.2);
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (this.nav.mode !== 'plane' || e.metaKey || e.ctrlKey || e.altKey ||
          (e.target as Element).closest?.('input:not([type=checkbox]), select, textarea, [contenteditable]')) return;
      if (e.code === 'KeyT') { if (!e.repeat) this.backToSafe(); }
      else if (KEYS.has(e.code)) this.keys.add(e.code);
      else return;
      e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.blurred = true; this.keys.clear(); this.touch.clear(); });
    addEventListener('focus', () => { this.blurred = false; });
    Object.assign(window, { __plane: {
      start: (s: { x: number; y?: number; z: number; h?: number; water?: boolean; type?: AircraftId }) => this.startAt(s),
      pose: () => ({ ...this.flight.p, heading: this.flight.heading, gamma: this.flight.gamma, bank: this.flight.bank, kmh: this.flight.v * 3.6, state: this.flight.state, throttle: this.throttle,
        type: this.type.label, g: this.flight.load }),
      script: (inp: PlaneInput | null) => { this.scripted = inp; if (inp) this.throttle = inp.throttle; },
    } });
    this.draw();
  }

  // the aircraft flown from now on (not while one flies)
  private use(type: Aircraft) {
    let m = this.made.get(type);
    if (!m) {
      const collision = new VoxelCollision(this.meta, viewerTileCache(this.meta.tiles.N), { radius: type.cfg.RADIUS, horizon: type.cfg.HORIZON });
      m = { flight: new PlaneFlight(type.cfg), model: type.model(), collision, world: collisionWorld(collision, this.meta.H, this.env.level) };
      this.nav.actors.add(m.model.group);
      this.made.set(type, m);
    }
    if (this.collision !== m.collision) this.collision?.release();
    this.type = type;
    this.help.innerHTML = `<span class="plane-help-keys">${type.help[0]}</span><span class="plane-help-touch">${type.help[1]}</span>`;
    ({ flight: this.flight, model: this.model, collision: this.collision, world: this.world } = m);
  }

  // ------------------------------------------------------------------ entering and leaving
  private toggle(water: boolean, type: Aircraft) {
    if (this.nav.mode === 'plane') { this.nav.flyUp(); return; }
    const pos = this.camera.position, look = this.target.clone().sub(pos);
    let x = pos.x, z = pos.z, heading = Math.atan2(look.x, look.z);
    if (water) {
      const r = this.nearestRiver(this.target.x, this.target.z);
      if (!r) { this.say('No river near the view', 2500); return; }
      [x, z] = r;
    }
    this.startAt({ x, z, y: pos.y, h: heading, water, type: type === AIRCRAFT.jet ? 'jet' : 'floatplane' });
  }

  private startAt(s: { x: number; y?: number; z: number; h?: number; water?: boolean; type?: AircraftId }) {
    if (this.nav.mode !== 'plane') {
      if (!this.nav.startCraft('plane')) return false;
      this.use(AIRCRAFT[s.type ?? 'floatplane']);
      this.enterFrom = { p: this.camera.position.clone(), q: this.camera.quaternion.clone(), fov: this.camera.fov, t0: performance.now() };
      this.savedFov = this.camera.fov;
    }
    // (clear of the map's wall: ~5 s of flight at the start's speed)
    const c = this.type.cfg, m = c.EDGE + Math.max(230, 5 * c.RESPAWN_SPEED);
    this.start = { x: clamp(s.x, m, this.meta.W - m), z: clamp(s.z, m, this.meta.D - m), y: s.y ?? 200, heading: s.h ?? 0, water: !!s.water && c.WATER_SPEED > 0 };
    if (s.water) { this.start.x = s.x; this.start.z = s.z; }
    this.phase = 'loading';
    this.keys.clear();
    this.touch.setActive(true);
    this.notice = '';
    return true;
  }

  // the river cell (flood.json) nearest (x, z): where the river can be; the water itself is found in the voxels then
  private nearestRiver(x: number, z: number): [number, number] | null {
    const r = this.env.river();
    if (!r?.length) return null;
    let best: [number, number] | null = null, d = Infinity;
    for (let k = 0; k < r.length; k += 2) {
      const e = (r[k] - x) ** 2 + (r[k + 1] - z) ** 2;
      if (e < d) { d = e; best = [r[k] + 12, r[k + 1] + 12]; }
    }
    return best;
  }

  // once the start's collision tiles are in: in the air, clear over the highest column round it; on the water, at the
  // open water nearest the river cell, facing along the longest open stretch
  private prepare() {
    const s = this.start!, col = this.collision;
    col.prefetch(this.v3.set(s.x, 0, s.z), this.v4.set(0, 0, 0));
    if (s.water) {
      const found = this.openWater(s.x, s.z);
      if (found === null) return;
      if (!found) { this.say('No open water here: starting in the air', 3000); s.water = false; return; }
      this.flight.reset({ x: found.x, y: found.water + this.type.cfg.FLOAT_H, z: found.z, heading: found.heading, water: true });
      this.throttle = 0;
    } else {
      let top = 0;
      for (const dx of [-60, 0, 60]) for (const dz of [-60, 0, 60]) {
        const su = col.surface(s.x + dx, s.z + dz);
        if (!su) return;
        top = Math.max(top, su.top);
      }
      const c = this.type.cfg;
      const pose: PlanePose = { x: s.x, y: clamp(s.y, top + c.RESPAWN_AGL, top + 300), z: s.z, heading: s.heading, speed: c.RESPAWN_SPEED };
      this.flight.reset(pose);
      this.throttle = this.scripted?.throttle ?? c.RESPAWN_THROTTLE;
    }
    this.flight.engine = this.throttle;
    this.flight.events.length = 0;
    this.cam.yaw = this.flight.heading;
    this.cam.pitch = 0;
    this.flight.attitude(this.cam.fwd, this.cam.up);
    this.phase = 'flying';
  }

  // open water within ~100 m of (x, z): the water column with the longest straight water run through it (8
  // directions, up to 300 m); null: tiles not in yet; false: none
  private openWater(x: number, z: number) {
    const col = this.collision;
    let best: { x: number; z: number; water: number; heading: number; run: number } | null = null;
    for (let r = 0; r <= 100; r += 20) for (let a = 0; a < (r ? 12 : 1); a++) {
      const px = x + r * Math.cos(a * Math.PI / 6), pz = z + r * Math.sin(a * Math.PI / 6);
      const w = waterTop(col, px, pz);
      if (w === null) return null;
      if (w < 0) continue;
      for (let k = 0; k < 8; k++) {
        const h = k * Math.PI / 4, sx = Math.sin(h), sz = Math.cos(h);
        let run = 0;
        for (; run < 300; run += 6) { const q = waterTop(col, px + sx * run, pz + sz * run); if (q === null || q < 0) break; }
        // (the side to side room as well: a long narrow channel is no runway)
        let side = 0;
        for (; side < 60; side += 6) { const q = waterTop(col, px + sz * side, pz - sx * side), q2 = waterTop(col, px - sz * side, pz + sx * side); if (q === null || q < 0 || q2 === null || q2 < 0) break; }
        const score = run + 2 * side;
        if (!best || score > best.run) best = { x: px, z: pz, water: w, heading: h, run: score };
      }
    }
    return best;
  }

  private backToSafe() {
    if (this.phase !== 'flying') return;
    this.flight.respawn(this.world);
  }

  private leave() {
    this.collision.release();
    this.phase = 'off';
    this.start = null;
    this.keys.clear();
    this.touch.setActive(false);
    this.model.group.visible = false;
    this.enterFrom = null;
    this.scripted = null;
    this.camera.up.set(0, 1, 0);
    if (this.savedFov) { this.camera.fov = this.savedFov; this.camera.updateProjectionMatrix(); this.savedFov = 0; }
  }

  private say(text: string, ms: number) { this.notice = text; this.noticeUntil = performance.now() + ms; }

  // ------------------------------------------------------------------ every frame
  update(dt: number) {
    const active = this.nav.mode === 'plane';
    if (!active && this.phase !== 'off') this.leave();
    if (active) {
      if (this.phase === 'loading') this.prepare();
      if (this.phase === 'flying') this.fly(dt);
    }
    const now = performance.now();
    if (now >= this.nextPanel) { this.nextPanel = now + 100; this.draw(); }
    const k = (now - this.crashAt) / CRASH_TINT_MS;
    this.tint.style.opacity = active && k < 1 ? String(0.7 * (1 - k)) : '0';
  }

  private fly(dt: number) {
    const f = this.flight, now = performance.now();
    const paused = this.blurred || document.hidden;
    if (!paused) {
      const input = this.input(dt);
      f.advance(input, dt, this.world);
    }
    this.collision.prefetch(f.p, f.velocity(this.v3));
    for (const e of f.events.splice(0)) {
      if (e.type === 'crash') {
        this.crashAt = now;
        this.say(e.what === 'water' ? `Splash! (${e.kmh} km/h) Back at a safe point…` : `Crash! (${e.what}, ${e.kmh} km/h) Back at a safe point…`, 0);
      } else if (e.type === 'respawn') { this.throttle = e.throttle; }
      else if (e.type === 'skim') this.say('Careful!', 1500);
      else if (e.type === 'touchdown') this.say('On the water', 2000);
      else if (e.type === 'takeoff') this.say('Airborne', 1500);
      else if (e.type === 'bump') this.say('Bump', 1200);
    }
    this.model.group.visible = f.state !== 'crashed';
    this.model.orient(f.p, f.attitude(this.fwd, this.up), this.up);
    this.model.animate(dt, f.engine, this.env.night(), now);
    this.chase(dt, now);
  }

  private input(dt: number): PlaneInput {
    if (this.scripted) return this.scripted;
    const has = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    let pad: Gamepad | undefined;
    try { pad = Array.from(navigator.getGamepads?.() ?? []).find((p) => p?.connected && p.mapping === 'standard') ?? undefined; }
    catch { /* the keyboard still works when the Gamepad API is blocked */ }
    const dz = (v: number | undefined) => { const a = v ?? 0; return Math.sign(a) * clamp((Math.abs(a) - DEAD) / (1 - DEAD), 0, 1); };
    // the throttle lever: keys and triggers move it, the slider sets it (pointer handlers)
    let lever = (has('ShiftLeft', 'ShiftRight', 'KeyR') ? 1 : 0) - (has('Space', 'KeyF') ? 1 : 0);
    if (pad) lever += (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0) - dz(pad.axes[3]);
    this.throttle = clamp(this.throttle + clamp(lever, -1, 1) * THROTTLE_RATE * dt, 0, 1);
    // stick: flight convention, stick back (S, down, the touch stick pulled down, the pad's stick back) = nose up
    let turn = (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0);
    let back = (has('KeyS', 'ArrowDown') ? 1 : 0) - (has('KeyW', 'ArrowUp') ? 1 : 0);
    const s = this.touch.left;
    if (s) {
      const x = clamp(stickAxis(s.dx, s.radius), -1, 1), y = clamp(stickAxis(s.dy, s.radius), -1, 1);
      turn += Math.sign(x) * Math.abs(x) ** 1.5;
      back -= Math.sign(y) * Math.abs(y) ** 1.3;
    }
    if (pad) { turn += dz(pad.axes[0]); back += dz(pad.axes[1]); }
    const pitch = clamp(back, -1, 1) * (this.invert ? -1 : 1);
    return { turn: clamp(turn, -1, 1), pitch, throttle: this.throttle };
  }

  // the chase camera: behind and over the plane. The floatplane's along a heading and pitch that follow its own with a
  // lag, rolled by a quarter of its bank; the jet's along its nose and its up, both lagged (it rolls with the jet,
  // through loops and inverted). Kept clear of what the collision holds; the field of view by speed; shaken by a crash
  private chase(dt: number, now: number) {
    const f = this.flight, cam = this.camera, c = this.cam, ch = this.type.chase, aero = this.type.cfg.AEROBATIC;
    let fwd: THREE.Vector3, off: THREE.Vector3;
    if (aero) {
      f.attitude(this.fwd, this.up);
      c.fwd.lerp(this.fwd, 1 - Math.exp(-ch.lag * dt)).normalize();
      c.up.lerp(this.up, 1 - Math.exp(-ch.rollLag * dt));
      c.up.addScaledVector(c.fwd, -c.up.dot(c.fwd)).normalize();
      c.yaw = Math.atan2(c.fwd.x, c.fwd.z);
      fwd = this.v3.copy(c.fwd);
      off = this.v4.copy(fwd).multiplyScalar(-ch.back * this.zoom).addScaledVector(c.up, ch.up * this.zoom);
    } else {
      c.yaw += Math.atan2(Math.sin(f.heading - c.yaw), Math.cos(f.heading - c.yaw)) * (1 - Math.exp(-ch.lag * dt));
      c.pitch += (f.gamma * 0.7 - c.pitch) * (1 - Math.exp(-ch.rollLag * dt));
      fwd = this.v3.set(Math.sin(c.yaw) * Math.cos(c.pitch), Math.sin(c.pitch), Math.cos(c.yaw) * Math.cos(c.pitch));
      off = this.v4.copy(fwd).multiplyScalar(-ch.back * this.zoom);
      off.y += ch.up * this.zoom;
    }
    const hit = f.state !== 'crashed' ? this.collision.sweep(f.p, off) : 'loading';
    const k = hit !== 'loading' && hit.hit ? Math.max(0.15, hit.fraction - 0.5 / off.length()) : 1;
    const want = off.multiplyScalar(k).add(f.p);
    const look = fwd.multiplyScalar(ch.look).add(f.p);
    const crash = (now - this.crashAt) / CRASH_TINT_MS;
    if (crash < 1) {
      const a = 0.8 * (1 - crash) ** 2;
      want.x += Math.sin(now * 0.071) * a; want.y += Math.sin(now * 0.093 + 1) * a; want.z += Math.sin(now * 0.057 + 2) * a;
    }
    if (aero) cam.up.copy(c.up); else cam.up.set(0, 1, 0);
    cam.position.copy(want);
    cam.lookAt(look);
    if (!aero) cam.rotateZ(-f.bank * 0.25);
    c.fov += (ch.fov(f.v) - c.fov) * (1 - Math.exp(-2 * dt));
    let fov = c.fov;
    // the entry: from where the map camera was to the chase pose
    const E = this.enterFrom;
    if (E) {
      const t = Math.min(1, (now - E.t0) / ENTER_MS), e = t * t * (3 - 2 * t);
      cam.position.lerpVectors(E.p, cam.position, e);
      cam.quaternion.slerpQuaternions(E.q, cam.quaternion.clone(), e);
      fov = E.fov + (fov - E.fov) * e;
      if (t >= 1) this.enterFrom = null;
    }
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
    // (the shadows' fit and the fog read the target: ahead of the plane)
    this.target.copy(f.p).addScaledVector(this.v3.set(Math.sin(c.yaw), 0, Math.cos(c.yaw)), aero ? 200 : 150);
  }

  // ------------------------------------------------------------------ the panel
  private draw() {
    const active = this.nav.mode === 'plane', f = this.flight, on = active && this.phase === 'flying';
    document.body.classList.toggle('plane-flying', active);
    this.panel.hidden = flying(this.nav.mode) && !active;
    this.panel.classList.toggle('mode-active', active);
    this.details.hidden = !active;
    this.help.hidden = this.phase !== 'flying';
    this.enter.textContent = active ? `Exit ${this.type.label}` : 'Plane';
    const canStart = this.nav.canStartCraft;
    this.enter.disabled = !active && !canStart;
    this.enterWater.hidden = this.enterJet.hidden = active;
    this.enterJet.disabled = !canStart;
    this.enterWater.disabled = !canStart || !this.env.river()?.length;
    const pct = Math.round(this.throttle * 100);
    (this.slider.querySelector('.fill') as HTMLElement).style.height = `${pct}%`;
    (this.slider.querySelector('.knob') as HTMLElement).style.bottom = `calc(${this.throttle} * (100% - 24px))`;
    this.slider.querySelector('.val')!.textContent = `${pct}%`;
    this.slider.setAttribute('aria-valuenow', String(pct));
    const now = performance.now();
    const msg = (on && f.state === 'crashed') || now < this.noticeUntil ? this.notice :
      this.phase === 'loading' ? 'Loading collision tiles near the start…' :
      !on ? '' :
      this.blurred || document.hidden ? 'Paused (window not in focus)' :
      f.waiting ? 'Waiting for the next collision tile…' :
      f.stalled ? 'Stall! Nose down or more throttle' :
      f.atEdge ? 'Map edge: turn back' : '';
    if (this.status.textContent !== msg) this.status.textContent = msg;
    if (!on) { this.telemetry.textContent = ''; return; }
    const su = this.collision.surface(f.p.x, f.p.z);
    const where = f.state === 'water' ? 'on the water' : su ? `${Math.round(f.p.y - f.cfg.RADIUS - su.ground)} m AGL` : `${Math.round(f.p.y)} m`;
    const g = f.cfg.AEROBATIC && f.state === 'air' ? ` · ${f.load.toFixed(1)} g` : '';
    const text = `${Math.round(f.v * 3.6)} km/h · ${where}${g} · throttle ${pct}%`;
    if (this.telemetry.textContent !== text) this.telemetry.textContent = text;
  }
}
