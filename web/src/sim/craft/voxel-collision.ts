import { component, type Vec3 } from '../../core/vec';
import type { ImpactKind, Sweep } from './sweep';
import type { Meta } from '../../core/meta';
import type { RawColumns } from '../../core/tile-data';
import { paletteMask, RULES, semanticTable } from '../../core/semantics';
import type { TileCache } from '../../core/tile-cache';
import { capField, surfaceAt, type CapField } from '../../core/surface';

// the drone's cube's half side and how far ahead (s) its tiles are fetched; the plane passes its own (plane.ts)
const RADIUS = 0.35, HORIZON = 2.2;
export interface CollisionOptions { radius?: number; horizon?: number }
const CONCURRENT_LOADS = 4;
type Runs = { offsets: Uint32Array; data: Uint16Array };
// caps: the node's sloped surfaces (core/surface.ts), what surface() reads -- the sweep keeps the voxels (a cap lies
// within caps.CLAMP, 60/64 m, of its voxel's top; a craft is no ground vehicle)
type CollisionTile = { ground: Uint8Array; base: Runs; foliage: Runs; caps: CapField | null };
const collisionTile = (N: number, v: { base: RawColumns & { ground: Uint8Array; caps?: Uint16Array | null }; foliage: RawColumns }): CollisionTile =>
  ({ ground: v.base.ground, base: runsOf(v.base), foliage: runsOf(v.foliage), caps: capField(N, v.base) });
export type { ImpactKind, Sweep } from './sweep';

function runsOf(columns: RawColumns): Runs {
  const offsets = new Uint32Array(columns.counts.length + 1);
  for (let i = 0; i < columns.counts.length; i++) offsets[i + 1] = offsets[i] + columns.counts[i] * 3;
  return { offsets, data: columns.runs };
}

// Sweeps the craft's cube (the drone's 70 cm) through one column segment, expanded by its half side r.
function contact(p: Vec3, d: Vec3, x: number, lo: number, hi: number, z: number, limit: number, r: number) {
  let enter = 0, leave = limit, axis = 0;
  for (let i = 0; i < 3; i++) {
    const min = (i === 0 ? x : i === 1 ? lo : z) - r;
    const max = (i === 0 ? x + 1 : i === 1 ? hi : z + 1) + r;
    const start = component(p, i), move = component(d, i);
    if (Math.abs(move) < 1e-10) {
      if (start < min || start > max) return null;
      continue;
    }
    const a = (min - start) / move, b = (max - start) / move;
    const entry = Math.min(a, b);
    if (entry >= enter) {
      enter = entry;
      axis = -Math.sign(move) * (i + 1);
    }
    leave = Math.min(leave, Math.max(a, b));
    if (enter > leave) return null;
  }
  // A craft already inside a voxel (e.g. at a corner) falls back to its opposing motion axis.
  if (axis === 0) {
    const i = Math.abs(d.x) >= Math.abs(d.y) && Math.abs(d.x) >= Math.abs(d.z) ? 0 : Math.abs(d.y) >= Math.abs(d.z) ? 1 : 2;
    axis = component(d, i) > 0 ? -(i + 1) : i + 1;
  }
  return { fraction: enter, axis };
}

