// The traffic's cars and people as a snapshot carries them (contract/agents.ts CarWire, PersonWire): the sim's end
// (AgentWire, one per session) and the client's (AgentRead), each keeping by id what the other was last sent. The
// client draws each one on from its last sample at the speed sent (reckoned: dead reckoning along its way), so a
// sample is sent only when that drifts: a way changed or one new comes at once, a drift past DRIFT m only on every
// AGENT_TICKS-th tick (10 a second), one past URGENT m (a car stopped short) at once. A car cruising or standing, a person walking a footway, is not sent at all
// between. Over the internet cars and people were ~95 % of a snapshot's bytes. The cars out of the traffic, the bodies
// and the avatars are sent when they change, a body come to rest once (else every shot's bodies and wrecks were sent
// whole every tick for as long as they lay near: 7 bodies were 57 kB/s). A craft likewise: one standing where the host
// placed it would otherwise cost its whole state every tick to everyone near. No three.js, no DOM.
import type { BoatPose, BoatsWire, BoatView, BodyDraw, BodyPose, BodyWire, CarState, CarWire, PersonState, PersonWire, SlimPose } from './contract/agents';
import type { VehicleId } from './contract/ids';
import type { RoadPose, WalkPose } from './contract/pose';
import { NPC_ARM, NPC_ARMED, NPC_DOWN, NPC_MOVING, NPC_SWIM, type AvatarState, type AvatarWire, type CarBody, type CraftState, type DetachedWire, type HealthWire,
  type NpcWire, type PlayerReads, type Snapshot } from './contract/snapshot';
import { PH_RIDE, PH_WALK, STEP } from './road-net';

// an NPC's heading may turn by TURN rad before it is sent again; far, it is sent every FAR_TICKS-th tick at most, when
// it drifted past FAR_DRIFT m or turned FAR_TURN rad (a figure a few pixels tall)
const TURN = 0.1, FAR_TICKS = 15, FAR_DRIFT = 0.5, FAR_TURN = 0.3;

/** v rounded to 1/k (k a power of ten): cm for lengths, cm/s for speeds; -0 as 0 so JSON writes no sign */
export const round = (v: number, k: number) => Math.round(v * k) / k + 0;
const CM = 100, MM = 1000;
// a quaternion's parts and an angle in rad: 1e-4 turns a body 5 m long by under a mm, as its place is rounded (the
// fifth digit of every moving body's four parts every tick was ~1 kB/s a player under fire)
const Q = 1e4, RAD = 1e4;

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
  prevOff: number; prev2: number; prev2Off: number; next: number; next2: number; move: string; len: number; bus: boolean;
  vt: VehicleId | undefined; col: string;
}
interface PersonSent { gen: number; s: number; tick: number; e: number; dir: number; wait: boolean; v: number; lat: number; col: string }

// whether a sample (s, v) is due at tick against the last one sent (h): it drifts past URGENT by the next tick, or past
// DRIFT by the next chance on a tick that is one
const drifts = (h: { s: number; v: number; tick: number }, s: number, v: number, tick: number) => {
  const now = Math.abs(reckon(h.s, h.v, h.tick, tick) - s), dv = Math.abs(v - h.v);
  return now + dv * STEP > URGENT || (tick % AGENT_TICKS === 0 && now + dv * AHEAD > DRIFT);
};

/** how far (m; a quaternion's part, rad) a body's pose may move between two ticks and still be at rest, and stray from
 * the rest pose sent before it is sent again: a car's body standing in a queue jitters by a mm or so */
export const STILL_M = 0.005, STILL_Q = 1e-3;
const samePose = (a: BodyPose, b: BodyPose) => a.x === b.x && a.y === b.y && a.z === b.z && a.ride === b.ride && a.qx === b.qx
  && a.qy === b.qy && a.qz === b.qz && a.qw === b.qw && a.lean === b.lean && a.wheelie === b.wheelie;
