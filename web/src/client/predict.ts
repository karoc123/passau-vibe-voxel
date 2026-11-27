// The player's own craft run on the page ahead of the host (prediction): the host's word on it is a round trip old, so
// the page steps its own copy of the craft's core with the player's input at once and draws that. Each new snapshot's
// state of it is taken as the truth for its tick, and the page's ticks since then stepped again from it with the
// inputs they had (rewind and replay). What then differs from what was drawn a moment before is blended out; a
// difference too big to blend (a reset, a crash, a craft met) is shown at once.
// The craft run ahead meets the solid things the newest snapshot has round it as the host's meets them (the same code,
// sim/solids.ts meetSolids): each tick where the host will have them, the traffic's cars driven on along their ways,
// the crafts at their speed (a parked one stays put) and the coaches by the timetable at the host's clock then (the
// snapshot's world clock gone on by the ticks since), so running into one is not undone a round trip later. A craft met
// coming at it loses its speed into it from then on, as the host's does: reckoned on through it, it pushed the craft
// back by its speed in each tick run ahead (2 m in a round trip, head-on at 12 m/s), all taken back when the host's
// word came. A craft is reckoned on along the arc its turn bends its way to (read off two snapshots): reckoned on
// straight, one turning in front of it was met where it was not (corrections of 0.6-0.9 m against under 0.2). A car
// brakes for the craft run ahead in its way with the host's sums (sim/solids.ts craftAhead, road-net.ts carAcc):
// reckoned on at its speed, the craft crossing in front of one was corrected by 0.2 m each snapshot for 0.6 s (now
// under 0.01 m).
// Its events are told when it first runs a tick (not when stepped again); the host's word on each comes a round trip
// later and is then not told again (heard): one of the same kind due within HEAR ticks of the host's.
// Which tick of the page's a snapshot's tick is: an input's seq was sent in the page's tick p and first applied in the
// host's tick ta (the ack), so the host runs ta - p ticks behind. The host holds each input for its tick (sim-server.ts
// Session), so that number changes only when the host moves its timeline (a packet later than any before it): the
// newest ack's is taken.
// No three.js, no DOM.
import type { CraftCore, CraftWorld } from '../sim/craft/craft-core';
import type { CraftId, CraftType } from '../sim/contract/ids';
import type { PilotInput } from '../sim/contract/inputs';
import type { Ack, CraftState } from '../sim/contract/snapshot';
import type { CraftEventOf } from '../sim/contract/crafts';
import type { BoatView, CarState } from '../sim/contract/agents';
import type { Car } from '../sim/types';
import type { CoachPose } from '../sim/coaches';
import type { CarPose } from '../sim/road-net';
import { AGENT_TICKS, reckon, type Sampled } from '../sim/agent-wire';
import { carShape, COACH_SHAPE, craftAhead, craftMeets, craftSolids, lightSolids, meetShapes, meetSolids, overlap, solidAt, vesselShape, type CraftPose, type Solid } from '../sim/solids';
import { CORES } from '../sim/craft/cores';
import { VoxelCollision } from '../sim/craft/voxel-collision';
import type { ClientTuning } from '../sim/tuning';
import { carAcc, STEP, stopShort } from '../sim/road-net';

// a correction is blended out over BLEND_S s; beyond SNAP m (or TURN rad) it is shown at once
const BLEND_S = 0.25, SNAP = 4, TURN = 0.6;
// the most ticks run ahead of the newest snapshot (a ping of 2 s)
const AHEAD = 60;
// a host's event and one told ahead of the same kind due this many ticks apart are one (the ticks a crash may move by
// when the host's things are not where they were reckoned to be)
const HEAR = 15;
// how far beyond the craft (m) the snapshot's things are looked at, besides what it and a car (at CAR_V m/s) cover in
// the ticks run ahead
const SEE = 20, CAR_V = 25;
// the most ticks between two snapshots a craft's turn is read from
const TURNED = 6;

