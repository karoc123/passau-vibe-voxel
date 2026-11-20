import type * as THREE from 'three';
import { PAL_GROUND } from './chamfer';
import { rampField, rampHeight, type RampField } from './ramps';
import type { ColumnData, Meta } from './types';
import { paletteMask, RULES, semanticTable } from './core/semantics';

export interface ColumnSource {
  N: number;
  levels: number[];
  version: number;
  columns(key: string): ColumnData | undefined;
}

type Point = { x: number; y: number; z: number };

// Voxel queries over whatever is loaded, each cell answered by the finest loaded tile covering it.
// Arguments are data coordinates: x east, r (row) south, z up, in metres; three.js has them as (x, z, r).
export class World {
  readonly W: number;
  readonly D: number;
  hitAxis = 0;
  private cache: ColumnData | null = null;
  private cacheVersion = -1;
  // per palette id: 1 where topSolid does not stand on it (leaves; ids past the palette: 0)
  private readonly leaf: Uint8Array;
  private readonly paved: Uint8Array;
  // per 1 m tile: its ramps (ramps.ts), as the mesher draws them; null: none
  private readonly ramps = new WeakMap<ColumnData, RampField | null>();

  constructor(private readonly src: ColumnSource, meta: Meta) {
    this.W = meta.W;
    this.D = meta.D;
    const t = semanticTable(meta.palette);
    this.leaf = paletteMask(t, (f) => !RULES.standOnForWalker(f), 1, 4096);
    this.paved = paletteMask(t, RULES.paved, PAL_GROUND);
  }

  // the top of paved ground at (x, r) where it is a ramp (column i of node n), else null
  // (deck: a bridge deck's top too, ramps.ts; else the ground's only)
  private ramp(n: ColumnData, i: number, x: number, r: number, deck = true) {
    if (n.s !== 1) return null;
    let f = this.ramps.get(n);
    if (f === undefined) {
      f = rampField(this.src.N, n.counts, n.off, n.runs, n.ground, this.paved);
      if (!f.any) f = null;
      this.ramps.set(n, f);
    }
    return f && f.paved[i] && (deck || f.ground[i] === f.under[i]) ? rampHeight(f, i, x - Math.floor(x), r - Math.floor(r)) : null;
  }

  // where something on the ground at level z (a path's point, scripts/traffic.py: whole metres) stands at (x, r): on a
  // ramp near that level, its height there; else z
  surface(x: number, r: number, z: number) {
    const c = this.column(x, r), h = c && this.ramp(c[0], c[1], x, r);
    return h != null && Math.abs(h - z) <= 1.5 ? h : z;
  }

  inside(x: number, r: number) { return x >= 0 && r >= 0 && x < this.W && r < this.D; }

  private node(x: number, r: number): ColumnData | null {
    const { src } = this, c = this.cache;
    if (c && this.cacheVersion === src.version && x >= c.x0 && r >= c.y0 && x < c.x0 + src.N * c.s && r < c.y0 + src.N * c.s) return c;
    for (let i = src.levels.length - 1; i >= 0; i--) {
      const s = src.levels[i], L = src.N * s, d = src.columns(`${s}/${Math.floor(x / L)}_${Math.floor(r / L)}`);
      if (d) { this.cache = d; this.cacheVersion = src.version; return d; }
    }
    return null;
  }

  private column(x: number, r: number): [ColumnData, number] | null {
    if (!this.inside(x, r)) return null;
    const n = this.node(x, r);
    return n && [n, Math.floor((x - n.x0) / n.s) + 1 + n.S * (Math.floor((r - n.y0) / n.s) + 1)];
  }

  groundAt(x: number, r: number) {
    const c = this.column(x, r);
    return c ? this.ramp(c[0], c[1], x, r, false) ?? c[0].ground[c[1]] : 0;
  }

  // any voxel (core/semantics.ts RULES.solidForRay), or under the floor
  solid(x: number, r: number, z: number) {
    const c = this.column(x, r);
    if (!c) return z < 0;
    const [n, i] = c, zc = Math.floor(z / n.s), R = n.runs;
    if (zc < 0) return true;
    for (let k = n.off[i], e = n.off[i + 1]; k < e; k++) {
      const z0 = R[k * 3];
      if (zc < z0) return false;
      if (zc < z0 + R[k * 3 + 1]) return true;
    }
    return false;
  }

  // whether the voxel at (x, r, z) is in a room (scripts/interiors.py: a void carved out of a building on purpose), by
  // the 1 m tile there (a coarser level has no rooms: they are solid in it)
  inRoom(x: number, r: number, z: number) {
    const c = this.column(x, r);
    if (!c || !c[0].roomOff) return false;
    const [n, i] = c, M = n.rooms!, off = n.roomOff!, zc = Math.floor(z / n.s);
    for (let k = off[i]; k < off[i + 1]; k++) if (zc >= M[k * 4 + 1] && zc < M[k * 4 + 1] + M[k * 4 + 2]) return true;
    return false;
  }

