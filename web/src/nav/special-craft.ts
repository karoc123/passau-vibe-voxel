import * as THREE from 'three';
import { clamp } from '../core/num';
import { ChaseRig, clearShare, followAngle, MouseLook } from './chase-rig';
import { CraftLink, type CraftContext, type CraftSpot, type PlayerCraft } from './craft';
import type { CraftView } from '../client/sim-client';
import { craftWorld, SPAWN_HEIGHT } from '../sim/craft/craft-collision';
import { CRAFT_SCALE, GLIDER_HEIGHT, rotorcraft, type CraftKind } from '../sim/craft/craft-motion';
import { craftLook } from '../view/crafts';
import type { CraftInput } from '../sim/contract/inputs';
import { NO_CRAFT_INPUT } from '../sim/craft/special-core';
import { gameKey, gamepad, HeldKeys, inFocus, onFocusLoss, padAxis, PAUSED } from './input';
import { ModePanel } from './mode-panel';
import { TouchSticks } from '../touch/sticks';
import './special-craft.css';
import { HOOK, hookPoint } from '../sim/hook';

// The helicopters, the hovercraft and the paraglider: crafts of the world sim's (CraftLink: their core,
// sim/craft/special-core.ts, stepped on the world's clock with its collision), the local player in the pilot's seat.
// Here: the panel, the input, the chase camera. Out of focus the input is hands off (input.ts). Left, the
// helicopter and the hovercraft stay in the world (board: back in); the paraglider, once landed or left, goes. A
// paraglider the host placed on high ground is boarded as they are: the host launches it over its drop.

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE']);
// the chase camera: back and up from the craft (m), at what it looks (m over the model's origin); the feet `drop` m
// under the motion's point (the paraglider's is the pilot's middle); the helicopter's framing scales with its model
// (CRAFT_SCALE), so it fills the view as before
const CS = CRAFT_SCALE.helicopter;
const CONFIG = {
  hovercraft: { name: 'Hovercraft', back: 22, up: 7.5, look: 1.8, drop: 0,
    help: ['W/S thrust and reverse · A/D steer (it drifts) · X get out · Esc exit', 'Left stick: thrust, reverse and steer.'] },
  helicopter: { name: 'Helicopter', back: 17 * CS, up: 6 * CS, look: 1.2 * CS, drop: 0,
    help: ['W/S nose down and up (forward, back) · A/D turn · Q/E sideways · Space climb · Shift descend · let go: it hovers · mouse: look round · X get out (high up: under a paraglider) · Esc exit',
      'Left stick: forward, back and turn. Right stick: up/down to climb and descend, sideways to slide.'] },
  // (no hover hold: its pilot flies for its door gunners, who ride along; C goes round its seats)
  gunship: { name: 'Military helicopter', back: 22, up: 7.5, look: 1.5, drop: 0,
    help: ['W/S nose down and up · A/D turn · Q/E sideways · Space climb · Shift descend · let go: it hovers · C: next seat (left gun, right gun, bench, controls) · X get out · Esc exit',
      'Left stick: forward, back and turn. Right stick: climb, descend, slide. The seat button goes round the seats.'] },
  paraglider: { name: 'Paraglider', back: 13, up: 3.5, look: 3, drop: GLIDER_HEIGHT,
    help: ['A/D steer · W dive · S brake (flare to land) · right mouse button: grappling hook at the middle of the view (again: let go) · G release (falling: G opens a canopy again) · Esc exit',
      'Left stick: turn, dive and brake. Release: let go of the wing; falling, Open canopy.'] },
} as const;

class SpecialCraft implements PlayerCraft {
  readonly view = 'own';
  readonly boards: readonly CraftKind[];
  private readonly panel: ModePanel;
  private readonly action: HTMLButtonElement;
  private readonly telemetry: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly model;
  private readonly rig: ChaseRig;
  private readonly touch: TouchSticks;
  // the craft in the world sim while the player is in it (its client, its own collision)
  protected readonly link: CraftLink<CraftKind>;
  private readonly keys = new HeldKeys(KEYS);
  private readonly pos = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  protected get on() { return this.phase === 'on'; }
  private phase: 'off' | 'finding' | 'on' | 'landing' = 'off';
  private start: (CraftSpot & { deadline: number }) | null = null;
  private camYaw = 0;
  private readonly mouseLook = new MouseLook();
  private zoom = 1;
  /** the point the grappling hook holds (the paraglider's), sent with the input while the wing is reeled there */
  protected hook: { x: number; y: number; z: number } | null = null;

