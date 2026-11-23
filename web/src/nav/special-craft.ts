import * as THREE from 'three';
import { clamp } from '../core/num';
import { FixedStep } from '../core/fixed-step';
import { viewerTileCache } from '../viewer-tiles';
import { ChaseRig, clearShare, followAngle } from './chase-rig';
import type { CraftContext, CraftSpot, PlayerCraft } from './craft';
import { makeCraftModel } from './craft-models';
import { craftWorld, CRAFT_RADIUS, SPAWN_HEIGHT } from './craft-collision';
import { CraftMotion, GLIDER_HEIGHT, type CraftInput, type CraftKind, type CraftStep } from '../sim/craft/craft-motion';
import { gameKey, gamepad, HeldKeys, inFocus, onFocusLoss, padAxis, PAUSED } from './input';
import { ModePanel } from './mode-panel';
import { stickAxis, TouchSticks } from './touch-sticks';
import { VoxelCollision } from './voxel-collision';
import './special-craft.css';

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE']);
// the chase camera: back and up from the craft (m), at what it looks (m over the motion's point); the model drawn
// `drop` m under the motion's point (the paraglider's is the pilot's middle, its model's origin the feet)
const CONFIG = {
  hovercraft: { name: 'Hovercraft', back: 12, up: 4.5, look: 0.8, drop: 0,
    help: ['W/S thrust and reverse · A/D steer (it drifts) · Esc exit', 'Left stick: thrust, reverse and steer.'] },
  helicopter: { name: 'Helicopter', back: 17, up: 6, look: 1.2, drop: 0,
    help: ['W/S nose down and up (forward, back) · A/D turn · Q/E sideways · Space climb · Shift descend · let go: it hovers · Esc exit',
      'Left stick: forward, back and turn. Right stick: up/down to climb and descend, sideways to slide.'] },
  paraglider: { name: 'Paraglider', back: 13, up: 3.5, look: 3, drop: GLIDER_HEIGHT,
    help: ['A/D steer · W speed bar · S brake (flare to land) · Esc exit', 'Left stick: turn, speed bar and brake.'] },
} as const;

class SpecialCraft implements PlayerCraft {
  readonly view = 'own';
  private readonly panel: ModePanel;
  private readonly action: HTMLButtonElement;
  private readonly telemetry: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly model;
  private readonly motion: CraftMotion;
  private readonly rig: ChaseRig;
  private readonly touch: TouchSticks;
  private readonly collision: VoxelCollision;
  private readonly world;
  private readonly clock = new FixedStep(1 / 60, 6, 0.1);
  private readonly keys = new HeldKeys(KEYS);
  private readonly pos = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private phase: 'off' | 'finding' | 'on' | 'landing' = 'off';
  private start: (CraftSpot & { deadline: number }) | null = null;
  private camYaw = 0;
  private result: CraftStep = 'moving';
  private zoom = 1;

  constructor(private readonly ctx: CraftContext, readonly id: CraftKind) {
    const { meta, canvas, host, camera, nav } = ctx, cfg = CONFIG[id];
    this.motion = new CraftMotion(id);
    this.model = makeCraftModel(id);
    nav.actors.add(this.model.group);
    this.collision = new VoxelCollision(meta, viewerTileCache(meta.tiles.N), { radius: CRAFT_RADIUS[id] });
    this.world = craftWorld(id, this.collision);
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
    if (this.id === 'paraglider' || this.phase !== 'off' || !this.ctx.nav.enterCraft(this)) return false;
    const { target, camera, meta } = this.ctx, look = camera.getWorldDirection(this.look);
    const spot = at ?? { x: target.x, z: target.z, h: Math.atan2(look.x, look.z) };
    this.start = { ...spot, x: clamp(spot.x, 5, meta.W - 5), z: clamp(spot.z, 5, meta.D - 5), deadline: performance.now() + 6500 };
    this.phase = 'finding';
    this.panel.silence();
    this.draw();
    return true;
  }

  protected deployFrom(source: PlayerCraft, at: CraftSpot) {
    if (this.phase !== 'off' || at.y === undefined || !this.ctx.nav.enterCraft(this, source)) return false;
    this.activate(at.x, at.y, at.z, at.h, 16);
    return true;
  }

  leave() {
    this.phase = 'off';
    this.start = null;
    this.model.group.visible = false;
    this.touch.setActive(false);
    this.keys.clear();
    this.rig.end();
    this.collision.release();
  }

  update(dt: number) {
    if (this.phase === 'finding') this.findStart();
    if (this.phase === 'on') {
      const m = this.motion;
      this.collision.prefetch(m.p, m.velocity);
      if (inFocus()) {
        const input = this.input();
        this.clock.run(dt, (step) => {
          this.result = m.step(input, step, this.world);
          if (this.result === 'landed') { this.landOnFoot(); return false; }
          if (this.result === 'splash') {
            this.panel.say('Water landing. Choose a dry landing spot next time.', 3500);
            this.ctx.nav.flyUp();
            return false;
          }
          return this.result !== 'loading';
        });
      }
      if (this.phase === 'on') this.render(dt);
    }
    this.draw();
  }

