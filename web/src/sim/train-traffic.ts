import { hash } from '../core/num';
import { at, farFrom, pt, type Viewer } from './path';
import { COACH_LENGTH, COACH_WIDTH, coachPoses, GAP, trainTracks, type CoachPose, type TrackPath } from './coaches';
import type { TrainPathData, TrainService } from './types';
import type { TrainState } from './contract/agents';

// Trains on the open-air railway (scripts/traffic.py: the OSM route=train relations, one path per track, each route
// with the stations it stops at): every route sends a train every half hour, from the map edge or a tunnel portal;
// it brakes for its stations, waits, and keeps its distance behind the train ahead on the same track.
// Like the street life (view/life.ts) a train comes and goes only POP_R from the viewer or further: one due to start
// waits until the track's start is that far, one past its track's end (into a tunnel, off the map) runs on along the
// track's last straight until it is that far. (Twice a car's distance: a train is 4 m tall and 80-170 m long.)

type TrainPath = TrackPath & { next: number[] };
interface Train { id: number; p: number; svc: TrainService; s: number; ds: number; v: number; n: number; wait: number; done: Set<number>; express: boolean; ahead?: Train | null }

const COACH_HEIGHT = 4;
const COACH_SIZE = Object.freeze({ x: COACH_WIDTH, y: COACH_HEIGHT, z: COACH_LENGTH });
const V = 16, A = 0.7, B = 0.9, DWELL = 25, HEADWAY = 1800, SPACING = 70;
export const POP_R = 600;

const EXPRESS = /Intercity|DB|ČD|ÖBB|EC|IC/i;

/** a train as a snapshot carries it (sim/server/snapshot.ts): what its coaches' poses are drawn from */
// (a train as saved, TrainState: contract/agents.ts)

export interface CoachBox extends CoachPose {
  readonly size: typeof COACH_SIZE;
}

export class TrainTraffic {
  private readonly list: Train[] = [];
  private readonly paths: TrainPath[];
  private readonly byPath: Train[][];
  private nextId = 1;

  constructor(data: TrainPathData[], private readonly seed = 0) {
    this.paths = trainTracks(data).map((d, i) => Object.assign(d, { next: d.svc.map((_, k) => this.draw(i * 31 + k + 5) * HEADWAY) }));
    this.byPath = this.paths.map(() => []);
    for (const p of this.paths)
      for (let s = 200 + this.draw(p.cum.length + 11) * 900; s < p.L - 50; s += 900 + this.draw(s) * 900)
        this.spawn(p, this.draw(s + 3) * p.svc.length | 0, s);
  }

  private draw(n: number) { return hash(n + this.seed / 2 ** 22); }

  private spawn(p: TrainPath, k: number, s: number) {
    const svc = p.svc[k], express = EXPRESS.test(svc.op) || EXPRESS.test(svc.ref), n = express ? 8 : 4;
    const done = new Set(svc.stops.filter((x) => x < s));
    const tr: Train = { id: this.nextId++, p: this.paths.indexOf(p), svc, s, ds: 0, v: V * 0.8, n, wait: 0, done, express };
    this.list.push(tr);
    return tr;
  }

  private len(tr: Train) { return tr.n * (COACH_LENGTH + GAP) - GAP; }

  // is the train (both its ends) at least POP_R from the viewer?
  private far(tr: Train, v: Viewer) {
    const p = this.paths[tr.p], a = at(p, tr.s, 0, pt()), b = at(p, tr.s - this.len(tr), 0, pt());
    return farFrom(v, a.x, a.y, a.z, POP_R) && farFrom(v, b.x, b.y, b.z, POP_R);
  }

