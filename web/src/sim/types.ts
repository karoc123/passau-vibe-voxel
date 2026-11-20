import type * as THREE from 'three';
import type { Path, PathData } from './path';
import type { TrainPathData } from './trains';

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
  rp?: THREE.Vector3;
  rh?: number;
}

export interface Car extends Blocked {
  kind: 'car';
  pitch?: number; // drawn nose up (radians) on a ramp (life.ts drawCars)
  roll?: number; // drawn left side up (radians): the driven car on uneven ground (drive.prototype.ts)
  id: number;
  e: number;
  lane: number;
  lcTo?: number;
  s: number;
  off: number;
  len: number;
  bus: boolean;
  col: THREE.Color;
  v0f: number;
  prev: number;
  prevOff: number;
  next: number;
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
  col: THREE.Color;
  bike?: boolean;
  rp?: THREE.Vector3;
  rh?: number;
  ctl?: { x: number; y: number; z: number; h: number; moving: boolean };
}

export type Agent = Car;
export type Rideable = Car | Person;
// ('tram' is no longer simulated; it stays in Kind only while nav/nav.ts and nav/ride.ts still name it)
export type Kind = 'car' | 'tram' | 'person';
export interface Pose { x: number; y: number; z: number; h: number }
