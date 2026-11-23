import * as THREE from 'three';
import type { Meta } from '../types';
import { clamp } from '../util';
import { viewerTileCache } from '../viewer-tiles';
import { VoxelCollision } from './voxel-collision';
import { FixedStep } from '../core/fixed-step';
import { BoatMotion, findSpawn, type BoatInput, type BoatWorld } from './boat-motion';
import { BoatModel } from './boat-model';
import type { Nav } from './nav';
import type { CraftContext, CraftEnv, CraftSpot, PlayerCraft } from './craft';
import { stickAxis, TouchSticks } from './touch-sticks';
import { gameKey, gamepad, HeldKeys, inFocus, onFocusLoss, padAxis, PAUSED } from './input';
import { ChaseRig, clearShare, follow, followAngle, shake } from './chase-rig';
import { HoldButton, ModePanel } from './mode-panel';
import { downstream, nearestRiver } from './river';
import './boat.css';

// The boat mode: a speedboat of the player's own on the rivers, driven like the car (W/S throttle and reverse, A/D
// steer, Space drift, T unstick, Esc exit; the same touch stick and handbrake button; the gamepad as the car's). Put
// down on the water nearest the map's focus, facing downstream; the motion in boat-motion.ts (pure, fixed step), the
// model in boat-model.ts; the collision tiles round it through VoxelCollision (as the drone's). Here: the panel, the
// input, the chase camera. Out of focus it holds still (input.ts).

const STEP = 1 / 120, MAX_STEPS = 12;
const KEYS: ReadonlySet<string> = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']);
const STEER_CURVE = 1.7; // the touch stick's steering: |x|^STEER_CURVE (as the car's)
const SPAWN_REACH = 48; // m round the river point nearest the focus searched for a spot the hull fits
const GIVE_UP_MS = 8000;
const BACK = 9.5, UP = 3.4, AHEAD = 8; // the chase camera: behind and over the boat, looking at a point ahead of it
const INTRO_MS = 900;

type Phase = 'off' | 'finding' | 'on';

export class BoatMode implements PlayerCraft {
  readonly id = 'boat';
  readonly view = 'own';
  private readonly nav: Nav;
  private readonly target: THREE.Vector3;
  private readonly meta: Meta;
  private readonly env: CraftEnv;
  private readonly collision: VoxelCollision;
  private readonly world: BoatWorld;
  private readonly motion = new BoatMotion();
  private readonly model: BoatModel;
  private readonly touch: TouchSticks;
  private readonly drift = new HoldButton('boat-drift-button', 'Drift', 'Drift (hold)');
  private readonly keys = new HeldKeys(KEYS);
  private readonly panel: ModePanel;
  private readonly action: HTMLButtonElement;
  private readonly speed: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly rig: ChaseRig;
  private phase: Phase = 'off';
  private start: { x: number; z: number; h: number; t0: number } | null = null;
  private readonly clock = new FixedStep(STEP, MAX_STEPS, 0.1);
  private zoom = 1;
  private camYaw = 0;
  private camY = 0;
  private shakeUntil = 0;
  private shakeA = 0;
  private readonly look = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();