  constructor(protected readonly ctx: CraftContext, readonly id: CraftKind) {
    const { canvas, host, camera, nav } = ctx, cfg = CONFIG[id];
    this.link = new CraftLink(ctx, id);
    this.boards = [id];
    this.model = craftLook(id);
    nav.actors.add(this.model.group);
    this.rig = new ChaseRig(camera);
    this.touch = new TouchSticks(canvas, {
      camera: rotorcraft(id) ? undefined : 'right',
      onPinch: (ratio) => { this.zoom = clamp(this.zoom * ratio, 0.65, 2); },
    });
    this.panel = new ModePanel(host, id, cfg.name);
    this.panel.el.classList.add('special-craft');
    this.action = this.panel.button(cfg.name, () => {
      if (this.phase === 'off') this.enter();
      else nav.flyUp();
    });
    this.telemetry = this.panel.line('telemetry');
    this.telemetry.classList.add('craft-telemetry');
    this.help = this.panel.help(cfg.help[0], cfg.help[1]);
    addEventListener('keydown', (e) => {
      if (this.phase === 'on' && gameKey(e) && this.keys.press(e)) e.preventDefault();
    });
    canvas.addEventListener('wheel', (e) => {
      if (this.phase !== 'on') return;
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.004), 0.65, 2);
      e.preventDefault();
    }, { passive: false });
    onFocusLoss(() => this.touch.clear());
    this.draw();
  }

  enter(at?: CraftSpot) {
    if (this.id === 'paraglider' || this.phase !== 'off' || !this.link.sim || !this.ctx.nav.enterCraft(this)) return false;
    this.link.open();
    const { target, camera, meta } = this.ctx, look = camera.getWorldDirection(this.look);
    const spot = at ?? { x: target.x, z: target.z, h: Math.atan2(look.x, look.z) };
    this.start = { ...spot, x: clamp(spot.x, 5, meta.W - 5), z: clamp(spot.z, 5, meta.D - 5), deadline: performance.now() + 6500 };
    this.phase = 'finding';
    this.panel.silence();
    this.draw();
    return true;
  }

  protected deployFrom(source: PlayerCraft, at: CraftSpot) {
    if (this.phase !== 'off' || at.y === undefined || !this.link.sim || !this.ctx.nav.enterCraft(this, source)) return false;
    this.link.open();
    this.link.spawn({ x: at.x, y: at.y, z: at.z, h: at.h, speed: 16 });
    this.activate(at.h);
    return true;
  }

  leave() {
    this.phase = 'off';
    this.hook = null;
    this.ctx.nav.hookLine.show(null);
    this.start = null;
    this.model.hide();
    this.touch.setActive(false);
    this.keys.clear();
    this.rig.end();
    this.link.close(this.id === 'paraglider');
  }

  // into one left in the world, or from a seat of its own (from: that seat's shell)
  board(craft: CraftView, from?: PlayerCraft) {
    if (!this.boards.includes(craft.type as CraftKind) || this.phase !== 'off' || !this.link.sim || !this.ctx.nav.enterCraft(this, from)) return false;
    this.link.open();
    this.link.board(craft.id);
    this.activate(craft.core.pose.h);
    return true;
  }

  // G or the touch button: on the wing let go of it into a free fall on foot (the velocity kept), falling open a wing
  // again over the body (its speed across kept; the canopy's opening takes the fall's). false: neither now
  protected canopy() {
    const nav = this.ctx.nav;
    if (this.phase === 'on') {
      const c = this.craft;
      if (!c) return false;
      const { p, velocity: v, heading } = c.core.motion;
      if (!nav.fall(new THREE.Vector3(p.x, p.y - CONFIG[this.id].drop, p.z), new THREE.Vector3(v.x, v.y, v.z), heading)) return false;
      this.panel.say('Falling: G opens a canopy again.', 3000);
      return true;
    }
    if (this.phase !== 'off' || !this.link.sim || !nav.canOpen) return false;
    const f = nav.fallPose, speed = Math.hypot(f.vx, f.vz), h = speed > 1 ? Math.atan2(f.vx, f.vz) : f.yaw;
    if (!nav.openCanopy(this)) return false;
    this.link.open();
    this.link.spawn({ x: f.x, y: f.y + CONFIG[this.id].drop, z: f.z, h, speed });
    this.activate(h);
    return true;
  }

  private get craft() { return this.phase === 'on' || this.phase === 'landing' ? this.link.craft : null; }

  get mouse() { return this.phase === 'on'; }
  turnView(dx: number, dy: number) { this.mouseLook.move(dx, dy); }

  // (before the sim's update, main.ts: the input sent, what happened to it; the frame it is put down it is not in yet)
  update(_dt: number) {
    if (this.phase === 'finding') this.findStart();
    if (this.phase === 'on' && this.link.refused()) {
      this.panel.say(`Someone else took that ${CONFIG[this.id].name.toLowerCase()}.`, 2500);
      this.ctx.nav.flyUp();
    }
    if (this.phase === 'on') {
      // (the line let go once the wing is there, or stopped at what is between)
      const m = this.hook && this.craft?.core, to = m ? m.motion.p : null;
      if (to && (Math.hypot(this.hook!.x - to.x, this.hook!.y - to.y, this.hook!.z - to.z) < HOOK.near || m!.result === 'blocked')) this.hook = null;
      this.link.input(inFocus() ? this.input() : NO_CRAFT_INPUT);
      this.link.frame();
      for (const e of this.link.events()) {
        if (e === 'landed') this.landOnFoot();
        else {
          this.panel.say('Water landing. Choose a dry landing spot next time.', 3500);
          this.ctx.nav.flyUp();
        }
        break;
      }
    }
    this.draw();
  }

  // (after the sim's update: the model and the camera where the craft is drawn this frame)
  place(dt: number) {
    if (this.phase === 'on' && this.craft) this.render(dt);
  }

  private findStart() {
    const s = this.start!, collision = this.link.col!, world = craftWorld(this.id, collision);
    collision.prefetch({ x: s.x, y: 0, z: s.z }, { x: 0, y: 0, z: 0 });
    let waiting = false;
    for (const radius of [0, 5, 10, 18, 30, 45, 65]) {
      for (let i = 0; i < (radius ? 12 : 1); i++) {
        const a = i * Math.PI / 6;
        const x = s.x + Math.sin(a) * radius, z = s.z + Math.cos(a) * radius;
        if (x < 5 || z < 5 || x >= collision.width - 5 || z >= collision.depth - 5) continue;
        const surface = world.surface(x, z);
        if (!surface) { waiting = true; continue; }
        if (rotorcraft(this.id) && surface.water) continue;
        const y = surface.height + SPAWN_HEIGHT[this.id];
        const clear = world.sweep({ x, y, z }, { x: 0, y: 1, z: 0 }, s.h, s.h);
        if (clear === 'loading') { waiting = true; continue; }
        if (!clear.hit) { this.link.spawn({ x, y, z, h: s.h, speed: 0 }); this.activate(s.h); return; }
      }
    }
    if (!waiting || performance.now() >= s.deadline) {
      this.panel.say(waiting ? 'Collision tiles did not load. Try again.' : 'No clear starting spot near the view.', 4000);
      this.ctx.nav.flyUp();
    }
  }

  get mapPose() {
    return this.craft?.core.pose ?? null;
  }

  // in (its craft spawned or boarded), heading h
  private activate(heading: number) {
    this.start = null;
    this.phase = 'on';
    this.hook = null;
    this.camYaw = heading;
    this.zoom = 1;
    this.panel.silence();
    this.rig.begin(450);
    this.keys.clear();
    this.touch.setActive(true);
    this.draw();
  }

  private landOnFoot() {
    const { p, heading } = this.craft!.core.motion;
    this.phase = 'landing';
    this.touch.setActive(false);
    const at = new THREE.Vector3(p.x, p.y - GLIDER_HEIGHT, p.z);
    const facing = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    const nav = this.ctx.nav;
    const returnToMap = () => { if (this.phase === 'landing') nav.flyUp(); };
    void nav.setWalk({ at, exact: true, facing, ms: 500 }).then(returnToMap, returnToMap);
  }

  private input(): CraftInput {
    const { keys, touch } = this, pad = gamepad();
    const left = touch.axes('left'), right = touch.axes('right');
    return {
      drive: clamp(keys.any('KeyW', 'ArrowUp') - keys.any('KeyS', 'ArrowDown') - padAxis(pad?.axes[1]) +
        (left?.y ?? 0), -1, 1),
      turn: clamp(keys.any('KeyD', 'ArrowRight') - keys.any('KeyA', 'ArrowLeft') + padAxis(pad?.axes[0]) +
        (left?.x ?? 0), -1, 1),
      lift: clamp(keys.any('Space') - keys.any('ShiftLeft', 'ShiftRight') + (pad?.buttons[7]?.value ?? 0) -
        (pad?.buttons[6]?.value ?? 0) - padAxis(pad?.axes[3]) + (right?.y ?? 0), -1, 1),
      side: clamp(keys.any('KeyE') - keys.any('KeyQ') + padAxis(pad?.axes[2]) +
        (right?.x ?? 0), -1, 1),
      ...(this.hook ? { hook: this.hook } : {}),
    };
  }

  private render(dt: number) {
    const c = this.craft!, collision = this.link.col!, m = c.core.drawn(this.link.alpha), cfg = CONFIG[this.id], group = this.model.group;
    this.model.draw(c, { dt, alpha: this.link.alpha, night: this.ctx.env.night(), now: performance.now() });
    this.camYaw = followAngle(this.camYaw, m.h, 4, dt);
    this.mouseLook.swing(this.offset.set(-Math.sin(this.camYaw) * cfg.back, cfg.up, -Math.cos(this.camYaw) * cfg.back).multiplyScalar(this.zoom), dt);
    const eye = this.pos.copy(group.position);
    eye.y += cfg.look;
    eye.addScaledVector(this.offset, clearShare(collision.sweep(eye, this.offset), this.offset, 0.12, 0.25));
    this.look.copy(group.position);
    this.look.y += cfg.look;
    const cam = this.rig.place(eye, this.rig.look(eye, this.look), 58, dt);
    this.ctx.nav.hookLine.show(this.hook ? group.position : null, this.hook);
    this.ctx.target.copy(cam.position).addScaledVector(cam.getWorldDirection(this.look), 10);
  }

  private draw() {
    const active = this.phase !== 'off', on = this.phase === 'on';
    this.panel.active = active;
    this.panel.el.hidden = this.id === 'paraglider' && !active && !this.panel.saying;
    this.action.hidden = this.id === 'paraglider' && !active;
    this.action.disabled = !active && (!this.ctx.nav.canStartCraft || !this.link.sim);
    ModePanel.text(this.action, active ? `Exit ${CONFIG[this.id].name.toLowerCase()}` : CONFIG[this.id].name);
    this.panel.details.hidden = !active && !this.panel.saying;
    this.help.hidden = this.telemetry.hidden = !on;
    const core = this.craft?.core, result = core?.result;
    ModePanel.text(this.panel.status, this.phase === 'finding' ? 'Looking for a clear starting spot…' :
      this.phase === 'landing' ? 'Landing…' : on && !inFocus() ? PAUSED :
      on && result === 'loading' ? 'Loading collision tiles…' :
      on && result === 'blocked' ? 'Obstacle ahead' :
      on && rotorcraft(this.id) && core?.motion.grounded ? 'On the skids: Space to take off' : this.panel.saying);
    if (!on || !core) return;
    const { p, speed } = core.motion;
    const height = this.id === 'hovercraft' ? null : this.link.col?.surface(p.x, p.z)?.top;
    ModePanel.text(this.telemetry, `${Math.round(speed * 3.6)} km/h` +
      (height == null ? '' : ` · ${Math.max(0, Math.round(p.y - height))} m above surface`));
  }
}

