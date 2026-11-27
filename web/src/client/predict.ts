// The player's own craft run on the page ahead of the host (prediction): the host's word on it is a round trip old, so
// the page steps its own copy of the craft's core with the player's input at once and draws that. Each new snapshot's
// state of it is taken as the truth for its tick, and the page's ticks since then stepped again from it with the
// inputs they had (rewind and replay). What then differs from what was drawn a moment before is blended out; a
// difference too big to blend (a reset, a crash, a craft met) is shown at once.
// The craft run ahead meets the solid things the newest snapshot has round it as the host's meets them (the same code,
// sim/solids.ts meetSolids): each tick where the host will have them, the traffic's cars reckoned on along their ways,
// the crafts at their speed (a parked one stays put) and the coaches by the timetable at the host's clock then (the
// snapshot's world clock gone on by the ticks since), so running into one is not undone a round trip later. Its events
// are told when it first runs a tick (not when stepped again); the host's word on each comes a round trip later and is
// then not told again (heard): one of the same kind due within HEAR ticks of the host's.
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
import { reckon, type Sampled } from '../sim/agent-wire';
import { carShape, COACH_SHAPE, craftSolids, lightSolids, meetShapes, meetSolids, solidAt, vesselShape, type Solid } from '../sim/solids';
import { CORES } from '../sim/craft/cores';
import { VoxelCollision } from '../sim/craft/voxel-collision';
import { DEFAULT_TUNING } from '../sim/tuning';
import { STEP } from '../sim/road-net';

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

/** where a car of the traffic is at arc length s, lane offset off (the page's road maths, the host's own) */
export type CarAt = (c: Car, s: number, off: number, out: CarPose) => CarPose;
/** the coaches at world time t (s) when the hour is hour (the page's timetable, the host's own) */
type CoachesAt = (t: number, hour: number) => Iterable<CoachPose>;
// a thing of the snapshot round the craft: a car of the traffic (where it is reckoned to be in a tick), or boxes as at
// the snapshot's tick going on at a speed (vx, vz m/s)
type Seen = { car: Sampled<CarState> } | { boxes: Solid[]; vx: number; vz: number };
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
  private thingsAt = 0;
  // the newest snapshot's world clock (s) and hour: where the coaches are reckoned from (null: none seen yet)
  private clockAt: number | null = null;
  private hour = 12;
  private readonly cores = new Map<CraftType, CraftCore>();
  private readonly carAt: CarPose = { x: 0, y: 0, z: 0, h: 0, pitch: 0 };
  // the events told ahead, each by the host's tick it is due in, not yet heard from the host; the page's tick told up
  // to; those told not yet read
  private told: { tick: number; key: string }[] = [];
  private toldTo = 0;
  private fresh: unknown[] = [];

  constructor(private readonly world: CraftWorld, private readonly carPose: CarAt, private readonly coaches: CoachesAt = () => []) {}

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
    const near = core.meet && this.clockAt !== null ? this.near(at) : null;
    core.clock.run(STEP, (s) => {
      if (!core.step(input, s, col)) return false;
      if (near?.length) meetSolids(type, core, near, col);
      return true;
    });
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
    const core = this.core!, p = core.pose, v = core.velocity, dt = (at - 1 - this.thingsAt) * STEP, out: Solid[] = [];
    let r = 0;
    for (const s of meetShapes(this.type!)) r = Math.max(r, Math.hypot(s.hx, s.hz) + Math.abs(s.fwd ?? 0));
    r += Math.hypot(v.x, v.z) * STEP + 1;
    const keep = (s: Solid) => { const b = r + s.hx + s.hz; if (Math.abs(s.x - p.x) < b && Math.abs(s.z - p.z) < b) out.push(s); };
    for (const o of this.things) {
      if ('car' in o) {
        const c = o.car;
        keep(solidAt(carShape(c), this.carPose(c as unknown as Car, reckon(c.s, c.v, c.at, at - 1), c.off, this.carAt)));
      } else for (const b of o.boxes) keep(dt ? { ...b, x: b.x + o.vx * dt, z: b.z + o.vz * dt } : b);
    }
    for (const k of this.coaches(this.clockAt! + dt, this.hour)) keep(solidAt(COACH_SHAPE, { x: k.x, y: k.y, z: k.z, h: k.heading }));
    return out;
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
    const out = s.detached.length ? new Set(s.detached.map((c) => c.id)) : null;
    for (const c of s.detached) if (c.detachedPose && by(c.detachedPose.x, c.detachedPose.z)) T.push({ boxes: [solidAt(carShape(c), c.detachedPose)], vx: 0, vz: 0 });
    for (const c of s.cars) {
      if (out?.has(c.id)) continue;
      const q = this.carPose(c as unknown as Car, reckon(c.s, c.v, c.at, tick), c.off, this.carAt);
      if (by(q.x, q.z)) T.push({ car: c });
    }
    for (const c of s.crafts) {
      if (c.id === this.id || !c.placed) continue;
      let k = this.cores.get(c.type);
      if (!k) this.cores.set(c.type, k = CORES[c.type](DEFAULT_TUNING) as CraftCore);
      k.load(c.core as never);
      const q = k.pose, w = k.velocity;
      if (!by(q.x, q.z)) continue;
      const boxes = lightSolids(own, c.type, q, craftSolids(c.type, q));
      if (boxes.length) T.push({ boxes, vx: w.x, vz: w.z });
    }
    for (const b of s.boats?.poses ?? []) if (by(b.x, b.z, b.len / 2)) T.push({ boxes: [solidAt(vesselShape(b), { x: b.x, y: b.y, z: b.z, h: b.heading })], vx: 0, vz: 0 });
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
    const core = this.core = CORES[type](DEFAULT_TUNING) as CraftCore;
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
    this.clockAt = null;
    this.told = [];
    this.fresh = [];
  }
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
