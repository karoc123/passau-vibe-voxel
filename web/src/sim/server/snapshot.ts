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

// what a client's path maths and drawing read of a car, a person (the contract's CarState, PersonState: these keys,
// all of them, with the types Car and Person have)
const CAR_KEYS = ['id', 'e', 'lane', 's', 'ds', 'off', 'dOff', 'prev', 'prevOff', 'prev2', 'prev2Off', 'next', 'next2', 'len', 'bus',
  'vt', 'col', 'brake', 'v', 'wait', 'detachedPose'] as const;
const PERSON_KEYS = ['id', 'e', 'dir', 's', 'v', 'lat', 'ph', 'wait', 'col', 'bike'] as const;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type StatesAreTheContracts = [
  Assert<Same<Pick<Car, (typeof CAR_KEYS)[number]>, CarState>>,
  Assert<Same<Pick<Person, (typeof PERSON_KEYS)[number]>, PersonState>>,
];

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]) => {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = o[k];
  return out;
};

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
    tick: sim.tick, acc: T.acc, t: T.t, day: T.day, active: T.active && { x: T.active.x, z: T.active.z },
    cars: T.cars.map((c) => pick(c, CAR_KEYS)), detached: T.detachedCars.map((c) => pick(c, CAR_KEYS)),
    people: T.people.map((p) => pick(p, PERSON_KEYS)), riders: T.riders.map((p) => pick(p, PERSON_KEYS)),
    bodies, trains: T.trains.save(),
    boats: boats && { poses: boats.poses.map((p) => ({ ...p })), previous: boats.previous.map((p) => ({ ...p })), elapsed: boats.elapsed, day: boats.day },
    walked, crafts, events: sim.eventsSince(since),
    player: { id: player, seat: sim.seat(player), driver: sim.driverSnapshot(player), results, ack: ack && { ...ack } },
    edits,
  };
}