  tick(t: number, dt: number, hour: number, viewer: Viewer) {
    const hh = ((hour % 24) + 24) % 24;
    const run = !(hh > 0.25 && hh < 4.5);
    // each track's trains, front first (by where they are at the start of the tick; on a track no train passes another)
    const byPath = this.byPath;
    for (const g of byPath) g.length = 0;
    for (const tr of this.list) byPath[tr.p].push(tr);
    for (const g of byPath) {
      if (g.length > 1) g.sort((x, y) => y.s - x.s);
      for (let i = 0; i < g.length; i++) { // the nearest train strictly ahead
        let j = i - 1;
        while (j >= 0 && g[j].s <= g[i].s) j--;
        g[i].ahead = j >= 0 ? g[j] : null;
      }
    }
    if (run)
      this.paths.forEach((p, i) => p.next.forEach((tNext, k) => {
        if (t < tNext) return;
        const last = byPath[i].reduce((m, tr) => Math.min(m, tr.s - this.len(tr)), Infinity);
        if (last < SPACING + 40) { p.next[k] = t + 20; return; } // the track is occupied: try again in a while
        const g = byPath[i], tr = this.spawn(p, k, 0); // (behind the rest: their tails are past SPACING + 40)
        if (!this.far(tr, viewer)) { this.list.pop(); p.next[k] = t + 5; return; } // in sight: a little later
        tr.ahead = g.length ? g[g.length - 1] : null;
        g.push(tr);
        p.next[k] = t + HEADWAY * (0.85 + 0.3 * this.draw(t + k));
      }));
    for (const tr of this.list) {
      const p = this.paths[tr.p], L = this.len(tr);
      if (tr.wait > 0) { tr.wait -= dt; tr.ds = 0; continue; }
      // the nearest place to stop: its next station (the train centred on it, front past the stop node), or the
      // tail of the train ahead on this track less a gap (the nearest one ahead: trains keep SPACING behind the tail
      // of the one in front, so its tail is the nearest of all those ahead)
      let stop = Infinity, station = -1;
      for (const x of tr.svc.stops) if (!tr.done.has(x)) { const f = Math.min(x + L / 2, p.L); if (f >= tr.s - 1 && f < stop) { stop = f; station = x; } }
      const o = tr.ahead;
      if (o) stop = Math.min(stop, o.s - this.len(o) - SPACING);
      const d = stop - tr.s;
      const vSafe = d === Infinity ? V : Math.sqrt(Math.max(0, 2 * B * Math.max(0, d)));
      const target = Math.min(V, vSafe);
      tr.v = tr.v < target ? Math.min(target, tr.v + A * dt) : Math.max(target, tr.v - B * 1.6 * dt);
      tr.ds = tr.v * dt;
      tr.s += tr.ds;
      if (station >= 0 && d < 1.5 && tr.v < 0.6 && stop !== Infinity && tr.s >= Math.min(station + L / 2, p.L) - 2) {
        tr.done.add(station); tr.wait = DWELL; tr.v = 0;
      }
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const tr = this.list[i];
      if (tr.s - this.len(tr) > this.paths[tr.p].L + 10 && this.far(tr, viewer)) this.list.splice(i, 1);
    }
  }

  // Poses at the most recent tick by default. Back up one step for frame interpolation.
  // (sim/coaches.ts coachPoses: the client's copy draws its coaches with the same code)
  coaches(back = 0): IterableIterator<CoachPose> { return coachPoses(this.paths, this.list, back); }

  /** the trains as a snapshot carries them */
  save(): TrainState[] { return this.list.map(({ id, p, s, ds, n, express }) => ({ id, p, s, ds, n, express })); }

  /** a client's copy (never ticked) set to a snapshot's trains: what coaches() reads */
  load(trains: readonly TrainState[]) {
    this.list.length = 0;
    for (const t of trains) this.list.push({ ...t, svc: { ref: '', op: '', stops: [] }, v: 0, wait: 0, done: new Set() });
  }

  // Boxes use the same base and heading as the rendered coaches, at the latest simulation tick.
  *coachBoxes(): IterableIterator<CoachBox> {
    for (const pose of this.coaches()) yield { ...pose, size: COACH_SIZE };
  }
}
