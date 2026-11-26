// The traffic's cars and people as a snapshot carries them (contract/agents.ts CarWire, PersonWire): the sim's end
// (AgentWire, one per session) and the client's (AgentRead), each keeping by id what the other was last sent, so a
// tick carries only what moved. Over the internet cars and people were ~95 % of a snapshot's bytes: named keys and
// 18-digit numbers for state that is mostly the same as the tick before. No three.js, no DOM.
import type { BodyDraw, BodyPose, CarState, CarWire, PersonState, PersonWire } from './contract/agents';
import type { VehicleId } from './contract/ids';
import type { RoadPose } from './contract/pose';
import { PH_RIDE, PH_WALK, STEP } from './road-net';

/** v rounded to 1/k (k a power of ten): cm for lengths, cm/s for speeds; -0 as 0 so JSON writes no sign */
export const round = (v: number, k: number) => Math.round(v * k) / k + 0;
const CM = 100, MM = 1000;
// a quaternion's parts and an angle in rad: 1e-5 turns a body 5 m long by under 0.1 mm
const Q = 1e5, RAD = 1e4;

interface CarSent {
  gen: number; off: number; e: number; lane: number; prev: number; prevOff: number; prev2: number; prev2Off: number;
  next: number; next2: number; len: number; bus: boolean; vt: VehicleId | undefined; col: string;
}
interface PersonSent { gen: number; e: number; dir: number; wait: boolean; v: number; lat: number; col: string }

/** what one session was sent of the traffic's cars and people: car and person give each one's wire form against it
 * (what changed since, all of it when new to the session), done ends the snapshot (the ones not in it forgotten, so
 * one coming back is sent whole) */
export class AgentWire {
  private readonly cars = new Map<number, CarSent>();
  private readonly people = new Map<number, PersonSent>();
  private gen = 0;

  car(c: CarState): CarWire {
    const off = round(c.off, CM), prevOff = round(c.prevOff, CM), prev2Off = round(c.prev2Off ?? 0, CM), len = round(c.len, CM);
    const prev2 = c.prev2 ?? -1, next2 = c.next2 ?? -1, h = this.cars.get(c.id);
    const base: CarWire = [c.id, round(c.s, CM), round(c.v, CM), c.brake];
    const known = h && h.len === len && h.bus === c.bus && h.vt === c.vt && h.col === c.col;
    const way = known && h.e === c.e && h.lane === c.lane && h.prev === c.prev && h.prevOff === prevOff && h.prev2 === prev2
      && h.prev2Off === prev2Off && h.next === c.next && h.next2 === next2;
    if (h && known && way) {
      h.gen = this.gen;
      if (h.off === off) return base;
      h.off = off;
      return [...base, off];
    }
    this.cars.set(c.id, { gen: this.gen, off, e: c.e, lane: c.lane, prev: c.prev, prevOff, prev2, prev2Off, next: c.next, next2, len,
      bus: c.bus, vt: c.vt, col: c.col });
    const route = [...base, off, c.e, c.lane, c.prev, prevOff, prev2, prev2Off, c.next, next2] as const;
    return known ? [...route] : [...route, len, c.bus ? 1 : 0, c.vt ?? 0, c.col];
  }

  person(p: PersonState): PersonWire {
    const v = round(p.v, CM), lat = round(p.lat, CM), h = this.people.get(p.id), s = round(p.s, CM);
    const known = h && h.v === v && h.lat === lat && h.col === p.col;
    if (h && known && h.e === p.e && h.dir === p.dir && h.wait === p.wait) { h.gen = this.gen; return [p.id, s]; }
    this.people.set(p.id, { gen: this.gen, e: p.e, dir: p.dir, wait: p.wait, v, lat, col: p.col });
    const way = [p.id, s, p.e, p.dir, p.wait ? 1 : 0] as const;
    return known ? [...way] : [...way, v, lat, round(p.ph, 100), p.col];
  }

