// The helicopter, the hovercraft and the paraglider as WorldSim steps them (craft-core.ts): their motion
// (craft-motion.ts CraftMotion) at 1/60 s, at most 6 steps (0.1 s) a frame, through their probes (craft-collision.ts
// craftWorld). A landing on foot or on the water (the paraglider's) ends it: it steps no more, and its pilot hears of it
// (events: 'landed', 'splash'). No three.js, no DOM (tools/core-deps.mjs).
import { FixedStep } from '../../core/fixed-step';
import type { Vec3 } from '../../core/vec';
import type { CraftCore, CraftSpot } from './craft-core';
import { craftWorld, CRAFT_RADIUS } from './craft-collision';
import { CRAFT, CraftMotion, type CraftInput, type CraftKind, type CraftMotionWorld, type CraftStep, type CraftTuning } from './craft-motion';
import type { VoxelCollision } from './voxel-collision';

export const NO_CRAFT_INPUT: CraftInput = Object.freeze({ turn: 0, drive: 0, lift: 0, side: 0 });
export type SpecialEvent = 'landed' | 'splash';
/** as drawn: the motion's point (the paraglider's: the pilot's middle), its heading, pitch (+: nose up), bank (+: the
 * right side down) */
export interface SpecialDrawn extends Vec3 { h: number; pitch: number; bank: number }

export class SpecialCore implements CraftCore<CraftInput, SpecialEvent, SpecialDrawn> {
  readonly motion: CraftMotion;
  readonly clock = new FixedStep(1 / 60, 6, 0.1);
  readonly reach: { radius: number };
  readonly neutral = NO_CRAFT_INPUT;
  readonly events: SpecialEvent[] = [];
  /** what the last step did ('blocked': met a wall; 'loading': waited for a tile) */
  result: CraftStep = 'moving';
  private worlds = new WeakMap<VoxelCollision, CraftMotionWorld>();

  constructor(readonly kind: CraftKind, cfg: CraftTuning = CRAFT) {
    this.motion = new CraftMotion(kind, cfg);
    this.reach = { radius: CRAFT_RADIUS[kind] };
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
  }

  step(input: CraftInput, dt: number, col: VoxelCollision) {
    if (this.ended) return false;
    this.result = this.motion.step(input, dt, this.world(col));
    if (this.result === 'landed' || this.result === 'splash') { this.events.push(this.result); return false; }
    return this.result !== 'loading';
  }

  get pose() { const { p, heading } = this.motion; return { x: p.x, y: p.y, z: p.z, h: heading }; }
  get velocity() { return this.motion.velocity; }
  // (as drawn at the last step)
  drawn(_alpha: number): SpecialDrawn {
    const m = this.motion;
    return { x: m.p.x, y: m.p.y, z: m.p.z, h: m.heading, pitch: m.pitch, bank: m.bank };
  }
}
