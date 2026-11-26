// The traffic's cars, people and trains as a snapshot carries them (contract/agents.ts CarWire, PersonWire, TrainWire): the sim's end
// (AgentWire, one per session) and the client's (AgentRead), each keeping by id what the other was last sent. The
// client draws each one on from its last sample at the speed sent (reckoned: dead reckoning along its way), so a
// sample is sent only when that drifts: a way changed or one new comes at once, a drift past DRIFT m only on every
// AGENT_TICKS-th tick (10 a second), one past URGENT m (a car stopped short) at once. A car cruising or standing, a person walking a footway, is not sent at all
// between. Over the internet cars and people were ~95 % of a snapshot's bytes. The cars out of the traffic, the bodies
// and the avatars are sent when they change, a body come to rest once (else every shot's bodies and wrecks were sent
// whole every tick for as long as they lay near: 7 bodies were 57 kB/s). No three.js, no DOM.
import type { BoatPose, BoatsWire, BoatView, BodyDraw, BodyPose, CarState, CarWire, PersonState, PersonWire, TrainState, TrainWire } from './contract/agents';
import type { VehicleId } from './contract/ids';
import type { RoadPose, WalkPose } from './contract/pose';
import type { AvatarState, AvatarWire, Snapshot } from './contract/snapshot';
import { PH_RIDE, PH_WALK, STEP } from './road-net';

/** v rounded to 1/k (k a power of ten): cm for lengths, cm/s for speeds; -0 as 0 so JSON writes no sign */
export const round = (v: number, k: number) => Math.round(v * k) / k + 0;
const CM = 100, MM = 1000;
// a quaternion's parts and an angle in rad: 1e-5 turns a body 5 m long by under 0.1 mm
const Q = 1e5, RAD = 1e4;

/** the ticks between the drifts sent (a way changed, one new or gone: at once) */
export const AGENT_TICKS = 3;
/** how far (m) the client's reckoning may drift from the sim before a sample is sent: its own position now, plus its
 * speed's error over the ticks to the next chance. The client blends a correction in, so this is what a car or a
 * person may stray by, never a jump */
export const DRIFT = 0.1;
/** how far (m) it may drift by the next tick before it is sent whatever the tick */
export const URGENT = 0.25;
// the speed's error counts over the ticks until the next sample can go
const AHEAD = AGENT_TICKS * STEP;

/** a car's or person's way position at tick, reckoned from its sample (s at tick at, at v; dir: a person's along their
 * way; wait: standing) */
export const reckon = (s: number, v: number, at: number, tick: number, dir = 1, wait = false) => wait ? s : s + v * dir * (tick - at) * STEP;

interface CarSent {
  gen: number; s: number; v: number; brake: number; tick: number; off: number; e: number; lane: number; prev: number;
  prevOff: number; prev2: number; prev2Off: number; next: number; next2: number; len: number; bus: boolean;
  vt: VehicleId | undefined; col: string;
}
interface PersonSent { gen: number; s: number; tick: number; e: number; dir: number; wait: boolean; v: number; lat: number; col: string }
interface TrainSent { gen: number; s: number; v: number; tick: number; p: number; n: number; express: boolean }

// whether a sample (s, v) is due at tick against the last one sent (h): it drifts past URGENT by the next tick, or past
// DRIFT by the next chance on a tick that is one
const drifts = (h: { s: number; v: number; tick: number }, s: number, v: number, tick: number) => {
  const now = Math.abs(reckon(h.s, h.v, h.tick, tick) - s), dv = Math.abs(v - h.v);
  return now + dv * STEP > URGENT || (tick % AGENT_TICKS === 0 && now + dv * AHEAD > DRIFT);
};

/** how far (m; a quaternion's part, rad) a body's pose may move between two ticks and still be at rest, and stray from
 * the rest pose sent before it is sent again: a car's body standing in a queue jitters by a mm or so */
export const STILL_M = 0.005, STILL_Q = 1e-3;
const still = (a: BodyPose, b: BodyPose) => Math.abs(a.x - b.x) <= STILL_M && Math.abs(a.y - b.y) <= STILL_M && Math.abs(a.z - b.z) <= STILL_M
  && Math.abs(a.ride - b.ride) <= STILL_M && Math.abs(a.qx - b.qx) <= STILL_Q && Math.abs(a.qy - b.qy) <= STILL_Q
  && Math.abs(a.qz - b.qz) <= STILL_Q && Math.abs(a.qw - b.qw) <= STILL_Q && Math.abs((a.lean ?? 0) - (b.lean ?? 0)) <= STILL_Q
  && Math.abs((a.wheelie ?? 0) - (b.wheelie ?? 0)) <= STILL_Q;
