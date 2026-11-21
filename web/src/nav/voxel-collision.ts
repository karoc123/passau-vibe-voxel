import type { Vector3 } from 'three';
import type { Meta } from '../types';
import type { RawColumns } from '../tile-data';
import { liveEdits } from '../core/live-edits';
import { paletteMask, RULES, semanticTable } from '../core/semantics';
import { TileCache } from '../core/tile-cache';
import { fetchGzip } from '../fetch';
import { capField, surfaceAt, type CapField } from '../core/surface';
import { CAPS } from '../caps-mode';

const RADIUS = 0.35;
const CONCURRENT_LOADS = 4;
type Runs = { offsets: Uint32Array; data: Uint16Array };
// caps: the node's sloped surfaces (core/surface.ts), what surface() reads -- the sweep keeps the voxels (a cap lies
// within 0.875 m of its voxel's top; the drone is no ground vehicle)
type CollisionTile = { ground: Uint8Array; base: Runs; foliage: Runs; caps: CapField | null };
const collisionTile = (N: number, v: { base: RawColumns & { ground: Uint8Array; caps?: Uint16Array | null }; foliage: RawColumns }): CollisionTile =>
  ({ ground: v.base.ground, base: runsOf(v.base), foliage: runsOf(v.foliage), caps: CAPS.use && v.base.caps ? capField(N, v.base) : null });
export type ImpactKind = 'terrain' | 'structure' | 'foliage' | 'city edge' | 'ceiling';
// Normal as a signed one-based axis index (x, y, z).
type Contact = { fraction: number; axis: number };
export type Sweep = (Contact & { hit: ImpactKind }) | { fraction: number; hit: null } | 'loading';

function runsOf(columns: RawColumns): Runs {
  const offsets = new Uint32Array(columns.counts.length + 1);
  for (let i = 0; i < columns.counts.length; i++) offsets[i + 1] = offsets[i] + columns.counts[i] * 3;
  return { offsets, data: columns.runs };
}

// Sweeps the drone's 70 cm cube through one column segment, expanded by its half.
function contact(p: Vector3, d: Vector3, x: number, lo: number, hi: number, z: number, limit: number) {
  let enter = 0, leave = limit, axis = 0;
  for (let i = 0; i < 3; i++) {
    const min = (i === 0 ? x : i === 1 ? lo : z) - RADIUS;
    const max = (i === 0 ? x + 1 : i === 1 ? hi : z + 1) + RADIUS;
    const start = p.getComponent(i), move = d.getComponent(i);
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
    axis = d.getComponent(i) > 0 ? -(i + 1) : i + 1;
  }
  return { fraction: enter, axis };
}

// The FPV drone's collision (fpv.ts): a small cache of the 1 m tiles near it, independent of visibility,
// render budget and the mesh-worker queue. The nodes' files come through a TileCache (core/tile-cache.ts: given, e.g.
// the viewer's shared one, or its own fetching data/tiles/), held while near.
export class VoxelCollision {
  readonly width: number;
  readonly depth: number;
  readonly ceiling: number;
  private readonly tileSide: number;
  private readonly row: number;
  private readonly nx: number;
  private readonly nz: number;
  // per palette id: 1 where the drone passes it in the foliage tile and does not settle on it (not core/semantics.ts
  // solidForDrone: grass; ids past the palette: solid)
  private readonly passable: Uint8Array;
  private readonly cache: TileCache;
  // the nodes this holds one reference to in the cache
  private readonly held = new Set<number>();
  private readonly tiles = new Map<number, CollisionTile>();
  private readonly inFlight = new Set<number>();
  private readonly retryAt = new Map<number, number>();
  private wanted: number[] = [];
  private nextPrefetch = 0;

  constructor(meta: Meta, cache?: TileCache) {
    this.width = meta.W;
    this.depth = meta.D;
    this.ceiling = meta.H + 600;
    this.tileSide = meta.tiles.N;
    this.row = this.tileSide + 2;
    this.nx = Math.ceil(meta.W / this.tileSide);
    this.nz = Math.ceil(meta.D / this.tileSide);
    this.passable = paletteMask(semanticTable(meta.palette), (f) => !RULES.solidForDrone(f));
    this.cache = cache ?? new TileCache({ N: this.tileSide, load: (p) => fetchGzip(`data/tiles/${p}`), edits: liveEdits });
    // (one per page, fpv.ts: listens as long as the page lives)
    liveEdits.listen((tx, tz) => this.invalidate(tx, tz));
  }

  // Node (tx, tz)'s columns changed (core/live-edits.ts, or its file again): its tile is read again, now where the
  // cache has it (its files in, or live columns with its foliage too), else loaded again
  invalidate(tx: number, tz: number) {
    const key = tx + tz * this.nx;
    if (!this.tiles.delete(key) && !this.wanted.includes(key)) return;
    const v = this.cache.view(tx, tz);
    if (v) this.tiles.set(key, collisionTile(this.tileSide, v));
  }

  prefetch(p: Vector3, v: Vector3) {
    const now = performance.now();
    if (now >= this.nextPrefetch) {
      this.nextPrefetch = now + 160;
      const current = this.near(p.x, p.z);
      const ahead = this.near(p.x + v.x * 2.2, p.z + v.z * 2.2);
      this.wanted = [...new Set([...current, ...ahead])];
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
  sweep(p: Vector3, d: Vector3): Sweep {
    let fraction = 1;
    let hit: ImpactKind | null = null, normalAxis = 0;
    const result = (): Sweep => hit ? { fraction, hit, axis: normalAxis } : { fraction, hit: null };
    // Reserve room for the drone at the edges of the model.
    for (const [axis, extent] of [[0, this.width], [1, this.ceiling], [2, this.depth]]) {
      const r = RADIUS;
      const start = p.getComponent(axis), move = d.getComponent(axis), end = start + move;
      if (end >= r && end <= extent - r) continue;
      const limit = (end < r ? r : extent - r);
      const t = move === 0 ? 0 : Math.max(0, (limit - start) / move);
      if (t <= fraction) {
        fraction = t;
        normalAxis = (axis + 1) * (end < r ? 1 : -1);
        hit = axis === 1 ? (end < r ? 'terrain' : 'ceiling') : 'city edge';
      }
    }

    const minX = Math.max(0, Math.floor(Math.min(p.x, p.x + d.x * fraction) - RADIUS));
    const maxX = Math.min(this.width - 1, Math.floor(Math.max(p.x, p.x + d.x * fraction) + RADIUS));
    const minZ = Math.max(0, Math.floor(Math.min(p.z, p.z + d.z * fraction) - RADIUS));
    const maxZ = Math.min(this.depth - 1, Math.floor(Math.max(p.z, p.z + d.z * fraction) + RADIUS));
    const minY = Math.min(p.y, p.y + d.y * fraction) - RADIUS;
    const maxY = Math.max(p.y, p.y + d.y * fraction) + RADIUS;
    if (minY > this.ceiling - 600) return result();

    for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
      const tile = this.tileAt(x, z);
      if (!tile) return 'loading';
      const i = this.column(x, z);
      const ground = tile.ground[i];
      if (minY <= ground) {
        const groundContact = contact(p, d, x, 0, ground, z, fraction);
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
          const voxelContact = contact(p, d, x, lo, hi, z, fraction);
          if (voxelContact && (voxelContact.fraction < fraction || !hit)) {
            ({ fraction, axis: normalAxis } = voxelContact);
            hit = kind;
          }
        }
      }
    }
    return result();
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
      .catch(() => this.retryAt.set(key, performance.now() + 1500))
      .finally(() => this.inFlight.delete(key));
  }
}
