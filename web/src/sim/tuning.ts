// The world's tuning: every number the motion laws and the car physics read, in one read-only value (ADR 0007). No
// three.js, no DOM, no Rapier (tools/core-deps.mjs). The defaults stay next to the code they tune and are frozen there;
// this gathers them. Each core and constructor takes its part (default: DEFAULT_TUNING's), and nothing changes it at
// run time: one world per server (ADR 0008), so the point is explicit passing, not several instances.
// - ride: the cars' ride (sim/vehicles.ts RIDE): createVehicle/createWheels (physics/rapier/vehicle.ts), RapierCar,
//   LifePhysics. A vehicle type's own differences (CarBuild tune) stay in the catalog, resolved at creation (rideOf).
// - boat: the speedboat (sim/craft/boat-motion.ts BOAT): BoatMotion, findSpawn
// - plane, jet: the floatplane and the jet (sim/craft/plane-flight.ts PLANE, JET): PlaneFlight
// - craft: the helicopter, hovercraft and paraglider (sim/craft/craft-motion.ts CRAFT): CraftMotion
// - edits: how long the world keeps an edit no player is near (sim/edit-keeper.ts EDIT_KEEPING): WorldSim
// - walk: how far a client's walk may move the person it walks as (sim/walk-bounds.ts WALK_BOUNDS): WorldSim
// A tool that varies tuning builds a copy ({ ...RIDE, stiffness: 40 }) and passes it, as tools/rapier-car.mjs --set
// and tools/plane.mjs --set do.
import { frozen } from '../core/frozen';
import { RIDE, type RideTuning } from './vehicles';
import { BOAT, type BoatTuning } from './craft/boat-motion';
import { JET, PLANE, type PlaneConfig } from './craft/plane-flight';
import { CRAFT, type CraftTuning } from './craft/craft-motion';
import { EDIT_KEEPING, type EditKeeping } from './edit-keeper';
import { WALK_BOUNDS, type WalkBounds } from './walk-bounds';

export interface Tuning {
  readonly ride: RideTuning;
  readonly boat: BoatTuning;
  readonly plane: PlaneConfig;
  readonly jet: PlaneConfig;
  readonly craft: CraftTuning;
  readonly edits: EditKeeping;
  readonly walk: WalkBounds;
}

export const DEFAULT_TUNING: Tuning = frozen({ ride: RIDE, boat: BOAT, plane: PLANE, jet: JET, craft: CRAFT, edits: EDIT_KEEPING, walk: WALK_BOUNDS });

