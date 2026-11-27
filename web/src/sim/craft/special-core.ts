// The helicopter, the hovercraft and the paraglider as WorldSim steps them (craft-core.ts): their motion
// (craft-motion.ts CraftMotion) at 1/60 s (two a world tick), through their probes (craft-collision.ts
// craftWorld). A landing on foot or on the water (the paraglider's) ends it: it steps no more, and its pilot hears of it
// (events: 'landed', 'splash'). An empty seat: hands off (the helicopter let down onto its skids). Drawn between the
// world's last two ticks (heading, pitch and bank the shorter way: they never roll over). No three.js, no DOM
// (tools/core-deps.mjs).
import { FixedStep } from '../../core/fixed-step';
import { lerpAngle, type Vec3 } from '../../core/vec';
import type { CraftSpot } from '../contract/commands';
import type { CraftStep, SpecialCoreState, SpecialEvent } from '../contract/crafts';
import type { CraftInput } from '../contract/inputs';
import type { CraftCore } from './craft-core';
import { Tank, type TankTuning } from '../tank';
import { craftWorld, CRAFT_RADIUS } from './craft-collision';
import { CRAFT, CraftMotion, type CraftKind, type CraftMotionWorld, type CraftTuning } from './craft-motion';
import type { VoxelCollision } from './voxel-collision';

export const NO_CRAFT_INPUT: CraftInput = Object.freeze({ turn: 0, drive: 0, lift: 0, side: 0 });
// the load of a helicopter holding itself in the air (of its full climb's)
const HOVER = 0.6;
const LET_DOWN: CraftInput = Object.freeze({ turn: 0, drive: 0, lift: -1, side: 0 });
// (its events, SpecialEvent: contract/crafts.ts)
/** as drawn: the motion's point (the paraglider's: the pilot's middle), its heading, pitch (+: nose up), bank (+: the
 * right side down) */
export interface SpecialDrawn extends Vec3 { h: number; pitch: number; bank: number }

export class SpecialCore implements CraftCore<CraftInput, SpecialEvent, SpecialDrawn, SpecialCoreState> {
  readonly motion: CraftMotion;
  readonly clock = new FixedStep(1 / 60, 6, 0.1);
  readonly reach: { radius: number };
  readonly neutral: CraftInput;
  readonly events: SpecialEvent[] = [];
  readonly tank: Tank;
  /** what the last step did ('blocked': met a wall; 'loading': waited for a tile) */
  result: CraftStep = 'moving';
  private worlds = new WeakMap<VoxelCollision, CraftMotionWorld>();
  // drawn: where it was at the world tick's start
  private readonly from: SpecialDrawn = { x: 0, y: 0, z: 0, h: 0, pitch: 0, bank: 0 };

  // fuel: its tank's numbers (none: it has none, the paraglider)
  constructor(readonly kind: CraftKind, cfg: CraftTuning = CRAFT, fuel: TankTuning | null = null) {
    this.tank = new Tank(fuel);
    this.motion = new CraftMotion(kind, cfg);
    this.reach = { radius: CRAFT_RADIUS[kind] };
    this.neutral = kind === 'helicopter' ? LET_DOWN : NO_CRAFT_INPUT;
  }

  /** the craft's view of the collision (its probes, the surface under it) */
  world(col: VoxelCollision) {
    let w = this.worlds.get(col);
    if (!w) this.worlds.set(col, w = craftWorld(this.kind, col));
    return w;
  }

  /** landed on foot or on the water: it steps no more */
  get ended() { return this.result === 'landed' || this.result === 'splash'; }

  reset(spot: CraftSpot) {
    this.motion.reset({ x: spot.x, y: spot.y ?? 0, z: spot.z }, spot.h, spot.speed ?? 0);
    this.result = 'moving';
    this.keep();
  }

  keep() {
    const m = this.motion, f = this.from;
    f.x = m.p.x; f.y = m.p.y; f.z = m.p.z; f.h = m.heading; f.pitch = m.pitch; f.bank = m.bank;
  }

  step(input: CraftInput, dt: number, col: VoxelCollision) {
    if (this.ended) return false;
    if (!this.tank.power) input = this.neutral;
    // (an empty seat is the engine off; a helicopter off its skids works to hold itself up)
    else if (input !== this.neutral) this.tank.burn(Math.max(Math.abs(input.drive), Math.abs(input.side), Math.abs(input.lift), this.kind === 'helicopter' && !this.motion.grounded ? HOVER : 0), dt);
    this.result = this.motion.step(input, dt, this.world(col));
    if (this.result === 'landed' || this.result === 'splash') { this.events.push(this.result); return false; }
    return this.result !== 'loading';
  }

  // pushed out of a solid thing as far as its probes let it; the speed into it lost, as into a wall (CraftMotion slide)
  meet(n: { x: number; z: number }, depth: number, col: VoxelCollision) {
    if (this.ended) return;
    const m = this.motion, d = { x: n.x * (depth + 1e-3), y: 0, z: n.z * (depth + 1e-3) };
    const hit = this.world(col).sweep(m.p, d, m.heading, m.heading);
    if (hit === 'loading') return;
    const f = hit.hit ? Math.max(0, hit.fraction - 0.002) : 1;
    m.p.x += d.x * f; m.p.z += d.z * f;
    const v = m.velocity, vn = v.x * n.x + v.z * n.z;
    if (vn < 0) { v.x -= vn * n.x; v.z -= vn * n.z; }
  }

  save(): SpecialCoreState { return { motion: this.motion.save(), result: this.result, from: { ...this.from }, ...this.tank.save() }; }
  load(s: SpecialCoreState) {
    this.motion.restore(s.motion);
    this.result = s.result;
    this.tank.load(s);
    Object.assign(this.from, s.from);
  }

  get pose() { const { p, heading } = this.motion; return { x: p.x, y: p.y, z: p.z, h: heading }; }
  get velocity() { return this.motion.velocity; }
  drawn(alpha: number): SpecialDrawn {
    const m = this.motion, a = this.from, t = Math.min(1, Math.max(0, alpha)), l = (u: number, v: number) => u + (v - u) * t;
    return { x: l(a.x, m.p.x), y: l(a.y, m.p.y), z: l(a.z, m.p.z), h: lerpAngle(a.h, m.heading, t), pitch: lerpAngle(a.pitch, m.pitch, t),
      bank: lerpAngle(a.bank, m.bank, t) };
  }
}