const still = (a: BodyPose, b: BodyPose) => Math.abs(a.x - b.x) <= STILL_M && Math.abs(a.y - b.y) <= STILL_M && Math.abs(a.z - b.z) <= STILL_M
  && Math.abs(a.ride - b.ride) <= STILL_M && Math.abs(a.qx - b.qx) <= STILL_Q && Math.abs(a.qy - b.qy) <= STILL_Q
  && Math.abs(a.qz - b.qz) <= STILL_Q && Math.abs(a.qw - b.qw) <= STILL_Q && Math.abs((a.lean ?? 0) - (b.lean ?? 0)) <= STILL_Q
  && Math.abs((a.wheelie ?? 0) - (b.wheelie ?? 0)) <= STILL_Q;
interface BodySent { gen: number; key: string; rest: BodyPose | null; p1: BodyPose | null }

/** what one session was sent of the traffic's cars and people: car and person give each one's wire form against it
 * at tick, or null when the client's reckoning of it holds (all of it when new to the session); the cars out of the
 * traffic, the bodies and the avatars likewise, null when the client's copy holds; done ends the snapshot: the ones
 * not in it forgotten (sent whole when they come back), their ids returned as gone */
export class AgentWire {
  private readonly cars = new Map<number, CarSent>();
  private readonly people = new Map<number, PersonSent>();
  private readonly boats = new Map<number, { gen: number; pose: BoatPose }>();
  private readonly detached = new Map<number, { gen: number; sent: Record<string, unknown> }>();
  private readonly bodies = new Map<number, BodySent>();
  private readonly avatars = new Map<number, { gen: number; player: string; pose: WalkPose; prev: WalkPose }>();
  private readonly crafts = new Map<number, { gen: number; key: string }>();
  private readonly npcs = new Map<number, { gen: number; w: NpcWire; tick: number }>();
  private gen = 0;
  private playerKey = '';
  // the health sent of each life the client holds below its max, by key
  private readonly lives = new Map<string, number>();

  /** a car out of the traffic (as sent: sim/server/snapshot.ts carState) at tick: whole when new to the client, then
   * only what changed (a driven car's whole state every tick was ~1 kB/s more a player), or null. One drawn from its
   * moving body (moving) has its pose and speed sent only every AGENT_TICKS-th tick, as a car of the traffic's sample
   * is: what reads them then is a page's prediction meeting it, and its pose beside its body's was ~1.5 kB/s more */
  detachedCar(c: CarState, tick: number, moving = false): DetachedWire | null {
    const h = this.detached.get(c.id), now = c as unknown as Record<string, unknown>;
    if (!h) { this.detached.set(c.id, { gen: this.gen, sent: { ...now } }); return c; }
    h.gen = this.gen;
    const out: Record<string, unknown> = { id: c.id }, was = h.sent, later = moving && tick % AGENT_TICKS !== 0;
    let n = 0;
    for (const k in now) {
      const v = now[k], w = was[k];
      if (v === w || (later && UNDER_WAY.has(k)) || (typeof v === 'object' && v && w && JSON.stringify(v) === JSON.stringify(w))) continue;
      out[k] = v ?? null;
      was[k] = v;
      n++;
    }
    return n ? out as DetachedWire : null;
  }

  /** a craft as sent (key: its state's string), or null when unchanged */
  craft(c: CraftState, key: string): CraftState | null {
    const h = this.crafts.get(c.id);
    if (h?.key === key) { h.gen = this.gen; return null; }
    this.crafts.set(c.id, { gen: this.gen, key });
    return c;
  }

