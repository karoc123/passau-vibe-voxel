// Road traffic far off as flow: on every road cars at hashed places in its lanes, all moving on at the road's pace, a
// pure function of the roads, the hour and the world clock. The page draws them beyond the agents' circle; the host
// puts each car it spawns where a flow car is (its lane, place, look), so a road coming into a circle gets its agents
// where the page drew its flow.
import { hash } from '../core/num';
import { trafficType } from './vehicles';
import type { VehicleId } from './contract/ids';
import type { Road } from './types';

export const CARS_PER_LANE_KM = 9;
export const CAR_COLOURS = ['#f0f0ee', '#e9e9e7', '#1c1c1e', '#2a2c30', '#8e9399', '#b9bcc0', '#5d6670', '#9b2a24', '#24467a', '#3d5a3a', '#c9b48e', '#6e1f2a'];
export const BUS_COLOUR = '#f2c230';
// a flow car's speed against the road's: about an agent's free speed less its waits
export const PACE = 0.8;

/** the share of the most cars the streets hold at hour: the commute to work and home, a lunch hump, little at night */
export function carsAt(hour: number) {
  const hh = ((hour % 24) + 24) % 24, bell = (c: number, w: number) => Math.exp(-(((hh - c) / w) ** 2));
  return Math.min(1, 0.18 + 0.55 * bell(8, 2.2) + 0.5 * bell(17, 2.6) + 0.45 * bell(13, 5));
}

/** one flow car: its lane, its front's place along the road (m), what it is */
export interface FlowCar { lane: number; s: number; vt?: VehicleId; bus: boolean; col: string }

export class Flow {
  // each road's flow cars at a density of 1 (busier classes more: the agents are spawned by L lanes c)
  private readonly k: Float64Array;

  constructor(private readonly roads: readonly Road[]) {
    let w = 0, lk = 0;
    for (const e of roads) { w += e.L * e.lanes * e.c; lk += e.L * e.lanes; }
    const mean = w / Math.max(lk, 1e-9);
    this.k = Float64Array.from(roads, (e) => e.L * e.lanes * CARS_PER_LANE_KM / 1000 * e.c / mean);
  }

  /** how many flow cars road i has at density d */
  count(i: number, d: number) { return Math.floor(this.k[i] * d + hash(i * 3 + 1)); }

  /** the j-th of road i's n flow cars at world time t (s) */
  car(i: number, j: number, n: number, t: number, out: FlowCar): FlowCar {
    const e = this.roads[i], lanes = e.lanes, lane = j % lanes, inLane = Math.ceil((n - lane) / lanes), m = (j / lanes) | 0;
    const u = (m + 0.5 + 0.5 * (hash(i * 977 + j * 13 + 5) - 0.5)) / inLane * e.L + e.v * PACE * t;
    const h = hash(i * 131 + j * 7 + 3), bus = e.c >= 2 && h < 0.06;
    out.lane = lane;
    out.s = ((u % e.L) + e.L) % e.L;
    out.bus = bus;
    out.vt = bus ? undefined : trafficType(i * 64 + j);
    out.col = bus ? BUS_COLOUR : CAR_COLOURS[(hash(i * 71 + j * 17 + 9) * CAR_COLOURS.length) | 0];
    return out;
  }
}
