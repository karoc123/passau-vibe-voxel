import type { CraftType, VehicleId } from '../sim/contract/ids';
import { CRAFT_SCALE } from '../sim/craft/craft-motion';
import { SEATS } from '../sim/seats';

// Where a passenger sits in each vehicle's look: the hips' point in its frame (x to its left, y up from its origin, z
// ahead, metres as drawn: a scaled look's numbers times its scale) and how far forward the legs reach from hanging
// (rad). Read off the looks (sim/vehicles.ts models, view/crafts/): rows across the cabin from the front, the
// driver's place left free. A seat index past a table's end sits on its last row's place.

/** a passenger's seat in a vehicle's frame */
export interface SeatPlace { x: number; y: number; z: number; legs: number }

const SIT = 1.35;
// rows of seats at heights y, across at xs, from z0 back by dz
const rows = (n: number, xs: readonly number[], y: number, z0: number, dz: number, legs = SIT): SeatPlace[] =>
  Array.from({ length: n }, (_, i) => ({ x: xs[i % xs.length], y, z: z0 - Math.floor(i / xs.length) * dz, legs }));
const at = (x: number, y: number, z: number, legs = SIT): SeatPlace => ({ x, y, z, legs });
const scaled = (s: number, p: SeatPlace[]) => p.map((q) => ({ ...q, x: q.x * s, y: q.y * s, z: q.z * s }));

const CARS: Record<VehicleId, SeatPlace[]> = {
  car: [at(-0.4, 0.55, 0.15), at(0.4, 0.55, -0.85), at(-0.4, 0.55, -0.85)],
  coupe: [at(-0.38, 0.25, -0.5)],
  van: [at(0, 0.9, 1.4), at(-0.55, 0.9, 1.4)],
  pickup: [at(-0.4, 0.6, 0.6)],
  // (four across behind the driver, the rows over a 12 m bus: one of another length stretches them with it)
  bus: rows(SEATS.car.bus.length - 1, [0.85, 0.4, -0.4, -0.85], 1.0, 3.6, 1.15),
  camper: [at(-0.45, 0.9, 1.9), at(0.45, 0.9, -0.5), at(-0.45, 0.9, -0.5)],
  // (the pillion behind the bike's own rider, the legs down its sides)
  moto: [at(0, 0.88, -0.6, 0.45)],
};

// the hovercraft's cabin: five rows of four between its window pillars, the hips under the window band so that the
// chest and head are in it and under its roof; the helicopter's three behind its door windows, low enough for the head
// to stay under the cabin's roof, the middle one a little back so that the shoulders do not meet
const CRAFTS: Partial<Record<CraftType, SeatPlace[]>> = {
  hovercraft: rows(20, [1.55, 0.85, -0.85, -1.55], 1.0, 3.55, 0.82),
  helicopter: scaled(CRAFT_SCALE.helicopter, [at(0.45, 0.05, 0.3), at(-0.45, 0.05, 0.3), at(0, 0.05, -0.1)]),
};

/** passenger seat index's place in a car of type id or a craft of type, or null: its look has none */
export function seatPlace(kind: 'car' | 'craft', type: string, index: number): SeatPlace | null {
  const t = kind === 'car' ? CARS[type as VehicleId] : CRAFTS[type as CraftType];
  return t?.length ? t[Math.min(index, t.length - 1)] : null;
}
