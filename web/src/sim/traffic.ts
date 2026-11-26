// The street traffic as a world sim: headless (no three.js, no DOM, no camera: tools/core-deps.mjs), on a fixed tick
// (STEP), drawing from a seeded random number generator, so a server could run it and two runs from one seed are the
// same. view/life.ts (StreetLife) is its presentation: it draws what is here, between the last two ticks.
//
// Live streets on the real OSM networks (scripts/traffic.py): fixed-time signals; cars with the Intelligent Driver
// Model per lane, turn lanes, OSM turn restrictions and junction "box" locks; people on footpaths, waiting for green
// at signalled crossings. Density follows the hour. Near player edits some cars are physical bodies (`bodies`:
// physics/rapier/life-phys.ts, stepped in the tick), and the people over a hole fall (`dropped`: drawn falling).
import { pushTo, rng, type Rng } from '../core/num';
import { BoatTraffic, type BoatData, type InTheWay } from './boat-traffic';
import type { WaterColumns } from './river';
import { TrainTraffic } from './train-traffic';
import { trafficType, VEHICLES } from './vehicles';
import { at, cellKey, farFrom, landingLane, pt, Turn, turnOf, type Pt, type Viewer } from './path';
import { ACTIVE_CELL, ACTIVE_R, activeKey, BLEND, CAR_POP_R, laneOffset, PED_POP_R, PH_RIDE, PH_WALK, pedGreen, RoadNet, signalAt, STEP, type CarPose, type Ground } from './road-net';
import type { Agent, Car, Controller, PedEdge, Road, TrafficData } from './types';

export { STEP, type CarPose, type Ground } from './road-net';
import { MAX_BIKES, MAX_CARS, MAX_PEOPLE, type BodyDraw, type Person } from './contract/agents';
import type { Fallen } from './contract/events';
import type { RoadPose } from './contract/pose';

const IDM = { a: 1.4, b: 2.2, s0: 2.2, T: 1.2 };
const BOX_IN = 7, BOX_OUT = 9;
// a focus moved more than its circle's radius over this at once (or is new): its circle is filled anew at once, near
// it too (not in sight of the other players)
const JUMP_F = 0.5;
// a focus moved this far (m) from where its circle was placed: the circles are placed anew
const MOVE_R = 120;
const CAR_COLOURS = ['#f0f0ee', '#e9e9e7', '#1c1c1e', '#2a2c30', '#8e9399', '#b9bcc0', '#5d6670', '#9b2a24', '#24467a', '#3d5a3a', '#c9b48e', '#6e1f2a'];
const SHIRTS = ['#c8553d', '#3d6fa8', '#e8e3d6', '#2f2f33', '#7a9a5b', '#d9a441', '#8b5fa8', '#5a8fa3', '#b03a48', '#f0f0f0', '#45505c', '#c97f5d'];
const SOFT = ['spatial', 'box-busy', 'no-room-exit', 'hold-at-line', 'next-edge-car'];
// What one player's circle may hold at most: above what the busiest circle of the map wants at its peak hour at
// 900 m (so a player alone is never cut), well under the meshes' caps (MAX_CARS, ...), which bound all players
// together; more players than those fit get thinner streets each (populate), never more agents.
const BUDGET = { cars: 700, peds: 800, bikes: 80 };
// the cars parked by the player (detachCar) kept: the oldest of more than PARKED goes once CAR_POP_R from the viewer,
// never more than PARKED_MAX
const PARKED = 8, PARKED_MAX = 24;
// Player edits (core/live-edits.ts, told by edited()): the paths' heights are baked (scripts/traffic.py), so only
// where the city was edited is the ground under a person looked at (Ground.support): more than HOLE m under their
// path's height and they fall (dropped: drawn falling, view/life.ts). The cars there are bodies (life-phys.ts): theirs fall.
// Nothing edited: nothing looked at.
const HOLE = 1;

export const DEFAULT_SEED = 1;

/** a person fallen out of the crowd as the events name it (struck, dropped: contract/events.ts): by id, with what its
 * fall is drawn with */
export const fallen = (p: Person): Fallen => ({ person: p.id, col: p.col, bike: !!p.bike });

// Physical bodies for some cars (physics/rapier/life-phys.ts): tick() in the traffic's tick, after the cars moved (it
// may slow a car whose body is held up: its ghost waits); owns(c): c has a body; pose(c, a, under): the presentation's
// (view/life.ts, which keeps it): the pose drawn between the last two ticks (a: 0 at the last but one, 1 at the last),
// where its body is, else under (its kinematic pose; for a parked car, where it was drawn last).
export interface TrafficBodies {
  beforeTick?(traffic: Traffic): void;
  tick(dt: number, traffic: Traffic): void;
  owns(c: Car): boolean;
  controlled?(c: Car): boolean;
  /** the drawn pose of car c (a: between the last two ticks; under: what it is drawn at without a body, the path's
   * pose for a car in the traffic, the last drawn otherwise): under itself, or a pose of its own (read it, copy it) */
  pose(c: Car, a: number, under: RoadPose): RoadPose;
  /** what pose(c, a) draws from, for a client's copy of the traffic (client/sim-client.ts TrafficMirror); null: nothing (its path's pose) */
  drawState?(c: Car): BodyDraw | null;
}

// (a car's body as drawn, BodyDraw: contract/agents.ts; drawn by sim/body-pose.ts)

export type Density = { cars: number; peds: number; bikes: number };

/** a player's view as the traffic takes it: who (kept from frame to frame), the middle of their circle, where they see
 * from (without: the focus, on the ground) */
export interface Focus { id: unknown; focus: { x: number; z: number }; viewer?: Viewer }

// One player's circle: its middle, its viewer, the ways it owns (those in no earlier player's circle: overlapping
// circles are counted once) with the weights to pick them by, its agents counted and wanted this tick; warm: to be
// filled at once (new, or jumped)
interface Region {
  x: number; z: number; viewer: Viewer; warm: boolean;
  roadAct: number[]; roadW: number[]; sources: number[]; laneKm: number;
  pedAct: number[]; pedW: number[]; pedKm: number; bikeAct: number[]; bikeW: number[]; bikeKm: number;
  cars: number; people: number; riders: number; targetCars: number;
}

