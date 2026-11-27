// What the world sim publishes to a client after an update (the snapshot, ADR 0008; its types, plain
// data: sim/contract/snapshot.ts). It crosses to the page from a Web Worker or over a socket as it is, its numbers
// rounded to what is drawn (sim/agent-wire.ts); the gates check that (CloneLink). The client's copy of the traffic it is drawn from: client/sim-client.ts
// TrafficMirror.
//   takeSnapshot(sim, player, since)   the sim side (sim/server/sim-server.ts Session): the traffic's agents as they
//                                      are after the update (enough for the client's own path maths: Traffic.carPose,
//                                      personPoint), the bodies' drawn poses, boats, the avatars, the
//                                      crafts (their cores' state), the events since (the crafts' and the drivers'
//                                      among them), the session's player's reads (id, seat, car, results, ack);
//                                      what is far from the player left out (its sight: interest.ts), what the
//                                      session holds already of the agents, bodies and avatars too (wire)
// No three.js, no DOM (tools/core-deps.mjs).
import type { Car } from '../types';
import type { BodyWire, CarState, CarWire, PersonWire } from '../contract/agents';
import { AgentWire, round, wireBody, wireCarBody, wireCore, wirePose } from '../agent-wire';
import type { CommandResult } from '../contract/commands';
import type { PlayerId } from '../contract/ids';
import type { Ack, AvatarWire, CraftState, EditNote, Snapshot } from '../contract/snapshot';
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
  detachedPose: c.detachedPose && wirePose(c.detachedPose), shift: c.shift, turn: c.turn }) satisfies Every<CarState>;

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
  for (const c of T.detachedCars) if (!S || S.car(c.id, i++)) { const w = wire.detachedCar(carState(c)); if (w) detached.push(w); }
  i = 0;
  for (const p of T.people) if (!S || S.person(p.id, i++)) { const w = wire.person(p, tick); if (w) people.push(w); }
  for (const p of T.riders) if (!S || S.person(p.id, i++)) { const w = wire.person(p, tick); if (w) riders.push(w); }
  const boats = T.boats && wire.boatsOf(T.boats);
  const bodies: [number, BodyWire][] = [];
  if (B?.drawState) for (const c of T.roadVehicles()) {
    if (S && !S.has('car', c.id)) continue;
    const d = B.drawState(c), w = d && wire.body(c.id, wireBody(d), tick);
    if (w) bodies.push([c.id, w]);
  }
  const avatars: AvatarWire[] = [];
  for (const [id, player] of sim.avatars) {
    const w = sim.players.get(player)?.walk, a = w && (!S || S.sees('avatar', id, w.pose.x, w.pose.z)) && wire.avatar({ id, player, pose: w.pose, prev: w.prev });
    if (a) avatars.push(a);
  }
  const drivers: [number, PlayerId][] = [];
  for (const id of sim.players.keys()) {
    const seat = sim.seat(id);
    if (seat?.role === 'driver' && (!S || S.has('car', seat.entity.id))) drivers.push([seat.entity.id, id]);
  }
  const gone = wire.done();
  const crafts: CraftState[] = [];
  // (a core of its type's state: sim/craft/cores.ts asserts the contract's are the cores')
  for (const c of sim.crafts.values()) {
    if (c.placed && (!S || S.sees('craft', c.id, c.core.pose.x, c.core.pose.z)))
      crafts.push({ id: c.id, type: c.type, pilot: c.pilot, placed: c.placed, core: wireCore(c.core.save()) } as CraftState);
  }
  const passengers: [kind: 'car' | 'craft', id: number, player: PlayerId, seat: number][] = [];
  for (const [id, P] of sim.players) {
    const s = P.seat?.role === 'passenger' ? P.seat : null, e = s?.entity;
    if (s && (e?.kind === 'car' || e?.kind === 'craft') && sim.entities.exists(e) && (!S || S.has(e.kind, e.id))) passengers.push([e.kind, e.id, id, s.index]);
  }
  let events = sim.eventsSince(since);
  if (S) { events = events.filter((e) => S.event(e)); S.done(); }
  // (rounded: the camera follows the body drawn, the page takes from these only where the fallen are cleared and the
  // speed shown in whole km/h; every tick's 15 places did not deflate)
  const d = sim.driverSnapshot(player), driver = d && { ...d, pose: wirePose(d.pose), kmh: round(d.kmh, 10), ...(d.body ? { body: wireCarBody(d.body) } : {}) };
  return {
    tick: sim.tick, t: T.t, hour: sim.timeOfDay.hour, day: T.day,
    cars, detached, people, riders, gone,
    bodies,
    boats,
    avatars, drivers, passengers, crafts, events,
    player: wire.player({ id: player, seat: sim.seat(player), driver, results, ack: ack && { ...ack } }),
    edits,
  };
}
