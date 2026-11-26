// What the world sim publishes to a client after an update (the snapshot, ADR 0008; its types, plain
// data: sim/contract/snapshot.ts). It crosses to the page from a Web Worker or over a socket as it is, its numbers
// rounded to what is drawn (sim/agent-wire.ts); the gates check that (CloneLink). The client's copy of the traffic it is drawn from: client/sim-client.ts
// TrafficMirror.
//   takeSnapshot(sim, player, since)   the sim side (sim/server/sim-server.ts Session): the traffic's agents as they
//                                      are after the update (enough for the client's own path maths: Traffic.carPose,
//                                      personPoint), the bodies' drawn poses, trains, boats, the walked people, the avatars, the
//                                      crafts (their cores' state), the events since (the crafts' and the drivers'
//                                      among them), the session's player's reads (id, seat, car, results, ack);
//                                      what is far from the player left out (its sight: interest.ts)
// No three.js, no DOM (tools/core-deps.mjs).
import type { Car } from '../types';
import type { BodyDraw, CarState, CarWire, PersonWire, TrainWire } from '../contract/agents';
import { AgentWire, round, wireBody, wirePose } from '../agent-wire';
import type { CommandResult } from '../contract/commands';
import type { PlayerId } from '../contract/ids';
import type { WalkPose } from '../contract/pose';
import type { Ack, AvatarState, CraftState, EditNote, Snapshot } from '../contract/snapshot';
import type { WorldSim } from '../world-sim';
import type { Sight } from './interest';

// what a client's path maths and drawing read of a car left out of the traffic (the contract's CarState, which Car
// extends): every key, an optional one undefined too (a car's object is reused by id: TrafficMirror apply).
// Object literals, not a copy by a list of keys: an object built key by key from a list (its optional keys undefined)
// is several times slower to make and to read (measured in A11: 0.7 ms a frame of the mirror's apply)
type Every<T> = { [K in keyof Required<T>]: T[K] };
const carState = (c: Car) => ({ id: c.id, e: c.e, lane: c.lane, s: round(c.s, 100), ds: round(c.ds, 100), off: round(c.off, 100),
  dOff: round(c.dOff, 100), prev: c.prev, prevOff: round(c.prevOff, 100), prev2: c.prev2, prev2Off: c.prev2Off, next: c.next,
  next2: c.next2, len: c.len, bus: c.bus, vt: c.vt, col: c.col, brake: c.brake, v: round(c.v, 100), wait: round(c.wait, 100),
  detachedPose: c.detachedPose && wirePose(c.detachedPose) }) satisfies Every<CarState>;

/** the sim's state after its update for a session of player; since: the tick of the session's last snapshot (its events
 * after it); results: the player's command outcomes since; edits: the nodes changed since; ack: the session's last seat
 * input taken; sight: which agents, bodies, crafts, avatars and events the session is sent (null: all); wire: what the
 * session was sent of the cars and people (none: they are sent whole) */
export function takeSnapshot(sim: WorldSim, player: PlayerId, since: number, results: CommandResult[], edits: EditNote[] = [], ack: Ack | null = null,
  sight: Sight | null = null, wire = new AgentWire()): Snapshot {
  const T = sim.traffic, B = T.bodies, S = sight?.look(sim, player) ? sight : null;
  const cars: CarWire[] = [], detached: CarState[] = [], people: PersonWire[] = [], riders: PersonWire[] = [];
  let i = 0;
  const tick = sim.tick;
  for (const c of T.cars) if (!S || S.car(c.id, i++)) { const w = wire.car(c, tick); if (w) cars.push(w); }
  for (const c of T.detachedCars) if (!S || S.car(c.id, i++)) detached.push(carState(c));
  i = 0;
  for (const p of T.people) if (!S || S.person(p.id, i++)) { const w = wire.person(p, tick); if (w) people.push(w); }
  for (const p of T.riders) if (!S || S.person(p.id, i++)) { const w = wire.person(p, tick); if (w) riders.push(w); }
  const trains: TrainWire[] = [];
  for (const t of T.trains.save()) { const w = wire.train(t, tick); if (w) trains.push(w); }
  const boats = T.boats && wire.boatsOf(T.boats);
  const gone = wire.done();
  const bodies: [number, BodyDraw][] = [];
  if (B?.drawState) for (const c of T.roadVehicles()) {
    if (S && !S.has('car', c.id)) continue;
    const d = B.drawState(c);
    if (d) bodies.push([c.id, wireBody(d)]);
  }
  const walked: [number, WalkPose][] = [];
  for (const p of T.people) { const w = (!S || S.has('person', p.id)) && sim.walkedPose(p.id); if (w) walked.push([p.id, { ...w }]); }
  const avatars: AvatarState[] = [];
  for (const [id, player] of sim.avatars) {
    const w = sim.players.get(player)?.walk;
    if (w && (!S || S.sees('avatar', id, w.pose.x, w.pose.z))) avatars.push({ id, player, pose: { ...w.pose }, prev: { ...w.prev } });
  }
  const drivers: [number, PlayerId][] = [];
  for (const id of sim.players.keys()) {
    const seat = sim.seat(id);
    if (seat?.role === 'driver' && (!S || S.has('car', seat.entity.id))) drivers.push([seat.entity.id, id]);
  }
  const crafts: CraftState[] = [];
  // (a core of its type's state: sim/craft/cores.ts asserts the contract's are the cores')
  for (const c of sim.crafts.values()) {
    if (c.placed && (!S || S.sees('craft', c.id, c.core.pose.x, c.core.pose.z)))
      crafts.push({ id: c.id, type: c.type, pilot: c.pilot, placed: c.placed, core: c.core.save() } as CraftState);
  }
  let events = sim.eventsSince(since);
  if (S) { events = events.filter((e) => S.event(e)); S.done(); }
  return {
    tick: sim.tick, t: T.t, hour: sim.timeOfDay.hour, day: T.day,
    cars, detached, people, riders, gone,
    bodies, trains,
    boats,
    walked, avatars, drivers, crafts, events,
    player: { id: player, seat: sim.seat(player), driver: sim.driverSnapshot(player), results, ack: ack && { ...ack } },
    edits,
  };
}
