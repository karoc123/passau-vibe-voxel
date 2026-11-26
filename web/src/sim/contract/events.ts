// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): what
// happened in a tick (WorldSim.eventsSince; a snapshot's events). Types and constants only (tools/core-deps.mjs R5).
import type { Vec3 } from '../../core/vec';
import type { EntityRef, PlayerId, Seat, WeaponId } from './ids';
import type { RoadPose } from './pose';
import type { CraftEventOf } from './crafts';

/** why a rider came off a motorbike (physics/rapier/player-car.ts PlayerCar.fall): running into the world (wall: a
 * wall, a kerb, a parked car), a car of the traffic, a train's coach (speed: m/s lost along the heading, or the shove
 * from what moved into it, whichever threw it); a crash landing (speed: m/s into the ground); tipped over past 60°
 * (side, speed 0) */
export interface FallCause { kind: 'wall' | 'car' | 'train' | 'landing' | 'side'; speed: number }

/** what the driver of a car is to be told (physics/rapier/player-car.ts PlayerCar's notes): its text, for ms; fall:
 * why the rider came off, on the note that says so */
export interface DriveNote { tick: number; text: string; ms: number; fall?: FallCause }

/** a person of the crowd fallen (struck, dropped): its id (contract/agents.ts Person: gone from the crowd then) and
 * what its fall is drawn with (its shirt, on a bike or not) */
export interface Fallen { person: number; col: string; bike: boolean }

/** what happened in a tick, to an entity or a player; tick: the tick that produced it (WorldSim.tick after it):
 *   struck            a person knocked down by a driven car (where, how fast it went: drawn falling, view/life.ts)
 *   impact            the same contact as a fact about the entity hit: by whom, how fast (m/s), where
 *   dropped           a person fallen into a hole (drawn falling from where it was drawn: by id)
 *   seated, unseated  a player into a seat or out of it (the tick the command was applied in)
 *   craft             what happened to a craft (craft: its type, e: its core's event of that type, as the shell
 *                     reads it: contract/crafts.ts)
 *   drive             what the driver of a car is to be told (life-phys.ts PlayerCar's note)
 *   shot              a player's weapon fired: from at to to, what stopped it there (hit: an entity, 'world' the
 *                     voxels, null nothing within its range)
 *   launch            a player's weapon let go a projectile at at with velocity v (m/s): it flies as its weapon's
 *                     package says until its blast
 *   blast             an explosion of a player's weapon at at, radius r (m): the crater it leaves follows as an
 *                     edit of the world's */
export type SimEvent =
  | ({ tick: number; kind: 'struck'; pose: RoadPose; vx: number; vz: number } & Fallen)
  | { tick: number; kind: 'impact'; entity: EntityRef; by?: EntityRef; speed: number; at: Vec3 }
  | ({ tick: number; kind: 'dropped' } & Fallen)
  | { tick: number; kind: 'seated' | 'unseated'; player: PlayerId; seat: Seat }
  | ({ tick: number; kind: 'craft'; entity: EntityRef } & CraftEventOf)
  | { tick: number; kind: 'drive'; entity: EntityRef; note: DriveNote }
  | { tick: number; kind: 'shot'; weapon: WeaponId; player: PlayerId; at: Vec3; to: Vec3; hit: EntityRef | 'world' | null }
  | { tick: number; kind: 'launch'; weapon: WeaponId; player: PlayerId; at: Vec3; v: Vec3 }
  | { tick: number; kind: 'blast'; weapon: WeaponId; player: PlayerId; at: Vec3; r: number };

/** the events kept for readers (ticks: 10 s); a reader further behind misses the older ones */
export const EVENT_TICKS = 300;