  top(x: number, r: number) {
    const c = this.column(x, r);
    if (!c) return 0;
    const [n, i] = c, k = n.off[i + 1] - 1;
    return this.ramp(n, i, x, r) ?? (k < n.off[i] ? n.ground[i] : (n.runs[k * 3] + n.runs[k * 3 + 1]) * n.s);
  }

  topSolid(x: number, r: number) {
    const c = this.column(x, r);
    if (!c) return 0;
    const [n, i] = c, R = n.runs, h = this.ramp(n, i, x, r);
    if (h != null) return h;
    for (let k = n.off[i + 1] - 1; k >= n.off[i]; k--) if (!this.leaf[R[k * 3 + 2]]) return (R[k * 3] + R[k * 3 + 1]) * n.s;
    return n.ground[i];
  }

  // the highest surface at or below `top` to stand on
  support(x: number, r: number, top: number) {
    const c = this.column(x, r);
    if (!c) return 0;
    const [n, i] = c, R = n.runs, h = this.ramp(n, i, x, r);
    if (h != null && h <= top) return h; // (paved ground: nothing stands on it)
    let s = n.ground[i];
    for (let k = n.off[i], e = n.off[i + 1]; k < e; k++) {
      const t = (R[k * 3] + R[k * 3 + 1]) * n.s;
      if (t <= top && t > s) s = t;
    }
    return s;
  }

  // a bridge deck or footbridge: low, wide, with headroom beneath (roofs rise from the ground, so they don't count)
  deckAt(x: number, r: number) {
    const d = this.floatingSurface(x, r);
    if (d == null || d - this.groundAt(x, r) > 35) return null;
    for (const [dx, dr] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
      const e = this.floatingSurface(x + dx, r + dr);
      if (e == null || Math.abs(e - d) > 1.5) return null;
    }
    return d;
  }

  private floatingSurface(x: number, r: number) {
    const c = this.column(x, r);
    if (!c) return null;
    const [n, i] = c, R = n.runs, gz = n.ground[i] / n.s, e = n.off[i + 1];
    for (let k = n.off[i]; k < e; k++) {
      const z0 = R[k * 3], top = z0 + R[k * 3 + 1];
      if (z0 <= gz + 2 / n.s) continue;
      let ceil = 1e9;
      for (let j = k + 1; j < e; j++) if (R[j * 3 + 1] > 1) { ceil = R[j * 3]; break; } // 1-voxel runs (cables, lamp heads) are no ceiling
      if (ceil - top >= 2.5 / n.s) return top * n.s;
    }
    return null;
  }

  blocked(x: number, r: number, z0: number, z1: number) {
    for (let z = Math.floor(z0); z < z1; z++) if (this.solid(x, r, z)) return true;
    return false;
  }

  clearAround(x: number, r: number, g: number, high: number) {
    return !this.blocked(x, r, g, g + high) && !this.blocked(x + 1, r, g, g + 3) && !this.blocked(x - 1, r, g, g + 3)
      && !this.blocked(x, r + 1, g, g + 3) && !this.blocked(x, r - 1, g, g + 3);
  }

  // distance along d (unit, three.js axes) to the first solid voxel; sets hitAxis
  raycast(o: Point | THREE.Vector3, d: Point | THREE.Vector3, maxDist = 4000) {
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
    const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
    const tdx = sx ? Math.abs(1 / d.x) : Infinity, tdy = sy ? Math.abs(1 / d.y) : Infinity, tdz = sz ? Math.abs(1 / d.z) : Infinity;
    let tx = sx ? (sx > 0 ? x + 1 - o.x : o.x - x) * tdx : Infinity;
    let ty = sy ? (sy > 0 ? y + 1 - o.y : o.y - y) * tdy : Infinity;
    let tz = sz ? (sz > 0 ? z + 1 - o.z : o.z - z) * tdz : Infinity;
    let t = 0;
    for (let i = 0; i < 20000 && t < maxDist; i++) {
      if (y < 0) { this.hitAxis = 1; return t; }
      if (y < 420 && this.solid(x, z, y)) return t;
      if (y > 420 && sy >= 0) return Infinity;
      if (tx < ty && tx < tz) { t = tx; x += sx; tx += tdx; this.hitAxis = 0; }
      else if (ty < tz) { t = ty; y += sy; ty += tdy; this.hitAxis = 1; }
      else { t = tz; z += sz; tz += tdz; this.hitAxis = 2; }
    }
    return Infinity;
  }
}
