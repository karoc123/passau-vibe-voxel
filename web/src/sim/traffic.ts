// The street traffic as a world sim: headless (no three.js, no DOM, no camera: tools/core-deps.mjs), on a fixed tick
// (STEP), drawing from a seeded random number generator, so a server could run it and two runs from one seed are the
// same. sim/life.ts (StreetLife) is its presentation: it draws what is here, between the last two ticks.
//
// Live streets on the real OSM networks (scripts/traffic.py): fixed-time signals; cars with the Intelligent Driver
// Model per lane, turn lanes, OSM turn restrictions and junction "box" locks; people on footpaths, waiting for green
// at signalled crossings. Density follows the hour. Near player edits some cars are physical bodies (`bodies`:
// physics/rapier/life-phys.ts, stepped in the tick), and the people over a hole fall (`dropped`: drawn falling).
import { hash, pushTo, rng, smooth, type Rng } from '../core/num';
import { trafficType, VEHICLES } from './vehicles';
import { at, cellKey, farFrom, landingLane, prepPath, pt, Turn, turnOf, type Pt, type Viewer } from './path';
import type { Agent, Car, Controller, PedEdge, Person, Road, RoadPose, TrafficData } from './types';

export const MAX_CARS = 1400, MAX_PEOPLE = 4000, MAX_BIKES = 1200;
const CYCLE = 64, GREEN = 26, AMBER = 3, PED_GREEN = 18;
const LANE_W = 3.0;
const IDM = { a: 1.4, b: 2.2, s0: 2.2, T: 1.2 };
const BLEND = 7;
const BOX_IN = 7, BOX_OUT = 9;
// the tick (s): the traffic's, and the bodies' (two physics steps of it)
export const STEP = 1 / 30;
export const ACTIVE_R = 900, ACTIVE_CELL = 300;
export const activeKey = (cx: number, cy: number) => cy * 65536 + cx;
// Agents come and go only this far from the viewer (the focus) or further: spawned there, removed there (over the
// hour's number, off the network, a dead end, the parked cars, the people knocked down), never in plain view. Closer
// in a car at a dead end waits there, a rider turns back; the number over the hour's waits until enough are far.
// Only the first fill (or a jump of the focus) puts them anywhere at once. (A car 300 m away is a few pixels tall, a
// person 150 m away about as much: tools/popin-check.mjs checks 200 and 100 m.)
export const CAR_POP_R = 300, PED_POP_R = 150;
// the focus moved this far at once (or the first update): the circle is filled anew at once, near the focus too
const JUMP_R = ACTIVE_R / 2;
const CAR_COLOURS = ['#f0f0ee', '#e9e9e7', '#1c1c1e', '#2a2c30', '#8e9399', '#b9bcc0', '#5d6670', '#9b2a24', '#24467a', '#3d5a3a', '#c9b48e', '#6e1f2a'];
const SHIRTS = ['#c8553d', '#3d6fa8', '#e8e3d6', '#2f2f33', '#7a9a5b', '#d9a441', '#8b5fa8', '#5a8fa3', '#b03a48', '#f0f0f0', '#45505c', '#c97f5d'];
const SOFT = ['spatial', 'box-busy', 'no-room-exit', 'hold-at-line', 'next-edge-car'];
// the cars parked by the player (detachCar) kept: the oldest of more than PARKED goes once CAR_POP_R from the viewer,
// never more than PARKED_MAX
const PARKED = 8, PARKED_MAX = 24;
// Player edits (core/live-edits.ts, told by edited()): the paths' heights are baked (scripts/traffic.py), so only
// where the city was edited is the ground under a person looked at (Ground.support): more than HOLE m under their
// path's height and they fall (dropped: drawn falling, life.ts). The cars there are bodies (life-phys.ts): theirs fall.
// Nothing edited: nothing looked at.
const HOLE = 1;

export const DEFAULT_SEED = 1;

// the ground the agents stand on (world.ts World: the edited columns too)
export interface Ground {
  // the drawn surface at (x, z) near height y (a ramp's, a cap's)
  surface(x: number, z: number, y: number): number;
  // the top of what is solid under height `top` at (x, z)
  support(x: number, z: number, top: number): number;
}

