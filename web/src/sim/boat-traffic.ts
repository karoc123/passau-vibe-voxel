import { hash, smooth, wrapAngle } from '../core/num';
import { at, prepPath, pt, type Path } from './path';
import { waterTop, type WaterColumns } from '../nav/river';

// Boats on the rivers (scripts/boats.py -> data/boats.json):
// - river-cruise ships moored along the old town's Danube quay (the OSM berths: Zollände, A14, Liegestelle 3..8), bow
//   upstream; how many lie there follows the season (Apr-Oct nearly every berth, often a second ship rafted alongside;
//   a few in March, November and December's Christmas-market cruises; in Jan-Feb a laid-up one, dark). Some of the
//   day's ships come in in the early morning and some leave in the evening, one at a time, at ~13 km/h along the
//   fairway: from downstream straight up to the berth, from upstream past the old town to turn in the Dreiflüsseeck's
//   basin and come in bow upstream; bound downstream, they turn in the wide reach above the old town.
// - the excursion boats of the Dreiflüsse-Stadtrundfahrt (the OSM ferry route) from the pier below the Rathaus: up
//   the Danube, back past the old town, round the Dreiflüsseeck, up the Inn and back, departures on the half hour in
//   summer, hourly in spring and autumn. A fleet of three: as many as the timetable needs take turns,
//   the rest lie rafted alongside the pier; a boat back from a trip ties up behind the ones waiting, and when the one at
//   the pier casts off the next slides in.
// The routes and timetables are sampled on the world tick, from its day and hour. Each vessel floats on the water's top
// where it is (nav/river.ts waterTop: the voxels' water, as the world's columns have it); where that is not known (no
// columns given, its tile not in, off the map) at the last top it had, else the last any vessel had, else WATER.
// On a partial map (the check fixtures) any part may be missing: no berths (no cruise ships), an empty tour (no
// excursion boats) or no fairway (the cruise ships stay moored all day).

export interface Berth { x: number; y: number; dx: number; dy: number; nx: number; ny: number }
type XY = [number, number];
// the cruise ships' lanes (boats.py): up (westbound) and down (eastbound), and the two turns between them, each
// [index on the lane it leaves, index on the lane it joins, points]
export interface Fairway { up: XY[]; down: XY[]; turnE: [number, number, XY[]]; turnW: [number, number, XY[]] }
export interface BoatData { berths: Berth[]; tour: XY[]; fairway?: Fairway }

export const CRUISE_L = 135, CRUISE_B = 11.4, TOUR_L = 38, TOUR_B = 8;
export const MAX_CRUISE = 24;
const V = 2.8, ACC = 0.06; // m/s along the loop (10 km/h: the round trip takes ~42 min, as the real one about 45), m/s²
const BOARD = 12 * 60; // a boat is lit and boarding this long before it casts off
const AFTER = 8 * 60; // and lit this long after it comes in
const FLEET = 3, SLOT = TOUR_B + 1; // excursion boats, and their spacing rafted at the pier
const SLIDE: XY = [45, 170]; // s after a boat casts off: the next one moves into its place
const TURN = 10 * 60; // the least time at the pier between two trips
const VC = 3.6, ACC_C = 0.015; // cruise ships under way: 13 km/h, m/s²
// a ship comes in from (and leaves to) this far beyond its lane's end, the map's edge, straight on: it is not seen to
// appear or vanish there (tools/popin-check.mjs)
const RUN_OUT = 1000;
const MORNING = 6 * 3600, LATEST_IN = 9.25 * 3600, EVENING = 18 * 3600, LATEST_OUT = 23.75 * 3600; // s after midnight
const WATER = 4; // m: the water's top before any is known (no columns given: the node checks)

export interface BoatPose {
  // IDs are stable by berth slot for cruise ships and by fleet slot for excursion boats.
  readonly id: number;
  readonly kind: 'ship' | 'boat';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly len: number;
  readonly lit: boolean;
  readonly underway: boolean;
}

// a cruise ship coming in or leaving: along `path` from t0 for dur seconds; `crab` metres at the berth end are the
// sideways slip to or from the quay, the hull kept parallel to it (hx, hy)
interface Move { path: Path; t0: number; dur: number; arrive: boolean; crab: number; hx: number; hy: number }
// k: the berth's slot (2 per berth), r: 0 at the quay, 1 alongside `inner`
interface Ship { x: number; y: number; dx: number; dy: number; len: number; lit: boolean; r: number; k: number; inner?: Ship; arr?: Move; dep?: Move }

