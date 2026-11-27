// Stands: where the host puts vehicles for anyone to take, found from the map's own voxels and roads, so any map gets
// them without a list; never on a carriageway (the traffic would stop for it). A block of the map (3 x 3 nodes) is
// looked at once, when a player first comes near it, read through a craft's collision (VoxelCollision), whose nodes
// are let go again after. A stand is stocked while a player is within the wake radius and emptied again past it while
// its vehicle is untouched, so the map's far parts cost nothing. Once a vehicle is taken, moved, harmed or wrecked it is an ordinary left one (WorldSim keeps it while
// players are near) and the stand refills after a while, out of sight. No three.js, no DOM (tools/core-deps.mjs).
import { hash } from '../core/num';
import type { Meta } from '../core/meta';
import type { TileCache } from '../core/tile-cache';
import type { CraftSpot } from './contract/commands';
import type { CraftType, EntityRef, VehicleId } from './contract/ids';
import type { Pose } from './contract/pose';
import type { Berth } from './boat-traffic';
import { findSpawn } from './craft/boat-motion';
import { SPAWN_HEIGHT } from './craft/craft-collision';
import { PLANE } from './craft/plane-flight';
import { VoxelCollision } from './craft/voxel-collision';
import { CAR_COLOURS } from './flow';
import { at } from './path';
import type { Tuning } from './tuning';
import type { Road } from './types';
import { trafficType } from './vehicles';
import { laneOffset } from './road-net';



/** a column as a stand's finder reads it: its ground, the top of what stands on it, its water's top (-1: none) */
interface Column { ground: number; top: number; water: number }
/** the columns a finder may read: null where it may not (off the map, outside what it was given); throws NOT_IN where
 * a node is not in yet */
interface Columns { at(x: number, z: number): Column | null }
const NOT_IN = new Error('stands: a node not in');

// a column is open where nothing but grass stands on its ground (m); level within LEVEL m of the middle; the room's
// probes ROOM_STEP m apart
const OPEN = 0.3, LEVEL = 0.6, ROOM_STEP = 2;

/** Landing room: the height of the ground at (x, z) if a disc of r m round it is level, dry and open (no roof, tree or
 * bridge over it), else null. A craft set down there fits whatever its heading */
function landingRoom(c: Columns, x: number, z: number, r: number): number | null {
  const o = c.at(x, z);
  if (!o || o.water >= 0 || o.top - o.ground > OPEN) return null;
  for (let dz = -r; dz <= r; dz += ROOM_STEP) for (let dx = -r; dx <= r; dx += ROOM_STEP) {
    if (dx * dx + dz * dz > r * r) continue;
    const q = c.at(x + dx, z + dz);
    if (!q || q.water >= 0 || q.top - q.ground > OPEN || Math.abs(q.top - o.top) > LEVEL) return null;
  }
  return o.top;
}

/** the columns of a craft's collision within box [x0, z0, x1, z1) */
function collisionColumns(col: VoxelCollision, box: readonly [number, number, number, number]): Columns {
  return {
    at(x, z) {
      if (x < box[0] || z < box[1] || x >= box[2] || z >= box[3] || !col.built.at(Math.floor(x), Math.floor(z))) return null;
      const s = col.surface(x, z), w = s && col.waterColumn(x, z, -1e9, -1e9);
      if (!s || !w) throw NOT_IN;
      return { ground: s.ground, top: s.top, water: w.water };
    },
  };
}

/** a stand: what stands there (a craft's type or a car's), where, and its vehicle now */
export interface Stand {
  readonly id: number;
  readonly kind: 'craft' | 'car';
  readonly type: CraftType | VehicleId;
  readonly spot: CraftSpot & { y: number };
  /** a car's paint */
  readonly col?: string;
  /** the vehicle stocked and not yet used (a craft's or car's id), or null */
  vehicle: number | null;
  /** when it may be stocked (s of the sim's clock); refill: only out of every player's sight */
  due: number;
  refill: boolean;
}