// Physical bodies for some cars (physics/rapier/life-phys.ts): tick() in the traffic's tick, after the cars moved (it
// may slow a car whose body is held up: its ghost waits); owns(c): c has a body; pose(c, a): the presentation's, after
// it set the car's kinematic pose (rp, rh, pitch, roll) between the last two ticks (a: 0 at the last but one, 1 at the
// last), puts it where its body is.
export interface TrafficBodies {
  beforeTick?(traffic: Traffic): void;
  tick(dt: number, traffic: Traffic): void;
  owns(c: Car): boolean;
  controlled?(c: Car): boolean;
  pose(c: Car, a: number): void;
}

// a car's kinematic pose: the ground point between its axles on its path, its heading, nose up
export interface CarPose { x: number; y: number; z: number; h: number; pitch: number }

function phase(ctrl: Controller, t: number, axis: number) {
  const u = ((t + ctrl.off) % CYCLE + CYCLE) % CYCLE;
  return ((u - (axis === 0 ? 0 : CYCLE / 2)) % CYCLE + CYCLE) % CYCLE;
}
const signal = (ctrl: Controller, t: number, axis: number) => { const k = phase(ctrl, t, axis); return k < GREEN ? 'G' : k < GREEN + AMBER ? 'Y' : 'R'; };
const pedGreen = (ctrl: Controller, t: number, axis: number) => phase(ctrl, t, axis) < PED_GREEN;

type Density = { cars: number; peds: number; bikes: number };

export class Traffic {
  ground: Ground | null = null;
  keep: Car | Person | null = null;
  bodies: TrafficBodies | null = null;
  readonly roads: Road[];
  readonly peds: PedEdge[];
  readonly ctrls: Controller[];
  readonly cars: Car[] = [];
  readonly detachedCars: Car[] = [];
  people: Person[] = [];
  riders: Person[] = [];
  // the people fallen into a hole since the presentation last took them (drawn falling: life.ts)
  dropped: Person[] = [];
  struck: { tick: number; person: Person; pose: RoadPose; vx: number; vz: number }[] = [];
  tickNumber = 0;
  // the boxes edited (map metres [x0, z0, x1, z1), a metre round): only an agent in one has its ground looked at
  edits: [number, number, number, number][] = [];
  day = 180;
  t = 0;
  // the time since the last tick (s, under STEP): how far between the last two ticks to draw
  acc = 0;
  private readonly rand: Rng;
  private readonly outs = new Map<number, number[]>();
  private readonly ins = new Map<number, number[]>();
  private readonly padj = new Map<number, [number, number][]>();
  private readonly restr = new Map<string, { to: number; type: string }[]>();
  private readonly box = new Map<number, Set<Car>>();
  // the middle of the active circle (a new object whenever it moves)
  active: { x: number; z: number } | null = null;
  // where the viewer is (update's viewer: the camera), and whether the circle is to be filled at once (populate)
  private viewer: Viewer = { x: 0, z: 0 };
  private warm = true;
  private roadOn: boolean[] = [];
  private pedOn: boolean[] = [];
  // the ways in the circle (their indices) and the weights to pick them by, in the same order
  private roadAct: number[] = [];
  private pedAct: number[] = [];
  private bikeAct: number[] = [];
  private roadW: number[] = [];
  private pedW: number[] = [];
  private bikeW: number[] = [];
  // the roads and footways by ACTIVE_CELL m cell of their ends and middle, for setActive (built on its first call)
  private wayGrid: { roads: Map<number, number[]>; peds: Map<number, number[]> } | null = null;
  private bikeKm = 0;
  private sources: number[] = [];
  private laneKm = 0;
  private pedKm = 0;
  private carGrid = new Map<number, Car[]>();
  private idSeq = 1;
  private readonly tmp = pt();
  private readonly tmp2 = pt();
  // scratch points (carPoint uses tmp itself)
  private readonly sP = pt();
  private readonly sF = pt();
  private readonly sC = pt();
  private readonly pA = pt();
  private readonly pB = pt();

