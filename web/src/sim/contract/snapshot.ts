// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): what the
// world sim publishes to a client after an update (the snapshot, ADR 0008; made by sim/server/snapshot.ts
// takeSnapshot, read by its TrafficMirror). Plain data, structured-cloneable: it crosses to the page from a Web Worker
// as it is (later, quantised, to a network client); the gates check that (CloneLink). Types and constants only
// (tools/core-deps.mjs R5).
import type { LiveNode, Region } from '../../core/live-edits';
import type { BodyDraw, BoatView, CarState, PersonState, TrainState } from './agents';
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

/** a level-1 node edited (its columns now) or given its files again (null) since the last snapshot (a worker's: the
 * page's live edits follow the world's) */
export interface EditNote { tx: number; ty: number; node: LiveNode | null; region: Region }

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

export interface Snapshot {
  /** the tick whose state this is; what moves is drawn between it and the tick before */
  tick: number;
  /** the world clock (the signals: s) */
  t: number;
  /** the world's time of day and day of the year (the host's: WorldSim.setTime; the page's light follows it) */
  hour: number;
  day: number;
  cars: CarState[];
  detached: CarState[];
  people: PersonState[];
  riders: PersonState[];
  /** the cars with a body (or its fade), by car id */
  bodies: [number, BodyDraw][];
  trains: TrainState[];
  boats: BoatView | null;
  /** the people walked by players: their pose, by person id */
  walked: [number, WalkPose][];
  /** the players' own bodies on foot */
  avatars: AvatarState[];
  /** the crafts put down, piloted or left */
  crafts: CraftState[];
  /** the events of the ticks after the last snapshot's */
  events: SimEvent[];
  /** the session's player (id: the host names it, sim/server/sim-server.ts SimServer.connect) and its reads; results since
   * the last snapshot (what their seat's entity did: events); ack: the session's last seat input taken (its seq, the
   * tick it was applied in: the state here is that of tick, after it) */
  player: { id: PlayerId; seat: Seat | null; driver: DriverSnapshot | null; results: CommandResult[]; ack: Ack | null };
  edits: EditNote[];
}
