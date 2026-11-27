// A player craft's core, the one contract WorldSim steps (sim/world-sim.ts crafts; docs/adr/0008-server-vision.md:
// every player-controlled thing on the world clock, sim side). Each craft keeps its own fixed step (FixedStep: its step
// size), run by WorldSim in each world tick: STEP worth of its steps (sim/traffic.ts STEP; 2 or 4 of them) with that
// tick's input; its motion law stays in its own module (boat-motion.ts, craft-motion.ts, fpv-flight.ts,
// plane-flight.ts), the core wraps it. No three.js, no DOM (tools/core-deps.mjs).
//   reset(spot)               put down at spot, standing still (or at spot.speed); drawn there, not coming from where
//                             it was (keep)
//   keep()                    the start of a world tick: where it is drawn from (its drawn state now, kept)
//   step(input, dt, world)    one fixed step of dt s through the craft's collision; false: not taken (a tile not in) or
//                             held (ended, disarmed): the rest of the tick's time is dropped
//   pose                      where it is now (x, y, z, heading h: 0 +z, pi/2 +x)
//   drawn(alpha)              its pose as drawn between the world's last two ticks: alpha (0..1, WorldSim's FrameTime)
//                             of the way from where it was kept to where it is now; one put somewhere at once in a
//                             step (the plane's respawn) drawn where it is
//   meet(n, depth, world)     met a solid thing (sim/solids.ts: its type has a shape): pushed out of it, bounced
//   save(), load(state)       its state on the wire (contract/crafts.ts CraftStates, by type: a snapshot's crafts): what
//                             a client's copy of it reads (pose, drawn, velocity, what its shell shows), declared field
//                             by field; core-state.ts checks nothing else it holds differs on the copy (tools/craft-motion.mjs)
// The shells (nav/boat.ts, ...) keep the panel, the camera, the model and the input mapping; they read the core.
import type { FixedStep } from '../../core/fixed-step';
import type { Meta } from '../../core/meta';
import type { TileCache } from '../../core/tile-cache';
import type { Vec3 } from '../../core/vec';
import type { CraftSpot } from '../contract/commands';
import type { CraftId, CraftType, PlayerId } from '../contract/ids';
import type { Pose } from '../contract/pose';
import type { CollisionOptions, VoxelCollision } from './voxel-collision';

/** a player craft (a CraftCore; WorldSim's crafts): an entity with one seat, its pilot's; stepped once put down */
export interface Craft<C extends CraftCore = CraftCore> {
  readonly id: CraftId;
  readonly type: CraftType;
  readonly core: C;
  /** its own: the tiles round it (the shell reads it too: its camera's sweep, its panel) */
  readonly collision: VoxelCollision;
  /** the player in the pilot's seat */
  readonly pilot: PlayerId | null;
  /** put down (placeCraft): stepped from then on */
  readonly placed: boolean;
}

/** what the crafts' collisions read: the map, the node files (the viewer's shared TileCache) and the clock (ms) their
 * fetch pacing reads (WorldSim's crafts; a shell's own, nav/craft.ts) */
export interface CraftWorld { meta: Meta; cache: TileCache; now: () => number }

export interface CraftCore<I = unknown, E = unknown, D = unknown, S = unknown> {
  /** its fixed step (step size), run by WorldSim each world tick for STEP s */
  readonly clock: FixedStep;
  /** its collision's cube and look-ahead (VoxelCollision, made by WorldSim) */
  readonly reach: CollisionOptions;
  /** the input of an empty seat (WorldSim: a craft left, or not yet given its pilot's): hands off, and what would keep
   * it going let go (a plane's lever back, a drone's throttle cut, a helicopter let down onto its skids) */
  readonly neutral: I;
  /** what happened since they were last read (WorldSim: the world's craft events, read by its pilot's session: Session.craftEvents) */
  readonly events: E[];
  reset(spot: CraftSpot): void;
  /** a world tick starts: what drawn(alpha) blends from (alpha 0) is its drawn state now */
  keep(): void;
  step(input: I, dt: number, world: VoxelCollision): boolean;
  /** (a plane's with its bank: its wings to the solid things, sim/solids.ts craftSolids) */
  readonly pose: Pose & { bank?: number };
  /** m/s, where its collision fetches ahead */
  readonly velocity: Vec3;
  /** run ahead on a page (client/predict.ts): it is not put back where only the host knows the place (a crashed
   * plane's respawn reads the safe poses the host kept); it waits for the host's word */
  ahead?: boolean;
  drawn(alpha: number): D;
  /** its state on the wire: plain data, objects of its own (none of the core's) */
  save(): S;
  /** a client's copy (a core of the same type and tuning, never stepped): state (save()'s) written into it */
  load(state: S): void;
  /** met a solid thing (sim/solids.ts; the craft's type has a shape there) depth m deep, n (a unit x, z) the way out
   * of it: pushed out as far as its own collision lets it, its speed into it turned back or lost as at a wall */
  meet?(n: { x: number; z: number }, depth: number, world: VoxelCollision): void;
  /** back to a safe spot nearby (T); false: not now */
  unstick?(world: VoxelCollision): boolean;
}
