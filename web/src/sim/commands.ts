// The players' commands to the world sim (ADR 0007: keyed by player id) and their outcomes: plain data, so they can
// cross to a Web Worker or a server. The sim queues them (WorldSim.send) and applies them in the order sent at the
// start of its next update, before its ticks, in one place (WorldSim.apply); a client never reaches a seat otherwise.
// A player holds at most one seat (WorldSim.seat): taking another leaves the one held first, in the same command;
// refused, the player keeps it. No three.js, no DOM (tools/core-deps.mjs).
import type { CarInput } from '../physics/rapier/car';
import type { CraftSpot } from './craft/craft-core';
import type { CraftType } from './craft/cores';
import type { WalkPose } from './types';
import type { EntityRef } from './entities';
import type { VehicleId } from './vehicles';
import type { CraftId, CraftInput, PlayerId } from './world-sim';

/** a player's command, applied at the start of the sim's next update, in order:
 *   follow        follow an entity (a car, a person, a craft; no rights over it), or none
 *   walkAs        take the walker's seat of a person (from pose: where they are drawn, kept within Tuning.walk.take of
 *                 where the sim has them); refused: another walks as them, or gone
 *   walkPose      where the walk (the client's) puts the person walked, bounded against the last one taken
 *                 (Tuning.walk); clamped: refused (ok false), walkedPose has the pose taken
 *   takeWheel     the driver's seat of a car (as type choice); refused: no road physics, no such car, or driven
 *   drive         the car's controls, until the next
 *   resetDriver   the player's car back on the road
 *   spawnCraft    a craft of type made, the player its pilot, put down at spot (what a game mode decides; today the
 *                 craft's shell)
 *   placeCraft    the player's craft put down again at spot
 *   enterCraft    the pilot's seat of a craft in the world (one left by its pilot); refused: gone, or piloted
 *   craftInput    the player's craft's controls (its type's input), until the next
 *   resetCraft    the player's craft back to a safe spot nearby; refused: not now
 *   dropCraft     the player's craft taken out of the world (one that does not stay: the paraglider)
 *   leaveSeat     out of the seat held: the person walked back to the crowd's walk, the car parked where it is, the
 *                 craft left where it is, hands off (its core's neutral) */
export type PlayerCommand =
  | { kind: 'follow'; player: PlayerId; entity: EntityRef | null }
  | { kind: 'walkAs'; player: PlayerId; person: number; pose: WalkPose }
  | { kind: 'walkPose'; player: PlayerId; pose: WalkPose }
  | { kind: 'takeWheel'; player: PlayerId; car: number; choice?: VehicleId }
  | { kind: 'drive'; player: PlayerId; input: CarInput }
  | { kind: 'resetDriver'; player: PlayerId }
  | { kind: 'spawnCraft'; player: PlayerId; type: CraftType; spot: CraftSpot }
  | { kind: 'placeCraft'; player: PlayerId; spot: CraftSpot }
  | { kind: 'enterCraft'; player: PlayerId; craft: CraftId }
  | { kind: 'craftInput'; player: PlayerId; input: CraftInput }
  | { kind: 'resetCraft'; player: PlayerId }
  | { kind: 'dropCraft'; player: PlayerId }
  | { kind: 'leaveSeat'; player: PlayerId };

/** what became of a command that can be refused (walkAs, walkPose clamped, takeWheel, spawnCraft, placeCraft,
 * enterCraft, resetCraft, edit), at the tick it was applied before; an edit's: its ref and the level-1 nodes it
 * changed */
export interface CommandResult { tick: number; kind: PlayerCommand['kind'] | 'edit'; ok: boolean; ref?: number; nodes?: [number, number][] }
