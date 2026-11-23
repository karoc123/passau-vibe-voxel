// What the world sim publishes to a client after an update (docs/plans/local-server.md: the snapshot), and the
// client's copy of the traffic it is drawn from (TrafficMirror). Plain data, structured-cloneable: it crosses to the
// page from a Web Worker as it is (later, quantised, to a network client).
//   takeSnapshot(sim, player, since)   the sim side (sim/sim-server.ts): the traffic's agents as they are after the
//                                      update (enough for the client's own path maths: Traffic.carPose, personPoint),
//                                      the bodies' drawn poses, trains, boats, the walked people, the crafts (their
//                                      cores' state), the events since, the player's reads (seat, car, notes, the
//                                      craft's events)
//   TrafficMirror                      the client side: a Traffic of its own over the same TrafficData, never ticked,
//                                      its agents set from each snapshot, one object per id (the drawn fields, the
//                                      nav's ride carry over); what view/life.ts draws (TrafficView)
// No three.js, no DOM (tools/core-deps.mjs).
import type { DriveNote, DriverSnapshot } from '../physics/rapier/player-car';
import type { BoatView } from './boat-traffic';
import { saveState } from './craft/core-state';
import type { CraftType } from './craft/cores';
import { STEP, Traffic, type BodyDraw, type Ground } from './traffic';
import type { TrainState } from './train-traffic';
import type { Car, Person, RoadPose, TrafficData, WalkPose } from './types';
import type { CommandResult, TrafficView } from './sim-client';
import type { CraftId, PlayerId, Seat, SimEvent, WorldSim } from './world-sim';
import type { Region, LiveNode } from '../core/live-edits';

// what a client's path maths and drawing read of a car, a person
const CAR_KEYS = ['id', 'e', 'lane', 's', 'ds', 'off', 'dOff', 'prev', 'prevOff', 'prev2', 'prev2Off', 'next', 'next2', 'len', 'bus',
  'vt', 'col', 'brake', 'v', 'wait', 'detachedPose'] as const;
const PERSON_KEYS = ['id', 'e', 'dir', 's', 'v', 'lat', 'ph', 'wait', 'col', 'bike'] as const;
export type CarState = Pick<Car, (typeof CAR_KEYS)[number]>;
export type PersonState = Pick<Person, (typeof PERSON_KEYS)[number]>;

/** a craft put down: what its shell or the page's drawing reads (its core's state: core-state.ts) */
export interface CraftState { id: CraftId; type: CraftType; pilot: PlayerId | null; placed: boolean; core: Record<string, unknown> }

/** a level-1 node edited (its columns now) or given its files again (null) since the last snapshot (a worker's: the
 * page's live edits follow the world's) */
export interface EditNote { tx: number; ty: number; node: LiveNode | null; region: Region }

export interface Snapshot {
  tick: number;
  /** s since the last tick: how far between the last two to draw */
  acc: number;
  /** the world clock (the signals) and day */
  t: number;
  day: number;
  active: { x: number; z: number } | null;
  cars: CarState[];
  detached: CarState[];
  people: PersonState[];
  riders: PersonState[];
  /** the cars with a body (or its fade), by car id */
  bodies: [number, BodyDraw][];
  trains: TrainState[];
  boats: BoatView | null;
  /** the people walked by players: their pose, by person id */
  walked: [number, WalkPose][];
  /** the crafts put down, piloted or left */
  crafts: CraftState[];
  /** the events of the ticks after the last snapshot's */
  events: SimEvent[];
  /** the player's reads; notes, craftEvents and results since the last snapshot */
  player: { seat: Seat | null; driver: DriverSnapshot | null; notes: DriveNote[]; craftEvents: unknown[]; results: CommandResult[] };
  edits: EditNote[];
}

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]) => {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = o[k];
  return out;
};

/** the sim's state after its update for player; since: the tick of the player's last snapshot (its events after it);
 * results: the player's command outcomes since; edits: the nodes changed since */
export function takeSnapshot(sim: WorldSim, player: PlayerId, since: number, results: CommandResult[], edits: EditNote[] = []): Snapshot {
  const T = sim.traffic, B = T.bodies, bodies: [number, BodyDraw][] = [];
  if (B?.drawState) for (const c of T.roadVehicles()) { const d = B.drawState(c); if (d) bodies.push([c.id, d]); }
  const walked: [number, WalkPose][] = [];
  for (const p of T.people) { const w = sim.walkedPose(p.id); if (w) walked.push([p.id, { ...w }]); }
  const boats = T.boats, crafts: CraftState[] = [];
  for (const c of sim.crafts.values()) if (c.placed) crafts.push({ id: c.id, type: c.type, pilot: c.pilot, placed: c.placed, core: saveState(c.core) });
  return {
    tick: sim.tick, acc: T.acc, t: T.t, day: T.day, active: T.active && { x: T.active.x, z: T.active.z },
    cars: T.cars.map((c) => pick(c, CAR_KEYS)), detached: T.detachedCars.map((c) => pick(c, CAR_KEYS)),
    people: T.people.map((p) => pick(p, PERSON_KEYS)), riders: T.riders.map((p) => pick(p, PERSON_KEYS)),
    bodies, trains: T.trains.save(),
    boats: boats && { poses: boats.poses.map((p) => ({ ...p })), previous: boats.previous.map((p) => ({ ...p })), elapsed: boats.elapsed, day: boats.day },
    walked, crafts, events: sim.eventsSince(since).map((e) => ({ ...e, person: pick(e.person, PERSON_KEYS) as Person })),
    player: {
      seat: sim.seat(player), driver: sim.driverSnapshot(player), notes: sim.driverNotes(player),
      craftEvents: sim.craftEvents(player), results,
    },
    edits,
  };
}