  /** car id's body as drawn (wireBody's) at tick, or null when the client's copy holds. One at rest (its last two
   * poses within STILL_*, no fade, no fall) is sent once as standing at its pose, then again only when it strays from
   * it; a fade once (the client runs its t on with the ticks: it is the end of every body's run, ~3 kB/s sent whole);
   * a moving one without the p0 the client was sent as its p1 */
  body(id: number, d: BodyDraw, tick: number): BodyWire | null {
    const h = this.bodies.get(id), p = d.p1, f = d.fade;
    const rest = p && d.p0 && !f && !d.drive?.fall && still(d.p0, p) ? p : null;
    const w: Omit<BodyDraw, 'p0'> & { p0?: BodyPose | null } = rest ? { ...d, p0: rest } : { ...d };
    // (at rest: what it is besides its pose; else the whole draw, a fade by the tick it began)
    const key = rest ? `${d.owns} ${d.body} ${d.drive?.wheelZ}` : JSON.stringify({ ...w, fade: f && { ...f, t: Math.round(tick - f.t / STEP) } });
    if (h && h.key === key && (!rest || (h.rest && still(h.rest, rest)))) { h.gen = this.gen; return null; }
    this.bodies.set(id, { gen: this.gen, key, rest, p1: w.p1 });
    if (h?.p1 && w.p0 && samePose(h.p1, w.p0)) delete w.p0;
    return { ...w, ...(w.p0 !== undefined ? { p0: w.p0 && slim(w.p0) } : {}), p1: w.p1 && slim(w.p1) };
  }

  /** the session's player's reads, or undefined when they are those sent before and it has no results */
  player(p: PlayerReads): PlayerReads | undefined {
    const key = JSON.stringify({ ...p, results: [] });
    if (!p.results.length && key === this.playerKey) return undefined;
    this.playerKey = key;
    return p;
  }

  /** the lives whose health the client holds otherwise than hurt has it (hurt: those below their max, by key, with it;
   * sees: whether the session is sent one now): a life healed or gone is sent at its max once, whether seen or not, so
   * the client forgets it */
  health(hurt: Iterable<{ key: string; hp: number; max: number }>, sees: (key: string) => boolean): HealthWire[] {
    const out: HealthWire[] = [], L = this.lives, now = new Set<string>();
    for (const { key, hp, max } of hurt) {
      now.add(key);
      // (rounded up: one hurt at all is never shown at 0)
      const n = Math.ceil(hp);
      if (L.get(key) === n || !sees(key)) continue;
      L.set(key, n);
      out.push([key, n, max]);
    }
    for (const key of L.keys()) if (!now.has(key)) { L.delete(key); out.push([key, -1, -1]); }
    return out;
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

  /** an NPC at tick (pose, and prev the tick before: its velocity), or null while the client's reckoning of the
   * sample sent before holds: within DRIFT, turned less than TURN rad, doing the same. Far (past the page's close
   * look), only every FAR_TICKS-th tick, by FAR_DRIFT. One standing is not sent at all */
  npc(id: number, pose: WalkPose, prev: WalkPose, tick: number, far: boolean): NpcWire | null {
    const flags = (pose.moving ? NPC_MOVING : 0) | (pose.swim ? NPC_SWIM : 0) | (pose.down ? NPC_DOWN : 0) | (pose.arm === NPC_ARM ? NPC_ARMED : 0);
    const w: NpcWire = [id, Math.round(pose.x * CM), Math.round(pose.y * CM), Math.round(pose.z * CM), Math.round(pose.h * 1000),
      Math.round((pose.x - prev.x) / STEP * CM), Math.round((pose.z - prev.z) / STEP * CM), flags];
    const h = this.npcs.get(id);
    if (h && h.w[7] === flags) {
      h.gen = this.gen;
      const o = h.w, dt = (tick - h.tick) * STEP, err = (Math.hypot(o[1] + o[5] * dt - w[1], o[3] + o[6] * dt - w[3]) + Math.abs(o[2] - w[2])) / CM;
      const dh = Math.abs(Math.atan2(Math.sin((w[4] - o[4]) / 1000), Math.cos((w[4] - o[4]) / 1000))), dv = Math.hypot(w[5] - o[5], w[6] - o[6]) / CM;
      if (far ? tick % FAR_TICKS !== 0 || (err <= FAR_DRIFT && dh <= FAR_TURN)
        : err + dv * STEP <= URGENT && (tick % AGENT_TICKS !== 0 || (err + dv * AHEAD <= DRIFT && dh <= TURN))) return null;
    }
    this.npcs.set(id, { gen: this.gen, w, tick });
    return w;
  }

  car(c: CarState, tick: number): CarWire | null {
    const s = round(c.s, CM), v = round(c.v, CM), off = round(c.off, CM), prevOff = round(c.prevOff, CM), prev2Off = round(c.prev2Off ?? 0, CM);
    const len = round(c.len, CM), prev2 = c.prev2 ?? -1, next2 = c.next2 ?? -1, h = this.cars.get(c.id), move = `${c.shift ?? ''}/${c.turn ?? ''}`;
    const known = h && h.len === len && h.bus === c.bus && h.vt === c.vt && h.col === c.col;
    const way = known && h.e === c.e && h.lane === c.lane && h.prev === c.prev && h.prevOff === prevOff && h.prev2 === prev2
      && h.prev2Off === prev2Off && h.next === c.next && h.next2 === next2 && h.move === move;
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
      next: c.next, next2, move, len, bus: c.bus, vt: c.vt, col: c.col });
    const route = [...base, off, c.e, c.lane, c.prev, prevOff, prev2, prev2Off, c.next, next2, c.shift ?? 0, c.turn ?? 0] as const;
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