  constructor(data: TrafficData, seed = DEFAULT_SEED) {
    this.rand = rng(seed);
    this.roads = data.roads.map((r, i) => Object.assign(prepPath(r), { i, lists: Array.from({ length: r.lanes }, () => []) }));
    this.peds = data.peds.map((e, i) => Object.assign(prepPath(e), { i }));
    this.ctrls = data.ctrls.map((c, i) => ({ ...c, off: hash(i + 1) * CYCLE }));
    this.roads.forEach((e, i) => { pushTo(this.outs, e.a, i); pushTo(this.ins, e.b, i); });
    this.peds.forEach((e, i) => { pushTo(this.padj, e.a, [i, 0]); pushTo(this.padj, e.b, [i, 1]); });
    for (const [fr, via, to, type] of data.restr ?? []) pushTo(this.restr, `${fr}:${via}`, { to, type });
  }

  private pick(w: number[], sum = w.reduce((a, b) => a + b, 0)) {
    let r = this.rand() * sum;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
    return w.length - 1;
  }
  private anyOf<T>(a: T[]) { return a[(this.rand() * a.length) | 0]; }

  // The ticks due after dt s (at most 0.1 s of them). focus: the middle of what is simulated (the active circle: what
  // is looked at); viewer: where it is seen from (the camera; by default the focus, on the ground), what agents come
  // and go far from.
  update(dt: number, hour: number, focus: { x: number; z: number }, viewer: Viewer = focus) {
    dt = Math.min(dt, 0.1);
    const A = this.active, d2 = A ? (A.x - focus.x) ** 2 + (A.z - focus.z) ** 2 : Infinity;
    this.viewer = { x: viewer.x, z: viewer.z, y: viewer.y };
    if (d2 > JUMP_R * JUMP_R) this.warm = true;
    if (d2 > 120 * 120) this.setActive(focus.x, focus.z);
    const hh = ((hour % 24) + 24) % 24;
    const bell = (c: number, w: number) => Math.exp(-(((hh - c) / w) ** 2));
    const density = {
      cars: Math.min(1, 0.18 + 0.55 * bell(8, 2.2) + 0.5 * bell(17, 2.6) + 0.45 * bell(13, 5)),
      peds: Math.min(1, 0.08 + 0.4 * bell(8.5, 1.8) + 0.85 * bell(16, 4.5) + 0.25 * bell(21, 2)),
      // the counters' day: the commute to work and home, a lunch hump, little at night; a fifth of July's in January
      bikes: (0.03 + 0.85 * bell(8, 1.4) + 1.0 * bell(17, 2.0) + 0.35 * bell(13, 3))
        * (0.2 + 0.4 * (1 - Math.cos(2 * Math.PI * (this.day - 15) / 365))),
    };
    if (this.warm) this.populate(density); // (drawn this frame)
    this.acc += dt;
    while (this.acc >= STEP) { this.step(STEP, density); this.acc -= STEP; }
  }

  // a signal's state now: green, amber, red
  signal(ctrl: number, axis: number) { return signal(this.ctrls[ctrl], this.t, axis); }