// A craft's collision (one each: the FPV drone, the boat, the special crafts, the floatplane and the jet, with their
// own radius and horizon): a small cache of the 1 m tiles near it, independent of visibility, render budget and the
// mesh-worker queue. Sim side (no three.js, no DOM, no fetch: tools/core-deps.mjs): the nodes' files come through the
// TileCache given (core/tile-cache.ts: the viewer's shared one, viewer-tiles.ts, or a tool's reading the disk), held
// while near; `now` is the clock (ms) its fetch pacing and retries read (the viewer's: performance.now).
export class VoxelCollision {
  readonly width: number;
  readonly depth: number;
  readonly ceiling: number;
  /** the map's height (meta.H) */
  readonly height: number;
  readonly radius: number;
  private readonly horizon: number;
  private readonly tileSide: number;
  private readonly row: number;
  private readonly nx: number;
  private readonly nz: number;
  // per palette id: 1 where the drone passes it in the foliage tile and does not settle on it (not core/semantics.ts
  // solidForDrone: grass; ids past the palette: solid)
  private readonly passable: Uint8Array;
  // per palette id: 1 for water (the boat's column, waterColumn)
  private readonly wet: Uint8Array;
  private readonly cache: TileCache;
  // the nodes this holds one reference to in the cache
  private readonly held = new Set<number>();
  private readonly tiles = new Map<number, CollisionTile>();
  private readonly inFlight = new Set<number>();
  private readonly retryAt = new Map<number, number>();
  private wanted: number[] = [];
  private nextPrefetch = 0;
  private unlisten: (() => void) | undefined;

  constructor(meta: Meta, cache: TileCache, private readonly now: () => number, { radius = RADIUS, horizon = HORIZON }: CollisionOptions = {}) {
    this.radius = radius;
    this.horizon = horizon;
    this.width = meta.W;
    this.depth = meta.D;
    this.ceiling = meta.H + 600;
    this.height = meta.H;
    this.tileSide = meta.tiles.N;
    this.row = this.tileSide + 2;
    this.nx = Math.ceil(meta.W / this.tileSide);
    this.nz = Math.ceil(meta.D / this.tileSide);
    this.passable = paletteMask(semanticTable(meta.palette), (f) => !RULES.solidForDrone(f));
    this.wet = paletteMask(semanticTable(meta.palette), RULES.water);
    this.cache = cache;
  }

  // A craft has left. Drop its local tiles and holds, and resume on its next prefetch.
  release() {
    this.unlisten?.();
    this.unlisten = undefined;
    this.nextPrefetch = 0;
    this.wanted = [];
    this.tiles.clear();
    this.retryAt.clear();
    for (const key of this.held) this.cache.release(key % this.nx, Math.floor(key / this.nx));
    this.held.clear();
    // In-flight loads check the current wanted list on arrival, which may have changed on re-entry.
  }

  // Node (tx, tz)'s columns changed (core/live-edits.ts, or its file again): its tile is read again, now where the
  // cache has it (its files in, or live columns with its foliage too), else loaded again
  private invalidate(tx: number, tz: number) {
    const key = tx + tz * this.nx;
    if (!this.tiles.delete(key) && !this.wanted.includes(key)) return;
    const v = this.cache.view(tx, tz);
    if (v) this.tiles.set(key, collisionTile(this.tileSide, v));
  }

  // A check stepping faster than wall time can ask for a fresh neighbourhood on demand.
  prefetch(p: Vec3, v: Vec3, refresh = false) {
    this.unlisten ??= this.cache.edits?.listen((tx, tz) => this.invalidate(tx, tz));
    const now = this.now();
    if (refresh || now >= this.nextPrefetch) {
      this.nextPrefetch = now + 160;
      // round the craft and round points along its path out to the horizon, no more than two nodes apart (so that
      // their 3 x 3 neighbourhoods touch: no node on the way is left out however fast it flies)
      const keys = this.near(p.x, p.z);
      const steps = Math.max(1, Math.ceil(Math.hypot(v.x, v.z) * this.horizon / (2 * this.tileSide)));
      for (let k = 1; k <= steps; k++) keys.push(...this.near(p.x + v.x * this.horizon * k / steps, p.z + v.z * this.horizon * k / steps));
      this.wanted = [...new Set(keys)];
      // Keep only the current and predictive neighbourhoods, including during quick resets.
      for (const key of this.tiles.keys()) if (!this.wanted.includes(key)) this.tiles.delete(key);
      for (const key of this.held) if (!this.wanted.includes(key)) { this.held.delete(key); this.cache.release(key % this.nx, Math.floor(key / this.nx)); }
      for (const key of this.retryAt.keys()) if (!this.wanted.includes(key)) this.retryAt.delete(key);
    }
    for (const key of this.wanted) {
      if (this.inFlight.size >= CONCURRENT_LOADS) break;
      if (this.tiles.has(key) || this.inFlight.has(key) || (this.retryAt.get(key) ?? 0) > now) continue;
      this.load(key);
    }
  }