  /** the snapshot's end: the ids of the cars, people, boats, cars out of the traffic, bodies, avatars and crafts it no
   * longer holds */
  done(): Snapshot['gone'] {
    const gone: Snapshot['gone'] = [[], [], [], [], [], [], [], []];
    [this.cars, this.people, this.boats, this.detached, this.bodies, this.avatars, this.crafts, this.npcs].forEach((M: Map<number, { gen: number }>, i) => {
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
  private carList: Sampled<CarState>[] = [];
  private readonly boats = new Map<number, BoatPose>();
  private boatList: BoatPose[] = [];
  private lists: [Sampled<PersonState>[], Sampled<PersonState>[]] = [[], []];

  constructor(private readonly L: (road: number) => number) {}

  private readonly held = { detached: new Held<CarState>(), avatars: new Held<AvatarState>(), crafts: new Held<CraftState>() };
  // the NPCs' last samples, by id, with the tick of the snapshot that sent each
  private readonly npcs = new Map<number, { w: NpcWire; at: number }>();
  // the bodies as sent, by car id, with the tick of the snapshot that sent each (a fade's t runs on from it)
  private readonly bodies = new Map<number, { d: BodyDraw; at: number }>();
  private bodyList: [number, BodyDraw][] = [];
  private fades = 0;

  /** a new session: nothing of the last one's known */
  clear() {
    this.cars.clear(); this.people.clear(); this.boats.clear();
    this.carList = []; this.lists = [[], []]; this.boatList = [];
    for (const h of Object.values(this.held)) h.clear();
    this.npcs.clear();
    this.bodies.clear(); this.bodyList = []; this.fades = 0;
  }

  /** the cars out of the traffic, the bodies, the avatars and the crafts after a snapshot (s: its changed ones and gone) */
  readHeld(s: Pick<Snapshot, 'tick' | 'detached' | 'bodies' | 'avatars' | 'crafts' | 'gone' | 'npcs'>): { detached: CarState[]; bodies: [number, BodyDraw][]; avatars: AvatarState[];
    crafts: CraftState[] } {
    const H = this.held, A = H.avatars, N = this.npcs;
    for (const id of s.gone[7] ?? []) N.delete(id);
    for (const w of s.npcs ?? []) N.set(w[0], { w, at: s.tick });
    const npcs: AvatarState[] = [];
    // (an NPC is drawn as an avatar between where its sample reckons it a tick before and now)
    for (const { w, at } of N.values()) npcs.push({ id: w[0], player: `npc${w[0]}`, pose: npcPose(w, s.tick - at), prev: npcPose(w, s.tick - 1 - at) });
    const avatars = A.read(s.avatars.map((a) => [a.id, { ...a, prev: a.prev ?? A.get(a.id)?.pose ?? a.pose }]), s.gone[5]);
    return {
      // (keys left out: as before; null: none now)
      detached: H.detached.read(s.detached.map((c) => [c.id, merged(H.detached.get(c.id), c)]), s.gone[3]),
      bodies: this.readBodies(s.bodies, s.gone[4], s.tick),
      // (prev left out: the pose sent before)
      avatars: npcs.length ? [...avatars, ...npcs] : avatars,
      crafts: H.crafts.read(s.crafts.map((c) => [c.id, c]), s.gone[6]),
    };
  }

  // the bodies after the snapshot of tick (p0 left out: the p1 sent before; a fade's t run on from the tick it was sent)
  private readBodies(changed: [number, BodyWire][], gone: readonly number[], tick: number): [number, BodyDraw][] {
    const M = this.bodies;
    for (const id of gone) M.delete(id);
    for (const [id, w] of changed) {
      const p1 = w.p1 && full(w.p1), p0 = w.p0 === undefined ? M.get(id)?.d.p1 ?? p1 : w.p0 && full(w.p0);
      M.set(id, { d: { ...w, p0, p1 }, at: tick });
    }
    if (!gone.length && !changed.length && !this.fades) return this.bodyList;
    this.fades = 0;
    this.bodyList = [];
    for (const [id, { d, at }] of M) {
      const f = d.fade;
      if (f) this.fades++;
      this.bodyList.push([id, f && tick !== at ? { ...d, fade: { ...f, t: f.t + (tick - at) * STEP } } : d]);
    }
    return this.bodyList;
  }

  /** the cars after the snapshot of tick: its samples (one unknown or cut short is left out: it cannot be drawn) and
   * gone; the list held before when neither changed it */
  readCars(list: CarWire[], gone: readonly number[], tick: number): Sampled<CarState>[] {
    const M = this.cars;
    let changed = false;
    for (const id of gone) changed = M.delete(id) || changed;
    for (const w of list) {
      const id = w[0], s = w[1], v = w[2], o = M.get(id);
      if (w.length < 15 && !o) continue;
      const off = w.length > 4 ? w[4]! : o!.off;
      let c: Sampled<CarState>;
      if (w.length >= 15) {
        const x = w as Extract<CarWire, { length: 15 | 19 }>;
        const st = w.length === 19 ? (w as Extract<CarWire, { length: 19 }>) : null;
        if (!st && !o) continue;
        c = { id, e: x[5], lane: x[6], s, ds: 0, off, dOff: 0, prev: x[7], prevOff: x[8], prev2: x[9], prev2Off: x[10], next: x[11],
          next2: x[12], shift: x[13] || undefined, turn: x[14] || undefined, len: st ? st[15] : o!.len, bus: st ? st[16] === 1 : o!.bus,
          vt: st ? st[17] || undefined : o!.vt, col: st ? st[18] : o!.col, brake: w[3], v, wait: 0, detachedPose: undefined, at: tick };
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

// A body's rotation as sent: its largest part (never under 1/2) left out, the others turned so it is positive (the same
// rotation): a quarter of a moving body's digits every tick
const QUAT = ['qx', 'qy', 'qz', 'qw'] as const;
function slim(p: BodyPose): SlimPose {
  let big: (typeof QUAT)[number] = 'qw';
  for (const k of QUAT) if (Math.abs(p[k]) > Math.abs(p[big])) big = k;
  const o: SlimPose = { ...p }, s = p[big] < 0 ? -1 : 1;
  for (const k of QUAT) o[k] = s < 0 ? round(-p[k], Q) : p[k];
  delete o[big];
  return o;
}
function full(p: SlimPose): BodyPose {
  let sum = 0, gone: (typeof QUAT)[number] = 'qw';
  for (const k of QUAT) { const v = p[k]; if (v === undefined) gone = k; else sum += v * v; }
  return p[gone] === undefined ? { ...p, [gone]: Math.sqrt(Math.max(0, 1 - sum)) } as BodyPose : p as BodyPose;
}

// an NPC's sample reckoned on by ticks (the tick it was sent at: 0; a dead one lies still)
const npcPose = (w: NpcWire, ticks: number): WalkPose => {
  const f = w[7], t = f & NPC_DOWN ? 0 : Math.max(-1, ticks) * STEP;
  return { x: (w[1] + w[5] * t) / CM, y: w[2] / CM, z: (w[3] + w[6] * t) / CM, h: w[4] / 1000, moving: !!(f & NPC_MOVING),
    ...(f & NPC_SWIM ? { swim: true } : {}), ...(f & NPC_DOWN ? { down: true } : {}), ...(f & NPC_ARMED ? { arm: NPC_ARM } : {}) };
};

// what of a car out of the traffic changes as it goes (sent less often while its body is drawn)
const UNDER_WAY = new Set(['detachedPose', 'v', 'brake', 's', 'ds', 'off', 'dOff', 'wait']);

const merged = (was: CarState | undefined, d: DetachedWire): CarState => {
  const c = { ...was, ...d } as Record<string, unknown>;
  for (const k in d) if (c[k] === null) delete c[k];
  return c as unknown as CarState;
};

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

/** a body's draw state as sent: positions to mm, its rotation to 1e-4 of a quaternion's parts, angles to 1e-4 rad
 * (a client draws it within a mm or so of where the sim does); a fade's t whole (a ms off is a mm and 1e-3 rad off at
 * the start of a fast fade) */
export function wireBody(d: BodyDraw): BodyDraw {
  const f = d.fade;
  return {
    owns: d.owns, body: d.body, p0: d.p0 && roundPose(d.p0), p1: d.p1 && roundPose(d.p1),
    drive: d.drive && { wheelZ: round(d.drive.wheelZ, MM), fall: d.drive.fall && { ...d.drive.fall } },
    fade: f && { dx: round(f.dx, MM), dy: round(f.dy, MM), dz: round(f.dz, MM), dh: round(f.dh, RAD), t: f.t, dur: f.dur },
  };
}

/** a craft's core state (save()'s) as sent: every number to 1e-4 (0.1 mm, 1e-4 rad). The client's prediction blends
 * the difference out (under its 1e-4 it is none), and the digits past it cannot deflate: a helicopter's whole core
 * every tick was ~5 kB/s */
export const wireCore = <T>(s: T): T => JSON.parse(JSON.stringify(s), (_, v) => typeof v === 'number' ? round(v, 1e4) : v) as T;

/** a driven car's body as sent to its driver: to the mm (and mm/s, 1e-4 rad), what a car has not (a bike's lean, the
 * water) left out. The page takes it within a cm as its own (client/predict-car.ts); sent to 1e-4 every tick, its
 * digits that do not deflate put the load gate's mean player at its 20 kB/s */
export const wireCarBody = (b: CarBody): CarBody => {
  const v3 = (a: number[], k: number) => a.map((x) => round(x, k)) as [number, number, number];
  const o: CarBody = { p: v3(b.p, MM), q: b.q.map((x) => round(x, RAD)) as CarBody['q'], v: v3(b.v, MM), w: v3(b.w, MM),
    steer: round(b.steer, RAD), bars: round(b.bars, MM), air: round(b.air, MM), ride: round(b.ride, MM) };
  if (b.lean) o.lean = round(b.lean, RAD);
  if (b.wheelie) o.wheelie = round(b.wheelie, RAD);
  if (b.water) o.water = true;
  return o;
};

/** a pose out of the traffic as sent (a left car's): to the mm, its angles to 1e-4 rad */
export const wirePose = (p: RoadPose): RoadPose => ({ x: round(p.x, MM), y: round(p.y, MM), z: round(p.z, MM),
  h: round(p.h, RAD), pitch: round(p.pitch, RAD), roll: round(p.roll, RAD) });
