// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): the
// traffic's agents as a snapshot carries them (enough for the client's own path maths: Traffic.carPose, personPoint),
// the cars' bodies as drawn, the trains, the boats. Types only (tools/core-deps.mjs R5).
import type { VehicleId } from './ids';
import type { RoadPose } from './pose';

/** a person of the crowd (sim/traffic.ts), on foot or on a bike. The events name one by id (struck, dropped:
 * contract/events.ts Fallen) */
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

/** a body's pose at a tick (sim/body-pose.ts bodyPoseAt): its origin (map metres), its rotation (a unit quaternion:
 * blended, never its angles), how far the ground is under the origin along its up (ride); a driven body's lean and
 * wheelie (rad) */
export interface BodyPose { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; ride: number; lean?: number; wheelie?: number }

/** a car's body as drawn (sim/traffic.ts TrafficBodies.drawState; drawn by sim/body-pose.ts drawnBodyPose): owns (a
 * body, not on its path), body (one at all), its poses at the last two ticks (p0, p1; null: none moving it), a driven
 * body's (drive: wheelZ, the rear wheel's offset its wheelie lifts by; fall: a rider coming off, to side, until the
 * driver's ms, tick: the tick it is drawn at), its fade back onto its path (t, dur: s; d*: the offset blended out) */
export interface BodyDraw {
  owns: boolean;
  body: boolean;
  p0: BodyPose | null;
  p1: BodyPose | null;
  drive: { wheelZ: number; fall: { side: number; until: number; tick: number } | null } | null;
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