export class Traffic {
  // the roads, footways and signals, and where on them the agents are drawn (shared with the client's mirror)
  readonly net: RoadNet;
  get ground() { return this.net.ground; }
  set ground(g: Ground | null) { this.net.ground = g; }
  // the world's water columns the boats float on (sim/river.ts; world.ts World); null: none, at a fixed top
  water: WaterColumns | null = null;
  // the entities players follow or control (sim/world-sim.ts WorldSim: follow, enterSeat), by id: kept in the sim
  // wherever they are (not removed out of the circle, trimmed, dropped into a hole or knocked down)
  readonly held = { car: new Set<number>(), person: new Set<number>() };
  // the people a player walks as (WorldSim enterSeat, a walker's; among held): where the player puts them, off their way
  readonly walked = new Set<number>();
  bodies: TrafficBodies | null = null;
  readonly roads: Road[];
  readonly peds: PedEdge[];
  readonly ctrls: Controller[];
  // the signal heads ([x, z, ground, rotation, controller, axis]: drawn by view/life.ts, their lights from signal())
  readonly heads: NonNullable<TrafficData['heads']>;
  readonly trains: TrainTraffic;
  private boatTraffic: BoatTraffic | null = null;
  /** whether something the river's vessels give way to is in a vessel's way (WorldSim's: the crafts) */
  inTheWay: InTheWay = () => false;
  readonly cars: Car[] = [];
  readonly detachedCars: Car[] = [];
  people: Person[] = [];
  riders: Person[] = [];
  // the people fallen into a hole and knocked down (by a driven car: life-phys.ts) in the ticks since the world sim
  // last took them (WorldSim.update: its events)
  dropped: ({ tick: number } & Fallen)[] = [];
  struck: ({ tick: number; pose: RoadPose; vx: number; vz: number; by: number } & Fallen)[] = [];
  tickNumber = 0;
  // the boxes edited (map metres [x0, z0, x1, z1), a metre round): only an agent in one has its ground looked at
  edits: [number, number, number, number][] = [];
  day = 180;
  /** the share of the hour's people and riders wanted (1: all): a host over its tick thins its crowd first */
  crowd = 1;
  /** the share of the hour's cars wanted (1: all): a host still over its tick with its crowd thinned thins its cars;
   * those over it leave at a road's end out of sight (never one followed or a body in play; one driven is not in cars) */
  carShare = 1;
  t = 0;
  // the time since the last tick (s, under STEP): how far between the last two ticks to draw; kept by whoever runs the
  // ticks (sim/world-sim.ts WorldSim.update; update here for a traffic run alone)
  acc = 0;
  private readonly rand: Rng;
  private readonly outs = new Map<number, number[]>();
  private readonly ins = new Map<number, number[]>();
  private readonly padj = new Map<number, [number, number][]>();
  private readonly restr = new Map<string, { to: number; type: string }[]>();
  private readonly box = new Map<number, Set<Car>>();
  // the players' circles, in the order of the views given (an agent's region: the owner of its way), and by id
  private regions: Region[] = [];
  private regionOf = new Map<unknown, Region>();
  // where the players see from (their cameras): agents come and go only far from all of them
  private viewers: Viewer[] = [];
  // the viewers of the circles not being filled at once (populate)
  private settled: Viewer[] = [];
  // the ways' owners (an index into regions; -1: in no circle), and whether they are in one
  private roadOwner = new Int32Array(0);
  private pedOwner = new Int32Array(0);
  private roadOn: boolean[] = [];
  private pedOn: boolean[] = [];
  // the roads and footways by ACTIVE_CELL m cell of their ends and middle, for setActive (built on its first call)
  private wayGrid: { roads: Map<number, number[]>; peds: Map<number, number[]> } | null = null;
  private carGrid = new Map<number, Car[]>();
  private idSeq = 1;
  // the people's and riders' ids (apart from the cars', whose ids pick their type: trafficType)
  private personSeq = 1;
  // scratch points
  private readonly tmp = pt();
  private readonly sP = pt();
  private readonly sF = pt();
  private readonly sC = pt();
  private readonly pA = pt();

  /** activeR: the radius (m) of each player's circle */
  constructor(data: TrafficData, private readonly seed = DEFAULT_SEED, readonly activeR = ACTIVE_R) {
    this.rand = rng(seed);
    // At the default seed, keep the original train and boat timetables.
    this.trains = new TrainTraffic(data.trains ?? [], (seed >>> 0) - DEFAULT_SEED);
    this.net = new RoadNet(data);
    ({ roads: this.roads, peds: this.peds, ctrls: this.ctrls, heads: this.heads } = this.net);
    this.roads.forEach((e, i) => { pushTo(this.outs, e.a, i); pushTo(this.ins, e.b, i); });
    this.peds.forEach((e, i) => { pushTo(this.padj, e.a, [i, 0]); pushTo(this.padj, e.b, [i, 1]); });
    for (const [fr, via, to, type] of data.restr ?? []) pushTo(this.restr, `${fr}:${via}`, { to, type });
  }

  get boats() { return this.boatTraffic; }

  setBoats(data: BoatData) {
    this.boatTraffic = new BoatTraffic(data, (this.seed >>> 0) - DEFAULT_SEED);
  }

  private pick(w: number[], sum = w.reduce((a, b) => a + b, 0)) {
    let r = this.rand() * sum;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
    return w.length - 1;
  }
  private anyOf<T>(a: T[]) { return a[(this.rand() * a.length) | 0]; }

