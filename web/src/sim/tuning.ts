// The world's tuning: every number the motion laws and the car physics read, in one read-only value (ADR 0007). No
// three.js, no DOM, no Rapier (tools/core-deps.mjs). The defaults stay next to the code they tune and are frozen there;
// this gathers them. Each core and constructor takes its part (default: DEFAULT_TUNING's), and nothing changes it at
// run time: one world per server (ADR 0008), so the point is explicit passing, not several instances.
// - ride: the cars' ride (sim/vehicles.ts RIDE): createVehicle/createWheels (physics/rapier/vehicle.ts), RapierCar,
//   LifePhysics. A vehicle type's own differences (CarBuild tune) stay in the catalog, resolved at creation (rideOf).
// - boat: the speedboat (sim/craft/boat-motion.ts BOAT): BoatMotion, findSpawn
// - plane, jet, fighter: the floatplane, the jet and the combat plane (sim/craft/plane-flight.ts PLANE, JET, FIGHTER): PlaneFlight
// - craft: the helicopter, hovercraft and paraglider (sim/craft/craft-motion.ts CRAFT): CraftMotion
// - drone: the FPV drone (sim/craft/fpv-flight.ts DRONE): FpvFlight, DroneCore
// - presence: how long the world keeps an edit, or a vehicle a player left, that no player is near (PRESENCE below,
//   the one default kept here: its code, sim/edit-keeper.ts, is the domain's): WorldSim, EditKeeper, Presence
// - walk: how far a client's walk may move the person it walks as (sim/walk-bounds.ts WALK_BOUNDS): WorldSim
// - health: each type's health and what harms it (sim/health.ts HEALTH): WorldSim
// - stands: where placed vehicles are stocked and when they refill (STANDS below, kept here as presence: its code,
//   sim/stands.ts, is the domain's): Stands
// - fuel: how long each vehicle's tank lasts (sim/tank.ts FUEL): the cores, WorldSim (a car's)
// - npc: an enemy's own numbers (NPC below, kept here as stands: its code, sim/npc-mind.ts, is the domain's): WorldSim
// - lookout: a lookout's (LOOKOUT below, likewise): WorldSim
// - camps: when an enemy camp is manned, how big its squad, when it is refilled (CAMPS below, likewise): Camps
// A tool that varies tuning builds a copy ({ ...RIDE, stiffness: 40 }) and passes it, as tools/rapier-car.mjs --set
// and tools/plane.mjs --set do.
import { frozen } from '../core/frozen';
import { RIDE, type RideTuning } from './vehicles';
import { BOAT, type BoatTuning } from './craft/boat-motion';
import { FIGHTER, JET, PLANE, type PlaneConfig } from './craft/plane-flight';
import { CRAFT, type CraftTuning } from './craft/craft-motion';
import { DRONE, type DroneTuning } from './craft/fpv-flight';
import { WALK_BOUNDS, type WalkBounds } from './walk-bounds';
import { HEALTH, type HealthTuning } from './health';
import { FUEL, type FuelTuning } from './tank';

// radius: m from a focus to the node's square (map metres; a vehicle's place) within which an edit is kept; after: s of
// world time with no focus that near before it is dropped
export interface PresenceTuning { readonly radius: number; readonly after: number }
export const PRESENCE: PresenceTuning = frozen({ radius: 600, after: 120 });

/** wake: m from a player within which a stand is stocked; keep: m past wake an untouched vehicle stays; refill: s after
 * its vehicle was used that a stand is stocked again; unseen: m no player may be within for that (a vehicle appearing
 * in front of someone would look like a cheat); giveUp: s a block's nodes may take to come in before it is left bare */
interface StandTuning { readonly wake: number; readonly keep: number; readonly refill: number; readonly unseen: number; readonly giveUp: number }
// The wake radius is the cars' send radius (sim/server/interest.ts), so a stand stocked is one a player can be sent.
const STANDS: StandTuning = frozen({ wake: 400, keep: 120, refill: 300, unseen: 150, giveUp: 20 });

