// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): what the
// world sim publishes to a client after an update (the snapshot, ADR 0008; made by sim/server/snapshot.ts
// takeSnapshot, read by its TrafficMirror). Plain data, structured-cloneable: it crosses to the page from a Web Worker
// as it is (later, quantised, to a network client); the gates check that (CloneLink). Types and constants only
// (tools/core-deps.mjs R5).
import type { WorldOp } from '../../core/layers';
import type { BodyWire, BoatsWire, CarState, CarWire, PersonWire, TrainWire } from './agents';
import type { CommandResult } from './commands';
import type { CraftStates } from './crafts';
import type { SimEvent } from './events';
import type { CraftId, CraftType, PlayerId, Seat } from './ids';
import type { RoadPose, WalkPose } from './pose';

/** a craft put down: what its shell or the page's drawing reads (core: its core's state, of its type: contract/crafts.ts,
 * sim/craft/craft-core.ts save) */
export type CraftState<K extends CraftType = CraftType> =
  { [T in K]: { id: CraftId; type: T; pilot: PlayerId | null; placed: boolean; core: CraftStates[T] } }[K];

/** a player's own body on foot (an avatar: contract/ids.ts): its id, its player, where its walker put it at the tick
 * and at the tick before (drawn between them) */
export interface AvatarState { id: number; player: PlayerId; pose: WalkPose; prev: WalkPose }
/** an avatar as a snapshot carries it (sim/agent-wire.ts, mm and 1e-4 rad): sent when it moved; prev left out when it
 * is the pose sent before */
export type AvatarWire = Omit<AvatarState, 'prev'> & { prev?: WalkPose };

/** a level-1 node's edits since the last snapshot: the ops from its from-th on, which the client applies in order over
 * its own copy of the node (core/world-edits.ts editNode: the same columns as the host's); ops null: the node is its
 * files again */
export interface EditNote { tx: number; ty: number; from: number; ops: WorldOp[] | null }

/** the last seat input a session sent that its player's seat took: its seq (the client's number), the tick it was
 * first applied in */
export interface Ack { seq: number; tick: number }

/** how long (ms) a driver's car sinks, is shaken by a crash, falls before it is reset (physics/rapier/player-car.ts) */
export const SINK_MS = 2000, CRASH_MS = 1100, FALL_MS = 1600;

/** the player's car as its driver reads it (physics/rapier/player-car.ts PlayerCar) */
export interface DriverSnapshot {
  tick: number;
  entityId: number;
  pose: RoadPose;
  kmh: number;
  waiting: boolean;
  onWheels: boolean;
  status: 'ok' | 'water';
  sinkMs: number;
  crashMs: number;
  fallMs: number;
}

/** the world's time of day (hour 0..24) and day of the year (1..365): world state the host sets, the same for every
 * player */
export interface TimeOfDay { hour: number; day: number }

/** a session's player (id: the host names it, sim/server/sim-server.ts SimServer.connect) and its reads; results since
 * the last snapshot (what their seat's entity did: events); ack: the session's last seat input taken (its seq, the
 * tick it was applied in: the state here is that of tick, after it) */
export interface PlayerReads { id: PlayerId; seat: Seat | null; driver: DriverSnapshot | null; results: CommandResult[]; ack: Ack | null }

/** a session's world after a tick: the traffic's cars, people, trains and boats, the cars out of the traffic, the
 * bodies and the avatars as what changed for the session since its last snapshot (sim/agent-wire.ts: the client
 * keeps the rest; gone: those it holds no more), the rest whole. Its cars, people, bodies, walked, avatars, crafts
 * and events are those near the session's player only (its own seat's entity always): a thing missing from walked or
 * crafts is gone for it */
export interface Snapshot {
  /** the tick whose state this is; what moves is drawn between it and the tick before */
  tick: number;
  /** the world clock (the signals: s) */
  t: number;
  /** the world's time of day and day of the year (the host's: WorldSim.setTime; the page's light follows it) */
  hour: number;
  day: number;
  /** the traffic's cars, people and riders: the samples since the session's last snapshot (contract/agents.ts CarWire) */
  cars: CarWire[];
  /** the cars out of the traffic (left, parked, a wreck) that changed */
  detached: CarState[];
  people: PersonWire[];
  riders: PersonWire[];
  /** the cars, the people and riders, the trains, the boats (a ship's id, -1 - a boat's), the cars out of the traffic,
   * the bodies (by car id), the avatars, by id, gone from the session's sight (or from the world) */
  gone: [cars: number[], people: number[], trains: number[], boats: number[], detached: number[], bodies: number[], avatars: number[]];
  /** the cars with a body (or its fade), by car id, whose draw changed (one at rest: once, its p0 its p1) */
  bodies: [number, BodyWire][];
  /** the trains: the samples since the session's last snapshot (contract/agents.ts TrainWire) */
  trains: TrainWire[];
  boats: BoatsWire | null;
  /** the people walked by players: their pose, by person id */
  walked: [number, WalkPose][];
  /** the players' own bodies on foot that moved */
  avatars: AvatarWire[];
  /** the cars driven by players, by car id with its driver (for a map's markers) */
  drivers: [car: number, player: PlayerId][];
  /** the players riding along in a car or a craft sent (its free seats, its riders not drawn on foot, map markers) */
  passengers: [kind: 'car' | 'craft', id: number, player: PlayerId][];
  /** the crafts put down, piloted or left */
  crafts: CraftState[];
  /** the events of the ticks after the last snapshot's */
  events: SimEvent[];
  /** the names the players chose, all of them (one without none), when they changed since the session's last snapshot */
  names?: [player: PlayerId, name: string][];
  /** the session's player and its reads, left out when they are those sent before and there are no results */
  player?: PlayerReads;
  edits: EditNote[];
}