// What a block holds at most, and how far apart (m, between spots) two stands are kept. One craft of a class a block
// is a few in sight of a player (a wake radius reaches over several blocks); a squad of four finds a second speedboat
// in the next block along the river.
const CAP: Record<string, number> = { boat: 1, floatplane: 1, hovercraft: 1, helicopter: 1, paraglider: 1, car: 3 };
const ROOM: Record<string, number> = { boat: 6, floatplane: 16, hovercraft: 8, helicopter: 9, paraglider: 4, car: 4 };
// Each class's finder: the probes' spacing (m), and its numbers. The helicopter's room is the rotor's reach and a
// margin; a hovercraft's its skirt's half length and a margin, with water within SHORE m; a speedboat within BANK m
// of land; a floatplane's run (m) and room either side; a paraglider's drop: the ground under a 1 in 4 glide over
// DROP_RUN m from BACK m short of an edge found within EDGE m, at least DROP m down at its end; a car's verge off the
// outer lane's middle (m), on roads no faster than CAR_ROAD m/s (not the fast roads' shoulders), every CAR_EVERY m.
const HELI_ROOM = 8, HELI_BIG = 14, HOVER_ROOM = 7, SHORE = 30, BANK = 20, RUN = 220, RUN_MAX = 300, SIDE = 24, SIDE_MAX = 60;
const DROP_RUN = 120, DROP = 30, GLIDE = 0.25, EDGE = 24, BACK = 4, CAR_VERGE = 1.5 + 2.4, CAR_ROAD = 14, CAR_EVERY = 25;
// a paraglider is launched from this high over its spot at this speed (m, m/s): clear of the edge at once
const LAUNCH_UP = 2.5, LAUNCH_SPEED = 14;

/** what the stands act through (WorldSim's) */
export interface StandWorld {
  readonly meta: Meta;
  readonly cache: TileCache;
  readonly now: () => number;
  readonly tuning: Tuning;
  readonly roads: readonly Road[];
  /** a craft of type put down at spot, asleep (not stepped until touched); its id */
  stockCraft(type: CraftType, spot: CraftSpot): number;
  /** a car of type parked at spot; its id, or null: no room for it */
  stockCar(type: VehicleId, col: string, spot: CraftSpot & { y: number }): number | null;
  /** where it is, or null: gone */
  pose(v: EntityRef): Pose | null;
  /** below its full health (or a wreck) */
  harmed(v: EntityRef): boolean;
  /** taken out of the world */
  remove(v: EntityRef): void;
  /** stepped again from now on */
  wake(v: EntityRef): void;
  /** craft id put down at spot again (its launch) */
  place(id: number, spot: CraftSpot): void;
  /** nothing (a craft, a car, a walker) within r m of (x, z) */
  clear(x: number, z: number, r: number): boolean;
}

// a block: its stands once looked at; while being looked at, its collision and the finders' run (one class a tick)
interface Block { stands: Stand[] | null; col: VoxelCollision | null; run: Generator<void, Stand[]> | null; since: number }

export class Stands {
  private readonly blocks = new Map<number, Block>();
  private readonly side: number;
  private readonly nbx: number;
  private readonly byVehicle = new Map<string, Stand>();
  // the roads' boxes (x0, z0, x1, z1 each), made when a block first asks
  private roadBoxes: Float64Array | null = null;
  private nextId = 1;
  /** the river boats' landing stages (boats.json): a speedboat beside one first */
  berths: readonly Berth[] = [];

  constructor(private readonly w: StandWorld) {
    this.side = 3 * w.meta.tiles.N;
    this.nbx = Math.ceil(w.meta.W / this.side);
  }

  get tuning() { return this.w.tuning.stands; }

  /** the blocks being looked at let go of their nodes (the host done with its world) */
  dispose() {
    for (const b of this.blocks.values()) { b.col?.release(); b.col = null; b.run = null; }
  }

  /** every stand found so far (a tool's) */
  *all(): Generator<Stand> { for (const b of this.blocks.values()) if (b.stands) yield* b.stands; }