const xyz = (p: XY[]) => p.map(([x, y]) => [x, y, 0] as [number, number, number]);

// a quadratic Bézier from a through c to b, without its first point
function bezier(a: XY, c: XY, b: XY, n = 12): XY[] {
  return Array.from({ length: n }, (_, k) => {
    const t = (k + 1) / n, u = 1 - t;
    return [u * u * a[0] + 2 * t * u * c[0] + t * t * b[0], u * u * a[1] + 2 * t * u * c[1] + t * t * b[1]] as XY;
  });
}
// RUN_OUT on from a, away from b
const beyond = (a: XY, b: XY): XY => { const l = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; return [a[0] + (a[0] - b[0]) / l * RUN_OUT, a[1] + (a[1] - b[1]) / l * RUN_OUT]; };
const arcLen = (p: XY[]) => p.reduce((l, q, k) => (k ? l + Math.hypot(q[0] - p[k - 1][0], q[1] - p[k - 1][1]) : 0), 0);

export class BoatTraffic {
  private readonly tour: Path | null; // no tour on this map, no excursion boats
  private readonly T: number = 0; // a round trip, s
  private readonly raft: XY = [0, 0]; // from the pier out into the river
  private readonly berths: Berth[];
  private readonly fairway?: Fairway;
  private readonly a = pt();
  private readonly b = pt();
  private lastHour = NaN;
  private clockSetAt = 0;
  private currentDay = -1;
  private elapsedSinceSet = 0;
  private ships: Ship[] = [];
  private departures: number[] = [];
  private currentPoses: readonly BoatPose[] = [];
  // the last water top known under each vessel (ships: their slot, boats: -1 - fleet slot), and under any
  private readonly tops = new Map<number, number>();
  private lastTop = WATER;
  private previousPoses: readonly BoatPose[] = [];

  constructor(data: BoatData, private readonly seed = 0) {
    const fin = (...v: number[]) => v.every(Number.isFinite);
    const pts = (p: unknown): p is XY[] => Array.isArray(p) && p.every((q) => Array.isArray(q) && fin(q[0], q[1]));
    this.berths = (Array.isArray(data.berths) ? data.berths : []).filter((b) => fin(b.x, b.y, b.dx, b.dy, b.nx, b.ny));
    // a fairway needs both lanes (route takes points 4 either side of abeam) and its turns
    const f = data.fairway;
    if (f && pts(f.up) && pts(f.down) && f.up.length >= 2 && f.down.length >= 2 && pts(f.turnE?.[2]) && pts(f.turnW?.[2])) this.fairway = f;
    // the loop: at least two points apart (a path of one point, or none, has no length nor heading)
    const tour = pts(data.tour) && data.tour.length >= 2 ? prepPath({ p: xyz(data.tour) }) : null;
    this.tour = tour && tour.L > 1 ? tour : null;
    if (this.tour) {
      const ramp = V / ACC; // s to reach cruising speed
      this.T = (this.tour.L - V * ramp) / V + 2 * ramp;
      this.raft = [-this.tour.startD[1], this.tour.startD[0]]; // the boat at the pier lies bow west, the river to starboard
    }
  }

  get day() { return this.currentDay; }
  get elapsed() { return this.elapsedSinceSet; }
  get poses() { return this.currentPoses; }
  get previous() { return this.previousPoses; }

  private draw(n: number) { return hash(n + this.seed / 2 ** 22); }

  // the share of the berths taken on this day of the year
  private static berthShare(day: number) {
    if (day < 60) return 0.12; // Jan-Feb: a ship or two laid up for the winter
    if (day < 91) return 0.35; // March: the first cruises
    if (day < 305) return 0.9; // April-October
    if (day < 335) return 0.4; // November
    return 0.45; // December: Christmas-market cruises
  }

  // departures of the Dreiflüsse-Stadtrundfahrt on this day, in seconds after midnight
  private static departures(day: number) {
    if (day < 75 || day > 310) return [];
    const summer = day >= 121 && day <= 280, out: number[] = [];
    for (let h = summer ? 9.5 : 10; h <= (summer ? 17 : 16) + 1e-6; h += summer ? 0.5 : 1) out.push(h * 3600);
    return out;
  }

