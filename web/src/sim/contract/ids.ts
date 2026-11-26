// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): the ids
// a command, an event or a snapshot names. Types and constants only (tools/core-deps.mjs R5); imports core/ and the
// contract, nothing else (R1).

/** a participant in the world (ADR 0007); the sim numbers none of its own, a host names them (a session's: SimServer
 * connect, a new id when none is given: the page's own) and stamps it on the commands sent through the session */
export type PlayerId = string;

export type CraftId = number;

/** what an entity is; numbered per kind */
export type EntityKind = 'car' | 'person' | 'craft';
/** an entity of the world: a car (Car.id), a person (Person.id) or a craft (CraftId); the kinds are numbered apart */
export interface EntityRef { kind: EntityKind; id: number }

/** what a seat's holder does: drives a car, pilots a craft, walks as a person */
export type Role = 'driver' | 'pilot' | 'walker';

/** a player's place on an entity (ADR 0008: control per seat): one of the seats of its model (sim/entities.ts SEATS).
 * A seat holds at most one player, a player at most one seat (the seat table: WorldSim seat) */
export interface Seat { entity: EntityRef; role: Role; index: number }

/** a road vehicle's type (sim/vehicles.ts VEHICLES: its build, its look) */
export type VehicleId = 'car' | 'coupe' | 'van' | 'pickup' | 'bus' | 'moto' | 'camper';

/** a player craft's type (sim/craft/cores.ts CORES: the core WorldSim makes for it) */
export type CraftType = 'boat' | 'hovercraft' | 'helicopter' | 'paraglider' | 'drone' | 'floatplane' | 'jet';
