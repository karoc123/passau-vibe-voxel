// The street traffic as a world sim: headless (no three.js, no DOM, no camera: tools/core-deps.mjs), on a fixed tick
// (STEP), drawing from a seeded random number generator, so a server could run it and two runs from one seed are the
// same. view/life.ts (StreetLife) is its presentation: it draws what is here, between the last two ticks.
//
// Live streets on the real OSM networks (scripts/traffic.py): fixed-time signals; cars with the Intelligent Driver
// Model per lane, turn lanes, OSM turn restrictions and junction "box" locks; people on footpaths, waiting for green
// at signalled crossings. Density follows the hour. Near player edits some cars are physical bodies (`bodies`:
// physics/rapier/life-phys.ts, stepped in the tick), and the people over a hole fall (`dropped`: drawn falling).
import { clamp, pushTo, rng, type Rng } from '../core/num';
import { BoatTraffic, type BoatData, type InTheWay } from './boat-traffic';
import type { WaterColumns } from './river';
import { TrainTraffic } from './train-traffic';
import { trafficType, VEHICLES } from './vehicles';
import { BUS_COLOUR, CAR_COLOURS, carsAt, Flow, PACE, type FlowCar } from './flow';
import { at, cellKey, farFrom, landingLane, pt, Turn, turnOf, type Pt, type Viewer } from './path';
import { ACTIVE_CELL, ACTIVE_R, activeKey, BLEND, CAR_POP_R, laneOffset, PED_POP_R, PH_RIDE, PH_WALK, pedGreen, RoadNet, shiftOff, signalAt, STEP, turnRear, turnTime, type CarPose, type Ground } from './road-net';
import { WALKER_R, type Solid } from './solids';
import type { Agent, Car, Controller, PedEdge, Road, TrafficData } from './types';

export { STEP, type CarPose, type Ground } from './road-net';
import { MAX_BIKES, MAX_CARS, MAX_PEOPLE, type BodyDraw, type Person } from './contract/agents';
import type { Fallen } from './contract/events';
import type { RoadPose } from './contract/pose';
import { EditBoxes } from './edit-boxes';

const IDM = { a: 1.4, b: 2.2, s0: 2.2, T: 1.2 };
const BOX_IN = 7, BOX_OUT = 9;
// a focus moved more than its circle's radius over this at once (or is new): its circle is filled anew at once, near
// it too (not in sight of the other players)
const JUMP_F = 0.5;
// a focus moved this far (m) from where its circle was placed: the circles are placed anew
const MOVE_R = 120;
const SHIRTS = ['#c8553d', '#3d6fa8', '#e8e3d6', '#2f2f33', '#7a9a5b', '#d9a441', '#8b5fa8', '#5a8fa3', '#b03a48', '#f0f0f0', '#45505c', '#c97f5d'];
const SOFT = ['spatial', 'box-busy', 'no-room-exit', 'hold-at-line', 'next-edge-car'];
// What one player's circle may hold at most: above what the busiest circle of the map wants at its peak hour at
// 900 m, more than a circle of 350 m holds (so a player alone is never cut), well under the meshes' caps (MAX_CARS, ...), which bound all players
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
// a walker this far (m) across a car's line (its half width, the walker's, a little room) is in its way
const WALKER_LAT = 0.9 + WALKER_R + 0.3;
// a craft's box this far across a car's line past its own half width, and up to this high over the road, is in its way
const CRAFT_LAT = 0.9 + 0.3, CRAFT_UNDER = 3;
// Something standing in a car's way (a craft, a player on foot, a car out of the traffic) is got past: after PASS_WAIT s
// still behind it the car drives beside it where the road has room (up to PASS_EDGE m beyond its outer lanes' middles,
// the oncoming lanes too) and nothing comes; with no room it turns round after TURN_WAIT s, with room but never clear
// after GIVE_UP s (a way with none back, or a road too narrow for its turn: it leaves once out of sight). Its way is
// then avoided by the routes for BLOCKED s, so the queue behind it does not grow.
const PASS_WAIT = 1.5, PASS_EDGE = 1.2, TURN_WAIT = 4, GIVE_UP = 15, BLOCKED = 30;
// how far on a car that got past needs, at speed, to be back in its lane (kept free by those coming the other way)
const PASS_BACK = 8;
// A car moves across (out beside something, back into its lane) as it rolls on, over SHIFT_K m of road a metre
// across (about 30 degrees at the steepest), at least SHIFT_MIN m: a driver's lane change, never a slide while
// standing. So it stops that much further short of something standing, with room to pull out.
const SHIFT_K = 1.9, SHIFT_MIN = 3;
const shiftLen = (d: number) => Math.max(SHIFT_MIN, SHIFT_K * Math.abs(d));
// a lane change at speed takes about as long as a driver's (a few seconds of road), not the steepest shift
const LC_S = 1.5;
// A car turns round within the road: its body at most TURN_EDGE m beyond the outer lanes' middles (half a lane and a
// verge; else up onto the pavement, as a longer car does on a narrow street), on as wide a circle as fits (TURN_R m)
const TURN_EDGE = [3, 4.5], TURN_R = [6, 5, 4.5, 4, 3.5, 3];
// how far across from its lane a car turned round clears those queued in it (two half widths and a little)
const TURN_CLEAR = 2.1;
const mm = (v: number) => Math.round(v * 1000) / 1000 + 0, cm = (v: number) => Math.round(v * 100) / 100 + 0;

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