/** where a car of the traffic is at arc length s, lane offset off (the page's road maths, the host's own) */
export type CarAt = (c: Car, s: number, off: number, out: CarPose) => CarPose;
/** the coaches at world time t (s) when the hour is hour (the page's timetable, the host's own) */
type CoachesAt = (t: number, hour: number) => Iterable<CoachPose>;
// a craft's pose as at the start of the host's tick from, and its speed (vx, vz m/s)
type Going = CraftPose & { from: number; vx: number; vz: number };
// a thing of the snapshot round the craft: a car of the traffic (where it is after each host's tick from the
// snapshot's: way[k] after its k-th tick on, braking for the craft run ahead as the host's brakes for the host's),
// boxes standing still, or a craft going on from the snapshot's tick turning at w (rad/s), and from the tick the craft
// run ahead met it in (metIn) without its speed into it (met); first: the host steps it before the craft run ahead in a tick
// (the host steps its crafts in the order they came), so each of the two meets the other where it stands after its
// step; meets: it is pushed out of the craft run ahead
type Seen = { car: Sampled<CarState>; way: Way[] } | { boxes: Solid[] } | { craft: CraftType; go: Going; w: number; met?: Going; metIn?: number; first: boolean; meets: boolean };
// where a car of the traffic is on its way after a host's tick (s m, going v m/s)
type Way = { s: number; v: number };
// what of a snapshot as held the craft may meet (the client's held snapshot is one)
type Taken = { tick: number; t: number; hour: number; cars: readonly Sampled<CarState>[]; detached: readonly CarState[]; crafts: readonly CraftState[]; boats: BoatView | null };

interface Tick { p: number; seq: number; input: PilotInput; key: string; before: unknown }