  // ------------------------------------------------------------------ the area around the camera
  // Only a circle around the focus is simulated: roads leaving it are exits, roads entering it are sources, and
  // agents left outside are removed.
  // (the ways looked at are those with an end or the middle in the cells the circle touches, not all of the map's)
  private setActive(x: number, z: number) {
    const R = ACTIVE_R, probes = (e: { p: number[][] }) => [e.p[0], e.p[e.p.length >> 1], e.p[e.p.length - 1]];
    const near = (e: { p: number[][] }) => probes(e).some((q) => (q[0] - x) ** 2 + (q[1] - z) ** 2 < R * R);
    const C = ACTIVE_CELL, key = activeKey;
    if (!this.wayGrid) {
      const index = (ways: { p: number[][] }[]) => {
        const g = new Map<number, number[]>();
        ways.forEach((e, i) => { for (const k of new Set(probes(e).map((q) => key(Math.floor(q[0] / C), Math.floor(q[1] / C))))) pushTo(g, k, i); });
        return g;
      };
      this.wayGrid = { roads: index(this.roads), peds: index(this.peds) };
      this.roadOn = new Array(this.roads.length).fill(false);
      this.pedOn = new Array(this.peds.length).fill(false);
    }
    const inCircle = (g: Map<number, number[]>, ways: { p: number[][] }[]) => {
      const out = new Set<number>();
      for (let cy = Math.floor((z - R) / C); cy <= Math.floor((z + R) / C); cy++)
        for (let cx = Math.floor((x - R) / C); cx <= Math.floor((x + R) / C); cx++)
          for (const i of g.get(key(cx, cy)) ?? []) if (!out.has(i) && near(ways[i])) out.add(i);
      return [...out].sort((a, b) => a - b);
    };
    for (const i of this.roadAct) this.roadOn[i] = false;
    for (const i of this.pedAct) this.pedOn[i] = false;
    this.roadAct = inCircle(this.wayGrid.roads, this.roads);
    this.pedAct = inCircle(this.wayGrid.peds, this.peds);
    for (const i of this.roadAct) this.roadOn[i] = true;
    for (const i of this.pedAct) this.pedOn[i] = true;
    this.roadW = this.roadAct.map((i) => { const e = this.roads[i]; return e.L * e.lanes * e.c; });
    this.laneKm = this.roadAct.reduce((a, i) => a + this.roads[i].L * this.roads[i].lanes, 0) / 1000;
    this.sources = this.roadAct.filter((i) => { const e = this.roads[i]; return e.L > 15 && !(this.ins.get(e.a) ?? []).some((j) => this.roadOn[j]); });
    this.pedW = this.pedAct.map((i) => this.peds[i].L * this.peds[i].w);
    this.pedKm = this.pedAct.reduce((a, i) => a + this.peds[i].L, 0) / 1000;
    this.bikeAct = this.pedAct.filter((i) => this.peds[i].bk);
    this.bikeW = this.bikeAct.map((i) => this.peds[i].L * this.peds[i].bk!);
    this.bikeKm = this.bikeW.reduce((a, w) => a + w, 0) / 1000;
    this.riders = this.riders.filter((p) => this.pedOn[p.e]);
    const out = new Set(this.cars.filter((c) => !this.roadOn[c.e] && c !== this.keep));
    for (const c of out) this.removeCar(c);
    if (out.size) this.cars.splice(0, this.cars.length, ...this.cars.filter((c) => !out.has(c)));
    this.people = this.people.filter((p) => this.pedOn[p.e] || p === this.keep || p.ctl);
    this.active = { x, z };
  }


  // ------------------------------------------------------------------ spawning
  // is (x, y) at height z at least r m from the viewer (where an agent may come or go)?
  private far(x: number, y: number, z: number, r: number) { return farFrom(this.viewer, x, y, z, r); }

  private spawnCar(fromSource: boolean) {
    const ei = fromSource && this.sources.length ? this.anyOf(this.sources) : this.roadAct[this.pick(this.roadW)];
    const e = this.roads[ei], lane = (this.rand() * e.lanes) | 0;
    const s = fromSource ? 0 : 10 + this.rand() * Math.max(0, e.L - 20 - BOX_IN - 12);
    if (s > e.L - BOX_IN - 12 || !this.laneGapOK(e, lane, s, null)) return;
    if (!this.warm) { const P = at(e, s, 0, this.tmp); if (!this.far(P.x, P.y, P.z, CAR_POP_R)) return; }
    const bus = e.c >= 2 && this.rand() < 0.06, id = this.idSeq++, vt = bus ? undefined : trafficType(id);
    const car: Car = {
      kind: 'car', id, e: ei, lane, s, v: e.v * 0.6, len: bus ? 12 : VEHICLES[vt!].len, bus, prev: -1, prevOff: 0, next: -1,
      v0f: 0.85 + this.rand() * 0.25, col: bus ? '#f2c230' : this.anyOf(CAR_COLOURS),
      off: this.laneOffset(e, lane), brake: 0, wait: 0, ghost: 0, ds: 0, dOff: 0, why: 'free', by: null,
      boxNode: -1, boxFrom: -1, boxTo: -1, boxLane: 0, boxT: 0, boxTurn: 0, block: null,
      geo: { px: 0, py: 0, cx: 0, cy: 0, z: 0, fx: 0, fy: 0 },
    };
    if (vt !== 'car') car.vt = vt;
    this.setNext(car, this.chooseNext(e));
    e.lists[lane].push(car);
    this.cars.push(car);
  }