/** an upright box (m): its foot's middle, heading, size across (x), up (y) and along (z) */
export interface WallBox { readonly id: string; readonly x: number; readonly y: number; readonly z: number; readonly heading: number;
  readonly size: { readonly x: number; readonly y: number; readonly z: number } }

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
  // the far traffic (the page's to draw), where cars are spawned; its density: the hour's, before any overload cut
  private readonly flow: Flow;
  private flowDensity = 1;
  private readonly flowCar: FlowCar = { lane: 0, s: 0, bus: false, col: '' };
  get ground() { return this.net.ground; }
  set ground(g: Ground | null) { this.net.ground = g; }
  // the world's water columns the boats float on (sim/river.ts; world.ts World); null: none, at a fixed top
  water: WaterColumns | null = null;
  // the entities players follow or control (sim/world-sim.ts WorldSim: follow, enterSeat), by id: kept in the sim
  // wherever they are (not removed out of the circle, trimmed, dropped into a hole or knocked down)
  readonly held = { car: new Set<number>(), person: new Set<number>() };
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
  /** the players on foot, where their walks are this tick (WorldSim's): a car stops for one in its way as for a car */
  walkers: readonly { x: number; y: number; z: number }[] = [];
  /** the crafts' boxes this tick (WorldSim's, sim/solids.ts craftSolids): a car stops for one in its way as for a car */
  crafts: readonly Solid[] = [];
  /** the things the road physics' cars meet as walls it does not move (WorldSim's: the crafts with a shape), upright
   * boxes on their foot */
  walls: () => Iterable<WallBox> = () => [];
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
  readonly editBoxes = new EditBoxes();
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
  // each road's way back (the other direction of its way; -1: one-way), found on first need
  private backOf: Int32Array | null = null;
  // until when each road is avoided by the routes (something standing in it turned a car round)
  private readonly blockedUntil: Float64Array;
  // whether this tick starts a half second (what is looked at less often than every tick)
  private half = false;
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
  // the cars turning round this tick, each with the stretch its turn sweeps (s on its road, and on its way it came by)
  private turning: Car[] = [];
  private readonly zones = new Map<Car, { R: number; lo: number; hi: number; e: number; elo: number; ehi: number }>();
  private readonly sweeps = new Map<string, { ulo: number; uhi: number; vlo: number; vhi: number }>();
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
    this.trains = new TrainTraffic(data.trains ?? []);
    this.net = new RoadNet(data);
    this.flow = new Flow(this.net.roads);
    ({ roads: this.roads, peds: this.peds, ctrls: this.ctrls, heads: this.heads } = this.net);
    this.roads.forEach((e, i) => { pushTo(this.outs, e.a, i); pushTo(this.ins, e.b, i); });
    this.peds.forEach((e, i) => { pushTo(this.padj, e.a, [i, 0]); pushTo(this.padj, e.b, [i, 1]); });
    for (const [fr, via, to, type] of data.restr ?? []) pushTo(this.restr, `${fr}:${via}`, { to, type });
    this.blockedUntil = new Float64Array(this.roads.length);
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
      cars: (this.flowDensity = carsAt(hour)) * this.carShare,
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

  // a car where one of a road's flow cars is now (the same look), so it comes in where the page drew that one: on a
  // road into the circle (fromSource) or anywhere in it; one with no flow car on it now, anywhere along it
  private spawnCar(r: Region, fromSource: boolean) {
    const ei = fromSource && r.sources.length ? this.anyOf(r.sources) : r.roadAct[this.pick(r.roadW)];
    const e = this.roads[ei], n = this.flow.count(ei, this.flowDensity);
    let f: FlowCar;
    if (n > 0) f = this.flow.car(ei, (this.rand() * n) | 0, n, this.t, this.flowCar);
    else {
      const bus = e.c >= 2 && this.rand() < 0.06, vt = bus ? undefined : trafficType(this.idSeq);
      f = { lane: (this.rand() * e.lanes) | 0, s: 10 + this.rand() * Math.max(0, e.L - 20 - BOX_IN - 12), bus, vt, col: bus ? BUS_COLOUR : this.anyOf(CAR_COLOURS) };
    }
    const { lane, s, bus, vt } = f;
    if (s > e.L - BOX_IN - 12 || !this.laneGapOK(e, lane, s, null)) return false;
    const P = at(e, s, 0, this.tmp);
    if (!this.mayAppear(r, P.x, P.y, P.z, CAR_POP_R)) return false;
    const id = this.idSeq++;
    const car: Car = {
      kind: 'car', id, e: ei, lane, s, v: e.v * PACE, len: bus ? 12 : VEHICLES[vt ?? 'car'].len, bus, prev: -1, prevOff: 0, next: -1,
      v0f: 0.85 + this.rand() * 0.25, col: f.col,
      off: laneOffset(e, lane), brake: 0, wait: 0, ghost: 0, ds: 0, dOff: 0, why: 'free', by: null,
      boxNode: -1, boxFrom: -1, boxTo: -1, boxLane: 0, boxT: 0, boxTurn: 0, block: null,
      geo: { px: 0, py: 0, cx: 0, cy: 0, z: 0, fx: 0, fy: 0 },
    };
    if (vt && vt !== 'car') car.vt = vt;
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
    const open = outs.filter((j) => !(this.blockedUntil[j] > this.t));
    if (open.length) outs = open;
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
    // the nearest thing standing in the way stopped for: its middle, its reach along the car's line, the room it needs across
    let standGap = -1, sx = 0, sz = 0, sExt = 0, sNeed = 0;
    // (short of it by the road it takes to pull out beside it)
    // (not the one it is out beside, clear of it across the road: on a bend its line ahead would cut it)
    const standStop = (d0: number, reason: string, x: number, z: number, ext: number, need: number, who: Agent | null = null) => {
      if (car.pass && this.besideClear(car, e, car.s + d0 + ext, x, z)) return;
      const d = d0 - shiftLen(need) - 0.5;
      if (d >= gap) return;
      stop(d, reason, who);
      standGap = gap; sx = x; sz = z; sExt = ext; sNeed = need;
    };
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
    // a car turning round: kept out of the stretch it sweeps, on this road or the next
    for (const o of this.turning) {
      const z = this.zones.get(o);
      if (!z || o === car) continue;
      const k = z.R === e.i ? 0 : z.e === e.i ? 1 : z.R === nextRoad?.i ? 2 : z.e === nextRoad?.i ? 3 : -1;
      if (k < 0) continue;
      const lo = (k & 1 ? z.elo : z.lo) + (k > 1 ? e.L : 0), hi = (k & 1 ? z.ehi : z.hi) + (k > 1 ? e.L : 0);
      if (car.s < lo + 0.5 && car.s - car.len < hi) stop(lo - 1 - car.s, 'turning', o);
    }
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
    // a player on foot in the way (ahead within its width, at its height): stopped for, assertive or not; one higher
    // than a low car's roof is on a roof (its own: driven on with the walker on top) or a bridge
    const g = car.geo;
    for (const w of this.walkers) {
      if (w.y - g.z > 1.2 || g.z - w.y > 2) continue;
      const rx = w.x - g.px, ry = w.z - g.py, along = rx * g.fx + ry * g.fy;
      if (along > -1 && along < 40 && Math.abs(rx * g.fy - ry * g.fx) < WALKER_LAT) standStop(along - WALKER_R, 'walker', w.x, w.z, WALKER_R, WALKER_LAT);
    }
    // a craft in the way (its box's reach along the car's line and across it): stopped for alike
    for (const s of this.crafts) {
      if (s.y > g.z + CRAFT_UNDER || s.y + s.top < g.z) continue;
      const rx = s.x - g.px, ry = s.z - g.py, along = rx * g.fx + ry * g.fy;
      const c = Math.cos(s.h), n = Math.sin(s.h), ca = c * g.fx - n * g.fy, na = n * g.fx + c * g.fy;
      const ea = s.hx * Math.abs(ca) + s.hz * Math.abs(na), el = s.hx * Math.abs(na) + s.hz * Math.abs(ca);
      if (along + ea > -1 && along - ea < 40 && Math.abs(rx * g.fy - ry * g.fx) < el + CRAFT_LAT) standStop(along - ea, 'craft', s.x, s.z, ea, el + CRAFT_LAT);
    }
    // one coming the other way, out beside something on its way back across this car's line: waited for short of
    // where it will be past; so is one that stopped for something standing first and has waited to get past (the
    // earlier, else the one that waited longer), so that the way out beside it stays free (a car never gives way to one
    // that gives way); what that one stands for is kept as what this one stands for, to get past it in turn
    const bi = this.back(e);
    if (bi >= 0) for (const l of this.roads[bi].lists) for (const o of l) {
      if (e.L - o.s <= car.s) continue;
      if (o.pass) {
        if (Math.abs(o.pass.off + car.off) <= 2.1) stop(e.L - (o.pass.far + o.len + 2 + PASS_BACK) - car.s - 3, 'oncoming', null);
      } else if (o.stand && o.v < 0.5 && o.wait > PASS_WAIT && o.why !== 'oncoming' && !car.pass
        && (!car.stand || car.why === 'oncoming' || o.wait > car.wait || (o.wait === car.wait && o.id < car.id))) {
        const w = o.stand, along = (w.x - g.px) * g.fx + (w.z - g.py) * g.fy;
        if (along < 80 && Math.abs((w.x - g.px) * g.fy - (w.z - g.py) * g.fx) < w.need + 1.8)
          standStop(along - w.ext - o.len - 5 - PASS_BACK, 'oncoming', w.x, w.z, w.ext, w.need);
      }
    }
    const b = car.block;
    if (b && b.o.detachedPose) { // a car out of the traffic (parked, a wreck, driven): never pushed through
      const o = b.o.geo, cosd = Math.abs(o.fx * g.fx + o.fy * g.fy), sind = Math.sqrt(Math.max(0, 1 - cosd * cosd));
      standStop(b.gap, 'spatial', o.cx, o.cy, (b.o.len / 2) * cosd + 0.9 * sind, 0.95 + (b.o.len / 2) * sind + 0.9 * cosd, b.o);
    } else if (b && b.o !== ig) { // physical blocker; circular waits are broken after 6 s when the blocker is stuck too
      const align = b.o.geo.fx * car.geo.fx + b.o.geo.fy * car.geo.fy, sameDir = align > 0.7;
      if ((sameDir || !assertive) && !(car.wait > 6 && b.o.wait > 3 && !sameDir)) stop(b.gap, 'spatial', b.o, b.o.v * Math.max(0, align));
    }
    if (nearJunction && !assertive) {
      const blocker = this.boxBlocker(car, e, e.b);
      if (blocker && car.wait <= 10 && !(ig && blocker === ig)) stop(e.L - BOX_IN - car.s, 'box-busy', blocker);
    }
    car.why = assertive && why === 'free' ? 'assertive' : why;
    car.by = by;
    if (standGap === gap) Object.assign(car.stand ??= { x: 0, z: 0, ext: 0, need: 0 }, { x: sx, z: sz, ext: sExt, need: sNeed });
    // (held by one coming the other way, out beside it or back from it: what it stands behind is still there)
    else if (!(why === 'oncoming' || (why === 'spatial' && bi >= 0 && (by as Car | null)?.e === bi))) car.stand = null;
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
    this.net.clock = this.t;
    this.tickNumber++;
    this.bodies?.beforeTick?.(this);
    this.half = ((this.t / 0.5) | 0) !== (((this.t - dt) / 0.5) | 0);
    if (this.half) this.breakDeadlocks();
    this.populate(density);
    this.snapshot();
    if (this.editBoxes.length) this.dropOverHoles();
    this.stepCars(dt);
    this.stepPeople(dt);
    this.stepRiders(dt);
    this.trains.tick(this.t, hour);
    this.bodies?.tick(dt, this);
    this.boatTraffic?.tick(this.t, hour, this.day, this.water, this.inTheWay);
  }

  // ------------------------------------------------------------------ player edits
  // Box (map metres [x0, z0, x1, z1)) was edited (core/world-edits.ts, through core/live-edits.ts), or, cleared,
  // is its files' again (the edit dropped): the edits meeting it are forgotten.
  edited(box: [number, number, number, number], cleared = false) {
    if (cleared) this.editBoxes.clear(box);
    else this.editBoxes.add([box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1]);
  }

  /** the boxes edited, as edited() was told of them */
  get edits() { return this.editBoxes.all; }

  // is (x, z) in an edited box?
  private inEdit(x: number, z: number) { return this.editBoxes.has(x, z); }

  // is the ground at (x, z) more than HOLE m under height y, in an edited box?
  private hole(x: number, z: number, y: number) {
    const G = this.ground;
    if (!G || !this.inEdit(x, z)) return false;
    return G.support(x, z, y + 1.5) < y - HOLE;
  }

  // the people and riders over a hole fall (out of the crowd: dropped, drawn falling)
  private dropOverHoles() {
    const P = this.pA, all = this.editBoxes.bounds;
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
    // (the person followed stays in the crowd)
    const over = (count: (r: Region) => number, t: number[]) => R.map((r, f) => count(r) - t[f]);
    const oRiders = over((r) => r.riders, tBikes), oPeople = over((r) => r.people, tPeds);
    if (oRiders.some((o) => o > 0)) this.riders = this.trim(this.riders, oRiders);
    if (oPeople.some((o) => o > 0)) this.people = this.trim(this.people, oPeople);
  }

  // where everything is at the start of the tick: cars in a grid, and who physically blocks whom
  private snapshot() {
    const G = 8;
    this.carGrid = new Map();
    this.turning = this.cars.filter((c) => c.turn);
    if (this.zones.size > this.turning.length) for (const c of [...this.zones.keys()]) if (!c.turn || !this.turning.includes(c)) this.zones.delete(c);
    for (const c of this.cars) {
      // (one moving across looks for what is in its way from where it is going)
      const e = this.roads[c.e], P = c.shift ? at(e, c.s, c.off, this.sP) : this.carPoint(c, c.s, this.sP);
      const F = c.shift ? at(e, c.s + 1, c.off, this.sF) : this.carPoint(c, c.s + 1, this.sF), C = this.carPoint(c, c.s - c.len / 2, this.sC);
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
      if (car.turn) {
        car.ds = 0; car.dOff = 0;
        if (this.t - car.turn[0] < turnTime(car.turn[1], car.turn[2], car.turn[3])) continue;
        car.turn = undefined;
        this.zones.delete(car);
        const to = laneOffset(e, car.lane);
        if (Math.abs(to - car.off) > 0.01) this.shift(car, to, shiftLen(to - car.off));
      }
      // (one behind a car pulling out to get past something follows it straight away, while there is room behind it;
      // one stopped on a road cars turned round on lately does not wait to turn round too)
      if (this.half && !car.pass && (car.wait > PASS_WAIT || (car.v < 3 && (car.by as Car | null)?.pass) || (car.v < 0.3 && this.blockedUntil[e.i] > this.t))) {
        const r = this.getPast(car, e);
        if (r === 'gone') { removed.add(car); continue; }
        if (r === 'turned') continue;
      }
      this.changeLane(car, e);
      let v0 = e.v * car.v0f;
      if (car.next >= 0 && e.L - car.s < 30 && this.nextTurn(car, e) !== Turn.Straight) v0 = Math.min(v0, this.nextTurn(car, e) === Turn.Right ? 4.5 : 6);
      const [gap, lv] = this.carObstacle(car, e);
      const ss = IDM.s0 + Math.max(0, car.v * IDM.T + (car.v * (car.v - lv)) / (2 * Math.sqrt(IDM.a * IDM.b)));
      const acc = Math.max(-9, IDM.a * (1 - (car.v / Math.max(v0, 0.1)) ** 4 - (gap === Infinity ? 0 : (ss / Math.max(gap, 0.1)) ** 2)));
      car.brake = acc < -0.8 || car.v < 0.3 ? 1 : 0;
      car.v = Math.max(0, car.v + acc * dt);
      // (creeping up to something standing is still waiting for it: one let go after giving way gets past it at once)
      car.wait = car.v < 0.3 ? car.wait + dt : car.stand && car.v < 3 ? car.wait : 0;
      // stuck too long for a soft reason: push through for a few metres (never through something standing, nor out
      // beside it)
      if (car.ghost <= 0 && !car.pass && !car.stand && ((car.wait > 15 && SOFT.slice(0, 4).includes(car.why)) || (car.wait > 25 && SOFT.slice(4).includes(car.why)))) { car.ghost = 8; car.wait = 0; }
      if (car.ghost > 0) { car.ghost -= car.v * dt; if (car.v < 1.5 && gap > 3) car.v = 1.5; }
      car.s += car.v * dt;
      // past what it drove beside: back into its lane (before the end of its road or the road on, getPast); done once
      // its rear axle is. (Its way out kept till then: out of its lane it is drawn so on the roads either side too.)
      const p = car.pass;
      if (p && !p.back && car.s - car.len > p.far + 1) {
        const o = laneOffset(e, car.lane), n = this.onward(car, e);
        this.shift(car, o, Math.max(SHIFT_MIN * 0.5, Math.min(PASS_BACK, shiftLen(o - car.off), e.L + (n ? n.L : 0) - 0.5 - (car.len - 1.2) - car.s)));
        p.back = true;
      }
      if (car.shift && car.s - (car.len - 1.2) > car.shift[1] && (!p || p.back)) { car.shift = undefined; car.pass = undefined; }
      if (car.next >= 0 && car.boxNode !== e.b && e.L - car.s < BOX_IN) { this.boxLeave(car); this.boxEnter(car, e, e.b); }
      if (car.s > e.L && !this.enterNext(car, e, s0)) { removed.add(car); continue; }
      if (car.boxNode >= 0 && car.e !== car.boxFrom && car.s > BOX_OUT) this.boxLeave(car);
      car.ds = car.e === e0 ? car.s - s0 : car.s + e.L - s0;
      car.dOff = car.e === e0 ? car.off - off0 : 0;
    }
    if (removed.size) this.cars.splice(0, this.cars.length, ...this.cars.filter((c) => !removed.has(c)));
  }

  // A lane change is a shift (drawn as the car rolls on, never sideways at a standstill) over about LC_S s at its
  // speed, done before the road's end blend (so that the next road's lane is where it lands); it is in its new lane
  // once its rear axle is.
  private changeLane(car: Car, e: Road) {
    if (car.pass) return;
    if (car.lcTo !== undefined) {
      if (car.shift) return;
      const lst = e.lists[car.lane];
      lst.splice(lst.indexOf(car), 1);
      car.lane = car.lcTo; car.lcTo = undefined;
      e.lists[car.lane].push(car);
    }
    if (car.shift) return;
    const lo = laneOffset(e, car.lane);
    // (out of its lane otherwise, e.g. left so on a road too short to change lanes: back as it rolls)
    if (Math.abs(lo - car.off) > 0.01) { this.shift(car, lo, shiftLen(lo - car.off)); return; }
    car.off = lo;
    const want = this.desiredLane(car, e);
    if (want === car.lane || car.s <= 4) return;
    const step = want > car.lane ? 1 : -1, to = laneOffset(e, car.lane + step), wb = car.len - 1.2;
    const len = Math.min(Math.max(shiftLen(to - lo), LC_S * car.v), e.L - BLEND - wb - car.s);
    if (len >= shiftLen(to - lo) && this.laneGapOK(e, car.lane + step, car.s, car)) {
      car.lcTo = car.lane + step;
      this.shift(car, to, len);
    }
  }

  // ------------------------------------------------------------------ getting past something standing
  // the other direction of road e's way (its line the same, reversed: s there is e.L - s here, offsets mirrored)
  private back(e: Road) {
    if (!this.backOf) {
      const b = this.backOf = new Int32Array(this.roads.length).fill(-1);
      for (const r of this.roads) for (const j of this.outs.get(r.b) ?? []) {
        const o = this.roads[j];
        if (o.b === r.a && o.w === r.w && Math.abs(o.L - r.L) < 1) b[r.i] = j;
      }
    }
    return this.backOf[e.i];
  }

  // A car held up PASS_WAIT s: behind one getting past the same thing, it follows it out; behind something standing,
  // it drives beside it where there is room and the way is clear, else (TURN_WAIT, GIVE_UP) turns round
  private getPast(car: Car, e: Road): 'gone' | 'turned' | null {
    const L = car.by as Car | null, queued = (car.why === 'leader' || car.why === 'spatial') && L?.e === car.e && L.lane === car.lane;
    const n = this.onward(car, e);
    if (queued && L.pass) {
      const end = L.pass.far + car.len + 2;
      if (this.passFits(car, e, n, L.pass.off, L.pass.near, L.pass.far) && this.clearFor(car, e, n, L.pass.off, end)) this.startPass(car, L.pass.off, L.pass.near, L.pass.far, L.pass.need);
      return null;
    }
    // (a queue on a road something standing turned a car round on lately, or one waiting for a car turning round
    // there: turned round too, from where it is)
    if ((queued ? L.v < 0.3 : car.why === 'turning' && car.v < 0.3) && this.blockedUntil[e.i] > this.t) return this.turnAround(car, e);
    const o = car.stand;
    if (!o || car.why === 'oncoming') return null;
    if (this.blockedUntil[e.i] > this.t) return this.turnAround(car, e);
    const g = car.geo, along = (o.x - g.px) * g.fx + (o.z - g.py) * g.fy;
    const near = car.s + along - o.ext, far = car.s + along + o.ext, end = far + car.len + 2;
    let room = false;
    if (far < e.L + (n ? n.L : 0)) {
      const so = car.s + along, A = this.lineAt(car, e, so, 0, this.tmp), ax = A.x, ay = A.y, B = this.lineAt(car, e, so, 1, this.tmp);
      const nx = B.x - ax, ny = B.y - ay, mid = ((o.x - ax) * nx + (o.z - ay) * ny) / (nx * nx + ny * ny || 1);
      let [lo, hi] = this.width(e);
      // (its way back on the next road: within that one's width too)
      if (n && this.backLen(car, far) >= e.L - 0.5) { const w = this.width(n); lo = Math.max(lo, w[0]); hi = Math.min(hi, w[1]); }
      const sides = [mid - o.need - 0.05, mid + o.need + 0.05].filter((c) => c >= lo && c <= hi)
        .sort((a, b) => Math.abs(a - car.off) - Math.abs(b - car.off));
      for (const c of sides) {
        if (!this.passFits(car, e, n, c, near, far)) continue;
        room = true;
        if (this.clearFor(car, e, n, c, end)) { this.startPass(car, c, near, far, o.need); return null; }
      }
    }
    return car.wait < (room ? GIVE_UP : TURN_WAIT) ? null : this.turnAround(car, e);
  }

  // the offsets a car may drive at to get past something on road e: its lanes and those of its way back, and a verge
  private width(e: Road): [number, number] {
    const bi = this.back(e), R = bi >= 0 ? this.roads[bi] : null;
    return [Math.min(e.o0, R ? -laneOffset(R, R.lanes - 1) : Infinity) - PASS_EDGE, Math.max(laneOffset(e, e.lanes - 1), R ? -R.o0 : -Infinity) + PASS_EDGE];
  }

  // where a car out beside something past far (s on its road) is back in its lane, its rear axle too
  private backLen(car: Car, far: number) { return far + 1 + car.len + SHIFT_MIN + (car.len - 1.2); }

  // The road on from e a car's way out beside something and back may run onto: its next, straight on (the shift is
  // carried over the junction: road-net.ts carPoint), its lane there where its lane is here, long enough for the way
  // back; null: none
  private onward(car: Car, e: Road): Road | null {
    if (car.next < 0) return null;
    const n = this.roads[car.next];
    if (n.L < 2 * BLEND || e.endD[0] * n.startD[0] + e.endD[1] * n.startD[1] < 0.97) return null;
    return Math.abs(laneOffset(n, landingLane(Turn.Straight, car.lane, n.lanes)) - laneOffset(e, car.lane)) < 0.3 ? n : null;
  }

  // road e's line at s, off across it; s beyond its end on the road on (or before its start on the road before), where
  // the car is drawn there
  private lineAt(car: Car, e: Road, s: number, off: number, out: Pt) {
    if (s > e.L && car.next >= 0) return at(this.roads[car.next], s - e.L, off, out);
    if (s < 0 && car.prev >= 0) { const p = this.roads[car.prev]; return at(p, p.L + s, off, out); }
    return at(e, s, off, out);
  }

  // is there room for a car to pull out to offset off before near, and back into its lane past far, on road e (on n
  // too, the road on)? (Beside it, its rear too, clear of the road's start, where a car is drawn blended into the road
  // before at its lane: something just past a junction is got past from the road before, its way out run on over the
  // junction; the way back done before the end of the road on)
  private passFits(car: Car, e: Road, n: Road | null, off: number, near: number, far: number) {
    return near - car.len > BLEND && near - 1 - car.s >= Math.min(shiftLen(off - car.off), 0.6 * shiftLen(off - car.off) + 1)
      && this.backLen(car, far) < e.L + (n ? n.L : 0) - 0.5;
  }

  // is a car out to get past something across the road from it by its offset (the thing at x, z, about s along the
  // road: as far across as when it pulled out; what it needs across seen along the car's own line changes as that
  // turns)?
  private besideClear(car: Car, e: Road, s: number, x: number, z: number) {
    const p = car.pass!, so = clamp(s, p.near - 1, p.far + 1), A = this.lineAt(car, e, so, 0, this.tmp), ax = A.x, ay = A.y, B = this.lineAt(car, e, so, 1, this.tmp);
    const nx = B.x - ax, ny = B.y - ay, mid = ((x - ax) * nx + (z - ay) * ny) / (nx * nx + ny * ny || 1);
    return Math.abs(mid - car.off) >= p.need - 0.05;
  }

  private startPass(car: Car, off: number, near: number, far: number, need: number) {
    this.shift(car, off, Math.min(shiftLen(off - car.off), near - 1 - car.s));
    car.pass = { off: car.off, near, far, need };
    car.lcTo = undefined;
    car.wait = 0;
  }

  // the car moves across to offset off over the next len m it rolls (its offset that already: what it is drawn to)
  private shift(car: Car, off: number, len: number) {
    car.shift = [mm(car.s), mm(car.s + len), mm(car.off), mm(off)];
    car.off = car.shift[3];
  }

  // is the stretch a car on e would drive beside something, at offset off with its front up to end, free of the other
  // cars: those across its way there (beside it, behind it in another lane, stopped ahead), and those coming the
  // other way (near enough that they could not stop short of it comfortably: they wait for it once it is out; those
  // about to come onto the way back too)?
  private clearFor(car: Car, e: Road, n: Road | null, off: number, end: number) {
    const lo = Math.min(car.off, off) - 2.1, hi = Math.max(car.off, off) + 2.1, stopIn = (v: number) => 1.5 * v + (v * v) / IDM.b;
    const across = (o: Car, k: number) => {
      const p = k * o.off, q = o.pass ? k * o.pass.off : p;
      return Math.max(p, q) > lo && Math.min(p, q) < hi;
    };
    // (the road on, where the stretch looked at reaches onto it: its cars and those coming the other way on it too,
    // s on e being e.L more)
    const on = n && end + 2 + PASS_BACK + stopIn(14) > e.L ? n : null;
    for (const [w, base] of on ? [[e, 0], [on, e.L]] as const : [[e, 0]] as const) for (const l of w.lists) for (const o of l) {
      if (o === car || !across(o, 1)) continue;
      const s = o.s + base;
      if (s > car.s ? s - o.len < end + 5 && o.v < 1 && !o.pass : o.lane !== car.lane && s > car.s - car.len - 3 - o.v * 3) return false;
    }
    const from = car.s - car.len - 3;
    let last = -1, lastL = 0;
    for (const [w, top] of on ? [[e, e.L], [on, e.L + on.L]] as const : [[e, e.L]] as const) {
      const bi = this.back(w);
      if (bi < 0) break;
      for (const l of this.roads[bi].lists) for (const o of l) {
        const s = top - o.s;
        if (across(o, -1) && s + o.len > from && s < end + 2 + PASS_BACK + (o.why === 'oncoming' ? 0 : stopIn(o.v))) return false;
      }
      last = bi; lastL = top;
    }
    if (last < 0) return true;
    const R = this.roads[last], reach = end + 2 + PASS_BACK + stopIn(14) - lastL;
    if (reach > 0) for (const j of this.ins.get(R.a) ?? []) {
      const q = this.roads[j];
      if (j !== e.i && j !== on?.i) for (const l of q.lists) for (const o of l) if (o.next === last && q.L - o.s < reach) return false;
    }
    return true;
  }

  // A car that cannot get past turns round onto its way back, within the road, where the stretch its turn sweeps is
  // free (a U-turn, else a three-point turn: drawn over a few seconds, nobody comes into that stretch meanwhile); on a
  // one-way road, or one too narrow for it, it leaves once out of sight. Its road is avoided by the routes for a while
  private turnAround(car: Car, e: Road): 'gone' | 'turned' | null {
    if (this.bodies?.owns(car)) return null;
    const bi = this.back(e);
    if (bi >= 0 && this.roadOn[bi]) {
      const plan = this.turnPlan(car, e, this.roads[bi]);
      if (plan === 'wait') return null;
      if (plan) {
        const A = { ...this.carPoint(car, car.s, this.sP) }, B = { ...this.carPoint(car, car.s - (car.len - 1.2), this.sF) };
        this.removeCar(car);
        const R = this.roads[bi];
        Object.assign(car, { e: bi, lane: 0, s: plan.s, v: 0, off: plan.off, prev: -1, prev2: -1, lcTo: undefined, pass: undefined, shift: undefined,
          stand: null, wait: 0, ghost: 0, why: 'turning', by: null, ds: 0, dOff: 0, turn: [this.t, plan.r, plan.d, plan.x, plan.u0, plan.v0, 0, 0, 0, 0] });
        R.lists[0].push(car);
        this.setNext(car, this.chooseNext(R));
        // (where the turn has it at its start less where it was drawn: blended out over the turn's first part)
        const A0 = this.carPoint(car, car.s, this.sP), ax = A.x - A0.x, ay = A.y - A0.y, B0 = this.carPoint(car, car.s - (car.len - 1.2), this.sF);
        const k = car.turn!;
        k[6] = mm(ax); k[7] = mm(ay); k[8] = mm(B.x - B0.x); k[9] = mm(B.y - B0.y);
        this.zones.set(car, { R: bi, lo: plan.lo, hi: plan.hi, e: e.i, elo: R.L - plan.hi, ehi: R.L - plan.lo });
        this.blockedUntil[e.i] = this.t + BLOCKED;
        return 'turned';
      }
    }
    if (this.held.car.has(car.id) || !this.far(car.geo.px, car.geo.py, car.geo.z, CAR_POP_R)) return null;
    this.blockedUntil[e.i] = this.t + BLOCKED;
    this.removeCar(car);
    return 'gone';
  }

  // How a car on road e turns round onto R (its way back, s there R.L - s here, offsets mirrored): the widest circle
  // whose sweep stays within the road's width and short of what it stands for, from its rear axle where it is (on as
  // far as its reversing would otherwise reach back into one queued behind) to its front at s in R's first lane, or
  // short of it if its front would swing out beyond the road (it moves over as it drives off); lo, hi: the stretch of
  // R its body sweeps. 'wait': the stretch is not free; null: no turn fits
  private turnPlan(car: Car, e: Road, R: Road) {
    const wb = car.len - 1.2, u0 = cm(R.L - car.s + wb), v0 = cm(-car.off), d0 = cm(laneOffset(R, 0) - v0);
    if (d0 < 0.5) return null;
    let vlo = Infinity, vhi = -Infinity;
    for (let l = 0; l < R.lanes; l++) { vlo = Math.min(vlo, laneOffset(R, l)); vhi = Math.max(vhi, laneOffset(R, l)); }
    for (let l = 0; l < e.lanes; l++) { vlo = Math.min(vlo, -laneOffset(e, l)); vhi = Math.max(vhi, -laneOffset(e, l)); }
    const o = car.stand, g = car.geo, ahead = o ? (o.x - g.px) * g.fx + (o.z - g.py) * g.fy - o.ext : Infinity;
    let back = R.L - 0.5;
    for (const l of e.lists) for (const c of l) if (c !== car && c.s <= car.s) back = Math.min(back, R.L - c.s - 1);
    for (const edge of TURN_EDGE) for (let d = d0; d >= Math.max(0.5, d0 - 2); d = cm(d - 0.25)) for (const r of TURN_R) {
      const w = this.sweep(r, d, wb);
      if (v0 + w.vlo < vlo - edge || v0 + w.vhi > vhi + edge) continue;
      // (ended short of its lane beside the queue: on far enough to be in it before it drives past them)
      const x = cm(Math.max(0, u0 + w.uhi - back, d < TURN_CLEAR ? u0 + 2 * wb + shiftLen(d0 - d) - back : 0));
      const ulo = u0 - x + w.ulo, uhi = u0 - x + w.uhi, s = cm(u0 - x + wb);
      // (short of what it stands for: R.L - (car.s + ahead) on R; its end clear of the blend into R's next road, which
      // a turn does not draw)
      if (ulo < R.L - car.s - ahead + 0.3 || ulo < 0.5 || s > R.L - BLEND || s - 2 * wb < 0.5) continue;
      const lo = ulo - 1, hi = uhi + 1, stopIn = (v: number) => 1.5 * v + (v * v) / IDM.b;
      for (const l of R.lists) for (const c of l) if (c.s > lo - stopIn(c.v) - 2 && c.s - c.len < hi) return 'wait';
      // (those standing queued behind it are behind its sweep already)
      for (const l of e.lists) for (const c of l) if (c !== car && c.s > R.L - hi - (c.v > 0.3 ? stopIn(c.v) + 2 : -1) && c.s - c.len < R.L - lo) return 'wait';
      for (const [w, from] of [[R, lo], [e, R.L - hi]] as const) for (const j of this.ins.get(w.a) ?? []) {
        const p = this.roads[j];
        for (const l of p.lists) for (const c of l) if (c.next === w.i && p.L - c.s + from < stopIn(c.v) + 5) return 'wait';
      }
      return { r, d, x, u0, v0, s, off: cm(v0 + d), lo, hi };
    }
    return null;
  }

  // the box a turn round (radius r across d m, wheelbase wb) sweeps, about its rear axle's start: u along the road, v
  // across it (the same few for every car: kept)
  private sweep(r: number, d: number, wb: number) {
    const key = `${r}/${d}/${wb}`, had = this.sweeps.get(key);
    if (had) return had;
    const q = { u: 0, w: 0, th: 0 }, n = 24, T = turnTime(r, d, 0), out = { ulo: Infinity, uhi: -Infinity, vlo: Infinity, vhi: -Infinity };
    for (let i = 0; i <= n; i++) {
      turnRear(r, d, 0, (T * i) / n, q);
      const c = Math.cos(q.th), sn = Math.sin(q.th);
      for (const [f, l] of [[wb + 0.6, 0.95], [wb + 0.6, -0.95], [-0.6, 0.95], [-0.6, -0.95]]) {
        const u = q.u + c * f - sn * l, v = -(q.w + sn * f + c * l);
        out.ulo = Math.min(out.ulo, u); out.uhi = Math.max(out.uhi, u); out.vlo = Math.min(out.vlo, v); out.vhi = Math.max(out.vhi, v);
      }
    }
    if (this.sweeps.size > 2000) this.sweeps.clear();
    this.sweeps.set(key, out);
    return out;
  }

  // may a car leave the street at the end of road e (out of sight: CAR_POP_R from the viewer)?
  private mayLeave(car: Car, e: Road) { const P = at(e, e.L, car.off, this.tmp); return this.far(P.x, P.y, P.z, CAR_POP_R); }

  // past the end of its road: onto the next one (false: it leaves), or hold at the line if the lane there is full (or
  // there is no way on and it may not leave here)
  private enterNext(car: Car, e: Road, s0: number) {
    const lst = e.lists[car.lane];
    lst.splice(lst.indexOf(car), 1);
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
    // (one moving across, out beside something or on its way back, goes on doing so on the next road as far out of its
    // lane there: its shift and what it gets past by that road's s)
    const h = car.shift, k = laneOffset(n, lane) - laneOffset(e, car.lane), p = car.pass;
    const prevOff = h ? mm(shiftOff(h, e.L)) : car.off;
    Object.assign(car, { prev2: car.prev, prev2Off: car.prevOff, prev: car.e, prevOff, s: car.s - e.L, e: car.next, lane, lcTo: undefined,
      off: h ? mm(car.off + k) : laneOffset(n, lane) });
    if (h) car.shift = [mm(h[0] - e.L), mm(h[1] - e.L), mm(h[2] + k), mm(h[3] + k)];
    if (h && p) Object.assign(p, { off: p.off + k, near: p.near - e.L, far: p.far - e.L });
    else car.pass = undefined;
    n.lists[lane].push(car);
    const n2 = car.next2 ?? -1;
    this.setNext(car, n2 >= 0 && this.roadOn[n2] ? n2 : this.chooseNext(n));
    if (n.L < 25 && car.next >= 0 && !car.shift) { // too short to change lanes later: take the next turn's lane now if it is free
      const wl = this.desiredLane(car, n);
      if (wl !== car.lane && this.laneGapOK(n, wl, car.s, car)) {
        n.lists[car.lane].splice(n.lists[car.lane].indexOf(car), 1);
        car.lane = wl;
        n.lists[wl].push(car);
        this.shift(car, laneOffset(n, wl), shiftLen(laneOffset(n, wl) - car.off));
      }
    }
    return true;
  }

  // the list cut by over[f] in each region f, the newest out of sight PED_POP_R from the viewers first; none closer,
  // nor kept
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
    car.turn = car.shift = car.pass = undefined;
    car.block = null;
    car.by = null;
    car.why = 'free';
    car.wait = 0;
    this.detachedCars.push(car);
    this.trimParked();
    return true;
  }

  /** a car out of the traffic (parked, a wreck) put back where it was left: a host's kept things read back after a
   * restart (a new id; on no road). null: PARKED_MAX already out of the traffic */
  parkAgain(k: Pick<Car, 'len' | 'bus' | 'vt' | 'col'>, pose: RoadPose): Car | null {
    if (this.detachedCars.length >= PARKED_MAX) return null;
    const car: Car = {
      kind: 'car', id: this.idSeq++, e: 0, lane: 0, s: 0, v: 0, len: k.len, bus: k.bus, prev: -1, prevOff: 0, next: -1, v0f: 1, col: k.col,
      off: 0, brake: 0, wait: 0, ghost: 0, ds: 0, dOff: 0, why: 'free', by: null, boxNode: -1, boxFrom: -1, boxTo: -1, boxLane: 0, boxT: 0,
      boxTurn: 0, block: null, geo: { px: 0, py: 0, cx: pose.x, cy: pose.z, z: pose.y, fx: 0, fy: 1 }, detachedPose: { ...pose },
    };
    if (k.vt) car.vt = k.vt;
    this.detachedCars.push(car);
    return car;
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
