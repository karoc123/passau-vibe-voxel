// The driver's own car run on the page ahead of the host (prediction), as the crafts are (predict.ts): over a network
// the host's word on it is a round trip and the render buffer old (150 ms and more), so the steering answered that
// late. The page steps its own copy of the car (the host's Rapier car and terrain code in a world of its own:
// physics/rapier/own-car.ts) with the driver's input at once and draws that. A snapshot's body is the truth for its
// tick: where the page's copy had it the same after that tick (within a hair: the two worlds' contacts are not solved
// in the same order) nothing is done, else the page's ticks since are stepped again from it with the inputs they had,
// and what then differs from what was drawn is blended out (beyond SNAP m or TURN rad shown at once: a reset). The
// page's world has only the terrain: what the host's car meets besides (the traffic, other cars, coaches) comes as such
// a correction. A crash, a splash or a fall the host holds the car for (no input) is held on the page from its word on
// it on.
// The page's tick a snapshot's tick is: as predict.ts (the newest ack's input sent in page tick p, taken in host tick
// ta: the host runs ta - p ticks behind).
// No three.js, no DOM.
import type { BodyDraw, BodyPose } from '../sim/contract/agents';
import type { CarInput } from '../sim/contract/inputs';
import { NO_INPUT } from '../sim/contract/inputs';
import type { RoadPose } from '../sim/contract/pose';
import type { Ack, CarBody, DriverSnapshot } from '../sim/contract/snapshot';
import { bodyPoseAt } from '../sim/body-pose';
import { STEP } from '../sim/road-net';

/** the car as the page runs it (physics/rapier/own-car.ts OwnCar) */
export interface OwnCar {
  put(c: CarKind, b: CarBody): void;
  save(): CarBody;
  load(b: CarBody): void;
  tick(input: CarInput): boolean;
  readonly wheelZ: number;
  drop(): void;
}
/** what of a car its body is built from */
export interface CarKind { vt?: string; bus: boolean; len: number }

// a correction is blended out over BLEND_S s, a large one at BLEND_V m/s (eased, its fastest 1.5 BLEND_V: driven into
// a bus the page had not, 2.4 m back in 0.25 s was the car drawn going back faster than it came); beyond SNAP m (or
// TURN rad) it is shown at once
const BLEND_S = 0.25, BLEND_V = 5, SNAP = 4, TURN = 0.6;
// the most ticks run ahead of the newest snapshot (a ping of 2 s)
const AHEAD = 60;
// the page's copy as the host's after a tick within these (m, m/s, rad, rad/s): nothing stepped again. Over 10 s of
// driving the two worlds part by under a mm a tick; stepped again on every snapshot instead, a phone paid for ~6 ticks
// of Rapier each one
const SAME_P = 0.01, SAME_V = 0.05, SAME_Q = 0.003, SAME_W = 0.05;

interface Tick { p: number; seq: number; input: CarInput; key: string; before: CarBody; after: CarBody }
type Err = { x: number; y: number; z: number; h: number; pitch: number; roll: number };

export class CarPrediction {
  /** the last frame's cost (ms, wall clock: cost only, never a decision) */
  ms = 0;
  /** the snapshots the page's copy was stepped again from, and those it matched (tools) */
  readonly stats = { replays: 0, same: 0 };
  private car: OwnCar | null = null;
  private loading = false;
  private failed = false;
  private id: number | null = null;
  private readonly ticks: Tick[] = [];
  private p = 0;
  private acc = 0;
  private readonly sent: [seq: number, p: number][] = [];
  private lag: number | null = null;
  private input: { seq: number; input: CarInput } | null = null;
  private seen = -1;
  private acked = -1;
  private errs: { e: Err; since: number; dur: number }[] = [];
  // the host's tick up to which it holds the car (no input), from its newest word
  private holdTo = -Infinity;
  // drawn while no tick is run ahead: the host's body
  private still: CarBody | null = null;

  /** make: the car's world, loaded when first driven */
  constructor(private readonly make: () => Promise<OwnCar>) {}