  private spawnPed() {
    const ei = this.pedAct[this.pick(this.pedW)], e = this.peds[ei], s = this.rand() * e.L;
    if (!this.warm) { const P = at(e, s, 0, this.tmp); if (!this.far(P.x, P.y, P.z, PED_POP_R)) return; }
    this.people.push({ kind: 'person', e: ei, dir: this.rand() < 0.5 ? 1 : -1, s, v: 1.05 + this.rand() * 0.55,
      lat: 0.35 + this.rand() * 1.0, ph: this.rand() * 6.28, wait: false, col: this.anyOf(SHIRTS) });
  }

  private spawnRider() {
    const ei = this.bikeAct[this.pick(this.bikeW)], e = this.peds[ei];
    if (!e || !e.bk) return;
    const s = this.rand() * e.L;
    if (!this.warm) { const P = at(e, s, 0, this.tmp); if (!this.far(P.x, P.y, P.z, PED_POP_R)) return; }
    this.riders.push({ kind: 'person', e: ei, dir: this.rand() < 0.5 ? 1 : -1, s, v: 4 + this.rand() * 1.8,
      lat: 0.45 + this.rand() * 0.3, ph: this.rand() * 6.28, wait: false, bike: true, col: this.anyOf(SHIRTS) });
  }

  // ------------------------------------------------------------------ routing
  private laneOffset(e: Road, lane: number) { return e.o0 + lane * LANE_W; }

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
      const st = signal(this.ctrls[sg.ctrl], this.t, sg.axis), d = sg.s - car.s;
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
  private step(dt: number, density: Density) {
    this.t += dt;
    this.tickNumber++;
    this.bodies?.beforeTick?.(this);
    if (((this.t / 0.5) | 0) !== (((this.t - dt) / 0.5) | 0)) this.breakDeadlocks();
    const targetCars = this.populate(density);
    this.snapshot();
    if (this.edits.length) this.dropOverHoles();
    this.stepCars(dt, targetCars);
    this.stepPeople(dt);
    this.stepRiders(dt);
    this.bodies?.tick(dt, this);
  }

