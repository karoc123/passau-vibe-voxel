// The game mode (ADR 0008: the rules of a game are a mode layered on the
// world sim): what a player may do that the sim itself does not decide. One mode per world sim, made by its host
// (SimServer; host/sim-host.ts: ?mode=, default sandbox) and kept on the WorldSim (WorldSim.mode), which asks it while it
// applies the players' commands (each tick, in order). Today's only mode is the sandbox (sim/modes/sandbox.ts:
// everything granted as asked). Kept to what that needs: whether a seat may be taken (mayEnter), whether an edit to
// the world's voxels may be made (mayEdit), and the players' requests (request: among them the world's time of day). No three.js, no DOM
// (tools/core-deps.mjs).
import type { WorldOp } from '../core/layers';
import type { CraftSpot, ModeRequest } from './contract/commands';
import type { CraftId, CraftType, PlayerId, Seat } from './contract/ids';
import type { Craft } from './craft/craft-core';
import type { WalkPose } from './contract/pose';

// (what a player asks of the rules, ModeRequest: contract/commands.ts)

/** the face of the world sim a mode acts through (WorldSim's) */
export interface ModeWorld {
  /** the seat the player holds, or null */
  seat(player: PlayerId): Seat | null;
  /** the craft the player pilots, or null */
  craftOf(player: PlayerId): Craft | null;
  /** a new craft of type, not yet put down (throws without a craft world) */
  addCraft(type: CraftType): Craft;
  /** craft id put down at spot */
  placeCraft(id: CraftId, spot: CraftSpot): void;
  /** craft id taken out of the world (its pilot leaves it first) */
  removeCraft(id: CraftId): void;
  /** the player into seat as enterSeat takes it (free, the one held left first, mayEnter asked); false: not */
  sit(player: PlayerId, seat: Seat): boolean;
  /** the player on foot: their avatar put down at pose, the player its walker (one held: put down there again);
   * false: not (the seat held could not be left) */
  walk(player: PlayerId, pose: WalkPose): boolean;
  /** the world's time of day (hour) and day of the year (without: kept), the same for every player */
  setTime(hour: number, day?: number): void;
  /** the player's car back on the road; false: they drive none */
  resetDriver(player: PlayerId): boolean;
}

export interface GameMode {
  readonly id: string;
  /** a player's request, granted (true: done) or refused */
  request(w: ModeWorld, player: PlayerId, r: ModeRequest): boolean;
  /** whether player may take seat, asked once it is found free (without: always) */
  mayEnter?(w: ModeWorld, player: PlayerId, seat: Seat): boolean;
  /** whether player may make an edit to the world's voxels (without: never); asked when the host gets the edit (a
   * refused one's nodes are not loaded) and again when it is applied, so a plain answer, no state changed */
  mayEdit?(w: ModeWorld, player: PlayerId, op: WorldOp): boolean;
}