const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const lerpAngle = (a: number, b: number, k: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

/** the client's copy of the traffic, set from snapshots: what view/life.ts and the nav read (TrafficView) */
export class TrafficMirror implements TrafficView {
  private readonly T: Traffic;
  private readonly carsById = new Map<number, Car>();
  private readonly peopleById = new Map<number, Person>();
  private readonly draws = new Map<number, BodyDraw>();
  boats: BoatView | null = null;
  /** the people walked by players, by person id */
  readonly walked = new Map<number, WalkPose>();
  readonly bodies = {
    owns: (c: Car) => !!this.draws.get(c.id)?.owns,
    pose: (c: Car, a: number) => this.bodyPose(c, a),
  };

  /** data: a TrafficData of its own (its paths are prepared in place: never the sim's); ground: the page's */
  constructor(data: TrafficData, ground: Ground | null) {
    this.T = new Traffic(data);
    this.T.ground = ground;
  }

  get heads() { return this.T.heads; }
  get peds() { return this.T.peds; }
  get cars() { return this.T.cars; }
  get detachedCars() { return this.T.detachedCars; }
  get people() { return this.T.people; }
  get riders() { return this.T.riders; }
  get active() { return this.T.active; }
  get acc() { return this.T.acc; }
  get trains() { return this.T.trains; }
  get ground() { return this.T.ground; }
  carPose: Traffic['carPose'] = (c, s, off, out) => this.T.carPose(c, s, off, out);
  pathPoint: Traffic['pathPoint'] = (c, s, out, off) => this.T.pathPoint(c, s, out, off);
  personPoint: Traffic['personPoint'] = (p, ds, out) => this.T.personPoint(p, ds, out);
  signal: Traffic['signal'] = (ctrl, axis) => this.T.signal(ctrl, axis);
  roadVehicles = () => this.T.roadVehicles();

  /** the snapshot's agents in place of the last (one object per id); its events with the people they name as drawn
   * here (a person fallen is gone from the snapshot's crowd, not yet from this) */
  apply(s: Snapshot): SimEvent[] {
    const T = this.T;
    const events = s.events.map((e) => ({ ...e, person: this.peopleById.get(e.person.id) ?? e.person }));
    T.acc = s.acc; T.t = s.t; T.day = s.day;
    // (a new object only when it moves: the signal heads are placed again then)
    if (!s.active) T.active = null;
    else if (!T.active || T.active.x !== s.active.x || T.active.z !== s.active.z) T.active = s.active;
    const cars = (list: CarState[], into: Car[], seen: Set<number>) => {
      into.length = 0;
      for (const st of list) {
        let c = this.carsById.get(st.id);
        if (!c) this.carsById.set(st.id, c = { kind: 'car' } as Car);
        Object.assign(c, st);
        into.push(c);
        seen.add(st.id);
      }
    };
    const seenCars = new Set<number>();
    cars(s.cars, T.cars, seenCars);
    cars(s.detached, T.detachedCars, seenCars);
    for (const id of this.carsById.keys()) if (!seenCars.has(id)) this.carsById.delete(id);
    const seenPeople = new Set<number>();
    const people = (list: PersonState[]) => list.map((st) => {
      let p = this.peopleById.get(st.id);
      if (!p) this.peopleById.set(st.id, p = { kind: 'person' } as Person);
      Object.assign(p, st);
      seenPeople.add(st.id);
      return p;
    });
    T.people = people(s.people);
    T.riders = people(s.riders);
    for (const id of this.peopleById.keys()) if (!seenPeople.has(id)) this.peopleById.delete(id);
    this.draws.clear();
    for (const [id, d] of s.bodies) this.draws.set(id, d);
    T.trains.load(s.trains);
    this.boats = s.boats;
    this.walked.clear();
    for (const [id, w] of s.walked) this.walked.set(id, w);
    return events;
  }

  // as LifePhysics.pose: a parked car or a wreck where it is, a body between its last two drawn poses, the fade back
  // onto its path blended out
  private bodyPose(c: Car, a: number) {
    const d = this.draws.get(c.id);
    if (c.detachedPose) put(c, c.detachedPose);
    if (!d) return;
    if (d.p0 && d.p1) {
      const p = d.p0, q = d.p1, l = (u: number, v: number) => u + (v - u) * a;
      put(c, { x: l(p.x, q.x), y: l(p.y, q.y), z: l(p.z, q.z), h: lerpAngle(p.h, q.h, a), pitch: lerpAngle(p.pitch, q.pitch, a), roll: lerpAngle(p.roll, q.roll, a) });
    }
    const f = d.fade;
    if (f && c.rp) {
      const k = 1 - smooth01((f.t + (a - 1) * STEP) / f.dur);
      c.rp.x += f.dx * k; c.rp.y += f.dy * k; c.rp.z += f.dz * k;
      c.rh = (c.rh ?? 0) + f.dh * k;
      if (!d.body) c.roll = (c.roll ?? 0) * (1 - k);
    }
  }
}

function put(c: Car, p: RoadPose) {
  const rp = (c.rp ??= { x: p.x, y: p.y, z: p.z });
  rp.x = p.x; rp.y = p.y; rp.z = p.z;
  c.rh = p.h; c.pitch = p.pitch; c.roll = p.roll;
}