interface BodySent { gen: number; key: string; rest: BodyPose | null }

/** what one session was sent of the traffic's cars and people: car and person give each one's wire form against it
 * at tick, or null when the client's reckoning of it holds (all of it when new to the session); the cars out of the
 * traffic, the bodies and the avatars likewise, null when the client's copy holds; done ends the snapshot: the ones
 * not in it forgotten (sent whole when they come back), their ids returned as gone */
export class AgentWire {
  private readonly cars = new Map<number, CarSent>();
  private readonly people = new Map<number, PersonSent>();
  private readonly trains = new Map<number, TrainSent>();
  private readonly boats = new Map<number, { gen: number; pose: BoatPose }>();
  private readonly detached = new Map<number, { gen: number; key: string }>();
  private readonly bodies = new Map<number, BodySent>();
  private readonly avatars = new Map<number, { gen: number; player: string; pose: WalkPose; prev: WalkPose }>();
  private gen = 0;

  /** a car out of the traffic (as sent: sim/server/snapshot.ts carState), or null when unchanged */
  detachedCar(c: CarState): CarState | null {
    const key = JSON.stringify(c), h = this.detached.get(c.id);
    if (h?.key === key) { h.gen = this.gen; return null; }
    this.detached.set(c.id, { gen: this.gen, key });
    return c;
  }

  /** car id's body as drawn (wireBody's), or null when the client's copy holds. One at rest (its last two poses within
   * STILL_*, no fade, no fall) is sent once as standing at its pose, then again only when it strays from it */
  body(id: number, d: BodyDraw): BodyDraw | null {
    const h = this.bodies.get(id), p = d.p1;
    const rest = p && d.p0 && !d.fade && !d.drive?.fall && still(d.p0, p) ? p : null;
    const w = rest ? { ...d, p0: rest } : d;
    // (at rest: what it is besides its pose; else the whole draw)
    const key = rest ? `${d.owns} ${d.body} ${d.drive?.wheelZ}` : JSON.stringify(w);
    if (h && h.key === key && (!rest || (h.rest && still(h.rest, rest)))) { h.gen = this.gen; return null; }
    this.bodies.set(id, { gen: this.gen, key, rest });
    return w;
  }

  /** an avatar (its poses rounded), or null when it stands where it was sent standing; prev left out when it is the
   * pose sent before */
  avatar(a: AvatarState): AvatarWire | null {
    const pose = wireWalk(a.pose), prev = wireWalk(a.prev), h = this.avatars.get(a.id);
    if (h && h.player === a.player) {
      h.gen = this.gen;
      if (sameWalk(h.pose, pose) && sameWalk(h.prev, pose)) return null;
      const w: AvatarWire = sameWalk(prev, h.pose) ? { id: a.id, player: a.player, pose } : { id: a.id, player: a.player, pose, prev };
      h.prev = w.prev ?? h.pose;
      h.pose = pose;
      return w;
    }
    this.avatars.set(a.id, { gen: this.gen, player: a.player, pose, prev });
    return { id: a.id, player: a.player, pose, prev };
  }

  car(c: CarState, tick: number): CarWire | null {
    const s = round(c.s, CM), v = round(c.v, CM), off = round(c.off, CM), prevOff = round(c.prevOff, CM), prev2Off = round(c.prev2Off ?? 0, CM);
    const len = round(c.len, CM), prev2 = c.prev2 ?? -1, next2 = c.next2 ?? -1, h = this.cars.get(c.id);
    const known = h && h.len === len && h.bus === c.bus && h.vt === c.vt && h.col === c.col;
    const way = known && h.e === c.e && h.lane === c.lane && h.prev === c.prev && h.prevOff === prevOff && h.prev2 === prev2
      && h.prev2Off === prev2Off && h.next === c.next && h.next2 === next2;
    const base: CarWire = [c.id, s, v, c.brake];
    if (h && known && way) {
      h.gen = this.gen;
      if (!drifts(h, s, v, tick) && (tick % AGENT_TICKS !== 0 || (h.brake === c.brake && h.off === off))) return null;
      h.s = s; h.v = v; h.brake = c.brake; h.tick = tick;
      if (h.off === off) return base;
      h.off = off;
      return [...base, off];
    }
    this.cars.set(c.id, { gen: this.gen, s, v, brake: c.brake, tick, off, e: c.e, lane: c.lane, prev: c.prev, prevOff, prev2, prev2Off,
      next: c.next, next2, len, bus: c.bus, vt: c.vt, col: c.col });
    const route = [...base, off, c.e, c.lane, c.prev, prevOff, prev2, prev2Off, c.next, next2] as const;
    return known ? [...route] : [...route, len, c.bus ? 1 : 0, c.vt ?? 0, c.col];
  }

