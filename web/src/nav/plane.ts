import type { Help } from '../ui/help';
import * as THREE from 'three';
import type { Meta } from '../core/meta';
import { clamp, el } from '../util';
import type { Nav } from './nav';
import { CraftLink, type CraftContext, type CraftEnv, type CraftSpot, type PlayerCraft } from './craft';
import type { CraftView } from '../client/sim-client';
import type { PlaneCore, PlaneDrawn } from '../sim/craft/plane-core';
import { FIGHTER, JET, PLANE, type PlaneConfig } from '../sim/craft/plane-flight';
import { mountOf, mountPoint, SEATS, type Mount } from '../sim/seats';
import { weaponById } from '../sim/weapons';
import { REACH } from '../sim/weapons/weapon';
import { aimPoint } from './gunner';
import type { PlaneInput } from '../sim/contract/inputs';
import { craftLook } from '../view/crafts';
import type { CraftLook } from '../view/crafts/craft-look';
import { TouchSticks } from '../touch/sticks';
import { gameKey, gamepad, HeldKeys, inFocus, onFocusLoss, padAxis, PAUSED } from './input';
import { ChaseRig, clearShare, follow, followAngle, shake } from './chase-rig';
import { ModePanel } from './mode-panel';
import { nearestRiver, waterTop } from '../sim/river';
import './plane.css';

// The plane mode: the glue round the world sim's plane (CraftLink 'floatplane' | 'jet' | 'fighter': its core,
// sim/craft/plane-core.ts round plane-flight.ts, stepped on the world's clock with its collision; the local player its
// pilot): the panel, the input (keyboard, touch, gamepad), the chase camera, the model, the crash's tint and shake. Three aircraft, picked by the panel's buttons: the floatplane
// (PLANE: in the air where the camera is, or afloat on the river nearest the view), the aerobatic jet (JET: in the
// air only; the stick rolls and pitches it, the chase camera rolls with it through loops) and the combat plane
// (FIGHTER: as the floatplane, with the MG fixed in its nose: the gunsight's dot where the nose points at the MG's
// range, the left mouse button, the gamepad's A or the touch button fires). Entered from orbit only.
//
// Keys: A/D turn, W/S nose down/up (flight convention; "Invert pitch" swaps), Shift or R throttle up, Space or F down
// (held, gradual; not Ctrl: Ctrl+W would close the tab), T back to the last safe point, Esc exit (nav.ts). Touch: the
// left thumb is a stick (sideways turn, up nose down), the throttle a slider on the right that stays where it is left,
// a pinch on the right zooms. Gamepad (standard mapping): left stick turn and pitch, RT/LT (or the right stick up/down)
// move the throttle. Out of focus its input is hands off: the stick let go, the lever where it is (input.ts).

