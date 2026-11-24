// The players' commands to the world sim (ADR 0007: applied per player id, the session's) and their outcomes: plain
// data, so they can cross to a Web Worker or a server. The sim queues them (WorldSim.send) and applies them in the
// order sent at the start of its next tick, in one place (WorldSim.apply); a client never reaches a seat otherwise.
// A player holds at most one seat (WorldSim.seat): taking another leaves the one held first, in the same command;
// refused, the player keeps it. A command names no player: the session it is sent through is one player's, and the host
// stamps that player on it (sim/server/sim-server.ts Session; docs/plans/architecture-review.md F2, A7), so a client cannot
// act as another. Part of the contract between the world sim and its clients
// (docs/plans/architecture-review.md section 3, layer 1): types and constants only (tools/core-deps.mjs R5).
import type { WorldOp } from '../../core/layers';
import type { CarInput, PilotInput } from './inputs';
import type { WalkPose } from './pose';
import type { EntityRef, CraftType, Role, VehicleId } from './ids';

/** what the page sends: a player's command to the world sim (PlayerCommand: applied at the start of the sim's next
 * tick, in order), or an edit, a change to the world's voxels (core/world-edits.ts) */
export type SimCommand = PlayerCommand | { kind: 'edit'; op: WorldOp; ref?: number };

/** a player's command (the player: the session's it is sent through), applied at the start of the sim's next tick, in order:
 *   follow        follow an entity (a car, a person, a craft; no rights over it), or none
 *   enterSeat     a seat of an entity (sim/entities.ts SEATS: role, index; without, its first): the driver's of a car (as
 *                 type choice), the walker's of a person on foot (from pose: where they are drawn, kept within
 *                 Tuning.walk.take of where the sim has them), the pilot's of a craft; refused: gone, no such seat, held
 *                 by another, not allowed (the game mode's mayEnter: sim/mode.ts), or (a car) no road physics. The one held is left first
 *   seatInput     the controls of the seat held, until the next: a driver's CarInput, a pilot's their craft's type's
 *                 input, a walker's pose (the walk is the client's), bounded against the last one taken (Tuning.walk:
 *                 clamped, refused, walkedPose has the pose taken); ignored for a role not held. seq: the client's
 *                 number for it (increasing per client; its session's ack: the last taken), tick: the world tick it was
 *                 sent for (the client's tick + 1; it is applied at the next tick run)
 *   leaveSeat     out of the seat held: the person walked back to the crowd's walk, the car parked where it is, the
 *                 craft left where it is, hands off (its core's neutral)
 *   request       what the player asks of the game mode (ModeRequest: a craft made, put down again, reset or
 *                 dropped; the car reset), granted or refused by it; its outcome a result of the request's kind */
export type PlayerCommand =
  | { kind: 'follow'; entity: EntityRef | null }
  | { kind: 'enterSeat'; entity: EntityRef; role?: Role; index?: number; choice?: VehicleId; pose?: WalkPose }
  | ({ kind: 'seatInput'; seq?: number; tick?: number } & SeatInput)
  | { kind: 'leaveSeat' }
  | { kind: 'request'; request: ModeRequest };

/** a seat's input, by its role */
export type SeatInput = { role: 'driver'; input: CarInput } | { role: 'pilot'; input: PilotInput } | { role: 'walker'; input: WalkPose };

/** what became of a command that can be refused (enterSeat, seatInput clamped, a request: by the request's kind, edit),
 * at the tick it was applied before; a seat's: its role; an edit's: its ref and the level-1 nodes it changed */
export interface CommandResult {
  tick: number; kind: Exclude<PlayerCommand['kind'], 'request'> | ModeRequest['kind'] | 'edit'; ok: boolean; role?: Role; ref?: number; nodes?: [number, number][];
}

/** what a player asks of the rules (a request command; its outcome is a result of the request's kind; the game mode,
 * sim/mode.ts, grants or refuses it):
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

/** where a craft is put down: x, z, heading h, a height for one that starts in the air or afloat, a speed along h for
 * one that starts moving, water: afloat (the floatplane) */
export interface CraftSpot { x: number; y?: number; z: number; h: number; speed?: number; water?: boolean }