/** an enemy's own numbers, each NPC's (a lookout's are its own): sight: m within which it notices a player (on foot:
 * their chest; in a vehicle: its body's middle);
 * react: s before its first shot at one; burst: shots in a row, pause: s between bursts; spread: rad its aim strays
 * close by, spreadPerM: what each metre adds; leash: m from its post it follows or searches at most; hear: m within
 * which a shot or a blast sends it to look */
export interface NpcTuning {
  readonly sight: number; readonly react: number; readonly burst: number; readonly pause: number;
  readonly spread: number; readonly spreadPerM: number; readonly leash: number; readonly hear: number;
}
// (a body 0.6 m wide at 20 m is ±0.015 rad: about one shot in three meets it. A leash keeps a camp a place: without, a
// player draws its squad across the map. The MG reaches 300 m: one firing past the sight is heard)
const NPC: NpcTuning = frozen({ sight: 60, react: 0.6, burst: 3, pause: 0.9, spread: 0.01, spreadPerM: 0.0016, leash: 120, hear: 150 });
// A lookout is air defence's first step (owner 2026-11-27): an NPC with a long sight and a steady aim at a high place.
// (The NPC's spread misses a helicopter at 150 m nearly always; this one strays up to ~2.7 m there, so about half its
// shots land: a helicopter 20 s in its sight 150 m off loses about half its health, the owner's starting point. Its
// react is the warning, time to turn away before the first burst. It never leaves its place: no leash)
const LOOKOUT: NpcTuning = frozen({ sight: 250, react: 2, burst: 4, pause: 2, spread: 0.006, spreadPerM: 0.00008, leash: 0, hear: 150 });

/** wake: m from a player within which a camp is manned; sleep: m no player may be within for its NPCs to be taken
 * away (their number kept); unseen: m no player may be within for one to be put down; refill: s after its first loss
 * that a camp is at full strength again; squad: its size by the players within wake (1, 2, ...; more: the last);
 * loop: m, the half side of its patrol's square */
export interface CampTuning {
  readonly wake: number; readonly sleep: number; readonly unseen: number; readonly refill: number;
  readonly squad: readonly number[]; readonly loop: number;
}
// (alone a camp must stay winnable; clearing one should pay off longer than taking a vehicle, whose stand refills in 300 s)
const CAMPS: CampTuning = frozen({ wake: 300, sleep: 400, unseen: 200, refill: 600, squad: frozen([2, 3, 4, 4]), loop: 8 });

export interface Tuning {
  readonly ride: RideTuning;
  readonly boat: BoatTuning;
  readonly plane: PlaneConfig;
  readonly jet: PlaneConfig;
  readonly fighter: PlaneConfig;
  readonly craft: CraftTuning;
  readonly drone: DroneTuning;
  readonly presence: PresenceTuning;
  readonly walk: WalkBounds;
  readonly health: HealthTuning;
  readonly stands: StandTuning;
  readonly fuel: FuelTuning;
  readonly npc: NpcTuning;
  readonly lookout: NpcTuning;
  readonly camps: CampTuning;
}

/** the parts the page runs as the host does, so the host sends them in its hello: the crafts' motion laws and tanks
 * (a mirror's and a prediction's cores are made with them) and the cars' ride and tank (the driver's own car run
 * ahead). Not the host's own (presence, walk, health, stands, npc, lookout, camps): they would only lengthen every hello */
export type ClientTuning = Pick<Tuning, 'ride' | 'boat' | 'plane' | 'jet' | 'fighter' | 'craft' | 'drone' | 'fuel'>;

export const DEFAULT_TUNING: Tuning = frozen({ ride: RIDE, boat: BOAT, plane: PLANE, jet: JET, fighter: FIGHTER, craft: CRAFT, drone: DRONE,
  presence: PRESENCE, walk: WALK_BOUNDS, health: HEALTH, stands: STANDS, fuel: FUEL,
  npc: NPC, lookout: LOOKOUT, camps: CAMPS });