  /** the stand whose untouched vehicle v is, or undefined */
  of(v: EntityRef) { return this.byVehicle.get(`${v.kind}:${v.id}`); }

  /** a seat of v taken: its stand's vehicle used (a paraglider's pilot launched over its drop) */
  seated(v: EntityRef, role: string) {
    const s = this.of(v);
    if (!s) return;
    this.release(s, this.clock);
    if (s.type === 'paraglider' && role === 'pilot') {
      const { x, y, z, h } = s.spot;
      this.w.place(v.id, { x, y: y + LAUNCH_UP, z, h, speed: LAUNCH_SPEED });
    }
  }

  private clock = 0;

  /** a tick at now (s of the sim's clock) with the players at foci: the blocks near them looked at (one a tick), their
   * stands stocked or emptied, the vehicles used let go */
  update(now: number, foci: readonly { x: number; z: number }[]) {
    this.clock = now;
    const T = this.tuning, S = this.side, reach = T.wake + T.keep;
    let looked = false;
    const want = new Set<number>();
    for (const f of foci) {
      for (let bz = Math.max(0, Math.floor((f.z - T.wake) / S)); bz <= Math.floor((f.z + T.wake) / S); bz++)
        for (let bx = Math.max(0, Math.floor((f.x - T.wake) / S)); bx <= Math.min(this.nbx - 1, Math.floor((f.x + T.wake) / S)); bx++) {
          if (bz * S >= this.w.meta.D) continue;
          want.add(bz * this.nbx + bx);
        }
    }
    for (const k of want) {
      let b = this.blocks.get(k);
      if (!b) this.blocks.set(k, b = { stands: null, col: null, run: null, since: now });
      if (!b.stands && !looked) looked = this.look(k, b, now);
    }
    const within = (x: number, z: number, r: number) => foci.some((f) => (f.x - x) ** 2 + (f.z - z) ** 2 <= r * r);
    for (const b of this.blocks.values()) {
      for (const s of b.stands ?? []) {
        const { x, z } = s.spot;
        if (s.vehicle !== null) {
          const v: EntityRef = { kind: s.kind, id: s.vehicle }, p = this.w.pose(v);
          if (!p) { this.forget(s); s.due = now; s.refill = false; continue; }
          if (Math.hypot(p.x - x, p.z - z) > MOVED || this.w.harmed(v)) { this.release(s, now); continue; }
          if (!within(x, z, reach)) { this.w.remove(v); this.forget(s); s.due = now; s.refill = false; }
        } else if (now >= s.due && within(x, z, T.wake) && !(s.refill && within(x, z, T.unseen)) && this.w.clear(x, z, ROOM[s.kind === 'car' ? 'car' : s.type])) {
          this.stock(s, now);
        }
      }
    }
  }

  private stock(s: Stand, now: number) {
    const id = s.kind === 'craft' ? this.w.stockCraft(s.type as CraftType, s.spot) : this.w.stockCar(s.type as VehicleId, s.col!, s.spot);
    // (no room for a car: tried again a little later)
    if (id === null) { s.due = now + 5; return; }
    s.vehicle = id;
    this.byVehicle.set(`${s.kind}:${id}`, s);
  }

  private forget(s: Stand) {
    if (s.vehicle !== null) this.byVehicle.delete(`${s.kind}:${s.vehicle}`);
    s.vehicle = null;
  }

  // its vehicle used: an ordinary left one from now on (awake), the stand refilled later out of sight
  private release(s: Stand, now: number) {
    if (s.vehicle === null) return;
    if (s.kind === 'craft') this.w.wake({ kind: 'craft', id: s.vehicle });
    this.forget(s);
    s.due = now + this.tuning.refill;
    s.refill = true;
  }

