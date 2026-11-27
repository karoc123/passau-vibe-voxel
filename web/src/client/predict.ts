// The player's own craft run on the page ahead of the host (prediction): the host's word on it is a round trip old, so
// the page steps its own copy of the craft's core with the player's input at once and draws that. Each new snapshot's
// state of it is taken as the truth for its tick, and the page's ticks since then stepped again from it with the
// inputs they had (rewind and replay). What then differs from what was drawn a moment before is blended out; a
// difference too big to blend (a reset, a crash, a craft met) is shown at once.
// Which tick of the page's a snapshot's tick is: an input's seq was sent in the page's tick p and first applied in the
// host's tick ta (the ack), so the host runs ta - p ticks behind. The host holds each input for its tick (sim-server.ts
// Session), so that number changes only when the host moves its timeline (a packet later than any before it): the
// newest ack's is taken.
// No three.js, no DOM.
import type { CraftCore, CraftWorld } from '../sim/craft/craft-core';
import type { CraftId, CraftType } from '../sim/contract/ids';
import type { PilotInput } from '../sim/contract/inputs';
import type { Ack, CraftState } from '../sim/contract/snapshot';
import { CORES } from '../sim/craft/cores';
import { VoxelCollision } from '../sim/craft/voxel-collision';
import { DEFAULT_TUNING } from '../sim/tuning';
import { STEP } from '../sim/road-net';

// a correction is blended out over BLEND_S s; beyond SNAP m (or TURN rad) it is shown at once
const BLEND_S = 0.25, SNAP = 4, TURN = 0.6;
// the most ticks run ahead of the newest snapshot (a ping of 2 s)
const AHEAD = 60;

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

  constructor(private readonly world: CraftWorld) {}

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

  /** a frame: the page's clock (its tick in progress, the time into it), the craft piloted (none: let go) and the
   * newest snapshot's word on it (its tick, its state, the ack) */
  update(dt: number, page: number, acc: number, craft: { id: CraftId; type: CraftType; placed: boolean } | null, tick: number, state: CraftState | null, ack: Ack | null) {
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
    if (tick > this.seen) this.take(tick, state, ack);
  }

  // a tick stepped with input from the state before it
  private run(t: Tick, input: PilotInput, key: string) {
    const core = this.core!;
    t.before = core.save();
    t.input = input;
    t.key = key;
    core.keep();
    this.col!.prefetch(core.pose, core.velocity);
    core.clock.run(STEP, (s) => core.step(input, s, this.col!));
    // (what happens to the craft is the host's to say)
    core.events.length = 0;
  }

  // the newest snapshot's state taken for its tick and the page's ticks after it stepped again
  private take(tick: number, state: CraftState, ack: Ack | null) {
    this.seen = tick;
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
    this.id = id;
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
  }
}

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
