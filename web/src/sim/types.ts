import type { Path, PathData } from './path';
import type { VehicleId } from './vehicles';

// a point in the world (x east, y up, z south: as three.js', without it: the sim runs headless)
export interface Vec3 { x: number; y: number; z: number }

export interface SignalRef { ctrl: number; axis: number }
export interface Controller { x: number; y: number; off: number }

export interface RoadData extends PathData {
  a: number; b: number; w: number;
  lanes: number;
  v: number;
  c: number;
  o0: number;
  sig?: SignalRef & { s: number };
}
export interface Road extends RoadData, Path { i: number; lists: Car[][] }

export interface PedData extends PathData { a: number; b: number; w: number; x?: SignalRef; side?: number; bk?: number }
export interface PedEdge extends PedData, Path { i: number }

// a railway track and the routes on it (sim/trains.ts)
export interface TrainService { ref: string; op: string; stops: number[] }
export interface TrainPathData extends PathData { svc: TrainService[] }

export interface TrafficData {
  roads: RoadData[];
  peds: PedData[];
  ctrls: { x: number; y: number }[];
  heads?: [number, number, number, number, number, number][];
  trains?: TrainPathData[];
  restr?: [number, number, number, string][];
}

// why an agent waits, and for whom: the chains these form are where deadlocks are found and broken
interface Blocked {
  v: number;
  why: string;
  by: Agent | null;
  ignore?: Agent | null;
  ignoreT?: number;
  // its pose: drawn (the presentation's, sim/life.ts), or, out of the traffic (a parked car, a wreck), where it is:
  // the ground point under it and its heading
  rp?: Vec3;
  rh?: number;
}

export interface Car extends Blocked {
  kind: 'car';
  pitch?: number; // drawn nose up (radians) on a ramp (life.ts drawCars)
  roll?: number; // drawn left side up (radians): the driven car on uneven ground (nav/drive.ts)
  id: number;
  detachedPose?: RoadPose; // authoritative pose out of traffic, independent of drawing
  e: number;
  lane: number;
  lcTo?: number;
  s: number;
  off: number;
  len: number;
  bus: boolean;
  vt?: VehicleId; // its type (sim/vehicles.ts; none: the car, or a bus)
  col: string; // its paint ('#rrggbb')
  v0f: number;
  prev: number;
  prevOff: number;
  next: number;
  // the road before prev and the one after next, with prev's offset there (-1, none: life.ts carPoint blends them in
  // when prev or next is shorter than its blend)
  prev2?: number;
  prev2Off?: number;
  next2?: number;
  brake: number;
  wait: number;
  ghost: number;
  ds: number;
  dOff: number;
  boxNode: number;
  boxFrom: number;
  boxTo: number;
  boxLane: number;
  boxT: number;
  boxTurn: number;
  geo: { px: number; py: number; cx: number; cy: number; z: number; fx: number; fy: number };
  block: { o: Car; gap: number } | null;
}

export interface Person {
  kind: 'person';
  e: number;
  dir: number;
  s: number;
  v: number;
  lat: number;
  ph: number;
  wait: boolean;
  col: string; // their shirt ('#rrggbb')
  bike?: boolean;
  rp?: Vec3; // drawn (sim/life.ts)
  rh?: number;
  ctl?: { x: number; y: number; z: number; h: number; moving: boolean };
}

export type Agent = Car;
export type Rideable = Car | Person;
export type Kind = 'car' | 'person';
export interface Pose { x: number; y: number; z: number; h: number }

export interface RoadPose extends Pose { pitch: number; roll: number }
