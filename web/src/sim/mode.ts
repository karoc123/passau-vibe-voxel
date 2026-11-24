// The game mode (docs/plans/entities-and-modes.md section 3, ADR 0008: the rules of a game are a mode layered on the
// world sim): what a player may do that the sim itself does not decide. One mode per world sim, made by its host
// (SimServer; sim-host.ts: ?mode=, default sandbox) and kept on the WorldSim (WorldSim.mode), which asks it while it
// applies the players' commands (each tick, in order). Today's only mode is the sandbox (sim/modes/sandbox.ts:
// everything granted as asked). Kept to what that needs: whether a seat may be taken (mayEnter), whether an edit to
// the world's voxels may be made (mayEdit), and the players' requests (request). No three.js, no DOM
// (tools/core-deps.mjs).
import type { WorldOp } from '../core/layers';
import type { CraftSpot } from './craft/craft-core';
import type { CraftType } from './craft/cores';
import type { Seat } from './entities';
import type { Craft, CraftId, PlayerId } from './world-sim';

/** what a player asks of the rules (a request command; its outcome is a result of the request's kind):
 *   craft        a craft of type made, the player its pilot, put down at spot (the spot the client's shell found)
 *   placeCraft   the player's craft put down again at spot
 *   resetCraft   the player's craft back to a safe spot nearby
 *   resetDriver  the player's car back on the road
 *   dropCraft    the player's craft taken out of the world (one that does not stay: the paraglider) */
export type ModeRequest =
  | { kind: 'craft'; type: CraftType; spot: CraftSpot }
  | { kind: 'placeCraft'; spot: CraftSpot }
  | { kind: 'resetCraft' }
  | { kind: 'resetDriver' }
  | { kind: 'dropCraft' };

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
  /** the player into seat as enterSeat takes it (free, the one held left first), not asking mayEnter; false: not */
  sit(player: PlayerId, seat: Seat): boolean;
  /** the player's car back on the road; false: they drive none */
  resetDriver(player: PlayerId): boolean;
}

export interface GameMode {
  readonly id: string;
  /** a player's request, granted (true: done) or refused */
  request(w: ModeWorld, player: PlayerId, r: ModeRequest): boolean;
  /** whether player may take seat, asked once it is found free (without: always) */
  mayEnter?(w: ModeWorld, player: PlayerId, seat: Seat): boolean;
  /** whether player may make an edit to the world's voxels (without: never) */
  mayEdit?(w: ModeWorld, player: PlayerId, op: WorldOp): boolean;
}