  /** a driver's input sent (stamped for the page's tick p) */
  sentInput(seq: number, input: CarInput, p: number) {
    this.input = { seq, input };
    this.sent.push([seq, p]);
    if (this.sent.length > 4 * AHEAD) this.sent.splice(0, this.sent.length - 4 * AHEAD);
  }

  /** a frame: the page's clock (its tick in progress, the time into it), the newest snapshot's driver reads (none:
   * not driving), the car's kind, the newest ack */
  update(dt: number, page: number, acc: number, d: DriverSnapshot | null, kind: CarKind | null, ack: Ack | null) {
    const t0 = performance.now();
    this.frame(dt, page, acc, d, kind, ack);
    this.ms = performance.now() - t0;
  }

  private frame(dt: number, page: number, acc: number, d: DriverSnapshot | null, kind: CarKind | null, ack: Ack | null) {
    if (!d?.body || d.waiting || !kind || this.failed) { this.drop(); return; }
    if (!this.car) {
      if (!this.loading) {
        this.loading = true;
        this.make().then((c) => { this.car = c; }, (e) => { this.failed = true; console.warn('own car', e); });
      }
      return;
    }
    for (const e of this.errs) e.since += dt;
    if (this.errs.some((e) => e.since >= e.dur)) this.errs = this.errs.filter((e) => e.since < e.dur);
    if (d.tick < this.seen) { this.lag = null; this.seen = -1; }
    if (d.entityId !== this.id) { this.open(d, kind, page, acc); return; }
    const car = this.car, last = this.ticks[this.ticks.length - 1], now = this.input;
    // (the input changed in the tick in progress: that tick stepped again with it, so it shows this frame)
    if (last && now && now.seq !== last.seq) {
      const key = key_(now.input);
      if (key !== last.key && !this.held(last.p)) { const was = last.after; car.load(last.before); if (!this.run(last, now.input, key)) { last.after = was; car.load(was); } }
      last.seq = now.seq;
    }
    this.acc = acc;
    while (this.p < page) {
      this.p++;
      const input = now ? now.input : NO_INPUT;
      const t: Tick = { p: this.p, seq: now?.seq ?? 0, input, key: '', before: null!, after: null! };
      if (!this.run(t, input, key_(input))) { this.p = page; break; }
      this.ticks.push(t);
      this.still = null;
    }
    if (this.ticks.length > AHEAD) this.ticks.splice(0, this.ticks.length - AHEAD);
    if (d.tick > this.seen) this.take(d, ack);
  }

  // whether the host holds the car in the host's tick for page tick p
  private held(p: number) { return this.lag !== null && p + this.lag <= this.holdTo; }

  // a tick stepped with input from the state before it; false: its ground not built yet (not stepped)
  private run(t: Tick, input: CarInput, key: string) {
    const car = this.car!;
    t.before = car.save();
    t.input = input;
    t.key = key;
    if (!car.tick(this.held(t.p) ? NO_INPUT : input)) return false;
    t.after = car.save();
    return true;
  }

  // the newest snapshot's body taken for its tick, the page's ticks after it stepped again if it differs
  private take(d: DriverSnapshot, ack: Ack | null) {
    const body = d.body!, tick = d.tick;
    this.seen = tick;
    this.holdTo = tick + Math.max(d.crashMs, d.sinkMs, d.fallMs) / (STEP * 1000);
    const sent = ack && ack.seq !== this.acked ? this.sent.find(([seq]) => seq === ack.seq) : undefined;
    if (sent) { this.acked = ack!.seq; this.lag = ack!.tick - sent[1]; }
    const at = this.lag === null ? Infinity : tick - this.lag, T = this.ticks;
    let i = 0;
    while (i < T.length && T[i].p < at) i++;
    const mine = T[i]?.p === at ? T[i].after : null;
    T.splice(0, mine ? i + 1 : i);
    if (mine && same(mine, body)) { this.stats.same++; return; }
    this.stats.replays++;
    const shown = this.drawn(null);
    const car = this.car!;
    car.load(body);
    if (!T.length) this.still = body;
    for (let k = 0; k < T.length; k++) {
      if (!this.run(T[k], T[k].input, T[k].key)) { T.length = k; this.still = car.save(); break; }
    }
    const raw = this.drawn(null), e = shown && raw && diff(shown, raw);
    if (!e) this.errs = [];
    else if (Math.max(Math.abs(e.x), Math.abs(e.y), Math.abs(e.z), Math.abs(e.h)) > 1e-4) this.errs.push({ e, since: 0, dur: Math.max(BLEND_S, Math.hypot(e.x, e.y, e.z) / BLEND_V) });
  }