  constructor({ nav, camera, target, meta, host, canvas, env }: CraftContext) {
    this.nav = nav; this.target = target; this.meta = meta; this.env = env;
    Object.assign(window, { __boat: this });
    this.collision = new VoxelCollision(meta, viewerTileCache(meta.tiles.N));
    this.world = this.collision;
    this.model = new BoatModel(nav.actors);
    this.rig = new ChaseRig(camera);
    this.touch = new TouchSticks(canvas, { onPinch: (r) => { this.zoom = clamp(this.zoom * r, 0.5, 2.2); }, camera: 'right' });
    const P = this.panel = new ModePanel(host, 'boat', 'Drive a boat');
    this.action = P.button('Boat', () => this.toggle());
    this.speed = P.line('speed');
    this.help = P.help('W/S throttle and reverse · A/D steer · Space drift · T unstick · Esc exit',
      'Left thumb: drag up for throttle, down to reverse, sideways to steer. Hold the right button to drift. Pinch on the right to zoom.');
    addEventListener('keydown', (e) => {
      if (this.phase === 'off' || !gameKey(e)) return;
      if (e.code === 'KeyT') { if (!e.repeat) this.unstick(); }
      else if (!this.keys.press(e)) return;
      e.preventDefault();
    });
    canvas.addEventListener('wheel', (e) => {
      if (this.phase === 'off') return;
      e.preventDefault();
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.004), 0.5, 2.2);
    }, { passive: false });
    onFocusLoss(() => this.touch.clear());
    this.draw();
  }

  get pose() { return this.phase === 'on' ? this.motion.pose : null; }
  get mapPose() { return this.pose; }

  // the panel's button: into the boat (from the map or a ride), or out of it
  toggle() {
    if (this.phase !== 'off') this.nav.flyUp();
    else this.enter();
  }

  // into the boat at (x, z) heading h (tools), else on the water nearest the map's focus, facing downstream
  enter(at?: CraftSpot) {
    if (this.phase !== 'off' || !this.nav.enterCraft(this)) return false;
    this.start = at ? { x: at.x, z: at.z, h: at.h, t0: performance.now() } : null;
    this.phase = 'finding';
    this.panel.silence();
    this.draw();
    return true;
  }

  update(dt: number) {
    if (this.phase === 'finding') this.find();
    if (this.phase === 'on') {
      const m = this.motion;
      this.collision.prefetch(new THREE.Vector3(m.x, m.y, m.z), new THREE.Vector3(m.vx, 0, m.vz));
      if (inFocus()) {
        const input = this.input();
        this.clock.run(dt, (step) => {
          const ev = m.step(input, step, this.world);
          if (ev === 'loading') return false;
          for (const e of ev) {
            this.panel.say(e.speed > 5 ? 'Crash!' : 'Bump!', 600);
            this.shakeUntil = performance.now() + 450;
            this.shakeA = clamp(e.speed / 20, 0.08, 0.5);
          }
          return true;
        });
      }
      const d = m.drawn();
      this.model.update(d, m.speed, this.env.night(), m.t);
      this.chase(dt);
    }
    this.draw();
  }

  private find() {
    const now = performance.now();
    if (!this.start) {
      const river = this.env.river();
      if (!river) return;
      const f = this.target, at = nearestRiver(river, f.x, f.z) ?? { x: f.x, z: f.z };
      const eck = this.meta.views?.eck?.target;
      this.start = { ...at, h: downstream(river, at.x, at.z, eck && { x: eck[0], z: eck[2] }), t0: now };
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
      if (now - s.t0 > GIVE_UP_MS) { this.panel.say('No water found near here.', 2500); this.nav.flyUp(); }
      return;
    }
    const at = findSpawn(this.world, s.x, s.z, s.h, SPAWN_REACH);
    if (!at) { this.panel.say('No open water near here.', 2500); this.nav.flyUp(); return; }
    this.motion.reset(at);
    this.clock.acc = 0;
    this.zoom = 1;
    this.camYaw = at.h;
    this.camY = at.y;
    this.phase = 'on';
    this.model.visible = true;
    this.touch.setActive(true);
    this.keys.clear();
    this.rig.begin(INTRO_MS);
  }

  leave() {
    this.collision.release();
    this.phase = 'off';
    this.model.visible = false;
    this.touch.setActive(false);
    this.keys.clear();
    this.drift.release();
    this.rig.end();
  }

  private unstick() {
    if (this.phase === 'on' && this.motion.unstick(this.world)) this.panel.say('Back on open water', 900);
  }

  private input(): BoatInput {
    const pressed = (...codes: string[]) => this.keys.any(...codes);
    const pad = gamepad(), stick = padAxis(pad?.axes[0]);
    const left = this.touch.left;
    const pedal = left ? clamp(stickAxis(left.dy, left.radius), -1, 1) : 0;
    const sx = left ? clamp(stickAxis(left.dx, left.radius), -1, 1) : 0;
    const gas = Math.max(pressed('KeyW', 'ArrowUp'), pad?.buttons[7]?.value ?? 0, pedal);
    const back = Math.max(pressed('KeyS', 'ArrowDown'), pad?.buttons[6]?.value ?? 0, -pedal);
    return {
      throttle: clamp(gas - back, -1, 1),
      steer: clamp(pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft') + stick + Math.sign(sx) * Math.abs(sx) ** STEER_CURVE, -1, 1),
      drift: this.keys.has('Space') || !!pad?.buttons[0]?.pressed || this.drift.held,
    };
  }

  // behind the boat along a heading that follows its own with a lag (a turn shows it a little from the side), over the
  // water; pulled in where the collision meets something between the boat and the camera
  private chase(dt: number) {
    const m = this.motion, now = performance.now();
    this.camYaw = followAngle(this.camYaw, m.h, 3.2, dt);
    this.camY += (m.y - this.camY) * follow(3, dt);
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw), base = this.camY;
    const eye = new THREE.Vector3(m.x, base + 1.6, m.z);
    const off = new THREE.Vector3(-fx * BACK * this.zoom, UP * this.zoom - 1.6, -fz * BACK * this.zoom);
    const pos = this.pos.copy(eye).addScaledVector(off, clearShare(this.collision.sweep(eye, off), off, 0.25, 0.4));
    if (now < this.shakeUntil) shake(pos, this.shakeA * (this.shakeUntil - now) / 450, now);
    const at = new THREE.Vector3(m.x + Math.sin(m.h) * AHEAD, base + 1.2, m.z + Math.cos(m.h) * AHEAD);
    const cam = this.rig.place(pos, this.rig.look(pos, at), 60 + 8 * clamp(Math.abs(m.speed) / 18.5, 0, 1), dt);
    // (the shadow fit and the fog read the target: as the ride's)
    this.target.copy(cam.position).addScaledVector(cam.getWorldDirection(this.look), 10);
  }

  private draw() {
    const on = this.phase === 'on', active = this.phase !== 'off', P = this.panel, note = P.saying;
    P.active = active;
    ModePanel.text(this.action, active ? 'Exit boat' : 'Boat');
    this.action.disabled = !active && !this.nav.canStartCraft;
    P.details.hidden = !active && !note;
    this.speed.hidden = this.help.hidden = !on;
    ModePanel.text(P.status, this.phase === 'finding' ? 'Looking for water…' : on && !inFocus() ? PAUSED :
      on && this.motion.waiting ? 'Loading collision tiles…' : note);
    if (on) ModePanel.text(this.speed, Math.round(Math.abs(this.motion.kmh)) + ' km/h');
  }
}