  private findStart() {
    const s = this.start!;
    this.collision.prefetch({ x: s.x, y: 0, z: s.z }, { x: 0, y: 0, z: 0 });
    let waiting = false;
    for (const radius of [0, 5, 10, 18, 30, 45, 65]) {
      for (let i = 0; i < (radius ? 12 : 1); i++) {
        const a = i * Math.PI / 6;
        const x = s.x + Math.sin(a) * radius, z = s.z + Math.cos(a) * radius;
        if (x < 5 || z < 5 || x >= this.collision.width - 5 || z >= this.collision.depth - 5) continue;
        const surface = this.world.surface(x, z);
        if (!surface) { waiting = true; continue; }
        if (this.id === 'helicopter' && surface.water) continue;
        const y = surface.height + SPAWN_HEIGHT[this.id];
        const clear = this.world.sweep({ x, y, z }, { x: 0, y: 1, z: 0 }, s.h, s.h);
        if (clear === 'loading') { waiting = true; continue; }
        if (!clear.hit) { this.activate(x, y, z, s.h); return; }
      }
    }
    if (!waiting || performance.now() >= s.deadline) {
      this.panel.say(waiting ? 'Collision tiles did not load. Try again.' : 'No clear starting spot near the view.', 4000);
      this.ctx.nav.flyUp();
    }
  }

  get mapPose() {
    if (this.phase !== 'on' && this.phase !== 'landing') return null;
    return { ...this.motion.p, h: this.motion.heading };
  }

  private activate(x: number, y: number, z: number, heading: number, speed = 0) {
    this.motion.reset({ x, y, z }, heading, speed);
    this.start = null;
    this.phase = 'on';
    this.result = 'moving';
    this.clock.acc = 0;
    this.camYaw = heading;
    this.zoom = 1;
    this.panel.silence();
    this.rig.begin(450);
    this.model.group.visible = true;
    this.keys.clear();
    this.touch.setActive(true);
    this.render(0);
    this.draw();
  }

  private landOnFoot() {
    const { p, heading } = this.motion;
    this.phase = 'landing';
    this.touch.setActive(false);
    const at = new THREE.Vector3(p.x, p.y - GLIDER_HEIGHT, p.z);
    const facing = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    const nav = this.ctx.nav;
    const returnToMap = () => { if (this.phase === 'landing') nav.flyUp(); };
    void nav.setWalk({ at, exact: true, facing, thirdPerson: true, ms: 500 }).then(returnToMap, returnToMap);
  }

  private input(): CraftInput {
    const { keys, touch } = this, pad = gamepad();
    const left = touch.left, right = touch.right;
    return {
      drive: clamp(keys.any('KeyW', 'ArrowUp') - keys.any('KeyS', 'ArrowDown') - padAxis(pad?.axes[1]) +
        (left ? stickAxis(left.dy, left.radius) : 0), -1, 1),
      turn: clamp(keys.any('KeyD', 'ArrowRight') - keys.any('KeyA', 'ArrowLeft') + padAxis(pad?.axes[0]) +
        (left ? stickAxis(left.dx, left.radius) : 0), -1, 1),
      lift: clamp(keys.any('Space') - keys.any('ShiftLeft', 'ShiftRight') + (pad?.buttons[7]?.value ?? 0) -
        (pad?.buttons[6]?.value ?? 0) - padAxis(pad?.axes[3]) + (right ? stickAxis(right.dy, right.radius) : 0), -1, 1),
      side: clamp(keys.any('KeyE') - keys.any('KeyQ') + padAxis(pad?.axes[2]) +
        (right ? stickAxis(right.dx, right.radius) : 0), -1, 1),
    };
  }

  private render(dt: number) {
    const m = this.motion, { group, rotor, tailRotor } = this.model, cfg = CONFIG[this.id];
    group.position.set(m.p.x, m.p.y - cfg.drop, m.p.z);
    group.rotation.set(-m.pitch, m.heading, m.bank, 'YXZ');
    // the rotors idle slower on the skids
    const spin = this.id === 'helicopter' && inFocus() ? (m.grounded ? 9 : 24) * dt : 0;
    if (rotor) rotor.rotation.y = (rotor.rotation.y + spin) % (2 * Math.PI);
    if (tailRotor) tailRotor.rotation.x = (tailRotor.rotation.x + 4 * spin) % (2 * Math.PI);
    this.camYaw = followAngle(this.camYaw, m.heading, 4, dt);
    this.offset.set(-Math.sin(this.camYaw) * cfg.back, cfg.up, -Math.cos(this.camYaw) * cfg.back).multiplyScalar(this.zoom);
    const eye = this.pos.copy(group.position);
    eye.y += cfg.look;
    eye.addScaledVector(this.offset, clearShare(this.collision.sweep(eye, this.offset), this.offset, 0.12, 0.25));
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
    this.action.disabled = !active && !this.ctx.nav.canStartCraft;
    ModePanel.text(this.action, active ? `Exit ${CONFIG[this.id].name.toLowerCase()}` : CONFIG[this.id].name);
    this.panel.details.hidden = !active && !this.panel.saying;
    this.help.hidden = this.telemetry.hidden = !on;
    ModePanel.text(this.panel.status, this.phase === 'finding' ? 'Looking for a clear starting spot…' :
      this.phase === 'landing' ? 'Landing…' : on && !inFocus() ? PAUSED :
      on && this.result === 'loading' ? 'Loading collision tiles…' :
      on && this.result === 'blocked' ? 'Obstacle ahead' :
      on && this.id === 'helicopter' && this.motion.grounded ? 'On the skids: Space to take off' : this.panel.saying);
    if (!on) return;
    const { p, speed } = this.motion;
    const height = this.id === 'hovercraft' ? null : this.collision.surface(p.x, p.z)?.top;
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
