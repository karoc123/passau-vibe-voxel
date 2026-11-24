// The players' commands to the world sim (ADR 0007: keyed by player id) and their outcomes: plain data, so they can
// cross to a Web Worker or a server. The sim queues them (WorldSim.send) and applies them in the order sent at the
// start of its next update, before its ticks, in one place (WorldSim.apply); a client never reaches a seat otherwise.
// A player holds at most one seat (WorldSim.seat): taking another leaves the one held first, in the same command;
// refused, the player keeps it. No three.js, no DOM (tools/core-deps.mjs).
import type { CarInput } from '../physics/rapier/car';
import type { CraftSpot } from './craft/craft-core';
import type { CraftType } from './craft/cores';
import type { WalkPose } from './types';
import type { EntityRef, Role } from './entities';
import type { VehicleId } from './vehicles';
import type { CraftInput, PlayerId } from './world-sim';

/** a player's command, applied at the start of the sim's next update, in order:
 *   follow        follow an entity (a car, a person, a craft; no rights over it), or none
 *   enterSeat     a seat of an entity (sim/entities.ts SEATS: role, index; without, its first): the driver's of a car (as
 *                 type choice), the walker's of a person on foot (from pose: where they are drawn, kept within
 *                 Tuning.walk.take of where the sim has them), the pilot's of a craft; refused: gone, no such seat, held
 *                 by another, not allowed (WorldSim.mayEnter), or (a car) no road physics. The one held is left first
 *   seatInput     the controls of the seat held, until the next: a driver's CarInput, a pilot's their craft's type's
 *                 input, a walker's pose (the walk is the client's), bounded against the last one taken (Tuning.walk:
 *                 clamped, refused, walkedPose has the pose taken); ignored for a role not held
 *   leaveSeat     out of the seat held: the person walked back to the crowd's walk, the car parked where it is, the
 *                 craft left where it is, hands off (its core's neutral)
 *   resetDriver   the player's car back on the road
 *   spawnCraft    a craft of type made, the player its pilot, put down at spot (what a game mode decides; today the
 *                 craft's shell)
 *   placeCraft    the player's craft put down again at spot
 *   resetCraft    the player's craft back to a safe spot nearby; refused: not now
 *   dropCraft     the player's craft taken out of the world (one that does not stay: the paraglider) */
export type PlayerCommand =
  | { kind: 'follow'; player: PlayerId; entity: EntityRef | null }
  | { kind: 'enterSeat'; player: PlayerId; entity: EntityRef; role?: Role; index?: number; choice?: VehicleId; pose?: WalkPose }
  | ({ kind: 'seatInput'; player: PlayerId } & SeatInput)
  | { kind: 'leaveSeat'; player: PlayerId }
  | { kind: 'resetDriver'; player: PlayerId }
  | { kind: 'spawnCraft'; player: PlayerId; type: CraftType; spot: CraftSpot }
  | { kind: 'placeCraft'; player: PlayerId; spot: CraftSpot }
  | { kind: 'resetCraft'; player: PlayerId }
  | { kind: 'dropCraft'; player: PlayerId };

/** a seat's input, by its role */
export type SeatInput = { role: 'driver'; input: CarInput } | { role: 'pilot'; input: CraftInput } | { role: 'walker'; input: WalkPose };

/** what became of a command that can be refused (enterSeat, seatInput clamped, spawnCraft, placeCraft, resetCraft,
 * edit), at the tick it was applied before; a seat's: its role; an edit's: its ref and the level-1 nodes it changed */
export interface CommandResult {
  tick: number; kind: PlayerCommand['kind'] | 'edit'; ok: boolean; role?: Role; ref?: number; nodes?: [number, number][];
}