  private open(d: DriverSnapshot, kind: CarKind, page: number, acc: number) {
    this.ticks.length = 0;
    this.errs = [];
    this.id = d.entityId;
    this.p = page;
    this.acc = acc;
    this.seen = d.tick;
    this.input = null;
    this.car!.put(kind, d.body!);
    this.still = d.body!;
  }

  /** where the own car id is drawn this frame (draw: the host's draw of its body, for a fall), or null: as the
   * snapshots have it */
  pose(id: number, draw: BodyDraw | null | undefined): RoadPose | null {
    return id === this.id ? this.drawn(draw) : null;
  }

  // the pose between the last tick's start and end at the page's time into it, the corrections left added
  private drawn(draw: BodyDraw | null | undefined): RoadPose | null {
    const last = this.ticks[this.ticks.length - 1];
    const a = this.still ?? last?.before, b = this.still ?? last?.after;
    if (!a || !b || !this.car) return null;
    const f = draw?.drive?.fall;
    // (a fall drawn by the host's tick the drawn one is)
    const fall = f && last && this.lag !== null ? { ...f, tick: last.p + this.lag } : null;
    const p = bodyPoseAt(bodyPose(a), bodyPose(b), this.still ? 1 : this.acc / STEP, { wheelZ: this.car.wheelZ, fall }, STEP);
    for (const { e, since, dur } of this.errs) {
      const k = left(since / dur);
      p.x += e.x * k; p.y += e.y * k; p.z += e.z * k; p.h += e.h * k; p.pitch += e.pitch * k; p.roll += e.roll * k;
    }
    return p;
  }

  private drop() {
    if (this.id === null) return;
    this.car?.drop();
    this.id = null;
    this.ticks.length = 0;
    this.errs = [];
    this.still = null;
  }
}

const key_ = (i: CarInput) => `${i.gas},${i.brake},${i.steer},${i.handbrake}`;

const bodyPose = (b: CarBody): BodyPose => ({ x: b.p[0], y: b.p[1], z: b.p[2], qx: b.q[0], qy: b.q[1], qz: b.q[2], qw: b.q[3], ride: b.ride, lean: b.lean, wheelie: b.wheelie });

function same(a: CarBody, b: CarBody) {
  const d = (u: number[], v: number[]) => Math.hypot(...u.map((x, i) => x - v[i]));
  // (q and -q one rotation; a small turn by t moves the quaternion by t / 2. Not by their dot: sent to 1e-4 a
  // quaternion is off its unit length by as much, and the dot's acos makes that a turn of 0.03 rad)
  const dq = Math.min(d(a.q, b.q), d(a.q, b.q.map((x) => -x)));
  return d(a.p, b.p) < SAME_P && d(a.v, b.v) < SAME_V && d(a.w, b.w) < SAME_W && 2 * dq < SAME_Q
    && Math.abs(a.steer - b.steer) < SAME_Q && !a.water === !b.water;
}

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
// shown - raw; null: too far to blend
function diff(s: RoadPose, r: RoadPose): Err | null {
  const e = { x: s.x - r.x, y: s.y - r.y, z: s.z - r.z, h: wrap(s.h - r.h), pitch: wrap(s.pitch - r.pitch), roll: wrap(s.roll - r.roll) };
  return Math.hypot(e.x, e.y, e.z) > SNAP || Math.max(Math.abs(e.h), Math.abs(e.pitch), Math.abs(e.roll)) > TURN ? null : e;
}

const left = (t: number) => { const u = Math.min(1, t); return 1 - u * u * (3 - 2 * u); };