  // a class of block k looked for, once its nodes are in (false: not yet, nothing done). A node found missing starts
  // the block again (its first class reads all of it, so little is lost)
  private look(k: number, b: Block, now: number): boolean {
    const S = this.side, bx = k % this.nbx, bz = Math.floor(k / this.nbx), box = [bx * S, bz * S, (bx + 1) * S, (bz + 1) * S] as const;
    const W = this.w, c = (b.col ??= new VoxelCollision(W.meta, W.cache, W.now));
    c.prefetch({ x: box[0] + S / 2, y: 0, z: box[1] + S / 2 }, { x: 0, y: 0, z: 0 });
    try {
      const r = (b.run ??= this.find(c, box)).next();
      if (!r.done) return true;
      b.stands = r.value;
    } catch (e) {
      if (e !== NOT_IN) throw e;
      b.run = null;
      if (now - b.since < this.tuning.giveUp) return false;
      b.stands = [];
    }
    c.release();
    b.col = null;
    b.run = null;
    return true;
  }

  // whether a disc of r m round (x, z) keeps off every carriageway near box: what stands on a road stops the traffic
  private roadsIn(box: readonly [number, number, number, number]) {
    const M = ROAD_REACH, cells = new Map<number, number[]>(), pt = { x: 0, y: 0, z: 0 };
    const key = (x: number, z: number) => Math.floor(x / ROAD_CELL) * 65536 + Math.floor(z / ROAD_CELL);
    // (each road's box, once: a block samples only the roads that reach it)
    const B = this.roadBoxes ??= Float64Array.from(this.w.roads.flatMap((e) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const q of e.p) { x0 = Math.min(x0, q[0]); z0 = Math.min(z0, q[1]); x1 = Math.max(x1, q[0]); z1 = Math.max(z1, q[1]); }
      return [x0, z0, x1, z1];
    }));
    for (let i = 0; i < this.w.roads.length; i++) {
      const e = this.w.roads[i], R = M + 20;
      if (B[4 * i] > box[2] + R || B[4 * i + 1] > box[3] + R || B[4 * i + 2] < box[0] - R || B[4 * i + 3] < box[1] - R) continue;
      // (the middle of its lanes, and half their width with the kerb)
      const lo = e.o0 - LANE / 2, hi = laneOffset(e, e.lanes - 1) + LANE / 2, mid = (lo + hi) / 2, half = (hi - lo) / 2;
      for (let s = 0; s <= e.L; s += ROAD_STEP) {
        at(e, s, mid, pt);
        if (pt.x < box[0] - M || pt.y < box[1] - M || pt.x >= box[2] + M || pt.y >= box[3] + M) continue;
        const k = key(pt.x, pt.y);
        let c = cells.get(k);
        if (!c) cells.set(k, c = []);
        c.push(pt.x, pt.y, half);
      }
    }
    return (x: number, z: number, r: number) => {
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const c = cells.get(key(x + i * ROAD_CELL, z + j * ROAD_CELL));
        if (c) for (let k = 0; k < c.length; k += 3) if ((c[k] - x) ** 2 + (c[k + 1] - z) ** 2 < (r + c[k + 2]) ** 2) return false;
      }
      return true;
    };
  }

  // the block's stands, the best spot of each class first, kept apart
  private *find(col: VoxelCollision, box: readonly [number, number, number, number]): Generator<void, Stand[]> {
    const C = collisionColumns(col, box), out: Stand[] = [], [x0, z0, x1, z1] = box;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    type Cand = { spot: CraftSpot & { y: number }; score: number };
    const pick = (kind: 'craft' | 'car', type: string, cands: Cand[], cap = CAP[kind === 'car' ? 'car' : type], extra?: (c: Cand, i: number) => Partial<Stand>) => {
      // (best score first; ties by place, so the same map gives the same stands)
      cands.sort((a, b) => a.score - b.score || (a.spot.x - cx) ** 2 + (a.spot.z - cz) ** 2 - (b.spot.x - cx) ** 2 - (b.spot.z - cz) ** 2);
      const r = ROOM[kind === 'car' ? 'car' : type];
      let n = 0;
      for (const c of cands) {
        if (n >= cap) break;
        if (out.some((s) => Math.hypot(s.spot.x - c.spot.x, s.spot.z - c.spot.z) < r + ROOM[s.kind === 'car' ? 'car' : s.type])) continue;
        out.push({ id: this.nextId++, kind, type: type as CraftType, spot: c.spot, vehicle: null, due: 0, refill: false, ...extra?.(c, n) });
        n++;
      }
    };
    const grid = function* (step: number) {
      for (let z = z0 + step / 2; z < z1; z += step) for (let x = x0 + step / 2; x < x1; x += step) yield [x, z] as const;
    };
    const dirs = Array.from({ length: 8 }, (_, k) => k * Math.PI / 4);
    let near: ReturnType<Stands['roadsIn']> | null = null;
    const offRoad = (x: number, z: number, r: number) => (near ??= this.roadsIn(box))(x, z, r);
    const wet = (x: number, z: number) => { const q = C.at(x, z); return !!q && q.water >= 0; };
    const dry = (x: number, z: number) => { const q = C.at(x, z); return !!q && q.water < 0; };

    // speedboats: on open water off a bank, along it; beside a landing stage first
    const boats: Cand[] = [];
    for (const b of this.berths) {
      if (b.x < x0 || b.y < z0 || b.x >= x1 || b.y >= z1) continue;
      for (const d of [30, -30]) {
        const h = Math.atan2(b.dx, b.dy), p = findSpawn(col, b.x + b.dx * d, b.y + b.dy * d, h, 8, this.w.tuning.boat);
        if (p && C.at(p.x, p.z)) boats.push({ spot: { x: p.x, y: p.y, z: p.z, h: p.h }, score: -1 });
      }
    }
    for (const [x, z] of grid(12)) {
      if (!wet(x, z)) continue;
      // (the bank's way: the directions land lies in, the nearer the more; the hull along it)
      let land = Infinity, ax = 0, az = 0;
      for (const h of dirs) for (let d = 2; d <= BANK; d += 2) {
        if (!dry(x + Math.sin(h) * d, z + Math.cos(h) * d)) continue;
        land = Math.min(land, d); ax += Math.sin(h) / d; az += Math.cos(h) / d;
        break;
      }
      if (land > BANK) continue;
      const p = findSpawn(col, x, z, Math.atan2(ax, az) + Math.PI / 2, 2, this.w.tuning.boat);
      if (p && C.at(p.x, p.z)) boats.push({ spot: { x: p.x, y: p.y, z: p.z, h: p.h }, score: land });
    }
    pick('craft', 'boat', boats);
    yield;

    // the floatplane: the longest straight run of open water with room either side
    const planes: Cand[] = [];
    for (const [x, z] of grid(24)) {
      const q = C.at(x, z);
      if (!q || q.water < 0) continue;
      for (const h of dirs) {
        const sx = Math.sin(h), sz = Math.cos(h);
        let run = 0, side = 0;
        while (run < RUN_MAX && wet(x + sx * run, z + sz * run)) run += 6;
        if (run < RUN) continue;
        while (side < SIDE_MAX && wet(x + sz * side, z - sx * side) && wet(x - sz * side, z + sx * side)) side += 6;
        if (side >= SIDE) planes.push({ spot: { x, y: q.water + PLANE.FLOAT_H, z, h, water: true }, score: -(run + 2 * side) });
      }
    }
    pick('craft', 'floatplane', planes);
    yield;

    // the hovercraft: room on the bank, facing the water nearest
    const hovers: Cand[] = [];
    for (const [x, z] of grid(12)) {
      let water = Infinity, to = 0;
      for (const h of dirs) for (let d = HOVER_ROOM + 2; d <= SHORE && d < water; d += 3) if (wet(x + Math.sin(h) * d, z + Math.cos(h) * d)) { water = d; to = h; }
      if (water > SHORE) continue;
      const y = offRoad(x, z, HOVER_ROOM) ? landingRoom(C, x, z, HOVER_ROOM) : null;
      if (y !== null) hovers.push({ spot: { x, y: y + SPAWN_HEIGHT.hovercraft, z, h: to }, score: water });
    }
    pick('craft', 'hovercraft', hovers);
    yield;

    // the helicopter: landing room, the more the better
    const helis: Cand[] = [];
    for (const [x, z] of grid(12)) {
      const y = offRoad(x, z, HELI_ROOM) ? landingRoom(C, x, z, HELI_ROOM) : null;
      if (y === null) continue;
      const big = landingRoom(C, x, z, HELI_BIG) !== null;
      helis.push({ spot: { x, y: y + SPAWN_HEIGHT.helicopter, z, h: 2 * Math.PI * hash(x * 7 + z) }, score: big ? 0 : 1 });
    }
    pick('craft', 'helicopter', helis);
    yield;

    // the paraglider: the highest drop under a clear glide, its spot a few metres back from the edge
    const gliders: Cand[] = [];
    for (const [x0g, z0g] of grid(16)) {
      const top = landingRoom(C, x0g, z0g, 2);
      if (top === null) continue;
      for (const h of dirs) {
        const sx = Math.sin(h), sz = Math.cos(h);
        let edge = 0;
        for (let d = 2; d <= EDGE && !edge; d += 2) { const q = C.at(x0g + sx * d, z0g + sz * d); if (!q) break; if (q.top < top - 2) edge = d; }
        if (!edge) continue;
        const x = x0g + sx * (edge - BACK), z = z0g + sz * (edge - BACK), y = offRoad(x, z, 2) ? landingRoom(C, x, z, 2) : null;
        if (y === null) continue;
        let ok = true, end = 0;
        for (let d = BACK + 2; d <= DROP_RUN && ok; d += 6) {
          const q = C.at(x + sx * d, z + sz * d);
          ok = !!q && q.top <= y - 1 - GLIDE * (d - BACK);
          if (q) end = y - q.top;
        }
        if (ok && end >= DROP) gliders.push({ spot: { x, y: y + SPAWN_HEIGHT.paraglider, z, h }, score: -end });
      }
    }
    pick('craft', 'paraglider', gliders);
    yield;

    // cars: on the verge of the slower roads, level, along the road
    const cars: Cand[] = [], pt = { x: 0, y: 0, z: 0 }, ahead = { x: 0, y: 0, z: 0 };
    for (const e of this.w.roads) {
      if (e.v > CAR_ROAD) continue;
      const off = laneOffset(e, e.lanes - 1) + CAR_VERGE;
      for (let s = CAR_EVERY / 2; s < e.L - CAR_EVERY / 2; s += CAR_EVERY) {
        at(e, s, off, pt);
        if (pt.x < x0 || pt.y < z0 || pt.x >= x1 || pt.y >= z1) continue;
        at(e, s + 1, off, ahead);
        const y = offRoad(pt.x, pt.y, CAR_HALF) ? landingRoom(C, pt.x, pt.y, ROOM.car - 1.5) : null;
        if (y === null || Math.abs(y - pt.z) > LEVEL * 2) continue;
        cars.push({ spot: { x: pt.x, y, z: pt.y, h: Math.atan2(ahead.x - pt.x, ahead.y - pt.y) }, score: hash(e.i * 131 + s) });
      }
    }
    pick('car', 'car', cars, CAP.car, (c) => {
      const k = Math.floor(c.score * 1e6);
      return { type: trafficType(k), col: CAR_COLOURS[k % CAR_COLOURS.length] };
    });
    return out;
  }
}

// a stand's vehicle this far (m) from its spot has been moved: used
const MOVED = 2;
// the roads sampled every ROAD_STEP m into cells of ROAD_CELL m, out to ROAD_REACH m past a block (a stand's room
// and a road's half width fit in a cell and its neighbours); a lane's width (sim/road-net.ts); a car's half width
const ROAD_STEP = 3, ROAD_CELL = 32, ROAD_REACH = 32, LANE = 3, CAR_HALF = 0.9 + 1;