  // arc length along the loop t seconds after casting off (accelerate, cruise, slow to the pier)
  private sAt(t: number) {
    const ramp = V / ACC, L = this.tour!.L;
    if (t <= 0) return 0;
    if (t >= this.T) return L;
    if (t < ramp) return 0.5 * ACC * t * t;
    const u = this.T - t;
    if (u < ramp) return L - 0.5 * ACC * u * u;
    return 0.5 * ACC * ramp * ramp + V * (t - ramp);
  }

  // ---- cruise ships

  // the way in to (or out from) a berth at (x, y), heading (hx, hy): from the east straight up the up lane, or from the
  // west down the down lane and round in the Eck's basin; out to the west up the up lane, or round in the reach above
  // the town and away down the down lane
  private route(f: Fairway, x: number, y: number, hx: number, hy: number, arrive: boolean, east: boolean, t0: number): Move {
    const near = (lane: XY[]) => lane.reduce((bi, p, i) => (Math.hypot(p[0] - x, p[1] - y) < Math.hypot(lane[bi][0] - x, lane[bi][1] - y) ? i : bi), 0);
    const ia = near(f.up), berth: XY = [x, y];
    let p: XY[];
    if (arrive) {
      const from = Math.max(ia - 4, 1); // ~30 m short of abeam (the up lane runs westwards)
      const slip = bezier(f.up[from], f.up[ia], berth);
      const lane = east ? f.up.slice(0, from + 1) : [...f.down.slice(0, f.turnE[0] + 1), ...f.turnE[2], ...f.up.slice(f.turnE[1], from + 1)];
      p = [beyond(lane[0], lane[1]), ...lane, ...slip];
      return this.move(p, arcLen([f.up[from], ...slip]), true, hx, hy, t0);
    }
    const to = Math.min(ia + 4, f.up.length - 2);
    const slip = [berth, ...bezier(berth, f.up[ia], f.up[to])];
    p = [...slip, ...(east ? [...f.up.slice(to + 1, f.turnW[0] + 1), ...f.turnW[2], ...f.down.slice(f.turnW[1])] : f.up.slice(to + 1))];
    p.push(beyond(p[p.length - 1], p[p.length - 2]));
    return this.move(p, arcLen(slip), false, hx, hy, t0);
  }

  private move(p: XY[], crab: number, arrive: boolean, hx: number, hy: number, t0: number): Move {
    const path = prepPath({ p: xyz(p) }), ramp = VC / ACC_C, dRamp = 0.5 * VC * ramp;
    return { path, t0, dur: Math.max(0, path.L - dRamp) / VC + ramp, arrive, crab, hx, hy };
  }

  // arc length along a move t s after it begins: an arrival comes in at speed and slows to the berth, a departure
  // gathers way from it
  private static sMove(mv: Move, t: number) {
    const ramp = VC / ACC_C, L = mv.path.L;
    if (mv.arrive) {
      const u = mv.dur - t;
      return u < ramp ? L - 0.5 * ACC_C * u * u : VC * t;
    }
    return t < ramp ? 0.5 * ACC_C * t * t : 0.5 * VC * ramp + VC * (t - ramp);
  }