export class Prediction {
  /** the craft run ahead: its core (its drawn() the one shown), while the player pilots one */
  core: CraftCore | null = null;
  private id: CraftId | null = null;
  private col: VoxelCollision | null = null;
  private readonly ticks: Tick[] = [];
  // the page's tick last run, and the time since the one in progress began (the client's clock)
  private p = 0;
  private acc = 0;
  private readonly sent: [seq: number, p: number][] = [];
  // the host's tick less the page's (null: not known yet)
  private lag: number | null = null;
  private input: { seq: number; input: PilotInput } | null = null;
  private seen = -1;
  private acked = -1;
  // the corrections being blended out: each what differed, and since when (s)
  private errs: { e: Leaf; since: number }[] = [];
  private type: CraftType | null = null;
  // the newest snapshot's things round the craft, and its tick
  private things: Seen[] = [];
  // which of things each of the solids near() gave is
  private readonly whose: (Seen | null)[] = [];
  private thingsAt = 0;
  // the newest snapshot's world clock (s) and hour: where the coaches are reckoned from (null: none seen yet)
  private clockAt: number | null = null;
  private hour = 12;
  private readonly cores = new Map<CraftType, CraftCore>();
  // the tuning the cores were made with (a host connected again may run with other numbers)
  private coresOf: ClientTuning | null = null;
  private readonly carAt: CarPose = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };
  private readonly mine: Solid[] = [];
  private readonly room = { ext: 0, need: 0 };
  // each craft's heading in the snapshot before (its tick, the heading): how fast it turns
  private headings = new Map<CraftId, [number, number]>();
  // the events told ahead, each by the host's tick it is due in, not yet heard from the host; the page's tick told up
  // to; those told not yet read
  private told: { tick: number; key: string }[] = [];
  private toldTo = 0;
  private fresh: unknown[] = [];

  /** tuning: the host's (the client's, once its hello is taken) */
  constructor(private readonly world: CraftWorld, private readonly tuning: () => ClientTuning, private readonly carPose: CarAt, private readonly coaches: CoachesAt = () => []) {}

  /** the core run ahead of craft id (null: not that one's) */
  coreOf(id: CraftId) { return id === this.id ? this.core : null; }

  /** how far into its tick in progress the craft is drawn */
  get alpha() { return this.acc / STEP; }

  /** a pilot's input sent (stamped for the page's tick p) */
  sentInput(seq: number, input: PilotInput, p: number) {
    this.input = { seq, input };
    this.sent.push([seq, p]);
    if (this.sent.length > 4 * AHEAD) this.sent.splice(0, this.sent.length - 4 * AHEAD);
  }

  /** the events told ahead since the last call */
  tell(): CraftEventOf[] {
    const t = this.type;
    return t ? this.fresh.splice(0).map((e) => ({ craft: t, e }) as CraftEventOf) : [];
  }

  /** whether the host's event e, of its tick, was told ahead already (then it is not told again) */
  heard(e: unknown, tick: number) {
    const k = keyOf(e), i = this.told.findIndex((x) => x.key === k && Math.abs(x.tick - tick) <= HEAR);
    if (i >= 0) this.told.splice(i, 1);
    return i >= 0;
  }

  /** a frame: the page's clock (its tick in progress, the time into it), the craft piloted (none: let go) and the
   * newest snapshot's word on it (its tick, its state, the ack), and that snapshot as held (taken: the things round it) */
  update(dt: number, page: number, acc: number, craft: { id: CraftId; type: CraftType; placed: boolean } | null, tick: number, state: CraftState | null, ack: Ack | null, taken: Taken | null = null) {
    // (one not put down is not stepped by the host either)
    if (!craft?.placed || !state || state.id !== craft.id) { this.drop(); return; }
    for (const e of this.errs) e.since += dt;
    if (this.errs.length && this.errs[0].since >= BLEND_S) this.errs = this.errs.filter((e) => e.since < BLEND_S);
    // (a new session counts its ticks anew)
    if (tick < this.seen) { this.lag = null; this.seen = -1; }
    if (craft.id !== this.id || !this.core) { this.open(craft.id, craft.type, state, tick, page, acc); return; }
    const core = this.core, last = this.ticks[this.ticks.length - 1], now = this.input;
    // (the input changed in the tick in progress: that tick stepped again with it, so it shows this frame)
    if (last && now && now.seq !== last.seq) {
      const key = JSON.stringify(now.input);
      if (key !== last.key) { core.load(last.before as never); this.run(last, now.input, key); }
      last.seq = now.seq;
    }
    this.acc = acc;
    while (this.p < page) {
      this.p++;
      const t: Tick = { p: this.p, seq: now?.seq ?? 0, input: now ? now.input : core.neutral as PilotInput, key: '', before: null };
      this.run(t, t.input, JSON.stringify(t.input));
      this.ticks.push(t);
    }
    if (this.ticks.length > AHEAD) this.ticks.splice(0, this.ticks.length - AHEAD);
    if (tick > this.seen) this.take(tick, state, ack, taken);
  }

  // a tick stepped with input from the state before it
  private run(t: Tick, input: PilotInput, key: string) {
    const core = this.core!, col = this.col!, type = this.type!;
    t.before = core.save();
    t.input = input;
    t.key = key;
    core.keep();
    col.prefetch(core.pose, core.velocity);
    // (the host's tick this one is; not known yet: the snapshot's)
    const at = this.lag === null ? this.thingsAt : t.p + this.lag;
    // (met in this tick or after by a run now stepped again)
    for (const o of this.things) if ('met' in o && o.met && o.metIn! >= at) o.met = undefined;
    // (driven in this tick or after by a run now stepped again)
    const k = at - this.thingsAt;
    for (const o of this.things) if ('car' in o && o.way.length > k) o.way.length = Math.max(k, 1);
    const meets = !!core.meet && this.clockAt !== null;
    if (meets) this.meetOwn(at, true);
    const near = meets ? this.near(at) : null;
    const met = (i: number, n: { x: number; z: number }) => this.met(this.whose[i], at, n);
    core.clock.run(STEP, (s) => {
      if (!core.step(input, s, col)) return false;
      if (near?.length) meetSolids(type, core, near, col, met);
      return true;
    });
    if (near) this.meetOwn(at, false);
    if (near && k > 0) this.drive(k);
    if (core.events.length) {
      if (t.p > this.toldTo && this.lag !== null) for (const e of core.events) { this.fresh.push(e); this.told.push({ tick: at, key: keyOf(e) }); }
      core.events.length = 0;
      if (this.fresh.length > 32) this.fresh.splice(0, this.fresh.length - 32);
    }
    this.toldTo = Math.max(this.toldTo, t.p);
  }

  // the snapshot's things the craft may meet in the host's tick at, where the host has them then (as at the tick's
  // start: after the one before), those within the craft's reach of where it is now
  private near(at: number): Solid[] {
    const core = this.core!, p = core.pose, v = core.velocity, k = at - 1 - this.thingsAt, dt = k * STEP, out: Solid[] = [], W = this.whose;
    W.length = 0;
    let r = 0;
    for (const s of meetShapes(this.type!)) r = Math.max(r, Math.hypot(s.hx, s.hz) + Math.abs(s.fwd ?? 0));
    r += Math.hypot(v.x, v.z) * STEP + 1;
    const keep = (s: Solid, o: Seen | null) => { const b = r + s.hx + s.hz; if (Math.abs(s.x - p.x) < b && Math.abs(s.z - p.z) < b) { out.push(s); W.push(o); } };
    for (const o of this.things) {
      if ('car' in o) {
        const c = o.car, s = k >= 0 ? wayAt(o.way, k).s : reckon(c.s, c.v, c.at, at - 1);
        keep(solidAt(carShape(c), this.carPose(c as unknown as Car, s, c.off, this.carAt)), null);
      } else if ('boxes' in o) for (const b of o.boxes) keep(b, null);
      else {
        const when = at + (o.first ? 1 : 0), q = going(o.met && o.met.from <= when ? o.met : o.go, o.w, when);
        for (const b of lightSolids(this.type!, o.craft, q, craftSolids(o.craft, q))) keep(b, o);
      }
    }
    for (const c of this.coaches(this.clockAt! + dt, this.hour)) keep(solidAt(COACH_SHAPE, { x: c.x, y: c.y, z: c.z, h: c.heading }), null);
    return out;
  }

  // the cars after the host's k-th tick from the snapshot's, the craft run ahead stepped in it: one that has the craft
  // in its way brakes for it (with the host's sums; wanting the speed the snapshot showed, the rest of its road unknown
  // here), the others go on at their speed
  private drive(k: number) {
    const own = this.mine;
    own.length = 0;
    craftSolids(this.type!, this.core!.pose, own);
    for (const o of this.things) if ('car' in o) o.way[k] = this.driven(o.car, wayAt(o.way, k - 1), own);
  }

  // car c a host's tick on from w, the craft's boxes own
  private driven(c: CarState, w: Way, own: readonly Solid[]): Way {
    let gap = Infinity;
    if (own.length) {
      const q = this.carPose(c as unknown as Car, w.s, c.off, this.carAt), fx = Math.sin(q.h), fy = Math.cos(q.h), f = (c.len - 1.2) / 2;
      const g = { px: q.x + fx * f, py: q.z + fy * f, z: q.y, fx, fy };
      for (const s of own) { const d = craftAhead(g, s, this.room); if (!Number.isNaN(d)) gap = Math.min(gap, Math.max(stopShort(d, this.room.need), 0.01)); }
    }
    const v = gap === Infinity ? w.v : Math.max(0, w.v + carAcc(w.v, c.v, gap, 0) * STEP);
    return { s: w.s + v * STEP, v };
  }

  // craft o met in the host's tick at, n the craft's way out of it
  private met(o: Seen | null, at: number, n: { x: number; z: number }) {
    if (!o || !('craft' in o) || o.met) return;
    const q = going(o.go, o.w, at + (o.first ? 1 : 0)), into = q.vx * n.x + q.vz * n.z;
    if (into > 0) { o.met = { ...q, vx: q.vx - into * n.x, vz: q.vz - into * n.z }; o.metIn = at; }
  }

  // the crafts the host steps (first: before the craft run ahead, else after it) in its tick at meeting the craft run
  // ahead where it stands: pushed out of it, their speed into it lost. Reckoned on through it instead, one coming
  // head-on stood in the craft's way a step further on than the host's (a correction of 0.4 m at 12 m/s each)
  private meetOwn(at: number, first: boolean) {
    const own = this.type!, p = this.core!.pose, out = { x: 0, z: 0 };
    let mine: Solid[] | null = null;
    for (const o of this.things) {
      if (!('craft' in o) || o.first !== first || !o.meets || o.met) continue;
      const q = going(o.go, o.w, at + 1);
      mine ??= craftSolids(own, p);
      const boxes = lightSolids(o.craft, own, p, mine.slice());
      for (const a of craftMeets(o.craft, q)) for (const b of boxes) {
        const d = overlap(a, b, out);
        if (d <= 0) continue;
        q.x += out.x * d; q.z += out.z * d;
        const into = q.vx * out.x + q.vz * out.z;
        if (into < 0) { q.vx -= into * out.x; q.vz -= into * out.z; }
        o.met = q;
        o.metIn = at;
      }
    }
  }

  // the newest snapshot's things round the craft (within what it and a car cover in the ticks run ahead)
  private see(tick: number, s: Taken) {
    const core = this.core!, p = core.pose, v = core.velocity, own = this.type!, T = this.things, ahead = (this.ticks.length + 5) * STEP;
    const R = SEE + (Math.hypot(v.x, v.z) + CAR_V) * ahead, by = (x: number, z: number, b = 0) => Math.abs(x - p.x) < R + b && Math.abs(z - p.z) < R + b;
    T.length = 0;
    this.thingsAt = tick;
    this.clockAt = s.t;
    this.hour = s.hour;
    // (a car the session took out of the traffic is a detached one from that tick)
    const out = s.detached.length ? new Set(s.detached.map((c) => c.id)) : null, mine = this.mine;
    // (the craft's boxes at the snapshot's tick stand for those of the ticks before it)
    mine.length = 0;
    craftSolids(own, core.pose, mine);
    for (const c of s.detached) if (c.detachedPose && by(c.detachedPose.x, c.detachedPose.z)) T.push({ boxes: [solidAt(carShape(c), c.detachedPose)] });
    for (const c of s.cars) {
      if (out?.has(c.id)) continue;
      const q = this.carPose(c as unknown as Car, reckon(c.s, c.v, c.at, tick), c.off, this.carAt);
      if (!by(q.x, q.z)) continue;
      // (from its sample on, up to AGENT_TICKS old while its speed changes: reckoned on at the sample's speed it kept
      // no braking for the craft, a correction each sample)
      const from = Math.max(c.at, tick - AGENT_TICKS);
      let w: Way = { s: reckon(c.s, c.v, c.at, from), v: c.v };
      for (let n = from; n < tick; n++) w = this.driven(c, w, mine);
      T.push({ car: c, way: [w] });
    }
    const H = new Map<CraftId, [number, number]>();
    for (const c of s.crafts) {
      if (c.id === this.id || !c.placed) continue;
      const t = this.tuning();
      if (t !== this.coresOf) { this.cores.clear(); this.coresOf = t; }
      let k = this.cores.get(c.type);
      if (!k) this.cores.set(c.type, k = CORES[c.type](t) as CraftCore);
      k.load(c.core as never);
      const q = k.pose as CraftPose, v = k.velocity, was = this.headings.get(c.id);
      H.set(c.id, [tick, q.h]);
      if (!by(q.x, q.z) || !lightSolids(own, c.type, q, craftSolids(c.type, q)).length) continue;
      // (its turn as the snapshots show it: the cores keep their yaw rates each its own way, or none)
      const w = was && tick - was[0] <= TURNED ? wrap(q.h - was[1]) / ((tick - was[0]) * STEP) : 0;
      T.push({ craft: c.type, go: { ...q, from: tick + 1, vx: v.x, vz: v.z }, w, first: c.id < this.id!, meets: !!k.meet && meetShapes(c.type).length > 0 });
    }
    this.headings = H;
    for (const b of s.boats?.poses ?? []) if (by(b.x, b.z, b.len / 2)) T.push({ boxes: [solidAt(vesselShape(b), { x: b.x, y: b.y, z: b.z, h: b.heading })] });
  }

  // the newest snapshot's state taken for its tick and the page's ticks after it stepped again
  private take(tick: number, state: CraftState, ack: Ack | null, taken: Taken | null) {
    this.seen = tick;
    if (this.told.length) this.told = this.told.filter((x) => x.tick >= tick - HEAR);
    const core = this.core!;
    const sent = ack && ack.seq !== this.acked ? this.sent.find(([seq]) => seq === ack.seq) : undefined;
    if (sent) { this.acked = ack!.seq; this.lag = ack!.tick - sent[1]; }
    const shown = copy(core.drawn(this.alpha) as Leaf);
    core.load(state.core as never);
    // (the page's tick the snapshot's is; not known yet: none run ahead)
    const at = this.lag === null ? Infinity : tick - this.lag, T = this.ticks;
    let i = 0;
    while (i < T.length && T[i].p <= at) i++;
    T.splice(0, i);
    if (taken?.tick === tick) this.see(tick, taken);
    for (const t of T) this.run(t, t.input, t.key);
    // (each correction blended on its own curve: one coming each snapshot does not hold the last ones back)
    const e = diff(shown, core.drawn(this.alpha) as Leaf);
    if (!e) this.errs = [];
    else if (most(e) > 1e-4) this.errs.push({ e, since: 0 });
  }

  private open(id: CraftId, type: CraftType, state: CraftState, tick: number, page: number, acc: number) {
    this.drop();
    this.p = page;
    this.acc = acc;
    const core = this.core = CORES[type](this.tuning()) as CraftCore;
    core.ahead = true;
    this.id = id;
    this.type = type;
    this.col = new VoxelCollision(this.world.meta, this.world.cache, this.world.now, core.reach);
    core.load(state.core as never);
    this.seen = tick;
    this.input = null;
    const raw = core.drawn.bind(core);
    // (the shells and the models draw the craft through its core's drawn(): the correction left is added there)
    core.drawn = (alpha: number) => {
      const d = raw(alpha) as Leaf;
      for (const e of this.errs) add(d, e.e, left(e.since));
      return d;
    };
  }

  private drop() {
    this.core = null;
    this.id = null;
    this.col?.release();
    this.col = null;
    this.ticks.length = 0;
    this.errs = [];
    this.type = null;
    this.things = [];
    this.headings.clear();
    this.clockAt = null;
    this.told = [];
    this.fresh = [];
  }
}

