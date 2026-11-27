// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): the
// traffic's agents as a snapshot carries them (enough for the client's own path maths: Traffic.carPose, personPoint),
// the cars' bodies as drawn, the trains, the boats. Types only (tools/core-deps.mjs R5).
import type { VehicleId } from './ids';
import type { RoadPose } from './pose';

/** the most cars, people on foot and bikes the traffic holds (sim/traffic.ts), so a snapshot carries; the page sizes its
 * instanced meshes by them (view/meshes.ts) */
export const MAX_CARS = 1400, MAX_PEOPLE = 4000, MAX_BIKES = 1200;

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

/** what a client's path maths and drawing read of a person (sim/server/snapshot.ts personState) */
export type PersonState = Pick<Person, 'id' | 'e' | 'dir' | 's' | 'v' | 'lat' | 'ph' | 'wait' | 'col' | 'bike'>;

/** a car moving across its road as it rolls on (pulling out beside something standing, back into its lane): its
 * offset eased from o0 at s0 to o1 at s1, by where on its road each point of it is (s), so it moves sideways only
 * while it moves on */
export type Shift = [s0: number, s1: number, o0: number, o1: number];
/** a car turning round onto its way back (its road now, s where its front ends up), drawn by the world's clock from
 * t0: x m on, then a turn on its rear axle of radius r across d m (a U-turn where the road is 2 r wide, else a
 * three-point turn), from its rear axle u0 along the road and v0 across it; (ax, ay), (bx, by) where its front and rear
 * axle were drawn at the start less where the turn has them, blended out */
type CarTurn = [t0: number, r: number, d: number, x: number, u0: number, v0: number, ax: number, ay: number, bx: number, by: number];

/** what a client's path maths and drawing read of a car (sim/types.ts Car extends it; sim/server/snapshot.ts carState) */
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
  // the road before prev and the one after next, with prev's offset there (-1, none: view/life.ts carPoint blends them in
  // when prev or next is shorter than its blend)
  prev2?: number;
  prev2Off?: number;
  next: number;
  next2?: number;
  len: number;
  bus: boolean;
  vt?: VehicleId; // its type (sim/vehicles.ts; none: the car, or a bus)
  col: string; // its paint ('#rrggbb')
  brake: number;
  v: number;
  wait: number;
  detachedPose?: RoadPose; // its pose out of the traffic: authoritative, independent of drawing
  shift?: Shift;
  turn?: CarTurn;
}

/** a car of the traffic as a snapshot carries a sample of it (sim/agent-wire.ts: when the client's reckoning drifts),
 * by length: [id, s, v, brake] while nothing else changed since the sample before; then its lane offset (off); then its way (e, lane, prev, prevOff, prev2,
 * prev2Off, next, next2; -1 none; its shift and turn, 0 none); then what it is (len, bus 1/0, vt or 0, col), sent when it comes into sight or
 * changes. ds, dOff and wait are the client's to work out. Lengths cm, speeds cm/s */
export type CarWire =
  | [id: number, s: number, v: number, brake: number]
  | [id: number, s: number, v: number, brake: number, off: number]
  | [id: number, s: number, v: number, brake: number, off: number, e: number, lane: number, prev: number, prevOff: number,
    prev2: number, prev2Off: number, next: number, next2: number, shift: Shift | 0, turn: CarTurn | 0]
  | [id: number, s: number, v: number, brake: number, off: number, e: number, lane: number, prev: number, prevOff: number,
    prev2: number, prev2Off: number, next: number, next2: number, shift: Shift | 0, turn: CarTurn | 0, len: number, bus: number,
    vt: VehicleId | 0, col: string];

/** a person of the crowd as a snapshot carries a sample of them (sim/agent-wire.ts), by length: [id, s]; then their way (e, dir,
 * wait 1/0) when it changed; then who they are (v, lat, ph, col), sent when they come into sight or change. A rider
 * is one of the snapshot's riders; ph after that is the client's to work out */
export type PersonWire =
  | [id: number, s: number]
  | [id: number, s: number, e: number, dir: number, wait: number]
  | [id: number, s: number, e: number, dir: number, wait: number, v: number, lat: number, ph: number, col: string];

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
/** a body's draw as a snapshot carries it (sim/agent-wire.ts): p0 left out when it is the p1 sent before (a moving
 * body's last pose); a fade's t is that at the snapshot's tick, sent again only when it does not run on with the ticks */
export type BodyWire = Omit<BodyDraw, 'p0'> & { p0?: BodyPose | null };

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

/** the boats as a snapshot carries them (sim/agent-wire.ts): the poses changed since the session's last snapshot
 * (moored ones are sent once), the river's clock (s) and day */
export interface BoatsWire { poses: BoatPose[]; elapsed: number; day: number }

/** what the presentation draws of the boats (view/boats.ts): their poses at the last two ticks, the time and day
 * (sim/boat-traffic.ts BoatTraffic) */
export interface BoatView {
  readonly poses: readonly BoatPose[];
  readonly previous: readonly BoatPose[];
  readonly elapsed: number;
  readonly day: number;
}