  // the day's cruise ships: which berths are taken (the same all day), and who comes in or leaves when
  private cruiseDay(d: number) {
    const f = this.fairway, ships: Ship[] = [];
    const share = BoatTraffic.berthShare(d), laidUp = d < 60;
    this.berths.forEach((b, i) => {
      const h = this.draw(d * 37 + i * 101 + 0.5);
      if (h >= share) return;
      const raft = !laidUp && h < share * 0.45; // a second ship tied alongside
      let inner: Ship | undefined;
      for (let r = 0; r < (raft ? 2 : 1) && ships.length < MAX_CRUISE; r++) {
        const len = (r ? 110 + 25 * this.draw(d + i * 13 + 7) : 125 + 10 * this.draw(d * 3 + i)) / CRUISE_L;
        const off = r * (CRUISE_B + 1.2), shift = (1 - len) * CRUISE_L * 0.5; // a shorter ship lies at the berth's upstream end
        const s: Ship = { x: b.x + b.nx * off + b.dx * shift, y: b.y + b.ny * off + b.dy * shift, dx: b.dx, dy: b.dy, len, lit: !laidUp, r, k: i * 2 + r, inner };
        ships.push(s);
        inner = s;
      }
    });
    if (!f || laidUp) return ships;
    // who moves today: an outer ship comes in after the inner one, and leaves before it
    const comes = new Set<Ship>(), goes = new Set<Ship>();
    for (const s of ships) {
      if (this.draw(d * 13 + s.k * 7 + 0.21) < 0.4 || (s.inner && comes.has(s.inner))) comes.add(s);
      if (this.draw(d * 17 + s.k * 5 + 0.67) < 0.4 || (s.inner && goes.has(s.inner))) goes.add(s);
    }
    // one at a time: arrivals from 6:00 (inner ships first), done before the first excursion boat; departures from
    // 18:00 (outer ships first), after the last one is back
    let t = MORNING + 1200 * this.draw(d * 0.7 + 0.3);
    for (const s of [...comes].sort((a, b) => a.r - b.r || this.draw(d + a.k) - this.draw(d + b.k))) {
      const mv = this.route(f, s.x, s.y, s.dx, s.dy, true, this.draw(d * 5 + s.k + 0.9) < 0.5, t);
      const outer = ships.find((o) => o.inner === s);
      if (mv.t0 + mv.dur > LATEST_IN || (outer && !comes.has(outer))) continue; // no time left: it was here overnight
      s.arr = mv;
      t = mv.t0 + mv.dur + 180;
    }
    for (const s of ships) if (s.inner && s.inner.arr && !s.arr) s.inner.arr = undefined; // an outer ship can't have been here first
    t = EVENING + 1200 * this.draw(d * 0.9 + 0.1);
    for (const s of [...goes].sort((a, b) => b.r - a.r || this.draw(d + a.k + 3) - this.draw(d + b.k + 3))) {
      const outer = ships.find((o) => o.inner === s);
      if (outer && !outer.dep) continue; // the ship alongside stays the night, so does this one
      const mv = this.route(f, s.x, s.y, s.dx, s.dy, false, this.draw(d * 3 + s.k + 0.4) < 0.5, t);
      if (mv.t0 + mv.dur > LATEST_OUT) continue;
      s.dep = mv;
      t = mv.t0 + mv.dur + 180;
    }
    return ships;
  }

  // where a ship under way is: on its path, heading along it, but kept parallel to the quay over the slip in or out
  private movingPose(s: Ship, mv: Move, clock: number, water: WaterColumns | null) {
    const sv = BoatTraffic.sMove(mv, clock - mv.t0), P = mv.path, A = this.a, B = this.b;
    at(P, sv + 30, 0, A); at(P, sv - 30, 0, B);
    let ang = Math.atan2(A.x - B.x, A.y - B.y);
    const w = mv.arrive ? smooth(P.L - mv.crab - 50, P.L - mv.crab + 5, sv) : 1 - smooth(mv.crab - 5, mv.crab + 50, sv);
    ang += wrapAngle(Math.atan2(mv.hx, mv.hy) - ang) * w;
    at(P, sv, 0, A);
    return this.shipPose(s, A.x, A.y, ang, true, water);
  }

  // ---- excursion boats

  // the trip a boat of the rotation (b < n) is on at the clock, its next departure, and when it last came in
  private static trips(deps: number[], n: number, b: number, clock: number, T: number) {
    let on = -1, next = Infinity, back = -Infinity;
    for (let k = b; k < deps.length; k += n) {
      const dep = deps[k];
      if (clock >= dep && clock < dep + T) on = dep;
      else if (dep > clock) { next = Math.min(next, dep); }
      else back = Math.max(back, dep + T);
    }
    return { on, next, back };
  }

  // the boat's place in the raft at the pier (0 alongside, 1, 2 outwards), easing in as the one ahead casts off
  private slot(deps: number[], n: number, b: number, clock: number) {
    if (b >= n) return b; // the spare boats lie outermost, out of the way
    const key = (o: number) => {
      const tr = BoatTraffic.trips(deps, n, o, clock, this.T);
      return tr.on >= 0 ? null : tr.next < Infinity ? tr.next : 1e6 + tr.back; // waiting for the next trip, or done for the day
    };
    const mine = key(b)!;
    let s = 0;
    for (let o = 0; o < n; o++) {
      if (o === b) continue;
      const k = key(o);
      if (k !== null && k < mine) s++;
    }
    // a boat that cast off a moment ago still holds its place, the others slide in
    for (const dep of deps) {
      const dt = clock - dep;
      if (dt < 0 || dt >= SLIDE[1]) continue;
      if (BoatTraffic.trips(deps, n, b, dep, this.T).on < 0 && deps.indexOf(dep) % n !== b) s += 1 - smooth(SLIDE[0], SLIDE[1], dt);
    }
    return s;
  }