  person(p: PersonState, tick: number): PersonWire | null {
    const v = round(p.v, CM), lat = round(p.lat, CM), h = this.people.get(p.id), s = round(p.s, CM);
    const known = h && h.v === v && h.lat === lat && h.col === p.col;
    if (h && known && h.e === p.e && h.dir === p.dir && h.wait === p.wait) {
      h.gen = this.gen;
      if (tick % AGENT_TICKS !== 0 || Math.abs(reckon(h.s, v, h.tick, tick, h.dir, h.wait) - s) <= DRIFT) return null;
      h.s = s; h.tick = tick;
      return [p.id, s];
    }
    this.people.set(p.id, { gen: this.gen, s, tick, e: p.e, dir: p.dir, wait: p.wait, v, lat, col: p.col });
    const way = [p.id, s, p.e, p.dir, p.wait ? 1 : 0] as const;
    return known ? [...way] : [...way, v, lat, round(p.ph, 100), p.col];
  }

  train(t: TrainState, tick: number): TrainWire | null {
    const s = round(t.s, CM), v = round(t.ds / STEP, CM), h = this.trains.get(t.id);
    if (h && h.p === t.p && h.n === t.n && h.express === t.express) {
      h.gen = this.gen;
      if (!drifts(h, s, v, tick)) return null;
      h.s = s; h.v = v; h.tick = tick;
      return [t.id, s, v];
    }
    this.trains.set(t.id, { gen: this.gen, s, v, tick, p: t.p, n: t.n, express: t.express });
    return [t.id, s, v, t.p, t.n, t.express ? 1 : 0];
  }

  /** the boats' poses that changed since the last (rounded: mm, 1e-4 rad) */
  boatsOf(b: BoatView): BoatsWire {
    const poses: BoatPose[] = [];
    for (const p of b.poses) {
      const q = { ...p, x: round(p.x, MM), y: round(p.y, MM), z: round(p.z, MM), heading: round(p.heading, RAD) }, k = boatKey(p), h = this.boats.get(k);
      if (h && sameBoat(h.pose, q)) { h.gen = this.gen; continue; }
      this.boats.set(k, { gen: this.gen, pose: q });
      poses.push(q);
    }
    return { poses, elapsed: round(b.elapsed, MM), day: b.day };
  }

  /** the snapshot's end: the ids of the cars, people, trains, boats, cars out of the traffic, bodies and avatars it no
   * longer holds */
  done(): Snapshot['gone'] {
    const gone: Snapshot['gone'] = [[], [], [], [], [], [], []];
    [this.cars, this.people, this.trains, this.boats, this.detached, this.bodies, this.avatars].forEach((M: Map<number, { gen: number }>, i) => {
      for (const [id, h] of M) if (h.gen !== this.gen) { M.delete(id); gone[i].push(id); }
    });
    this.gen++;
    return gone;
  }
}

const wireWalk = (p: WalkPose): WalkPose => ({ ...p, x: round(p.x, MM), y: round(p.y, MM), z: round(p.z, MM), h: round(p.h, RAD) });
const sameWalk = (a: WalkPose, b: WalkPose) => a.x === b.x && a.y === b.y && a.z === b.z && a.h === b.h && a.moving === b.moving
  && a.arm === b.arm && a.swim === b.swim;

// a boat's id on the wire: a ship's id, -1 - an excursion boat's
const boatKey = (p: BoatPose) => p.kind === 'ship' ? p.id : -1 - p.id;
const sameBoat = (a: BoatPose, b: BoatPose) => a.x === b.x && a.y === b.y && a.z === b.z && a.heading === b.heading && a.len === b.len
  && a.lit === b.lit && a.underway === b.underway;

/** a car or person as the client holds it: its last sample, taken at tick at (the client reckons it on from there) */
export type Sampled<T> = T & { at: number };

/** the client's end: the cars and people a session holds, each snapshot's samples taken into them (AgentWire); L: a
 * road's length (a car's way across onto its next road) */