  // ------------------------------------------------------------------ player edits
  // Box (map metres [x0, z0, x1, z1)) was edited (stream.ts replaceColumns, through core/live-edits.ts), or, cleared,
  // is its files' again (the node freed): the edits meeting it are forgotten.
  edited(box: [number, number, number, number], cleared = false) {
    if (cleared) this.edits = this.edits.filter((b) => !(b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3]));
    else this.edits.push([box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1]);
  }

  // is the ground at (x, z) more than HOLE m under height y, in an edited box?
  private hole(x: number, z: number, y: number) {
    const G = this.ground;
    if (!G || !this.edits.some((b) => x >= b[0] && z >= b[1] && x < b[2] && z < b[3])) return false;
    return G.support(x, z, y + 1.5) < y - HOLE;
  }

  // the people and riders over a hole fall (out of the crowd: dropped, drawn falling)
  private dropOverHoles() {
    const P = this.pA;
    const drop = (list: Person[]) => list.filter((p) => {
      if (p.ctl || p === this.keep) return true;
      this.personPoint(p, 0, P);
      if (!this.hole(P.x, P.y, P.z)) return true;
      this.dropped.push(p);
      return false;
    });
    this.people = drop(this.people);
    this.riders = drop(this.riders);
  }

  // As many as the hour wants, a few more a tick out of sight (all at once anywhere when warm: the first fill), and
  // those over it out of sight gone. Returns the cars wanted.
  private populate(density: Density) {
    this.trimParked();
    const targetCars = Math.min(MAX_CARS - PARKED_MAX, Math.round(this.laneKm * 9 * density.cars));
    const targetPeds = Math.min(MAX_PEOPLE, Math.round(this.pedKm * 24 * density.peds));
    const warm = this.warm, n = (k: number, target: number) => (warm ? 4 * target + 50 : k);
    for (let k = 0, K = n(6, targetCars); k < K && this.cars.length < targetCars; k++) this.spawnCar(!warm && this.cars.length > targetCars * 0.5);
    for (let k = 0, K = n(40, targetPeds); k < K && this.people.length < targetPeds; k++) this.spawnPed();
    // at July's evening peak 5 riders a km per unit of weight: 10 a km along a main road (at
    // 5 m/s), 5 on an ordinary bike way
    const targetBikes = Math.min(MAX_BIKES, Math.round(this.bikeKm * 5 * density.bikes));
    for (let k = 0, K = n(10, targetBikes); k < K && this.riders.length < targetBikes; k++) this.spawnRider();
    this.warm = false;
    // (the person followed or walked stays in the crowd)
    if (this.riders.length > targetBikes) this.riders = this.trim(this.riders, targetBikes);
    if (this.people.length > targetPeds) this.people = this.trim(this.people, targetPeds);
    return targetCars;
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

  private stepCars(dt: number, targetCars: number) {
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
      if (car.s > e.L && !this.enterNext(car, e, s0, targetCars)) { removed.add(car); continue; }
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
    if (car.lcTo === undefined) { car.off += (this.laneOffset(e, car.lane) - car.off) * Math.min(1, dt * 3); return; }
    const tgt = this.laneOffset(e, car.lcTo);
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
  private enterNext(car: Car, e: Road, s0: number, targetCars: number) {
    const lst = e.lists[car.lane];
    lst.splice(lst.indexOf(car), 1);
    car.lcTo = undefined;
    if ((car.next < 0 || this.cars.length > targetCars + 4) && this.mayLeave(car, e)) { this.boxLeave(car); return false; }
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
    Object.assign(car, { prev2: car.prev, prev2Off: car.prevOff, prev: car.e, prevOff: car.off, s: car.s - e.L, e: car.next, lane, off: this.laneOffset(n, lane) });
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

  // the list cut to n, the newest out of sight PED_POP_R from the viewer first; none closer, nor kept or walked
  private trim(list: Person[], n: number) {
    let over = list.length - n;
    const gone = new Set<Person>(), P = this.pA;
    for (let i = list.length - 1; i >= 0 && over > 0; i--) {
      const p = list[i];
      if (p.ctl || p === this.keep) continue;
      this.personPoint(p, 0, P);
      if (this.far(P.x, P.y, P.z, PED_POP_R)) { gone.add(p); over--; }
    }
    return gone.size ? list.filter((p) => !gone.has(p)) : list;
  }

  private stepPeople(dt: number) {
    for (const pe of this.people) {
      if (pe.ctl) continue;
      const e = this.peds[pe.e];
      if (pe.wait) {
        if (!e.x || !pedGreen(this.ctrls[e.x.ctrl], this.t, e.x.axis)) continue;
        pe.wait = false;
      }
      pe.s += pe.v * dt * pe.dir;
      pe.ph += pe.v * dt * 4.2;
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
      pe.ph += pe.v * dt * 1.6;
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
  // A car's path at arc length s, blended across the junction nodes into smooth arcs: the roads before and after
  // weighted by how far the car is from each node (smooth over BLEND either side of it), each pull added on, so
  // that on a road shorter than 2 BLEND the car is drawn between both, and across a road shorter than BLEND the road
  // beyond it pulls too (prev2, next2). Where the car moves onto the next road the sum is the same on either side.
  private carPoint(car: Car, s: number, out: Pt, off = car.off) {
    const e = this.roads[car.e], P = at(e, s, off, out), x = P.x, y = P.y, z = P.z, Q = this.tmp, R = this.tmp2;
    // (P moved by w times the way from (ax, ay, az) to B)
    const pull = (ax: number, ay: number, az: number, B: Pt, w: number) => { P.x += (B.x - ax) * w; P.y += (B.y - ay) * w; P.z += (B.z - az) * w; };
    if (s < BLEND && car.prev >= 0) {
      const pe = this.roads[car.prev];
      at(pe, pe.L + s, car.prevOff, Q);
      pull(x, y, z, Q, 1 - smooth(-BLEND, BLEND, s));
      const p2 = car.prev2 ?? -1;
      if (p2 >= 0 && s + pe.L < BLEND) { const pp = this.roads[p2]; pull(Q.x, Q.y, Q.z, at(pp, pp.L + pe.L + s, car.prev2Off ?? 0, R), 1 - smooth(-BLEND, BLEND, s + pe.L)); }
    }
    if (s > e.L - BLEND && car.next >= 0) {
      const n = this.roads[car.next], lane = landingLane(turnOf(e, n), car.lane, n.lanes);
      at(n, s - e.L, this.laneOffset(n, lane), Q);
      pull(x, y, z, Q, smooth(-BLEND, BLEND, s - e.L));
      const n2 = car.next2 ?? -1;
      if (n2 >= 0 && s - e.L - n.L > -BLEND) {
        const nn = this.roads[n2], lane2 = landingLane(turnOf(n, nn), lane, nn.lanes);
        pull(Q.x, Q.y, Q.z, at(nn, s - e.L - n.L, this.laneOffset(nn, lane2), R), smooth(-BLEND, BLEND, s - e.L - n.L));
      }
    }
    return P;
  }

  // a car's drawn path (carPoint) at arc length s on its road, for what steers a body along it (TrafficBodies)
  pathPoint(car: Car, s: number, out: Pt, off = car.off) { return this.carPoint(car, s, out, off); }

  // A car's kinematic pose with its front at arc length s, lane offset off: both axles on the blended path, the body
  // following the curve; on a ramp (world.ts surface: the paths' heights are whole metres) both axles on it, the body
  // pitched between them
  carPose(c: Car, s: number, off: number, out: CarPose) {
    const A = this.carPoint(c, s, this.pA, off), B = this.carPoint(c, s - (c.len - 1.2), this.pB, off), G = this.ground;
    out.h = Math.atan2(A.x - B.x, A.y - B.y);
    out.x = (A.x + B.x) / 2; out.z = (A.y + B.y) / 2;
    out.pitch = 0; out.y = Math.max(A.z, B.z);
    if (G) {
      const za = G.surface(A.x, A.y, A.z), zb = G.surface(B.x, B.y, B.z);
      if (za !== A.z || zb !== B.z) { out.pitch = Math.atan2(za - zb, Math.hypot(A.x - B.x, A.y - B.y) || 1); out.y = (za + zb) / 2; }
    }
    return out;
  }

  // Where a person walking or riding is, ds m on along their way (out: x, z on the map as x, y; their height as z):
  // a walker off the way's line by their lat (on its side, if it has one), a rider right of it
  personPoint(p: Person, ds: number, out: Pt) {
    const e = this.peds[p.e], A = at(e, p.s + ds * p.dir, 0, out), B = at(e, p.s + (ds + 0.5) * p.dir, 0, this.tmp2);
    const l = Math.hypot(B.x - A.x, B.y - A.y) || 1, dx = (B.x - A.x) / l, dy = (B.y - A.y) / l;
    const lat = p.bike || e.side === undefined ? p.lat : p.lat * e.side * p.dir;
    const x = A.x - dy * lat, y = A.y + dx * lat;
    out.z = this.ground ? this.ground.surface(x, y, A.z) : A.z;
    out.x = x; out.y = y;
    return out;
  }

  // Person p out of the crowd (knocked down: life.ts); whether they were in it
  removePerson(p: Person) {
    const list = p.bike ? this.riders : this.people, i = list.indexOf(p);
    if (i < 0 || p === this.keep) return false;
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
    car.rp ??= { ...car.detachedPose };
    this.detachedCars.push(car);
    this.trimParked();
    return true;
  }

  // Keep recent player-parked cars around and leave ample room for the traffic fleet: of more than PARKED the oldest
  // out of sight goes (never the one driven or followed); more than PARKED_MAX, the oldest anyway.
  private trimParked() {
    const D = this.detachedCars;
    if (D.length <= PARKED) return;
    const canTrim = (c: Car) => c !== this.keep && !this.bodies?.controlled?.(c);
    let i = D.findIndex((c) => {
      const p = c.detachedPose!;
      return canTrim(c) && this.far(p.x, p.z, p.y, CAR_POP_R);
    });
    if (i < 0 && D.length > PARKED_MAX) i = D.findIndex(canTrim);
    if (i >= 0) D.splice(i, 1);
  }

}