  private shipPose(s: Ship, x: number, z: number, heading: number, underway: boolean, water: WaterColumns | null): BoatPose {
    return { id: s.k, kind: 'ship', x, y: this.top(s.k, x, z, water), z, heading, len: s.len * CRUISE_L, lit: s.lit, underway };
  }

  // the water's top under vessel `key` at (x, z), else the last known (see the head of the file)
  private top(key: number, x: number, z: number, water: WaterColumns | null) {
    const w = water ? waterTop(water, x, z) : null;
    if (w === null || w < 0) return this.tops.get(key) ?? this.lastTop;
    this.tops.set(key, w);
    return this.lastTop = w;
  }

  // water: the world's columns the vessels float on (null: none, all at WATER)
  tick(time: number, hour: number, day: number, water: WaterColumns | null = null) {
    const reset = Number.isNaN(this.lastHour) || Math.abs(hour - this.lastHour) > 1e-6;
    if (reset) {
      this.clockSetAt = time;
      this.lastHour = hour;
    }
    this.elapsedSinceSet = time - this.clockSetAt;
    const clock = hour * 3600 + this.elapsedSinceSet;
    const d = Math.round(day);
    const newDay = d !== this.currentDay;
    if (newDay) {
      this.currentDay = d;
      this.ships = this.cruiseDay(d);
      this.departures = BoatTraffic.departures(d);
    }
    const poses: BoatPose[] = [];

    // cruise ships: moored, or coming in or leaving
    for (const s of this.ships) {
      if (s.arr && clock < s.arr.t0) continue; // not here yet
      if (s.dep && clock > s.dep.t0 + s.dep.dur) continue; // gone
      const mv = s.arr && clock < s.arr.t0 + s.arr.dur ? s.arr : s.dep && clock > s.dep.t0 ? s.dep : null;
      poses.push(mv ? this.movingPose(s, mv, clock, water) : this.shipPose(s, s.x, s.y, Math.atan2(s.dx, s.dy), false, water));
    }

    // excursion boats
    if (this.tour) {
      const deps = this.departures, at0 = this.a, at1 = this.b, P = this.tour, half = TOUR_L / 2, [rx, ry] = this.raft;
      const every = deps.length > 1 ? deps[1] - deps[0] : 3600;
      const n = Math.min(FLEET, deps.length, Math.ceil((this.T + TURN) / every)); // the boats the timetable needs
      for (let b = 0; b < FLEET; b++) {
        const tr = b < n ? BoatTraffic.trips(deps, n, b, clock, this.T) : { on: -1, next: Infinity, back: -Infinity };
        let s = 0, lat = 0;
        if (tr.on >= 0) {
          const t = clock - tr.on;
          s = this.sAt(t);
          // coming in to its place in the raft
          lat = this.slot(deps, n, b, tr.on + this.T) * SLOT * smooth(P.L - 170, P.L - 25, s);
        } else {
          s = 0;
          lat = this.slot(deps, n, b, clock) * SLOT;
        }
        at(P, s + half * 0.8, 0, at0); at(P, s - half * 0.8, 0, at1);
        const heading = Math.atan2(at0.x - at1.x, at0.y - at1.y);
        at(P, s, 0, at0);
        const lit = tr.on >= 0 || tr.next - clock < BOARD || clock - tr.back < AFTER;
        const x = at0.x + rx * lat, z = at0.y + ry * lat;
        poses.push({
          id: b,
          kind: 'boat',
          x,
          y: this.top(-1 - b, x, z, water),
          z,
          heading,
          len: TOUR_L,
          lit,
          underway: tr.on >= 0,
        });
      }
    }

    this.previousPoses = reset || newDay ? [] : this.currentPoses;
    this.currentPoses = poses;
  }
}