export class AgentRead {
  private readonly cars = new Map<number, Sampled<CarState>>();
  private readonly people = new Map<number, Sampled<PersonState>>();
  private readonly trains = new Map<number, Sampled<TrainState>>();
  private carList: Sampled<CarState>[] = [];
  private trainList: Sampled<TrainState>[] = [];
  private readonly boats = new Map<number, BoatPose>();
  private boatList: BoatPose[] = [];
  private lists: [Sampled<PersonState>[], Sampled<PersonState>[]] = [[], []];

  constructor(private readonly L: (road: number) => number) {}

  private readonly held = { detached: new Held<CarState>(), bodies: new Held<[number, BodyDraw]>(), avatars: new Held<AvatarState>() };

  /** a new session: nothing of the last one's known */
  clear() {
    this.cars.clear(); this.people.clear(); this.trains.clear(); this.boats.clear();
    this.carList = []; this.lists = [[], []]; this.trainList = []; this.boatList = [];
    for (const h of Object.values(this.held)) h.clear();
  }

  /** the cars out of the traffic, the bodies and the avatars after a snapshot (s: its changed ones and gone) */
  readHeld(s: Pick<Snapshot, 'detached' | 'bodies' | 'avatars' | 'gone'>): { detached: CarState[]; bodies: [number, BodyDraw][]; avatars: AvatarState[] } {
    const H = this.held, A = H.avatars;
    return {
      detached: H.detached.read(s.detached.map((c) => [c.id, c]), s.gone[4]),
      bodies: H.bodies.read(s.bodies.map((b) => [b[0], b]), s.gone[5]),
      // (prev left out: the pose sent before)
      avatars: A.read(s.avatars.map((a) => [a.id, { ...a, prev: a.prev ?? A.get(a.id)?.pose ?? a.pose }]), s.gone[6]),
    };
  }

  /** the cars after the snapshot of tick: its samples (one unknown or cut short is left out: it cannot be drawn) and
   * gone; the list held before when neither changed it */
  readCars(list: CarWire[], gone: readonly number[], tick: number): Sampled<CarState>[] {
    const M = this.cars;
    let changed = false;
    for (const id of gone) changed = M.delete(id) || changed;
    for (const w of list) {
      const id = w[0], s = w[1], v = w[2], o = M.get(id);
      if (w.length < 13 && !o) continue;
      const off = w.length > 4 ? w[4]! : o!.off;
      let c: Sampled<CarState>;
      if (w.length >= 13) {
        const x = w as Extract<CarWire, { length: 13 | 17 }>;
        const st = w.length === 17 ? (w as Extract<CarWire, { length: 17 }>) : null;
        if (!st && !o) continue;
        c = { id, e: x[5], lane: x[6], s, ds: 0, off, dOff: 0, prev: x[7], prevOff: x[8], prev2: x[9], prev2Off: x[10], next: x[11],
          next2: x[12], len: st ? st[13] : o!.len, bus: st ? st[14] === 1 : o!.bus, vt: st ? st[15] || undefined : o!.vt,
          col: st ? st[16] : o!.col, brake: w[3], v, wait: 0, detachedPose: undefined, at: tick };
      } else c = { ...o!, s, off, brake: w[3], v, at: tick };
      // (the way since the last sample: across onto its next road too; the time stood still)
      c.ds = !o ? v * STEP : o.e === c.e ? s - o.s : o.e === c.prev ? s + this.L(o.e) - o.s : 0;
      c.dOff = o && o.e === c.e ? off - o.off : 0;
      c.wait = v < 0.3 ? (o?.wait ?? 0) + (o ? (tick - o.at) * STEP : 0) : 0;
      M.set(id, c);
      changed = true;
    }
    if (changed) this.carList = [...M.values()];
    return this.carList;
  }

  /** the boats after a snapshot (its poses changed, and gone), and as they were after the one before */
  readBoats(w: BoatsWire | null, gone: readonly number[]): BoatView | null {
    if (!w) return null;
    const M = this.boats, previous = this.boatList;
    for (const k of gone) M.delete(k);
    for (const p of w.poses) M.set(boatKey(p), p);
    if (gone.length || w.poses.length) this.boatList = [...M.values()];
    return { poses: this.boatList, previous, elapsed: w.elapsed, day: w.day };
  }

