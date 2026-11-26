import type { Path, PathData } from './path';
import type { CarState, Person } from './contract/agents';

interface SignalRef { ctrl: number; axis: number }
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

interface PedData extends PathData { a: number; b: number; w: number; x?: SignalRef; side?: number; bk?: number }
export interface PedEdge extends PedData, Path { i: number }

// a railway track and the routes on it (view/trains.ts)
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
}

// a car of the traffic: what a snapshot carries of it (the contract's CarState: contract/agents.ts) and the traffic's own
export interface Car extends Blocked, CarState {
  kind: 'car';
  lcTo?: number;
  v0f: number;
  ghost: number;
  boxNode: number;
  boxFrom: number;
  boxTo: number;
  boxLane: number;
  boxT: number;
  boxTurn: number;
  geo: { px: number; py: number; cx: number; cy: number; z: number; fx: number; fy: number };
  block: { o: Car; gap: number } | null;
}

export type Agent = Car;
export type Rideable = Car | Person;
export type Kind = 'car' | 'person';