// where g is (as at the start of) the host's tick at, and how fast it goes: on along the arc its turn w bends its way to
function going(g: Going, w: number, at: number): Going {
  const t = (at - g.from) * STEP, a = w * t, c = Math.cos(a), s = Math.sin(a);
  // (the speed turned by a, and the way gone: its integral; straight for a turn too small to divide by)
  const [u, r] = Math.abs(a) < 1e-6 ? [t, 0] : [s / w, (1 - c) / w];
  return { ...g, x: g.x + g.vx * u + g.vz * r, z: g.z + g.vz * u - g.vx * r, h: g.h + a, from: at, vx: g.vx * c + g.vz * s, vz: g.vz * c - g.vx * s };
}

// where a car is after the host's k-th tick from the snapshot's: those not driven yet at its speed
function wayAt(way: Way[], k: number): Way {
  while (way.length <= k) { const w = way[way.length - 1]; way.push({ s: w.s + w.v * STEP, v: w.v }); }
  return way[k];
}

// an event's kind: its type or kind, or itself (a word)
const keyOf = (e: unknown) => typeof e === 'object' && e ? String((e as { type?: string }).type ?? (e as { kind?: string }).kind) : String(e);

const left = (t: number) => { const u = Math.min(1, t / BLEND_S); return 1 - u * u * (3 - 2 * u); };