  /** the trains after the snapshot of tick (ds: the way a tick at the speed sent) */
  readTrains(list: TrainWire[], gone: readonly number[], tick: number): Sampled<TrainState>[] {
    const M = this.trains;
    let changed = false;
    for (const id of gone) changed = M.delete(id) || changed;
    for (const w of list) {
      const o = M.get(w[0]);
      if (w.length === 6) M.set(w[0], { id: w[0], s: w[1], ds: w[2] * STEP, p: w[3], n: w[4], express: w[5] === 1, at: tick });
      else if (o) M.set(w[0], { ...o, s: w[1], ds: w[2] * STEP, at: tick });
      else continue;
      changed = true;
    }
    if (changed) this.trainList = [...M.values()];
    return this.trainList;
  }

  /** the people after the snapshot of tick (its riders, bikes, in a list of their own): its samples and gone; the
   * lists held before when neither changed them */
  readPeople(walkers: PersonWire[], riders: PersonWire[], gone: readonly number[], tick: number): [Sampled<PersonState>[], Sampled<PersonState>[]] {
    const M = this.people;
    let changed = false;
    for (const id of gone) changed = M.delete(id) || changed;
    const read = (list: PersonWire[], bike: boolean) => {
      for (const w of list) {
        const id = w[0], s = w[1], o = M.get(id);
        let p: Sampled<PersonState>;
        if (w.length === 9) p = { id, e: w[2], dir: w[3], s, v: w[5], lat: w[6], ph: w[7], wait: w[4] === 1, col: w[8], bike: bike || undefined, at: tick };
        else if (!o) continue;
        else {
          p = w.length === 5 ? { ...o, e: w[2], dir: w[3], s, wait: w[4] === 1, at: tick } : { ...o, s, at: tick };
          // (the step's phase turns with the way walked: sim/traffic.ts stepPeople)
          if (!o.wait) p.ph = o.ph + o.v * (tick - o.at) * STEP * (bike ? PH_RIDE : PH_WALK);
        }
        M.set(id, p);
        changed = true;
      }
    };
    read(walkers, false);
    read(riders, true);
    if (changed) {
      const walking: Sampled<PersonState>[] = [], riding: Sampled<PersonState>[] = [];
      for (const p of M.values()) (p.bike ? riding : walking).push(p);
      this.lists = [walking, riding];
    }
    return this.lists;
  }
}

// what a client holds of a kind sent when it changes: by id, and as a list (the one before when nothing changed)
class Held<T> {
  private readonly M = new Map<number, T>();
  private list: T[] = [];
  get(id: number) { return this.M.get(id); }
  clear() { this.M.clear(); this.list = []; }
  read(changed: [number, T][], gone: readonly number[]): T[] {
    for (const id of gone) this.M.delete(id);
    for (const [id, v] of changed) this.M.set(id, v);
    if (gone.length || changed.length) this.list = [...this.M.values()];
    return this.list;
  }
}

const roundPose = (p: BodyPose): BodyPose => ({ x: round(p.x, MM), y: round(p.y, MM), z: round(p.z, MM), qx: round(p.qx, Q),
  qy: round(p.qy, Q), qz: round(p.qz, Q), qw: round(p.qw, Q), ride: round(p.ride, MM),
  ...(p.lean !== undefined && { lean: round(p.lean, RAD) }), ...(p.wheelie !== undefined && { wheelie: round(p.wheelie, RAD) }) });

/** a body's draw state as sent: positions to mm, its rotation to 1e-5 of a quaternion's parts, angles to 1e-4 rad
 * (a client draws it within a mm or so of where the sim does) */
export function wireBody(d: BodyDraw): BodyDraw {
  const f = d.fade;
  return {
    owns: d.owns, body: d.body, p0: d.p0 && roundPose(d.p0), p1: d.p1 && roundPose(d.p1),
    drive: d.drive && { wheelZ: round(d.drive.wheelZ, MM), fall: d.drive.fall && { ...d.drive.fall } },
    fade: f && { dx: round(f.dx, MM), dy: round(f.dy, MM), dz: round(f.dz, MM), dh: round(f.dh, RAD), t: round(f.t, MM), dur: f.dur },
  };
}

/** a pose out of the traffic as sent (a left car's): to the mm, its angles to 1e-4 rad */
export const wirePose = (p: RoadPose): RoadPose => ({ x: round(p.x, MM), y: round(p.y, MM), z: round(p.z, MM),
  h: round(p.h, RAD), pitch: round(p.pitch, RAD), roll: round(p.roll, RAD) });