  // The ticks due after dt s (at most 0.1 s of them), for a traffic run alone (the world sim runs its own: frame,
  // tick). focus: the middle of what is simulated (the active circle: what is looked at); viewer: where it is seen from (the
  // camera; by default the focus, on the ground), what agents come and go far from.
  update(dt: number, hour: number, focus: { x: number; z: number }, viewer: Viewer = focus) {
    const density = this.frame(hour, [{ id: 0, focus, viewer }]);
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= STEP) { this.tick(density, hour); this.acc -= STEP; }
  }

  /** a frame's own part, before its ticks: the active circles round the players' foci, their viewers, the hour's
   * density (what the frame's ticks populate to); a circle new or jumped is filled at once. No views: no one looks
   * (the circles and the viewers kept where they were) */
  frame(hour: number, views: readonly Focus[]): Density {
    if (views.length) {
      let place = views.length !== this.regions.length;
      const jump = (this.activeR * JUMP_F) ** 2;
      const next = views.map(({ id, focus: f, viewer }, i) => {
        let r = this.regionOf.get(id);
        const d2 = r ? (r.x - f.x) ** 2 + (r.z - f.z) ** 2 : Infinity, v: Viewer = viewer ?? f;
        r ??= { x: f.x, z: f.z, viewer: v, warm: true, roadAct: [], roadW: [], sources: [], laneKm: 0, pedAct: [], pedW: [],
          pedKm: 0, bikeAct: [], bikeW: [], bikeKm: 0, cars: 0, people: 0, riders: 0, targetCars: 0 };
        r.viewer = { x: v.x, z: v.z, y: v.y };
        if (d2 > jump) r.warm = true;
        if (d2 > MOVE_R * MOVE_R || this.regions[i] !== r) place = true;
        return [r, f] as const;
      });
      this.viewers = next.map(([r]) => r.viewer);
      if (place) {
        for (const [r, f] of next) { r.x = f.x; r.z = f.z; }
        this.regionOf = new Map(views.map((v, i) => [v.id, next[i][0]]));
        this.setActive(next.map(([r]) => r));
      }
    }
    const hh = ((hour % 24) + 24) % 24;
    const bell = (c: number, w: number) => Math.exp(-(((hh - c) / w) ** 2));
    const density = {
      cars: Math.min(1, 0.18 + 0.55 * bell(8, 2.2) + 0.5 * bell(17, 2.6) + 0.45 * bell(13, 5)) * this.carShare,
      peds: Math.min(1, 0.08 + 0.4 * bell(8.5, 1.8) + 0.85 * bell(16, 4.5) + 0.25 * bell(21, 2)) * this.crowd,
      // the counters' day: the commute to work and home, a lunch hump, little at night; a fifth of July's in January
      bikes: (0.03 + 0.85 * bell(8, 1.4) + 1.0 * bell(17, 2.0) + 0.35 * bell(13, 3))
        * (0.2 + 0.4 * (1 - Math.cos(2 * Math.PI * (this.day - 15) / 365))) * this.crowd,
    };
    if (this.regions.some((r) => r.warm)) this.populate(density); // (drawn this frame)
    return density;
  }

  /** one tick (STEP s) at the frame's density and hour */
  tick(density: Density, hour: number) { this.step(STEP, density, hour); }

  // a signal's state now: green, amber, red
  signal(ctrl: number, axis: number) { return signalAt(this.ctrls[ctrl], this.t, axis); }

  // ------------------------------------------------------------------ the areas around the players
  // Only circles round the foci are simulated: roads leaving them are exits, roads entering them are sources, and
  // agents left outside are removed. A way in several circles is the first's: what overlaps is counted once.
  // (the ways looked at are those with an end or the middle in the cells a circle touches, not all of the map's)
  private setActive(regions: Region[]) {
    const R = this.activeR, probes = (e: { p: number[][] }) => [e.p[0], e.p[e.p.length >> 1], e.p[e.p.length - 1]];
    const C = ACTIVE_CELL, key = activeKey;
    if (!this.wayGrid) {
      const index = (ways: { p: number[][] }[]) => {
        const g = new Map<number, number[]>();
        ways.forEach((e, i) => { for (const k of new Set(probes(e).map((q) => key(Math.floor(q[0] / C), Math.floor(q[1] / C))))) pushTo(g, k, i); });
        return g;
      };
      this.wayGrid = { roads: index(this.roads), peds: index(this.peds) };
      this.roadOwner = new Int32Array(this.roads.length);
      this.pedOwner = new Int32Array(this.peds.length);
    }
    this.roadOwner.fill(-1);
    this.pedOwner.fill(-1);
    const claim = (g: Map<number, number[]>, ways: { p: number[][] }[], owner: Int32Array, f: number, x: number, z: number) => {
      const out: number[] = [];
      const near = (e: { p: number[][] }) => probes(e).some((q) => (q[0] - x) ** 2 + (q[1] - z) ** 2 < R * R);
      for (let cy = Math.floor((z - R) / C); cy <= Math.floor((z + R) / C); cy++)
        for (let cx = Math.floor((x - R) / C); cx <= Math.floor((x + R) / C); cx++)
          for (const i of g.get(key(cx, cy)) ?? []) if (owner[i] < 0 && near(ways[i])) { owner[i] = f; out.push(i); }
      return out.sort((a, b) => a - b);
    };
    regions.forEach((r, f) => {
      r.roadAct = claim(this.wayGrid!.roads, this.roads, this.roadOwner, f, r.x, r.z);
      r.pedAct = claim(this.wayGrid!.peds, this.peds, this.pedOwner, f, r.x, r.z);
    });
    this.roadOn = Array.from(this.roadOwner, (o) => o >= 0);
    this.pedOn = Array.from(this.pedOwner, (o) => o >= 0);
    for (const r of regions) {
      r.roadW = r.roadAct.map((i) => { const e = this.roads[i]; return e.L * e.lanes * e.c; });
      r.laneKm = r.roadAct.reduce((a, i) => a + this.roads[i].L * this.roads[i].lanes, 0) / 1000;
      r.sources = r.roadAct.filter((i) => { const e = this.roads[i]; return e.L > 15 && !(this.ins.get(e.a) ?? []).some((j) => this.roadOn[j]); });
      r.pedW = r.pedAct.map((i) => this.peds[i].L * this.peds[i].w);
      r.pedKm = r.pedAct.reduce((a, i) => a + this.peds[i].L, 0) / 1000;
      r.bikeAct = r.pedAct.filter((i) => this.peds[i].bk);
      r.bikeW = r.bikeAct.map((i) => this.peds[i].L * this.peds[i].bk!);
      r.bikeKm = r.bikeW.reduce((a, w) => a + w, 0) / 1000;
    }
    this.regions = regions;
    this.riders = this.riders.filter((p) => this.pedOn[p.e]);
    const out = new Set(this.cars.filter((c) => !this.roadOn[c.e] && !this.held.car.has(c.id)));
    for (const c of out) this.removeCar(c);
    if (out.size) this.cars.splice(0, this.cars.length, ...this.cars.filter((c) => !out.has(c)));
    this.people = this.people.filter((p) => this.pedOn[p.e] || this.held.person.has(p.id));
  }


  // ------------------------------------------------------------------ spawning
  // is (x, y) at height z at least r m from every viewer (where an agent may come or go)?
  private far(x: number, y: number, z: number, r: number, viewers = this.viewers) {
    for (const v of viewers) if (!farFrom(v, x, y, z, r)) return false;
    return true;
  }

  // may an agent of region r appear at (x, y, z)? Out of every player's sight; while r is filled at once, out of sight
  // of the players whose circles are not (r's own player has just arrived: theirs fills at once)
  private mayAppear(r: Region, x: number, y: number, z: number, R: number) {
    return this.far(x, y, z, R, r.warm ? this.settled : this.viewers);
  }

  private spawnCar(r: Region, fromSource: boolean) {
    const ei = fromSource && r.sources.length ? this.anyOf(r.sources) : r.roadAct[this.pick(r.roadW)];
    const e = this.roads[ei], lane = (this.rand() * e.lanes) | 0;
    const s = fromSource ? 0 : 10 + this.rand() * Math.max(0, e.L - 20 - BOX_IN - 12);
    if (s > e.L - BOX_IN - 12 || !this.laneGapOK(e, lane, s, null)) return false;
    const P = at(e, s, 0, this.tmp);
    if (!this.mayAppear(r, P.x, P.y, P.z, CAR_POP_R)) return false;
    const bus = e.c >= 2 && this.rand() < 0.06, id = this.idSeq++, vt = bus ? undefined : trafficType(id);
    const car: Car = {
      kind: 'car', id, e: ei, lane, s, v: e.v * 0.6, len: bus ? 12 : VEHICLES[vt!].len, bus, prev: -1, prevOff: 0, next: -1,
      v0f: 0.85 + this.rand() * 0.25, col: bus ? '#f2c230' : this.anyOf(CAR_COLOURS),
      off: laneOffset(e, lane), brake: 0, wait: 0, ghost: 0, ds: 0, dOff: 0, why: 'free', by: null,
      boxNode: -1, boxFrom: -1, boxTo: -1, boxLane: 0, boxT: 0, boxTurn: 0, block: null,
      geo: { px: 0, py: 0, cx: 0, cy: 0, z: 0, fx: 0, fy: 0 },
    };
    if (vt !== 'car') car.vt = vt;
    this.setNext(car, this.chooseNext(e));
    e.lists[lane].push(car);
    this.cars.push(car);
    return true;
  }

  private spawnPed(r: Region) {
    const ei = r.pedAct[this.pick(r.pedW)], e = this.peds[ei], s = this.rand() * e.L;
    const P = at(e, s, 0, this.tmp);
    if (!this.mayAppear(r, P.x, P.y, P.z, PED_POP_R)) return false;
    this.people.push({ kind: 'person', id: this.personSeq++, e: ei, dir: this.rand() < 0.5 ? 1 : -1, s, v: 1.05 + this.rand() * 0.55,
      lat: 0.35 + this.rand() * 1.0, ph: this.rand() * 6.28, wait: false, col: this.anyOf(SHIRTS) });
    return true;
  }

  private spawnRider(r: Region) {
    const ei = r.bikeAct[this.pick(r.bikeW)], e = this.peds[ei];
    if (!e || !e.bk) return false;
    const s = this.rand() * e.L;
    const P = at(e, s, 0, this.tmp);
    if (!this.mayAppear(r, P.x, P.y, P.z, PED_POP_R)) return false;
    this.riders.push({ kind: 'person', id: this.personSeq++, e: ei, dir: this.rand() < 0.5 ? 1 : -1, s, v: 4 + this.rand() * 1.8,
      lat: 0.45 + this.rand() * 0.3, ph: this.rand() * 6.28, wait: false, bike: true, col: this.anyOf(SHIRTS) });
    return true;
  }

  // ------------------------------------------------------------------ routing

  private chooseNext(e: Road) {
    const all = (this.outs.get(e.b) ?? []).filter((j) => this.roadOn[j]);
    let outs = all.filter((j) => { const o = this.roads[j]; return turnOf(e, o) !== Turn.Back && !(o.b === e.a && o.w === e.w); });
    for (const r of this.restr.get(`${e.w}:${e.b}`) ?? []) {
      if (r.type.startsWith('only_')) outs = outs.filter((j) => this.roads[j].w === r.to);
      else if (r.type.startsWith('no_')) outs = outs.filter((j) => this.roads[j].w !== r.to);
    }
    // a dead end (nothing on but back): turn there rather than vanish
    if (!outs.length && all.length) outs = all;
    if (!outs.length) return -1;
    return outs[this.pick(outs.map((j) => { const o = this.roads[j]; return (turnOf(e, o) === Turn.Straight ? 4 : 1) * o.c * (o.L > 6 ? 1 : 0.3); }))];
  }

  // the road a car on e takes next, and (when that one is too short to blend across on its own) the one after it, chosen
  // now: carPoint blends into both before the car gets there
  private setNext(car: Car, next: number) {
    car.next = next;
    car.next2 = next >= 0 && this.roads[next].L < BLEND ? this.chooseNext(this.roads[next]) : -1;
  }

  private nextTurn(car: Car, e: Road) { return car.next >= 0 ? turnOf(e, this.roads[car.next]) : Turn.Straight; }

  private desiredLane(car: Car, e: Road) {
    if (car.next < 0 || e.lanes === 1) return car.lane;
    const t = this.nextTurn(car, e);
    return t === Turn.Left ? 0 : t === Turn.Right ? e.lanes - 1 : car.lane;
  }

  private laneGapOK(e: Road, lane: number, s: number, car: Car | null) {
    const myLen = car ? car.len : 4.6;
    if (e.lists[lane].some((o) => o !== car && o.s > s - myLen - 5 && o.s - o.len < s + 7)) return false;
    return !e.lists.some((l) => l.some((o) => o !== car && o.lcTo === lane && Math.abs(o.s - s) < 12));
  }

  private removeCar(c: Car) {
    const l = this.roads[c.e].lists[c.lane];
    l.splice(l.indexOf(c), 1);
    this.boxLeave(c);
  }

  // ------------------------------------------------------------------ junction box
  // May this car enter junction n now? Fine alongside: the same approach in lanes ordered like their turns, parallel
  // approaches, opposite flows that don't turn left; never two into the same road at once.
  private boxBlocker(car: Car, e: Road, n: number): Car | null {
    const myTurn = this.nextTurn(car, e);
    for (const h of this.box.get(n) ?? []) {
      if (h === car) continue;
      if (h.boxFrom === e.i) {
        const dl = car.lane - h.boxLane, dt = myTurn - h.boxTurn;
        if (dl === 0) continue;
        if (dl * dt < 0) return h;
        if (h.boxTo === car.next && car.next >= 0) {
          const lanes = this.roads[car.next].lanes;
          if (landingLane(myTurn, car.lane, lanes) === landingLane(h.boxTurn as Turn, h.boxLane, lanes)) return h;
        }
        continue;
      }
      if (h.boxTo === car.next && car.next >= 0) return h;
      const he = this.roads[h.boxFrom], dot = he.endD[0] * e.endD[0] + he.endD[1] * e.endD[1];
      if (dot > 0.75) continue;
      if (dot < -0.75 && myTurn !== Turn.Left && h.boxTurn !== Turn.Left) continue;
      return h;
    }
    return null;
  }

  private boxEnter(car: Car, e: Road, n: number) {
    Object.assign(car, { boxNode: n, boxFrom: e.i, boxTo: car.next, boxLane: car.lane, boxT: this.t, boxTurn: this.nextTurn(car, e) });
    const set = this.box.get(n) ?? new Set<Car>();
    this.box.set(n, set.add(car));
  }

  private boxLeave(car: Car) {
    if (car.boxNode >= 0) { this.box.get(car.boxNode)?.delete(car); car.boxNode = -1; }
  }

  // ------------------------------------------------------------------ what a car must keep its distance to
  private carObstacle(car: Car, e: Road): [number, number] {
    let gap = Infinity, lv = 0, why = 'free', by: Agent | null = null;
    const stop = (d: number, reason: string, who: Agent | null, speed = 0) => { if (d < gap) { gap = Math.max(d, 0.01); lv = speed; why = reason; by = who; } };
    const assertive = car.ghost > 0;
    const ig = car.ignore && (car.ignoreT ?? 0) > this.t ? car.ignore : null;
    const lead = (o: Car, g: number) => { if (!(o === ig && o.e !== car.e) && g < gap) { gap = g; lv = o.v; why = o.e === car.e ? 'leader' : 'next-edge-car'; by = o; } };
    for (const o of e.lists[car.lane]) if (o !== car && o.s > car.s) lead(o, o.s - o.len - car.s);
    for (let l = 0; l < e.lanes; l++) {
      if (l === car.lane) continue;
      for (const o of e.lists[l]) if (o.s > car.s && (o.lcTo === car.lane || car.lcTo === l)) lead(o, o.s - o.len - car.s);
    }
    const turn = this.nextTurn(car, e), nextRoad = car.next >= 0 ? this.roads[car.next] : null;
    const nextLane = nextRoad ? landingLane(turn, car.lane, nextRoad.lanes) : 0;
    if (nextRoad) for (let l = 0; l < nextRoad.lanes; l++) for (const o of nextRoad.lists[l]) {
      if ((l === nextLane || o.lcTo === nextLane) && o.s < 30) lead(o, e.L - car.s + o.s - o.len);
    }
    if (!nextRoad && e.L - car.s < 40 && !this.mayLeave(car, e)) stop(e.L - car.s - 0.5, 'dead-end', null);
    const sg = e.sig;
    if (sg && car.s < sg.s + 0.3) {
      const st = signalAt(this.ctrls[sg.ctrl], this.t, sg.axis), d = sg.s - car.s;
      if (st === 'R' || (st === 'Y' && d > (car.v * car.v) / (2 * IDM.b) + 1)) stop(d, 'signal', null);
    }
    const nearJunction = nextRoad && car.boxNode !== e.b && e.L - car.s < BOX_IN + 15;
    if (nearJunction && !assertive) { // only into the junction with room to clear it on the exit road
      let room = Infinity, rb: Car | null = null;
      for (const o of nextRoad.lists[nextLane]) if (o.v < 2 && o.s - o.len < room) { room = o.s - o.len; rb = o; }
      if (room < car.len + 2 && nextRoad.L > car.len + 4 && rb !== ig) stop(e.L - BOX_IN - car.s, 'no-room-exit', rb);
    }
    const b = car.block;
    if (b && b.o !== ig) { // physical blocker; circular waits are broken after 6 s when the blocker is stuck too
      const align = b.o.geo.fx * car.geo.fx + b.o.geo.fy * car.geo.fy, sameDir = align > 0.7;
      if ((sameDir || !assertive) && !(car.wait > 6 && b.o.wait > 3 && !sameDir)) stop(b.gap, 'spatial', b.o, b.o.v * Math.max(0, align));
    }
    if (nearJunction && !assertive) {
      const blocker = this.boxBlocker(car, e, e.b);
      if (blocker && car.wait <= 10 && !(ig && blocker === ig)) stop(e.L - BOX_IN - car.s, 'box-busy', blocker);
    }
    car.why = assertive && why === 'free' ? 'assertive' : why;
    car.by = by;
    return [gap, lv];
  }

  // Every waiting agent waits for one other (by), so cycles are cheap to find; in each, the one with the softest
  // reason ignores its blocker for a few seconds.
  private breakDeadlocks() {
    const rank = (a: Agent) => { const i = SOFT.indexOf(a.why); return i < 0 ? 99 : i; };
    const state = new Map<Agent, 1 | 2>();
    for (const a0 of this.cars) {
      if (state.has(a0)) continue;
      const path: Agent[] = [];
      let a: Agent | null = a0;
      while (a && !state.has(a) && a.v < 0.3 && a.by) { state.set(a, 1); path.push(a); a = a.by; }
      if (a && state.get(a) === 1) {
        let best: Agent | null = null;
        for (const m of path.slice(path.indexOf(a))) if (rank(m) < 99 && (!best || rank(m) < rank(best))) best = m;
        if (best) { best.ignore = best.by; best.ignoreT = this.t + 4; }
      }
      for (const p of path) state.set(p, 2);
    }
  }

  // ------------------------------------------------------------------ one tick
  private step(dt: number, density: Density, hour: number) {
    this.t += dt;
    this.tickNumber++;
    this.bodies?.beforeTick?.(this);
    if (((this.t / 0.5) | 0) !== (((this.t - dt) / 0.5) | 0)) this.breakDeadlocks();
    this.populate(density);
    this.snapshot();
    if (this.edits.length) this.dropOverHoles();
    this.stepCars(dt);
    this.stepPeople(dt);
    this.stepRiders(dt);
    this.trains.tick(this.t, dt, hour, this.viewers);
    this.bodies?.tick(dt, this);
    this.boatTraffic?.tick(this.t, hour, this.day, this.water, this.inTheWay);
  }

  // ------------------------------------------------------------------ player edits
  // Box (map metres [x0, z0, x1, z1)) was edited (core/world-edits.ts, through core/live-edits.ts), or, cleared,
  // is its files' again (the edit dropped): the edits meeting it are forgotten.
  edited(box: [number, number, number, number], cleared = false) {
    if (cleared) this.edits = this.edits.filter((b) => !(b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3]));
    else this.edits.push([box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1]);
  }

  // is (x, z) in an edited box?
  private inEdit(x: number, z: number) { return this.edits.some((b) => x >= b[0] && z >= b[1] && x < b[2] && z < b[3]); }

  // is the ground at (x, z) more than HOLE m under height y, in an edited box?
  private hole(x: number, z: number, y: number) {
    const G = this.ground;
    if (!G || !this.inEdit(x, z)) return false;
    return G.support(x, z, y + 1.5) < y - HOLE;
  }

  // the people and riders over a hole fall (out of the crowd: dropped, drawn falling)
  private dropOverHoles() {
    const P = this.pA, all = this.edits.reduce((u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    const drop = (list: Person[]) => list.filter((p) => {
      if (this.held.person.has(p.id)) return true;
      // (where they are on the map first: their height reads the ground's voxels, every person every tick while an
      // edit stands)
      this.personPoint(p, 0, P, true);
      if (P.x < all[0] || P.y < all[1] || P.x >= all[2] || P.y >= all[3] || !this.inEdit(P.x, P.y)) return true;
      this.personPoint(p, 0, P);
      if (!this.hole(P.x, P.y, P.z)) return true;
      this.dropped.push({ tick: this.tickNumber, ...fallen(p) });
      return false;
    });
    this.people = drop(this.people);
    this.riders = drop(this.riders);
  }

  // As many as the hour wants in each player's circle, a few more a tick out of sight (all at once anywhere in a circle
  // filled at once), and those over it out of sight gone. Each circle wants at most BUDGET; all of them together at
  // most the caps, each cut alike (thinner streets for all, never more agents).
  private populate(density: Density) {
    this.trimParked();
    const R = this.regions;
    for (const r of R) { r.cars = 0; r.people = 0; r.riders = 0; }
    for (const c of this.cars) { const f = this.roadOwner[c.e]; if (f >= 0) R[f].cars++; }
    for (const p of this.people) { const f = this.pedOwner[p.e]; if (f >= 0) R[f].people++; }
    for (const p of this.riders) { const f = this.pedOwner[p.e]; if (f >= 0) R[f].riders++; }
    // at July's evening peak 5 riders a km per unit of weight: 10 a km along a main road (at 5 m/s), 5 on an ordinary
    // bike way
    const targets = (want: (r: Region) => number, budget: number, cap: number) => {
      const t = R.map((r) => Math.min(budget, Math.round(want(r)))), sum = t.reduce((a, b) => a + b, 0);
      return sum > cap ? t.map((n) => Math.floor(n * cap / sum)) : t;
    };
    const tCars = targets((r) => r.laneKm * 9 * density.cars, BUDGET.cars, MAX_CARS - PARKED_MAX);
    const tPeds = targets((r) => r.pedKm * 24 * density.peds, BUDGET.peds, MAX_PEOPLE);
    const tBikes = targets((r) => r.bikeKm * 5 * density.bikes, BUDGET.bikes, MAX_BIKES);
    const n = (r: Region, k: number, target: number) => (r.warm ? 4 * target + 50 : k);
    this.settled = R.filter((r) => !r.warm).map((r) => r.viewer);
    R.forEach((r, f) => {
      const t = r.targetCars = tCars[f];
      for (let k = 0, K = n(r, 6, t); k < K && r.cars < t; k++) if (this.spawnCar(r, !r.warm && r.cars > t * 0.5)) r.cars++;
    });
    R.forEach((r, f) => { for (let k = 0, K = n(r, 40, tPeds[f]); k < K && r.people < tPeds[f]; k++) if (this.spawnPed(r)) r.people++; });
    R.forEach((r, f) => { for (let k = 0, K = n(r, 10, tBikes[f]); k < K && r.riders < tBikes[f]; k++) if (this.spawnRider(r)) r.riders++; });
    for (const r of R) r.warm = false;
    // (the person followed or walked stays in the crowd)
    const over = (count: (r: Region) => number, t: number[]) => R.map((r, f) => count(r) - t[f]);
    const oRiders = over((r) => r.riders, tBikes), oPeople = over((r) => r.people, tPeds);
    if (oRiders.some((o) => o > 0)) this.riders = this.trim(this.riders, oRiders);
    if (oPeople.some((o) => o > 0)) this.people = this.trim(this.people, oPeople);
  }

  // where everything is at the start of the tick: cars in a grid, and who physically blocks whom
  private snapshot() {
    const G = 8;
    this.carGrid = new Map();
    for (const c of this.cars) {
      const P = this.carPoint(c, c.s, this.sP), F = this.carPoint(c, c.s + 1, this.sF), C = this.carPoint(c, c.s - c.len / 2, this.sC);
      const l = Math.hypot(F.x - P.x, F.y - P.y) || 1, g = c.geo;
      g.px = P.x; g.py = P.y; g.cx = C.x; g.cy = C.y; g.z = P.z; g.fx = (F.x - P.x) / l; g.fy = (F.y - P.y) / l;
      c.block = null;
      pushTo(this.carGrid, cellKey(C.x, C.y, G), c);
    }
    for (const c of this.detachedCars) {
      const p = c.detachedPose!;
      const fx = Math.sin(p.h), fy = Math.cos(p.h), g = c.geo;
      g.px = p.x + fx * c.len / 2; g.py = p.z + fy * c.len / 2; g.cx = p.x; g.cy = p.z; g.z = p.y; g.fx = fx; g.fy = fy;
      pushTo(this.carGrid, cellKey(p.x, p.z, G), c);
    }
    for (const c of this.cars) {
      const g0 = c.geo, gx = (g0.px / G) | 0, gy = (g0.py / G) | 0;
      let best = Infinity, who: Car | null = null;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const o of this.carGrid.get((gx + i) * 100003 + (gy + j)) ?? []) {
        if (o === c || Math.abs(o.geo.z - g0.z) > 2) continue;
        const rx = o.geo.cx - g0.px, ry = o.geo.cy - g0.py;
        const along = rx * g0.fx + ry * g0.fy, lat = Math.abs(rx * g0.fy - ry * g0.fx);
        const cosd = Math.abs(o.geo.fx * g0.fx + o.geo.fy * g0.fy), sind = Math.sqrt(Math.max(0, 1 - cosd * cosd));
        const he = (o.len / 2) * cosd + 0.9 * sind, hl = (o.len / 2) * sind + 0.9 * cosd;
        if (lat < 0.95 + hl && along + he > 0.3 && along - he < 12 && along - he - 0.6 < best) { best = along - he - 0.6; who = o; }
      }
      if (who) c.block = { o: who, gap: best };
    }
    for (const c of this.cars) { // both block each other: whoever entered the junction first (else the lower id) goes
      const b = c.block;
      if (b && b.o.block?.o === c) {
        const pc = c.boxNode >= 0 ? c.boxT : Infinity, po = b.o.boxNode >= 0 ? b.o.boxT : Infinity;
        if (pc < po || (pc === po && c.id < b.o.id)) c.block = null;
      }
    }
  }

  private stepCars(dt: number) {
    const removed = new Set<Car>();
    for (const car of this.cars) {
      const e = this.roads[car.e], s0 = car.s, off0 = car.off, e0 = car.e;
      this.changeLane(car, e, dt);
      let v0 = e.v * car.v0f;
      if (car.next >= 0 && e.L - car.s < 30 && this.nextTurn(car, e) !== Turn.Straight) v0 = Math.min(v0, this.nextTurn(car, e) === Turn.Right ? 4.5 : 6);
      const [gap, lv] = this.carObstacle(car, e);
      const ss = IDM.s0 + Math.max(0, car.v * IDM.T + (car.v * (car.v - lv)) / (2 * Math.sqrt(IDM.a * IDM.b)));
      const acc = Math.max(-9, IDM.a * (1 - (car.v / Math.max(v0, 0.1)) ** 4 - (gap === Infinity ? 0 : (ss / Math.max(gap, 0.1)) ** 2)));
      car.brake = acc < -0.8 || car.v < 0.3 ? 1 : 0;
      car.v = Math.max(0, car.v + acc * dt);
      car.wait = car.v < 0.3 ? car.wait + dt : 0;
      // stuck too long for a soft reason: push through for a few metres
      if (car.ghost <= 0 && ((car.wait > 15 && SOFT.slice(0, 4).includes(car.why)) || (car.wait > 25 && SOFT.slice(4).includes(car.why)))) { car.ghost = 8; car.wait = 0; }
      if (car.ghost > 0) { car.ghost -= car.v * dt; if (car.v < 1.5 && gap > 3) car.v = 1.5; }
      car.s += car.v * dt;
      if (car.next >= 0 && car.boxNode !== e.b && e.L - car.s < BOX_IN) { this.boxLeave(car); this.boxEnter(car, e, e.b); }
      if (car.s > e.L && !this.enterNext(car, e, s0)) { removed.add(car); continue; }
      if (car.boxNode >= 0 && car.e !== car.boxFrom && car.s > BOX_OUT) this.boxLeave(car);
      car.ds = car.e === e0 ? car.s - s0 : car.s + e.L - s0;
      car.dOff = car.e === e0 ? car.off - off0 : 0;
    }
    if (removed.size) this.cars.splice(0, this.cars.length, ...this.cars.filter((c) => !removed.has(c)));
  }

  private changeLane(car: Car, e: Road, dt: number) {
    const want = this.desiredLane(car, e);
    if (want !== car.lane && car.lcTo === undefined && car.s > 4 && e.L - car.s > 15) {
      const step = want > car.lane ? 1 : -1;
      if (this.laneGapOK(e, car.lane + step, car.s, car)) car.lcTo = car.lane + step;
    }
    if (car.lcTo === undefined) { car.off += (laneOffset(e, car.lane) - car.off) * Math.min(1, dt * 3); return; }
    const tgt = laneOffset(e, car.lcTo);
    car.off += Math.sign(tgt - car.off) * Math.min(Math.abs(tgt - car.off), 1.4 * dt * Math.max(0.4, Math.min(1, car.v / 5)));
    if (Math.abs(tgt - car.off) < 0.05) {
      const lst = e.lists[car.lane];
      lst.splice(lst.indexOf(car), 1);
      car.lane = car.lcTo; car.lcTo = undefined;
      e.lists[car.lane].push(car);
    }
  }

  // may a car leave the street at the end of road e (out of sight: CAR_POP_R from the viewer)?
  private mayLeave(car: Car, e: Road) { const P = at(e, e.L, car.off, this.tmp); return this.far(P.x, P.y, P.z, CAR_POP_R); }

  // past the end of its road: onto the next one (false: it leaves), or hold at the line if the lane there is full (or
  // there is no way on and it may not leave here)
  private enterNext(car: Car, e: Road, s0: number) {
    const lst = e.lists[car.lane];
    lst.splice(lst.indexOf(car), 1);
    car.lcTo = undefined;
    const r = this.regions[this.roadOwner[e.i]], over = !!r && r.cars > r.targetCars + 4 && !this.held.car.has(car.id) && !this.bodies?.owns(car);
    if ((car.next < 0 || over) && this.mayLeave(car, e)) { this.boxLeave(car); return false; }
    if (car.next < 0) {
      lst.push(car);
      Object.assign(car, { s: e.L - 0.01, v: 0, why: 'dead-end', by: null });
      car.ds = car.s - s0;
      return true;
    }
    const n = this.roads[car.next], lane = landingLane(turnOf(e, n), car.lane, n.lanes);
    const hold = n.lists[lane].find((o) => o.s < car.len + 1.5);
    if (hold && !(car.ignore === hold && (car.ignoreT ?? 0) > this.t)) {
      lst.push(car);
      Object.assign(car, { s: e.L - 0.01, v: 0, why: 'hold-at-line', by: hold });
      car.ds = car.s - s0;
      return true;
    }
    Object.assign(car, { prev2: car.prev, prev2Off: car.prevOff, prev: car.e, prevOff: car.off, s: car.s - e.L, e: car.next, lane, off: laneOffset(n, lane) });
    n.lists[lane].push(car);
    const n2 = car.next2 ?? -1;
    this.setNext(car, n2 >= 0 && this.roadOn[n2] ? n2 : this.chooseNext(n));
    if (n.L < 25 && car.next >= 0) { // too short to change lanes later: take the next turn's lane now if it is free
      const wl = this.desiredLane(car, n);
      if (wl !== car.lane && this.laneGapOK(n, wl, car.s, car)) {
        n.lists[car.lane].splice(n.lists[car.lane].indexOf(car), 1);
        car.lane = wl; // (its offset eases over: changeLane)
        n.lists[wl].push(car);
      }
    }
    return true;
  }

  // the list cut by over[f] in each region f, the newest out of sight PED_POP_R from the viewers first; none closer,
  // nor kept or walked
  private trim(list: Person[], over: number[]) {
    const gone = new Set<Person>(), P = this.pA;
    let left = over.reduce((a, o) => a + Math.max(0, o), 0);
    for (let i = list.length - 1; i >= 0 && left > 0; i--) {
      const p = list[i], f = this.pedOwner[p.e];
      if (this.held.person.has(p.id) || f < 0 || over[f] <= 0) continue;
      this.personPoint(p, 0, P);
      if (this.far(P.x, P.y, P.z, PED_POP_R)) { gone.add(p); over[f]--; left--; }
    }
    return gone.size ? list.filter((p) => !gone.has(p)) : list;
  }

  private stepPeople(dt: number) {
    for (const pe of this.people) {
      if (this.walked.has(pe.id)) continue;
      const e = this.peds[pe.e];
      if (pe.wait) {
        if (!e.x || !pedGreen(this.ctrls[e.x.ctrl], this.t, e.x.axis)) continue;
        pe.wait = false;
      }
      pe.s += pe.v * dt * pe.dir;
      pe.ph += pe.v * dt * PH_WALK;
      if (pe.s >= 0 && pe.s <= e.L) continue;
      const opts = (this.padj.get(pe.s < 0 ? e.a : e.b) ?? []).filter(([j]) => j !== pe.e && this.pedOn[j]);
      if (!opts.length) { pe.dir *= -1; pe.s = Math.min(Math.max(pe.s, 0), e.L); continue; }
      const [j, end] = opts[this.pick(opts.map(([k]) => this.peds[k].w))];
      const n = this.peds[j];
      pe.e = j;
      pe.dir = end === 0 ? 1 : -1;
      pe.s = end === 0 ? 0 : n.L;
      if (n.x && !pedGreen(this.ctrls[n.x.ctrl], this.t, n.x.axis)) pe.wait = true;
    }
  }

  // a rider keeps to the bike ways, the busier more often; off their end (into a street) they are gone, and another
  // starts somewhere else (in sight of the viewer they turn back instead)
  private stepRiders(dt: number) {
    this.riders = this.riders.filter((pe) => {
      const e = this.peds[pe.e];
      if (pe.wait) {
        if (!e.x || !pedGreen(this.ctrls[e.x.ctrl], this.t, e.x.axis)) return true;
        pe.wait = false;
      }
      pe.s += pe.v * dt * pe.dir;
      pe.ph += pe.v * dt * PH_RIDE;
      if (pe.s >= 0 && pe.s <= e.L) return true;
      const opts = (this.padj.get(pe.s < 0 ? e.a : e.b) ?? []).filter(([j]) => j !== pe.e && this.pedOn[j] && this.peds[j].bk);
      if (!opts.length) {
        const P = this.personPoint(pe, 0, this.pA);
        if (this.far(P.x, P.y, P.z, PED_POP_R)) return false;
        pe.dir *= -1; pe.s = Math.min(Math.max(pe.s, 0), e.L);
        return true;
      }
      const [j, end] = opts[this.pick(opts.map(([k]) => this.peds[k].bk! * Math.max(this.peds[k].L, 5)))];
      const n = this.peds[j];
      pe.e = j;
      pe.dir = end === 0 ? 1 : -1;
      pe.s = end === 0 ? 0 : n.L;
      if (n.x && !pedGreen(this.ctrls[n.x.ctrl], this.t, n.x.axis)) pe.wait = true;
      return true;
    });
  }

  // ------------------------------------------------------------------ where things are
  // where things are drawn: sim/road-net.ts RoadNet (the client's mirror draws with the same code)
  private carPoint(car: Car, s: number, out: Pt, off = car.off) { return this.net.carPoint(car, s, out, off); }

  // a car's drawn path (carPoint) at arc length s on its road, for what steers a body along it (TrafficBodies)
  pathPoint(car: Car, s: number, out: Pt, off = car.off) { return this.net.carPoint(car, s, out, off); }

  carPose(c: Car, s: number, off: number, out: CarPose, flat = false) { return this.net.carPose(c, s, off, out, flat); }

  personPoint(p: Person, ds: number, out: Pt, flat = false) { return this.net.personPoint(p, ds, out, flat); }

  // Person p out of the crowd (knocked down: view/life.ts); whether they were in it
  removePerson(p: Person) {
    const list = p.bike ? this.riders : this.people, i = list.indexOf(p);
    if (i < 0 || this.held.person.has(p.id)) return false;
    list.splice(i, 1);
    return true;
  }

  // ------------------------------------------------------------------ following
  roadVehicles(): Car[] { return this.detachedCars.length ? [...this.cars, ...this.detachedCars] : this.cars; }

  detachCar(car: Car, pose: RoadPose) {
    if (this.detachedCars.includes(car)) { car.detachedPose = { ...pose }; return true; }
    const i = this.cars.indexOf(car);
    if (i < 0) return false;
    car.detachedPose = { ...pose };
    this.removeCar(car);
    this.cars.splice(i, 1);
    car.block = null;
    car.by = null;
    car.why = 'free';
    car.wait = 0;
    this.detachedCars.push(car);
    this.trimParked();
    return true;
  }

  /** a parked car (or a wreck) taken out of the world (WorldSim: no player near it) */
  dropParked(car: Car) {
    const i = this.detachedCars.indexOf(car);
    if (i >= 0) this.detachedCars.splice(i, 1);
  }

  // Keep recent player-parked cars around and leave ample room for the traffic fleet: of more than PARKED the oldest
  // out of sight goes (never the one driven or followed); more than PARKED_MAX, the oldest anyway.
  private trimParked() {
    const D = this.detachedCars;
    if (D.length <= PARKED) return;
    const canTrim = (c: Car) => !this.held.car.has(c.id) && !this.bodies?.controlled?.(c);
    let i = D.findIndex((c) => {
      const p = c.detachedPose!;
      return canTrim(c) && this.far(p.x, p.z, p.y, CAR_POP_R);
    });
    if (i < 0 && D.length > PARKED_MAX) i = D.findIndex(canTrim);
    if (i >= 0) D.splice(i, 1);
  }

}
