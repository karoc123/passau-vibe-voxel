// What the world sim publishes to a client after an update (the snapshot, ADR 0008; its types, plain
// data: sim/contract/snapshot.ts). It crosses to the page from a Web Worker as it is (later, quantised, to a network
// client); the gates check that (CloneLink). The client's copy of the traffic it is drawn from: client/sim-client.ts
// TrafficMirror.
//   takeSnapshot(sim, player, since)   the sim side (sim/server/sim-server.ts Session): the traffic's agents as they
//                                      are after the update (enough for the client's own path maths: Traffic.carPose,
//                                      personPoint), the bodies' drawn poses, trains, boats, the walked people, the
//                                      crafts (their cores' state), the events since (the crafts' and the drivers'
//                                      among them), the session's player's reads (id, seat, car, results, ack)
// No three.js, no DOM (tools/core-deps.mjs).
import type { Car } from '../types';
import type { BodyDraw, CarState, Person, PersonState } from '../contract/agents';
import type { CommandResult } from '../contract/commands';
import type { PlayerId } from '../contract/ids';
import type { WalkPose } from '../contract/pose';
import type { Ack, CraftState, EditNote, Snapshot } from '../contract/snapshot';
import type { WorldSim } from '../world-sim';

// what a client's path maths and drawing read of a car, a person (the contract's CarState, PersonState): every key,
// an optional one undefined too (a car's object is reused by id: TrafficMirror apply), with the types Car and Person
// have. Object literals, not a copy by a list of keys: an object built key by key from a list (its optional keys
// undefined) is several times slower to make and to read (measured in A11: 0.7 ms a frame of the mirror's apply)
type Every<T> = { [K in keyof Required<T>]: T[K] };
const carState = (c: Car) => ({ id: c.id, e: c.e, lane: c.lane, s: c.s, ds: c.ds, off: c.off, dOff: c.dOff, prev: c.prev,
  prevOff: c.prevOff, prev2: c.prev2, prev2Off: c.prev2Off, next: c.next, next2: c.next2, len: c.len, bus: c.bus, vt: c.vt,
  col: c.col, brake: c.brake, v: c.v, wait: c.wait, detachedPose: c.detachedPose }) satisfies Every<CarState>;
const personState = (p: Person) => ({ id: p.id, e: p.e, dir: p.dir, s: p.s, v: p.v, lat: p.lat, ph: p.ph, wait: p.wait,
  col: p.col, bike: p.bike }) satisfies Every<PersonState>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type StatesAreTheContracts = [
  Assert<Same<Pick<Car, keyof CarState>, CarState>>,
  Assert<Same<Pick<Person, keyof PersonState>, PersonState>>,
];

/** the sim's state after its update for a session of player; since: the tick of the session's last snapshot (its events
 * after it); results: the player's command outcomes since; edits: the nodes changed since; ack: the session's last seat
 * input taken */
export function takeSnapshot(sim: WorldSim, player: PlayerId, since: number, results: CommandResult[], edits: EditNote[] = [], ack: Ack | null = null): Snapshot {
  const T = sim.traffic, B = T.bodies, bodies: [number, BodyDraw][] = [];
  if (B?.drawState) for (const c of T.roadVehicles()) { const d = B.drawState(c); if (d) bodies.push([c.id, d]); }
  const walked: [number, WalkPose][] = [];
  for (const p of T.people) { const w = sim.walkedPose(p.id); if (w) walked.push([p.id, { ...w }]); }
  const boats = T.boats, crafts: CraftState[] = [];
  // (a core of its type's state: sim/craft/cores.ts asserts the contract's are the cores')
  for (const c of sim.crafts.values()) if (c.placed) crafts.push({ id: c.id, type: c.type, pilot: c.pilot, placed: c.placed, core: c.core.save() } as CraftState);
  return {
    tick: sim.tick, acc: T.acc, t: T.t, hour: sim.timeOfDay.hour, day: T.day, active: T.active && { x: T.active.x, z: T.active.z },
    cars: T.cars.map(carState), detached: T.detachedCars.map(carState),
    people: T.people.map(personState), riders: T.riders.map(personState),
    bodies, trains: T.trains.save(),
    boats: boats && { poses: boats.poses.map((p) => ({ ...p })), previous: boats.previous.map((p) => ({ ...p })), elapsed: boats.elapsed, day: boats.day },
    walked, crafts, events: sim.eventsSince(since),
    player: { id: player, seat: sim.seat(player), driver: sim.driverSnapshot(player), results, ack: ack && { ...ack } },
    edits,
  };
}
