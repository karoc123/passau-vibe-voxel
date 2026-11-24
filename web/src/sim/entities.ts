// The world's entities, one index over the kinds' own stores (docs/plans/entities-and-modes.md section 1): a car
// (Traffic, the road physics), a person (Traffic's crowd and riders, a walked one where its walker puts it), a craft
// (WorldSim.crafts). Each kind keeps its storage and its numbering (Car.id picks the traffic vehicle's type); this
// reads them through one adapter per kind. Read only. No three.js, no DOM (tools/core-deps.mjs).
//   exists(ref)   the entity is in the world
//   pose(ref)     where it is (map metres, heading h: 0 +z, pi/2 +x), or null: gone, or not put down
//   seats(ref)    the seats its model has (the seat table, WorldSim, says who holds them)
import type { Pose } from './types';

/** what an entity is; numbered per kind */
export type EntityKind = 'car' | 'person' | 'craft';
/** an entity of the world: a car (Car.id), a person (Person.id) or a craft (CraftId); the kinds are numbered apart */
export interface EntityRef { kind: EntityKind; id: number }
/** an entity's key in a map ("car:12") */
export const entityKey = (r: EntityRef) => `${r.kind}:${r.id}`;
export const sameEntity = (a: EntityRef | null | undefined, b: EntityRef | null | undefined) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;

/** what a seat's holder does: drives a car, pilots a craft, walks as a person */
export type Role = 'driver' | 'pilot' | 'walker';
/** a seat of an entity's model: its role and which of that role's seats (0: the first) */
export interface SeatSpec { readonly role: Role; readonly index: number }

/** a kind's store, read: what Entities asks of it */
export interface KindCore {
  exists(id: number): boolean;
  pose(id: number): Pose | null;
  seats(id: number): readonly SeatSpec[];
}

export class Entities {
  constructor(private readonly kinds: Readonly<Record<EntityKind, KindCore>>) {}

  exists(ref: EntityRef) { return this.kinds[ref.kind].exists(ref.id); }
  pose(ref: EntityRef): Pose | null { return this.kinds[ref.kind].pose(ref.id); }
  /** its seats ([] once gone) */
  seats(ref: EntityRef): readonly SeatSpec[] { return this.exists(ref) ? this.kinds[ref.kind].seats(ref.id) : []; }
}
