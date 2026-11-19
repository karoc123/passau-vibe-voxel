import type { Vector3 } from 'three';
import type { Meta } from '../types';
import { decodeTile, type Columns } from '../tile-data';
import { PAL_GROUND } from '../chamfer';
import { rampField, rampHeight, type RampField } from '../ramps';
import { fetchGzip } from '../util';
import { MAT, pavedGround } from '../voxelMaterial';

const RADIUS = 0.35;
const CONCURRENT_LOADS = 4;
type Runs = { offsets: Uint32Array; data: Uint16Array };
// ramps: the smooth paved ground (ramps.ts) as the mesher draws it, built on first use; null: none in the tile
type CollisionTile = { ground: Uint8Array; base: Runs; foliage: Runs; counts: Uint16Array; ramps?: RampField | null };
export type ImpactKind = 'terrain' | 'structure' | 'foliage' | 'city edge' | 'ceiling';
// Normal as a signed one-based axis index (x, y, z).
type Contact = { fraction: number; axis: number };
export type Sweep = (Contact & { hit: ImpactKind }) | { fraction: number; hit: null } | 'loading';
export interface SweepOptions {
  half?: Vector3; // the box's half extents (default: the drone's 35 cm cube)
  above?: number; // ignore voxels (and the ground) whose top is at or below this height: what a body steps over
  foliage?: boolean; // trees block (default true)
  water?: boolean; // water blocks (default true)
  escape?: boolean; // what the box already overlaps doesn't block it (default false: it blocks the move along its axis)
}
// a surface to stand on; water: the river's (or a pond's) top
export interface Support { height: number; water: boolean }
const CUBE = { x: RADIUS, y: RADIUS, z: RADIUS };

function runsOf(columns: Columns): Runs {
  const offsets = new Uint32Array(columns.counts.length + 1);
  for (let i = 0; i < columns.counts.length; i++) offsets[i + 1] = offsets[i] + columns.counts[i] * 3;
  return { offsets, data: columns.runs };
}

// Sweeps a box (half extents h; the drone's 70 cm cube by default) through one column segment, expanded by h.
function contact(p: Vector3, d: Vector3, x: number, lo: number, hi: number, z: number, limit: number, h: { x: number; y: number; z: number }, escape = false) {
  let enter = 0, leave = limit, axis = 0;
  for (let i = 0; i < 3; i++) {
    const r = i === 0 ? h.x : i === 1 ? h.y : h.z;
    const min = (i === 0 ? x : i === 1 ? lo : z) - r;
    const max = (i === 0 ? x + 1 : i === 1 ? hi : z + 1) + r;
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
    if (escape) return null;
    const i = Math.abs(d.x) >= Math.abs(d.y) && Math.abs(d.x) >= Math.abs(d.z) ? 0 : Math.abs(d.y) >= Math.abs(d.z) ? 1 : 2;
    axis = d.getComponent(i) > 0 ? -(i + 1) : i + 1;
  }
  return { fraction: enter, axis };
}

// A small collision cache independent of visibility, render budget and the mesh-worker queue.
export class VoxelCollision {
  readonly width: number;
  readonly depth: number;
  readonly ceiling: number;
  private readonly tileSide: number;
  private readonly row: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly material: Uint8Array;
  private readonly paved: Uint8Array;
  private readonly tiles = new Map<number, CollisionTile>();
  private readonly inFlight = new Set<number>();
  private readonly retryAt = new Map<number, number>();
  private wanted: number[] = [];
  private nextPrefetch = 0;