const KEYS: ReadonlySet<string> = new Set(['KeyA', 'KeyD', 'KeyW', 'KeyS', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ShiftLeft', 'ShiftRight', 'KeyR', 'KeyF', 'Space']);
const THROTTLE_RATE = 0.5; // /s the lever moves while a key is held (0 to full in 2 s)
const INVERT_KEY = 'plane-invert-v1';
const ENTER_MS = 600;
const CRASH_TINT_MS = 1200;
const Z = new THREE.Vector3(0, 0, 1);

// the aircraft: the flight's numbers (plane-flight.ts, the same on a server) and what only the viewer needs
type Chase = { back: number; up: number; look: number; lag: number; rollLag: number; fov: (v: number) => number };
type Look = CraftLook<'floatplane'> | CraftLook<'jet'> | CraftLook<'fighter'>;
interface Aircraft { id: AircraftId; cfg: PlaneConfig; label: string; model: () => Look; chase: Chase; help: [keys: string, touch: string] }
type AircraftId = 'floatplane' | 'jet' | 'fighter';
const AIRCRAFT: Record<AircraftId, Aircraft> = {
  floatplane: { id: 'floatplane', cfg: PLANE, label: 'plane', model: () => craftLook('floatplane'),
    chase: { back: 14, up: 4, look: 30, lag: 4, rollLag: 3, fov: (v) => clamp(56 + (v - 25) * 0.33, 56, 74) },
    help: ['A/D turn · W/S nose down/up · R/F throttle up and down · X out (high up: under a paraglider) · T last safe point',
      'Left thumb: sideways to turn, up/down for the nose. Right slider: throttle. Pinch on the right to zoom.'] },
  jet: { id: 'jet', cfg: JET, label: 'jet', model: () => craftLook('jet'),
    chase: { back: 17, up: 3.5, look: 40, lag: 5, rollLag: 4, fov: (v) => clamp(60 + (v - 50) * 0.2, 60, 78) },
    help: ['A/D roll · W/S nose down/up (hold S for a loop) · let go: it holds its path · R/F throttle up and down (top 15 %: afterburner) · X out (high up: under a paraglider) · T last safe point',
      'Left thumb: sideways to roll, up/down for the nose; let go and it holds its path. Right slider: throttle. Pinch on the right to zoom.'] },
  fighter: { id: 'fighter', cfg: FIGHTER, label: 'combat plane', model: () => craftLook('fighter'),
    chase: { back: 14, up: 3.5, look: 40, lag: 5, rollLag: 3.5, fov: (v) => clamp(56 + (v - 25) * 0.3, 56, 74) },
    help: ['A/D turn · W/S nose down/up · left mouse button: fire (aim with the nose: the dot) · R/F throttle up and down · X out (high up: under a paraglider) · T last safe point',
      'Left thumb: sideways to turn, up/down for the nose. Fire button: the gun, aimed with the nose (the dot). Right slider: throttle. Pinch on the right to zoom.'] },
};

const readInvert = () => { try { return localStorage.getItem(INVERT_KEY) === '1'; } catch { return false; } };

export class PlaneMode implements PlayerCraft {
  readonly id = 'plane';
  readonly view = 'own';
  readonly boards = ['floatplane', 'jet', 'fighter'] as const;
  private readonly nav: Nav;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly target: THREE.Vector3;
  private readonly meta: Meta;
  private readonly env: CraftEnv;
  private type: Aircraft = AIRCRAFT.floatplane;
  // per aircraft (made when first flown): its model
  private readonly made = new Map<Aircraft, Look>();
  private model!: Look;
  // the plane in the world sim while the player flies it (its client, its own collision)
  private readonly link: CraftLink<AircraftId>;
  // the chase camera to be set from the plane once the sim has put it down
  private aim = false;
  private readonly touch: TouchSticks;
  private readonly keys = new HeldKeys(KEYS);
  private readonly panel: ModePanel;
  private readonly enterButton: HTMLButtonElement;
  private readonly enterWater: HTMLButtonElement;
  private readonly enterJet: HTMLButtonElement;
  private readonly enterFighter: HTMLButtonElement;
  // the combat plane's gun: its mount, the trigger held (the mouse's, the touch button's), the gunsight's dot and the
  // touch button
  private gun: Mount | null = null;
  /** flying: the mouse taken (Nav); with a gun its left button fires */
  get mouse() { return this.phase === 'flying'; }
  private trigger = false;
  private readonly sight = el('div', 'plane-sight');
  private readonly fireButton = el('button', 'plane-fire', 'Fire');
  private readonly telemetry: HTMLDivElement;
  private readonly invertBox: HTMLInputElement;
  private readonly rig: ChaseRig;
  private readonly tint = el('div', 'fpv-impact-tint plane-tint');
  private readonly slider = el('div', '', '<div class="fill"></div><div class="knob"></div><span class="val"></span>');
  private throttle = 0.6;
  private invert = readInvert();
  private phase: 'off' | 'loading' | 'flying' = 'off';
  private start: { x: number; z: number; y: number; heading: number; water: boolean } | null = null;
  private crashAt = -1e9;
  private zoom = 1;
  private readonly cam = { yaw: 0, pitch: 0, fwd: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) };
  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly v4 = new THREE.Vector3();
  private readonly bank = new THREE.Quaternion();
  private nextPanel = 0;

  constructor(ctx: CraftContext) {
    const { nav, camera, target, meta, host, canvas, env } = ctx;
    this.nav = nav; this.camera = camera; this.target = target; this.meta = meta; this.env = env;
    this.link = new CraftLink<AircraftId>(ctx, 'floatplane');
    const P = this.panel = new ModePanel(host, 'plane', 'Plane');
    this.enterButton = P.button('Plane', () => this.toggle(false, AIRCRAFT.floatplane));
    this.enterWater = P.button('Plane on the river', () => this.toggle(true, AIRCRAFT.floatplane));
    this.enterJet = P.button('Jet', () => this.toggle(false, AIRCRAFT.jet));
    this.enterFighter = P.button('Combat plane', () => this.toggle(false, AIRCRAFT.fighter));
    this.telemetry = P.line('telemetry');
    this.rig = new ChaseRig(camera);
    this.use(AIRCRAFT.floatplane);
    const label = el('label', 'plane-invert', '<input type="checkbox"> Invert pitch', P.details);
    this.invertBox = label.querySelector('input')!;
    this.invertBox.checked = this.invert;
    this.invertBox.addEventListener('change', () => {
      this.invert = this.invertBox.checked;
      try { localStorage.setItem(INVERT_KEY, this.invert ? '1' : '0'); } catch { /* not remembered */ }
      this.invertBox.blur();
    });
    this.tint.setAttribute('aria-hidden', 'true');
    this.sight.setAttribute('aria-hidden', 'true');
    canvas.addEventListener('mousedown', (e) => { if (this.gun && this.phase === 'flying' && e.button === 0) this.trigger = true; });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.trigger = false; });
    const fb = this.fireButton;
    fb.addEventListener('pointerdown', (e) => { e.preventDefault(); fb.setPointerCapture(e.pointerId); this.trigger = true; });
    for (const end of ['pointerup', 'pointercancel'] as const) fb.addEventListener(end, () => { this.trigger = false; });
    fb.addEventListener('contextmenu', (e) => e.preventDefault());
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
      if (this.phase === 'off') return;
      e.preventDefault();
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.004), 0.6, 2.2);
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (this.phase === 'off' || !gameKey(e)) return;
      if (e.code === 'KeyT') { if (!e.repeat) this.reset(); }
      else if (!this.keys.press(e)) return;
      e.preventDefault();
    });
    onFocusLoss(() => { this.touch.clear(); this.trigger = false; });
    this.draw();
  }

  // the aircraft flown from now on (not while one flies)
  private use(type: Aircraft) {
    let m = this.made.get(type);
    if (!m) {
      m = type.model();
      this.nav.actors.add(m.group);
      this.made.set(type, m);
    }
    this.type = type;
    this.model = m;
    this.gun = mountOf(SEATS.craft[type.id], { role: 'pilot', index: 0 });
    this.trigger = false;
  }

  get help(): Help { const [keys, touch] = this.type.help; return { id: this.type.id, keys, touch }; }

  // ------------------------------------------------------------------ entering and leaving
  // into the floatplane at a spot (tools), else in the air where the camera is
  enter(at?: CraftSpot) {
    if (this.phase !== 'off') return false;
    if (at) return this.startAt(at);
    this.toggle(false, AIRCRAFT.floatplane);
    return this.phase !== 'off';
  }

  // the panel's buttons: in (on the river nearest the view, or in the air where the camera is), or out
  private toggle(water: boolean, type: Aircraft) {
    if (this.phase !== 'off') { this.nav.flyUp(); return; }
    const pos = this.camera.position, look = this.target.clone().sub(pos);
    let x = pos.x, z = pos.z, heading = Math.atan2(look.x, look.z);
    if (water) {
      const r = nearestRiver(this.env.river() ?? [], this.target.x, this.target.z);
      if (!r) { this.panel.say('No river near the view', 2500); return; }
      ({ x, z } = r);
    }
    this.startAt({ x, z, y: pos.y, h: heading, water, type: type.id });
  }

  private startAt(s: { x: number; y?: number; z: number; h?: number; water?: boolean; type?: AircraftId }) {
    if (this.phase === 'off') {
      if (!this.link.sim || !this.nav.enterCraft(this)) return false;
      const id = s.type ?? 'floatplane';
      this.use(AIRCRAFT[id]);
      this.link.open(id);
      this.rig.begin(ENTER_MS);
    }
    // (clear of the map's wall: ~5 s of flight at the start's speed)
    const c = this.type.cfg, m = c.EDGE + Math.max(230, 5 * c.RESPAWN_SPEED);
    this.start = { x: clamp(s.x, m, this.meta.W - m), z: clamp(s.z, m, this.meta.D - m), y: s.y ?? 200, heading: s.h ?? 0, water: !!s.water && c.WATER_SPEED > 0 };
    if (s.water) { this.start.x = s.x; this.start.z = s.z; }
    this.phase = 'loading';
    this.keys.clear();
    this.touch.setActive(true);
    this.panel.silence();
    this.draw();
    return true;
  }

  // once the start's collision tiles are in: in the air, clear over the highest column round it; on the water, at the
  // open water nearest the river cell, facing along the longest open stretch
  private prepare() {
    const s = this.start!, col = this.link.col!;
    col.prefetch(this.v3.set(s.x, 0, s.z), this.v4.set(0, 0, 0));
    if (s.water) {
      const found = this.openWater(s.x, s.z);
      if (found === null) return;
      if (!found) { this.panel.say('No open water here: starting in the air', 3000); s.water = false; return; }
      this.link.put({ x: found.x, y: found.water + this.type.cfg.FLOAT_H, z: found.z, h: found.heading, water: true });
      this.throttle = 0;
    } else {
      let top = 0;
      for (const dx of [-60, 0, 60]) for (const dz of [-60, 0, 60]) {
        const su = col.surface(s.x + dx, s.z + dz);
        if (!su) return;
        top = Math.max(top, su.top);
      }
      const c = this.type.cfg;
      this.link.put({ x: s.x, y: clamp(s.y, top + c.RESPAWN_AGL, top + 300), z: s.z, h: s.heading, speed: c.RESPAWN_SPEED });
      this.throttle = c.RESPAWN_THROTTLE;
    }
    // (the engine put at the lever by the core: idle afloat, RESPAWN_THROTTLE in the air; the camera set from the plane
    // the first frame it is in: fly)
    this.aim = true;
    this.phase = 'flying';
  }

  // the plane, once the sim has put it down
  private get craft() { return this.phase === 'flying' ? this.link.craft : null; }

  get mapPose() {
    return this.craft?.core.pose ?? null;
  }

  // into a plane left in the world (afloat, landed, or gliding down with its lever back)
  board(craft: CraftView) {
    const type = craft.type;
    if (this.phase !== 'off' || (type !== 'floatplane' && type !== 'jet' && type !== 'fighter') || !this.link.sim || !this.nav.enterCraft(this)) return false;
    this.use(AIRCRAFT[type]);
    this.link.open(type);
    this.link.board(craft.id);
    this.rig.begin(ENTER_MS);
    // (the lever where the engine is)
    this.throttle = (craft.core as PlaneCore).flight.engine;
    this.aim = true;
    this.phase = 'flying';
    this.keys.clear();
    this.touch.setActive(true);
    this.panel.silence();
    this.draw();
    return true;
  }

  // open water within ~100 m of (x, z): the water column with the longest straight water run through it (8
  // directions, up to 300 m); null: tiles not in yet; false: none
  private openWater(x: number, z: number) {
    const col = this.link.col!;
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

  reset() {
    if (this.phase !== 'flying') return;
    this.link.reset();
  }

  leave() {
    this.link.close();
    this.phase = 'off';
    this.start = null;
    this.keys.clear();
    this.touch.setActive(false);
    this.model.hide();
    this.rig.end();
    this.trigger = false;
  }

  // ------------------------------------------------------------------ every frame
  update(dt: number) {
    const active = this.phase !== 'off';
    if (active) {
      if (this.phase === 'loading') this.prepare();
      if (this.phase === 'flying') this.fly(dt);
    }
    const now = performance.now();
    if (now >= this.nextPanel) { this.nextPanel = now + 100; this.draw(); }
    const k = (now - this.crashAt) / CRASH_TINT_MS;
    this.tint.style.opacity = active && k < 1 ? String(0.7 * (1 - k)) : '0';
    document.body.classList.toggle('plane-gun', active && !!this.gun);
    if (!active || !this.gun) this.sight.style.visibility = 'hidden';
  }

  // (before the sim's update, main.ts: the input sent, what happened to it)
  private fly(dt: number) {
    const now = performance.now();
    if (this.link.refused()) { this.panel.say('Someone else took that plane.', 2500); this.nav.flyUp(); return; }
    this.link.input(inFocus() ? this.input(dt) : { turn: 0, pitch: 0, throttle: this.throttle });
    this.link.resets();
    const c = this.link.frame();
    if (!c) return;
    const core = c.core, f = core.flight;
    if (this.aim) {
      this.aim = false;
      this.cam.yaw = f.heading;
      this.cam.pitch = 0;
      f.attitude(this.cam.fwd, this.cam.up);
    }
    for (const e of this.link.events()) {
      if (e.type === 'crash') {
        this.crashAt = now;
        this.panel.say(e.what === 'water' ? `Splash! (${e.kmh} km/h) Back at a safe point…` : `Crash! (${e.what}, ${e.kmh} km/h) Back at a safe point…`, 0);
      } else if (e.type === 'respawn') { this.throttle = e.throttle; }
      else if (e.type === 'skim') this.panel.say('Careful!', 1500);
      else if (e.type === 'touchdown') this.panel.say('On the water', 2000);
      else if (e.type === 'takeoff') this.panel.say('Airborne', 1500);
      else if (e.type === 'bump') this.panel.say('Bump', 1200);
    }
  }

  // (after the sim's update: the model and the chase camera where the plane is drawn this frame)
  place(dt: number) {
    const c = this.phase === 'flying' ? this.link.craft : null;
    if (!c) return;
    const now = performance.now(), d = c.core.drawn(this.link.alpha);
    this.model.draw(c, { dt, alpha: this.link.alpha, night: this.env.night(), now });
    this.fwd.copy(d.fwd);
    this.up.copy(d.up);
    this.chase(d, dt, now);
    this.shoot(d, dt);
  }

  // the combat plane's gun: aimed where the nose points as drawn, the point the page sees there sent with each shot
  // (the host aims at it from the mount where it has the plane); the gunsight's dot on that line at the MG's range
  private shoot(d: PlaneDrawn, dt: number) {
    const m = this.gun, w = m && weaponById(m.weapon), sim = this.link.sim, nav = this.nav;
    if (!m || !w || !sim) return;
    const f = d.fwd, h = Math.atan2(f.x, f.z), pitch = Math.asin(clamp(f.y, -1, 1));
    const from = mountPoint(m, { x: d.p.x, y: d.p.y, z: d.p.z, h, pitch }), dir = { x: f.x, y: f.y, z: f.z };
    const air = this.craft?.core.flight.state === 'air';
    nav.arms.update(dt, sim, h, pitch, this.camera, air && inFocus() && (this.trigger || !!gamepad()?.buttons[0]?.pressed), { slot: w.slot, to: () => aimPoint(sim, nav.world, from, dir) });
    const s = this.v4.set(from.x, from.y, from.z).addScaledVector(this.v3.set(f.x, f.y, f.z), REACH);
    this.camera.updateMatrixWorld();
    s.project(this.camera);
    const on = air && s.z < 1;
    this.sight.style.visibility = on ? 'visible' : 'hidden';
    if (on) this.sight.style.transform = `translate(${((s.x + 1) / 2 * innerWidth).toFixed(1)}px, ${((1 - s.y) / 2 * innerHeight).toFixed(1)}px)`;
  }

  private input(dt: number): PlaneInput {
    const has = (...codes: string[]) => this.keys.any(...codes) > 0;
    const pad = gamepad(), dz = padAxis;
    // the throttle lever: keys and triggers move it, the slider sets it (pointer handlers)
    let lever = (has('ShiftLeft', 'ShiftRight', 'KeyR') ? 1 : 0) - (has('Space', 'KeyF') ? 1 : 0);
    if (pad) lever += (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0) - dz(pad.axes[3]);
    this.throttle = clamp(this.throttle + clamp(lever, -1, 1) * THROTTLE_RATE * dt, 0, 1);
    // stick: flight convention, stick back (S, down, the touch stick pulled down, the pad's stick back) = nose up
    let turn = (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0);
    let back = (has('KeyS', 'ArrowDown') ? 1 : 0) - (has('KeyW', 'ArrowUp') ? 1 : 0);
    const s = this.touch.axes('left');
    if (s) {
      const x = clamp(s.x, -1, 1), y = clamp(s.y, -1, 1);
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
  private chase(d: PlaneDrawn, dt: number, now: number) {
    const core = this.craft!.core, collision = this.link.col!, f = core.flight, c = this.cam, ch = this.type.chase, aero = this.type.cfg.AEROBATIC;
    let fwd: THREE.Vector3, off: THREE.Vector3;
    if (aero) {
      c.fwd.lerp(this.fwd, follow(ch.lag, dt)).normalize();
      c.up.lerp(this.up, follow(ch.rollLag, dt));
      c.up.addScaledVector(c.fwd, -c.up.dot(c.fwd)).normalize();
      c.yaw = Math.atan2(c.fwd.x, c.fwd.z);
      fwd = this.v3.copy(c.fwd);
      off = this.v4.copy(fwd).multiplyScalar(-ch.back * this.zoom).addScaledVector(c.up, ch.up * this.zoom);
    } else {
      c.yaw = followAngle(c.yaw, d.heading, ch.lag, dt);
      c.pitch += (d.gamma * 0.7 - c.pitch) * follow(ch.rollLag, dt);
      fwd = this.v3.set(Math.sin(c.yaw) * Math.cos(c.pitch), Math.sin(c.pitch), Math.cos(c.yaw) * Math.cos(c.pitch));
      off = this.v4.copy(fwd).multiplyScalar(-ch.back * this.zoom);
      off.y += ch.up * this.zoom;
    }
    const hit = f.state !== 'crashed' ? collision.sweep(d.p, off) : 'loading';
    const want = off.multiplyScalar(clearShare(hit, off, 0.15, 0.5)).add(d.p);
    const look = fwd.multiplyScalar(ch.look).add(d.p);
    const crash = (now - this.crashAt) / CRASH_TINT_MS;
    if (crash < 1) shake(want, 0.8 * (1 - crash) ** 2, now);
    const up = this.camera.up.copy(aero ? c.up : THREE.Object3D.DEFAULT_UP);
    const q = this.rig.look(want, look, up);
    if (!aero) q.multiply(this.bank.setFromAxisAngle(Z, -d.bank * 0.25));
    // (from where the map camera was to the chase pose over the entry)
    this.rig.place(want, q, ch.fov(f.v), dt);
    // (the shadows' fit and the fog read the target: ahead of the plane)
    this.target.copy(d.p).addScaledVector(this.v3.set(Math.sin(c.yaw), 0, Math.cos(c.yaw)), aero ? 200 : 150);
  }

  // ------------------------------------------------------------------ the panel
  private draw() {
    const c = this.craft, f = c?.core.flight, active = this.phase !== 'off', on = active && this.phase === 'flying' && !!f, P = this.panel;
    P.active = active;
    P.details.hidden = !active;
    this.enterButton.textContent = active ? `Exit ${this.type.label}` : 'Plane';
    const canStart = this.nav.canStartCraft && !!this.link.sim;
    this.enterButton.disabled = !active && !canStart;
    this.enterWater.hidden = this.enterJet.hidden = this.enterFighter.hidden = active;
    this.enterJet.disabled = this.enterFighter.disabled = !canStart;
    this.enterWater.disabled = !canStart || !this.env.river()?.length;
    const pct = Math.round(this.throttle * 100);
    (this.slider.querySelector('.fill') as HTMLElement).style.height = `${pct}%`;
    (this.slider.querySelector('.knob') as HTMLElement).style.bottom = `calc(${this.throttle} * (100% - 24px))`;
    this.slider.querySelector('.val')!.textContent = `${pct}%`;
    this.slider.setAttribute('aria-valuenow', String(pct));
    const msg = on && f!.state === 'crashed' ? P.last : P.saying ||
      (this.phase === 'loading' ? 'Loading collision tiles near the start…' :
      !on || !f ? '' :
      !inFocus() ? PAUSED :
      f.waiting ? 'Waiting for the next collision tile…' :
      f.stalled ? 'Stall! Nose down or more throttle' :
      f.atEdge ? 'Map edge: turn back' : '');
    ModePanel.text(P.status, msg);
    if (!on || !f || !c) { this.telemetry.textContent = ''; return; }
    const su = this.link.col?.surface(f.p.x, f.p.z);
    const where = f.state === 'water' ? 'on the water' : su ? `${Math.round(f.p.y - f.cfg.RADIUS - su.ground)} m AGL` : `${Math.round(f.p.y)} m`;
    const g = f.cfg.AEROBATIC && f.state === 'air' ? ` · ${f.load.toFixed(1)} g` : '';
    ModePanel.text(this.telemetry, `${Math.round(f.v * 3.6)} km/h · ${where}${g} · throttle ${pct}%`);
  }
}