export class HovercraftMode extends SpecialCraft {
  constructor(ctx: CraftContext) { super(ctx, 'hovercraft'); }
}

export class HelicopterMode extends SpecialCraft {
  constructor(ctx: CraftContext) { super(ctx, 'helicopter'); }
}

export class GunshipMode extends SpecialCraft {
  constructor(ctx: CraftContext) { super(ctx, 'gunship'); }
}

export class ParagliderMode extends SpecialCraft {
  constructor(ctx: CraftContext) {
    super(ctx, 'paraglider');
    // (a key another handler used is not this wing's)
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyG' && !e.repeat && !e.defaultPrevented && gameKey(e) && this.canopy()) e.preventDefault();
    });
    ctx.canvas.addEventListener('mousedown', (e) => { if (e.button === 2 && this.on) this.hookShot(); });
  }

  // The right button: the hook fired along the middle of the view from beside the pilot (the camera is behind them:
  // what stands between the two is not aimed at) at a voxel within the line's range of the pilot; with the line out,
  // or at nothing, it lets go
  private hookShot() {
    const c = this.link.craft, w = this.ctx.nav.world;
    if (this.hook || !c || !w) { this.hook = null; return; }
    const cam = this.ctx.camera, d = cam.getWorldDirection(new THREE.Vector3()), p = c.core.motion.p;
    const from = cam.position.clone().addScaledVector(d, Math.max(0, d.dot(new THREE.Vector3(p.x - cam.position.x, p.y - cam.position.y, p.z - cam.position.z))));
    const at = hookPoint(w, from, d, HOOK.range + from.distanceTo(p as THREE.Vector3));
    if (at && Math.hypot(at.x - p.x, at.y - p.y, at.z - p.z) <= HOOK.range) this.hook = { x: at.x, y: at.y, z: at.z };
  }

  /** the touch button's: as G */
  press() { return this.canopy(); }

  /** what G does now: let go of the wing, open one again, or nothing */
  get canopyAction(): 'release' | 'open' | null {
    return this.on ? 'release' : this.ctx.nav.canOpen ? 'open' : null;
  }
  deploy(source: PlayerCraft, at: CraftSpot) { return this.deployFrom(source, at); }
}
