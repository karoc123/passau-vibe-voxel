import * as THREE from 'three';
import { clamp } from '../core/num';
import { ChaseRig, clearShare, followAngle } from './chase-rig';
import { CraftLink, type CraftContext, type CraftSpot, type PlayerCraft } from './craft';
import type { CraftView } from '../client/sim-client';
import { makeCraftModel } from './craft-models';
import { craftWorld, SPAWN_HEIGHT } from '../sim/craft/craft-collision';
import { CRAFT_SCALE, GLIDER_HEIGHT, type CraftKind } from '../sim/craft/craft-motion';
import type { CraftInput } from '../sim/contract/inputs';
import { NO_CRAFT_INPUT } from '../sim/craft/special-core';
import { gameKey, gamepad, HeldKeys, inFocus, onFocusLoss, padAxis, PAUSED } from './input';
import { ModePanel } from './mode-panel';
import { TouchSticks } from '../touch/sticks';
import './special-craft.css';

// The helicopter, the hovercraft and the paraglider: crafts of the world sim's (CraftLink: their core,
// sim/craft/special-core.ts, stepped on the world's clock with its collision), the local player in the pilot's seat.
// Here: the panel, the input, the chase camera, the model. Out of focus the input is hands off (input.ts). Left, the
// helicopter and the hovercraft stay in the world (board: back in); the paraglider, once landed or left, goes.

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE']);
// the chase camera: back and up from the craft (m), at what it looks (m over the motion's point); the model drawn
// `drop` m under the motion's point (the paraglider's is the pilot's middle, its model's origin the feet); the
// hovercraft's and the helicopter's framing scales with their models (CRAFT_SCALE), so they fill the view as before
const HS = CRAFT_SCALE.hovercraft, CS = CRAFT_SCALE.helicopter;
const CONFIG = {
  hovercraft: { name: 'Hovercraft', back: 12 * HS, up: 4.5 * HS, look: 0.8 * HS, drop: 0,
    help: ['W/S thrust and reverse · A/D steer (it drifts) · Esc exit', 'Left stick: thrust, reverse and steer.'] },
  helicopter: { name: 'Helicopter', back: 17 * CS, up: 6 * CS, look: 1.2 * CS, drop: 0,
    help: ['W/S nose down and up (forward, back) · A/D turn · Q/E sideways · Space climb · Shift descend · let go: it hovers · Esc exit',
      'Left stick: forward, back and turn. Right stick: up/down to climb and descend, sideways to slide.'] },
  paraglider: { name: 'Paraglider', back: 13, up: 3.5, look: 3, drop: GLIDER_HEIGHT,
    help: ['A/D steer · W speed bar · S brake (flare to land) · Esc exit', 'Left stick: turn, speed bar and brake.'] },
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
  private readonly link: CraftLink<CraftKind>;
  private readonly keys = new HeldKeys(KEYS);
  private readonly pos = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private phase: 'off' | 'finding' | 'on' | 'landing' = 'off';
  private start: (CraftSpot & { deadline: number }) | null = null;
  private camYaw = 0;
  private zoom = 1;

  constructor(private readonly ctx: CraftContext, readonly id: CraftKind) {
    const { canvas, host, camera, nav } = ctx, cfg = CONFIG[id];
    this.link = new CraftLink(ctx, id);
    this.boards = id === 'paraglider' ? [] : [id];
    this.model = makeCraftModel(id);
    nav.actors.add(this.model.group);
    this.rig = new ChaseRig(camera);
    this.touch = new TouchSticks(canvas, {
      camera: id === 'helicopter' ? undefined : 'right',
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
    this.start = null;
    this.model.group.visible = false;
    this.touch.setActive(false);
    this.keys.clear();
    this.rig.end();
    this.link.close(this.id === 'paraglider');
  }

  // into one left in the world
  board(craft: CraftView) {
    if (!this.boards.includes(craft.type as CraftKind) || this.phase !== 'off' || !this.link.sim || !this.ctx.nav.enterCraft(this)) return false;
    this.link.open();
    this.link.board(craft.id);
    this.activate(craft.core.pose.h);
    return true;
  }

  private get craft() { return this.phase === 'on' || this.phase === 'landing' ? this.link.craft : null; }

  // (before the sim's update, main.ts: the input sent, what happened to it; the frame it is put down it is not in yet)
  update(_dt: number) {
    if (this.phase === 'finding') this.findStart();
    if (this.phase === 'on' && this.link.refused()) {
      this.panel.say(`Someone else took that ${CONFIG[this.id].name.toLowerCase()}.`, 2500);
      this.ctx.nav.flyUp();
    }
    if (this.phase === 'on') {
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
        if (this.id === 'helicopter' && surface.water) continue;
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
    };
  }

  private render(dt: number) {
    const core = this.craft!.core, collision = this.link.col!, m = core.drawn(this.link.alpha), { group, rotor, tailRotor } = this.model, cfg = CONFIG[this.id];
    group.visible = true;
    group.position.set(m.x, m.y - cfg.drop, m.z);
    group.rotation.set(-m.pitch, m.h, m.bank, 'YXZ');
    // the rotors idle slower on the skids
    const spin = this.id === 'helicopter' ? (core.motion.grounded ? 9 : 24) * dt : 0;
    if (rotor) rotor.rotation.y = (rotor.rotation.y + spin) % (2 * Math.PI);
    if (tailRotor) tailRotor.rotation.x = (tailRotor.rotation.x + 4 * spin) % (2 * Math.PI);
    this.camYaw = followAngle(this.camYaw, m.h, 4, dt);
    this.offset.set(-Math.sin(this.camYaw) * cfg.back, cfg.up, -Math.cos(this.camYaw) * cfg.back).multiplyScalar(this.zoom);
    const eye = this.pos.copy(group.position);
    eye.y += cfg.look;
    eye.addScaledVector(this.offset, clearShare(collision.sweep(eye, this.offset), this.offset, 0.12, 0.25));
    this.look.copy(group.position);
    this.look.y += cfg.look;
    const cam = this.rig.place(eye, this.rig.look(eye, this.look), 58, dt);
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
      on && this.id === 'helicopter' && core?.motion.grounded ? 'On the skids: Space to take off' : this.panel.saying);
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

export class ParagliderMode extends SpecialCraft {
  constructor(ctx: CraftContext) { super(ctx, 'paraglider'); }
  deploy(source: PlayerCraft, at: CraftSpot) { return this.deployFrom(source, at); }
}
