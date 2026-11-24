// The contract between the world sim and its clients (docs/plans/architecture-review.md section 3, layer 1): the
// traffic's agents as a snapshot carries them (enough for the client's own path maths: Traffic.carPose, personPoint),
// the cars' bodies as drawn, the trains, the boats. Types only (tools/core-deps.mjs R5).
import type { VehicleId } from './ids';
import type { RoadPose } from './pose';

/** a person of the crowd (sim/traffic.ts), on foot or on a bike. Whole in the events that name one (struck, dropped:
 * contract/events.ts) */
export interface Person {
  kind: 'person';
  /** its entity id, kept while it lives (people and riders are numbered apart from the cars: contract/ids.ts EntityRef) */
  id: number;
  e: number;
  dir: number;
  s: number;
  v: number;
  lat: number;
  ph: number;
  wait: boolean;
  col: string; // their shirt ('#rrggbb')
  bike?: boolean;
}

/** what a client's path maths and drawing read of a person (sim/server/snapshot.ts PERSON_KEYS) */
export type PersonState = Pick<Person, 'id' | 'e' | 'dir' | 's' | 'v' | 'lat' | 'ph' | 'wait' | 'col' | 'bike'>;

/** what a client's path maths and drawing read of a car (sim/types.ts Car; sim/server/snapshot.ts CAR_KEYS) */
export interface CarState {
  id: number;
  e: number;
  lane: number;
  s: number;
  ds: number;
  off: number;
  dOff: number;
  prev: number;
  prevOff: number;
  prev2?: number;
  prev2Off?: number;
  next: number;
  next2?: number;
  len: number;
  bus: boolean;
  vt?: VehicleId;
  col: string;
  brake: number;
  v: number;
  wait: number;
  detachedPose?: RoadPose;
}

/** a car's body as drawn (sim/traffic.ts TrafficBodies.drawState): owns (a body, not on its path), body (one at all),
 * its drawn poses at the last two ticks (p0, p1; null: none moving it), its fade back onto its path (t, dur: s; d*: the
 * offset blended out) */
export interface BodyDraw {
  owns: boolean;
  body: boolean;
  p0: RoadPose | null;
  p1: RoadPose | null;
  fade: { dx: number; dy: number; dz: number; dh: number; t: number; dur: number } | null;
}

/** a train as saved and loaded (sim/train-traffic.ts TrainTraffic save, load) */
export interface TrainState { id: number; p: number; s: number; ds: number; n: number; express: boolean }

/** a ship or a boat on the river (sim/boat-traffic.ts) */
export interface BoatPose {
  // IDs are stable by berth slot for cruise ships and by fleet slot for excursion boats.
  readonly id: number;
  readonly kind: 'ship' | 'boat';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly len: number;
  readonly lit: boolean;
  readonly underway: boolean;
}

/** what the presentation draws of the boats (view/boats.ts): their poses at the last two ticks, the time and day
 * (sim/boat-traffic.ts BoatTraffic) */
export interface BoatView {
  readonly poses: readonly BoatPose[];
  readonly previous: readonly BoatPose[];
  readonly elapsed: number;
  readonly day: number;
}