  constructor(meta: Meta) {
    this.width = meta.W;
    this.depth = meta.D;
    this.ceiling = meta.H + 600;
    this.tileSide = meta.tiles.N;
    this.row = this.tileSide + 2;
    this.nx = Math.ceil(meta.W / this.tileSide);
    this.nz = Math.ceil(meta.D / this.tileSide);
    this.material = Uint8Array.from(meta.palette, p => p[3]);
    this.paved = Uint8Array.from(meta.palette, p => (pavedGround(p) ? PAL_GROUND : 0));
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
        if (this.material[data[j + 2]] !== MAT.GRASS) top = Math.max(top, data[j] + data[j + 1]);
      }
    }
    return { ground: tile.ground[i], top };
  }

  roadSurface(x: number, z: number, from: number, clearance: number) {
    const ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= this.width || iz >= this.depth) return { height: from, blocked: true };
    const tile = this.tileAt(ix, iz);
    if (!tile) return null;
    const i = this.column(ix, iz);
    const base = tile.base, ceiling = from + 1.07;
    let height = tile.ground[i], water = false;
    if (height > ceiling) return { height, blocked: true, water };
    for (let j = base.offsets[i]; j < base.offsets[i + 1]; j += 3) {
      const top = base.data[j] + base.data[j + 1];
      if (top >= height && top <= ceiling) {
        height = top;
        water = this.material[base.data[j + 2]] === MAT.WATER;
      }
    }
    // Water is no wall: whoever drives into it sinks (drive.prototype.ts).
    if (water) return { height, blocked: false, water };
    // (a ramp's top may lie up to a metre below its voxel's: the voxel is the ramp, nothing over it)
    const voxel = height;
    if (height === tile.ground[i]) height = this.ramp(tile, i, x, z) ?? height;
    // The car can step over 1 m changes in the source terrain. Keep the body clear over lower wheel samples.
    const bottom = Math.max(voxel, height, from - 0.45);
    for (const layer of [base, tile.foliage]) {
      for (let j = layer.offsets[i]; j < layer.offsets[i + 1]; j += 3) {
        const lo = layer.data[j], hi = lo + layer.data[j + 1];
        if (lo >= bottom + clearance) break;
        if (hi > bottom && this.material[layer.data[j + 2]] !== MAT.GRASS) return { height, blocked: true, water };
      }
    }
    return { height, blocked: false, water };
  }

  // The highest surface at or below `top` at (x, z): the ground (smooth where it is a ramp), a roof, a deck, water.
  // Foliage is not stood on. null: the tile is still loading.
  support(x: number, z: number, top: number): Support | null {
    const ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= this.width || iz >= this.depth) return { height: 0, water: false };
    const tile = this.tileAt(ix, iz);
    if (!tile) return null;
    const i = this.column(ix, iz), base = tile.base, ground = tile.ground[i];
    let height = ground, water = false;
    for (let j = base.offsets[i]; j < base.offsets[i + 1]; j += 3) {
      const t = base.data[j] + base.data[j + 1];
      if (t > top) break;
      if (t >= height) { height = t; water = this.material[base.data[j + 2]] === MAT.WATER; }
    }
    if (height === ground && !water) {
      const ramp = this.ramp(tile, i, x, z);
      if (ramp != null && ramp <= top + 1) height = ramp;
    }
    return { height, water };
  }

  private ramp(tile: CollisionTile, i: number, x: number, z: number) {
    if (tile.ramps === undefined) {
      const off = new Uint32Array(tile.counts.length + 1);
      for (let c = 0; c < tile.counts.length; c++) off[c + 1] = off[c] + tile.counts[c];
      const f = rampField(this.tileSide, tile.counts, off, tile.base.data, tile.ground, this.paved);
      tile.ramps = f.any ? f : null;
    }
    const f = tile.ramps;
    return f && f.paved[i] ? rampHeight(f, i, x - Math.floor(x), z - Math.floor(z)) : null;
  }

  sweep(p: Vector3, d: Vector3, options?: SweepOptions): Sweep {
    const h = options?.half ?? CUBE, above = options?.above ?? -Infinity;
    const foliage = options?.foliage ?? true, water = options?.water ?? true, escape = !!options?.escape;
    let fraction = 1;
    let hit: ImpactKind | null = null, normalAxis = 0;
    const result = (): Sweep => hit ? { fraction, hit, axis: normalAxis } : { fraction, hit: null };
    // Reserve room for the drone at the edges of the model.
    for (const [axis, extent] of [[0, this.width], [1, this.ceiling], [2, this.depth]]) {
      const r = axis === 0 ? h.x : axis === 1 ? h.y : h.z;
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

    const minX = Math.max(0, Math.floor(Math.min(p.x, p.x + d.x * fraction) - h.x));
    const maxX = Math.min(this.width - 1, Math.floor(Math.max(p.x, p.x + d.x * fraction) + h.x));
    const minZ = Math.max(0, Math.floor(Math.min(p.z, p.z + d.z * fraction) - h.z));
    const maxZ = Math.min(this.depth - 1, Math.floor(Math.max(p.z, p.z + d.z * fraction) + h.z));
    const minY = Math.min(p.y, p.y + d.y * fraction) - h.y;
    const maxY = Math.max(p.y, p.y + d.y * fraction) + h.y;
    if (minY > this.ceiling - 600) return result();

    for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
      const tile = this.tileAt(x, z);
      if (!tile) return 'loading';
      const i = this.column(x, z);
      const ground = tile.ground[i];
      if (minY <= ground && ground > above) {
        const groundContact = contact(p, d, x, 0, ground, z, fraction, h, escape);
        if (groundContact) {
          ({ fraction, axis: normalAxis } = groundContact);
          hit = 'terrain';
        }
      }
      for (const [kind, runs] of [['structure', tile.base], ['foliage', tile.foliage]] as const) {
        for (let j = runs.offsets[i]; j < runs.offsets[i + 1]; j += 3) {
          const lo = runs.data[j], hi = lo + runs.data[j + 1];
          if (lo > maxY) break;
          if (hi < minY || hi <= above) continue;
          const material = this.material[runs.data[j + 2]];
          if (kind === 'foliage' ? !foliage || material === MAT.GRASS : !water && material === MAT.WATER) continue;
          const voxelContact = contact(p, d, x, lo, hi, z, fraction, h, escape);
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
    const path = `${key % this.nx}_${Math.floor(key / this.nx)}.bin`;
    this.inFlight.add(key);
    Promise.all(['1', '1f'].map(s => fetchGzip(`data/tiles/${s}/${path}`)))
      .then(([base, foliage]) => {
        if (!this.wanted.includes(key)) return;
        const terrain = decodeTile(base, this.tileSide);
        this.tiles.set(key, { ground: terrain.ground, base: runsOf(terrain), foliage: runsOf(decodeTile(foliage, this.tileSide)), counts: terrain.counts });
        this.retryAt.delete(key);
      })
      .catch(() => this.retryAt.set(key, performance.now() + 1500))
      .finally(() => this.inFlight.delete(key));
  }
}