  // The collision runs include integer voxel tops. Hull clearance must respect those even on sloped caps.
  voxelGround(x: number, z: number) {
    const ix = Math.floor(x), iz = Math.floor(z);
    return this.tileAt(ix, iz)?.ground[this.column(ix, iz)] ?? null;
  }

  surface(x: number, z: number) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const tile = this.tileAt(ix, iz);
    if (!tile) return null;
    const i = this.column(ix, iz);
    let top = tile.ground[i];
    for (const { offsets, data } of [tile.base, tile.foliage]) {
      for (let j = offsets[i]; j < offsets[i + 1]; j += 3) {
        if (!this.passable[data[j + 2]]) top = Math.max(top, data[j] + data[j + 1]);
      }
    }
    // (the caps of the ground's run and of the run the drone settles on: as drawn)
    if (!tile.caps) return { ground: tile.ground[i], top };
    const fx = x - ix, fz = z - iz;
    return { ground: surfaceAt(tile.caps, i, tile.ground[i], fx, fz), top: surfaceAt(tile.caps, i, top, fx, fz) };
  }

  // The drone's cube from p moved by d: how far it gets (fraction of d) and what it hits first
  sweep(p: Vec3, d: Vec3): Sweep {
    let fraction = 1;
    let hit: ImpactKind | null = null, normalAxis = 0;
    const result = (): Sweep => hit ? { fraction, hit, axis: normalAxis } : { fraction, hit: null };
    // Reserve room for the drone at the edges of the model.
    for (const [axis, extent] of [[0, this.width], [1, this.ceiling], [2, this.depth]]) {
      const r = this.radius;
      const start = component(p, axis), move = component(d, axis), end = start + move;
      if (end >= r && end <= extent - r) continue;
      const limit = (end < r ? r : extent - r);
      const t = move === 0 ? 0 : Math.max(0, (limit - start) / move);
      if (t <= fraction) {
        fraction = t;
        normalAxis = (axis + 1) * (end < r ? 1 : -1);
        hit = axis === 1 ? (end < r ? 'terrain' : 'ceiling') : 'city edge';
      }
    }

    const R = this.radius;
    const minX = Math.max(0, Math.floor(Math.min(p.x, p.x + d.x * fraction) - R));
    const maxX = Math.min(this.width - 1, Math.floor(Math.max(p.x, p.x + d.x * fraction) + R));
    const minZ = Math.max(0, Math.floor(Math.min(p.z, p.z + d.z * fraction) - R));
    const maxZ = Math.min(this.depth - 1, Math.floor(Math.max(p.z, p.z + d.z * fraction) + R));
    const minY = Math.min(p.y, p.y + d.y * fraction) - R;
    const maxY = Math.max(p.y, p.y + d.y * fraction) + R;
    if (minY > this.ceiling - 600) return result();

    for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
      const tile = this.tileAt(x, z);
      if (!tile) return 'loading';
      const i = this.column(x, z);
      const ground = tile.ground[i];
      if (minY <= ground) {
        const groundContact = contact(p, d, x, 0, ground, z, fraction, R);
        if (groundContact) {
          ({ fraction, axis: normalAxis } = groundContact);
          hit = 'terrain';
        }
      }
      for (const [kind, runs] of [['structure', tile.base], ['foliage', tile.foliage]] as const) {
        for (let j = runs.offsets[i]; j < runs.offsets[i + 1]; j += 3) {
          const lo = runs.data[j], hi = lo + runs.data[j + 1];
          if (lo > maxY) break;
          if (hi < minY) continue;
          if (kind === 'foliage' && this.passable[runs.data[j + 2]]) continue;
          const voxelContact = contact(p, d, x, lo, hi, z, fraction, R);
          if (voxelContact && (voxelContact.fraction < fraction || !hit)) {
            ({ fraction, axis: normalAxis } = voxelContact);
            hit = kind;
          }
        }
      }
    }
    return result();
  }

  // The boat's view of column (x, z) (sim/craft/boat-motion.ts): the top of its water (the river is the ground's top
  // voxel(s), physics/rapier/terrain.ts) or -1 where the ground's top is no water, and whether anything solid is in it
  // between y0 and y1 (the ground: up to the water's bottom; the runs over it, foliage that is no grass; the water not).
  // null: not loaded.
  waterColumn(x: number, z: number, y0: number, y1: number): { water: number; blocked: boolean } | null {
    if (x < 0 || z < 0 || x >= this.width || z >= this.depth) return { water: -1, blocked: true };
    const ix = Math.floor(x), iz = Math.floor(z), tile = this.tileAt(ix, iz);
    if (!tile) return null;
    const i = this.column(ix, iz), g = tile.ground[i];
    let water = -1, solid = g, blocked = false;
    const { offsets, data } = tile.base;
    for (let j = offsets[i]; j < offsets[i + 1]; j += 3) {
      const lo = data[j], hi = lo + data[j + 1];
      if (this.wet[data[j + 2]]) {
        if (hi >= g && lo < solid) { solid = lo; water = Math.max(water, hi); }
      } else if (hi > g && lo < y1 && hi > y0) blocked = true;
    }
    if (!blocked) {
      const f = tile.foliage;
      for (let j = f.offsets[i]; j < f.offsets[i + 1]; j += 3) {
        const lo = f.data[j], hi = lo + f.data[j + 1];
        if (!this.passable[f.data[j + 2]] && !this.wet[f.data[j + 2]] && lo < y1 && hi > y0) { blocked = true; break; }
      }
    }
    return { water, blocked: blocked || solid > y0 };
  }

  private column(x: number, z: number) {
    return x % this.tileSide + 1 + this.row * (z % this.tileSide + 1);
  }

  private tileAt(x: number, z: number) {
    return this.tiles.get(Math.floor(x / this.tileSide) + this.nx * Math.floor(z / this.tileSide));
  }

  private near(x: number, z: number) {
    const tx = Math.max(0, Math.min(this.nx - 1, Math.floor(x / this.tileSide)));
    const tz = Math.max(0, Math.min(this.nz - 1, Math.floor(z / this.tileSide)));
    const cells: { key: number; distance: number }[] = [];
    for (let j = Math.max(0, tz - 1); j <= Math.min(this.nz - 1, tz + 1); j++) {
      for (let i = Math.max(0, tx - 1); i <= Math.min(this.nx - 1, tx + 1); i++) {
        cells.push({ key: i + j * this.nx, distance: Math.abs(i - tx) + Math.abs(j - tz) });
      }
    }
    return cells.sort((a, b) => a.distance - b.distance).map(cell => cell.key);
  }

  private load(key: number) {
    const tx = key % this.nx, tz = Math.floor(key / this.nx);
    this.inFlight.add(key);
    this.cache.acquire(tx, tz)
      .then((v) => {
        // (one reference held per wanted node)
        const wanted = this.wanted.includes(key);
        if (!wanted || this.held.has(key)) this.cache.release(tx, tz); else this.held.add(key);
        if (!wanted) return;
        this.tiles.set(key, collisionTile(this.tileSide, v));
        this.retryAt.delete(key);
      })
      .catch(() => {
        if (this.wanted.includes(key)) this.retryAt.set(key, this.now() + 1500);
      })
      .finally(() => this.inFlight.delete(key));
  }
}