  done() {
    for (const M of [this.cars, this.people] as Map<number, { gen: number }>[]) for (const [id, h] of M) if (h.gen !== this.gen) M.delete(id);
    this.gen++;
  }
}

interface CarHeld { state: CarState; tick: number }
interface PersonHeld { state: PersonState; tick: number }

/** the client's end: each snapshot's cars and people made whole again from what was sent before (AgentWire), in the
 * order sent; L: a road's length (a car's ds across onto its next road) */
export class AgentRead {
  private cars = new Map<number, CarHeld>();
  private people = new Map<number, PersonHeld>();

  constructor(private readonly L: (road: number) => number) {}

  /** a new session: nothing of the last one's known */
  clear() { this.cars.clear(); this.people.clear(); }

  /** the cars of the snapshot of tick (one unknown or cut short is left out: it cannot be drawn) */
  readCars(list: CarWire[], tick: number): CarState[] {
    const out: CarState[] = [], was = this.cars, now = new Map<number, CarHeld>();
    for (const w of list) {
      const id = w[0], s = w[1], v = w[2], h = was.get(id), o = h?.state;
      if (w.length < 13 && !o) continue;
      const off = w.length > 4 ? w[4]! : o!.off;
      let c: CarState;
      if (w.length >= 13) {
        const x = w as Extract<CarWire, { length: 13 | 17 }>;
        const st = w.length === 17 ? (w as Extract<CarWire, { length: 17 }>) : null;
        if (!st && !o) continue;
        c = { id, e: x[5], lane: x[6], s, ds: 0, off, dOff: 0, prev: x[7], prevOff: x[8], prev2: x[9], prev2Off: x[10], next: x[11],
          next2: x[12], len: st ? st[13] : o!.len, bus: st ? st[14] === 1 : o!.bus, vt: st ? st[15] || undefined : o!.vt,
          col: st ? st[16] : o!.col, brake: w[3], v, wait: 0, detachedPose: undefined };
      } else c = { ...o!, s, off, brake: w[3], v };
      // (as the sim moves it on: sim/traffic.ts; one new to the client was moving at v)
      const dt = h ? (tick - h.tick) * STEP : STEP;
      c.ds = !o ? v * STEP : o.e === c.e ? s - o.s : o.e === c.prev ? s + this.L(o.e) - o.s : 0;
      c.dOff = o && o.e === c.e ? off - o.off : 0;
      c.wait = v < 0.3 ? (o?.wait ?? 0) + dt : 0;
      now.set(id, { state: c, tick });
      out.push(c);
    }
    this.cars = now;
    return out;
  }

  /** the people of the snapshot of tick, its riders (bike) in a list of their own: one read keeps both lists */
  readPeople(walkers: PersonWire[], riders: PersonWire[], tick: number): [PersonState[], PersonState[]] {
    const was = this.people, now = new Map<number, PersonHeld>();
    const read = (list: PersonWire[], bike: boolean) => {
      const out: PersonState[] = [];
      for (const w of list) {
        const id = w[0], s = w[1], h = was.get(id), o = h?.state;
        let p: PersonState;
        if (w.length === 9) p = { id, e: w[2], dir: w[3], s, v: w[5], lat: w[6], ph: w[7], wait: w[4] === 1, col: w[8], bike: bike || undefined };
        else if (!o) continue;
        else {
          p = w.length === 5 ? { ...o, e: w[2], dir: w[3], s, wait: w[4] === 1 } : { ...o, s };
          // (the step's phase turns with the way walked: sim/traffic.ts stepPeople)
          if (s !== o.s || p.e !== o.e) p.ph = o.ph + p.v * (tick - h.tick) * STEP * (bike ? PH_RIDE : PH_WALK);
        }
        now.set(id, { state: p, tick });
        out.push(p);
      }
      return out;
    };
    const both: [PersonState[], PersonState[]] = [read(walkers, false), read(riders, true)];
    this.people = now;
    return both;
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