// a drawn pose as numbers: its angles by their names, its unit vectors and attitudes by theirs, the rest metres
type Leaf = { [k: string]: number | Leaf };
const ANGLES = new Set(['h', 'heading', 'pitch', 'bank', 'roll', 'gamma']);
const UNITS = new Set(['fwd', 'up', 'attitude']);
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

function copy(d: Leaf): Leaf {
  const o: Leaf = {};
  for (const k in d) { const v = d[k]; o[k] = typeof v === 'number' ? v : copy(v); }
  return o;
}

// shown - raw, leaf by leaf; null: too far to blend
function diff(shown: Leaf, raw: Leaf, unit = false): Leaf | null {
  // (q and -q are one attitude)
  const flip = 'w' in raw && dot(shown, raw) < 0 ? -1 : 1, o: Leaf = {};
  for (const k in raw) {
    const a = shown[k], b = raw[k];
    if (typeof b === 'number') {
      if (typeof a !== 'number') return null;
      const e = ANGLES.has(k) ? wrap(a - b) : flip * a - b;
      if (!Number.isFinite(e) || Math.abs(e) > (unit || ANGLES.has(k) ? TURN : SNAP)) return null;
      o[k] = e;
    } else {
      if (typeof a !== 'object') return null;
      const e = diff(a, b, UNITS.has(k));
      if (!e) return null;
      o[k] = e;
    }
  }
  return o;
}

function add(d: Leaf, e: Leaf, k: number) {
  for (const key in e) {
    const v = d[key], x = e[key];
    if (typeof v === 'number') d[key] = v + (x as number) * k;
    else if (v) { add(v, x as Leaf, k); if (UNITS.has(key)) unit(v); }
  }
}

function most(e: Leaf): number { let m = 0; for (const k in e) { const v = e[k]; m = Math.max(m, typeof v === 'number' ? Math.abs(v) : most(v)); } return m; }
function dot(a: Leaf, b: Leaf) { let s = 0; for (const k in b) if (typeof a[k] === 'number') s += (a[k] as number) * (b[k] as number); return s; }
function unit(v: Leaf) {
  const n = Math.sqrt(dot(v, v));
  if (n > 0) for (const k in v) v[k] = (v[k] as number) / n;
}
