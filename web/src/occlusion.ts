import * as THREE from 'three';
import type { ColumnData } from './core/meta';
import { TILE_N } from './core/tile-data';

// Occlusion culling of the city's tile meshes against the city itself, on the CPU, each frame, for the main camera
// only (the sun's shadow map draws every caster, as before).
//
// The city is a heightfield, nearly: each column is solid from the bottom up to some height (its occluder height:
// the runs from z = 0 up, unbroken, of opaque voxels -- not leaves, water or fountain jets -- less a metre for roof
// slopes, eroded by a column all round for chamfered corners). Those heights, the minimum over 2 m cells and then over
// 4, 8 .. 128 m cells (a min-pyramid), stand for what blocks the view; where a tile is not in, or not all shown yet,
// its cells are 0 and block nothing. A room (scripts/interiors.py: a void carved out of a building on purpose, enclosed
// but for its doors) counts as the solid building it was, so that a building with rooms hides as much as before: its
// spans fill the gaps in the runs. Not near the camera, which may stand in a room or look into one through its door: a
// tile with rooms keeps a second pyramid without them (as the voxels are), drawn on while the camera is in that tile or
// one of the eight round it. The pyramid is kept per 128 m tile (5.3 kB each), only for the tiles that block
// something -- those shown, so within the view distance -- not over the map: its size and the march's reach follow
// what is shown around the camera, not the map's area. The march finds a tile's pyramid through a grid over the box of
// the tiles held (made again when they change).
//
// Per frame: the view's azimuths in bins of a fraction of a degree. Along each bin the march goes outward in steps;
// at distance r the chord across the bin (both its edges at r) lies in at most 2 x 2 cells of the first level whose
// cells are as wide as the chord, and the least of their heights h is solid all across it from the ground up. So
// every ray in that bin that passes the chord with an elevation (tangent) under (h - eye) / r is blocked there: the
// bin's horizon after step k is the greatest such tangent so far. A box (a tile's mesh) is hidden if, in every bin
// its footprint spans, the horizon at its nearest distance is above the tangent of its top. Conservative throughout:
// a cell too coarse, a step too long or a bin too wide only ever blocks less. The march in a bin stops once its
// horizon is above anything that could stand further out (maxY).
const LEVELS = 7; // cells of 2, 4 .. 128 m
// per tile: level l's (64 >> l)^2 cells, row by row, from OFF[l]
const OFF = new Int32Array(LEVELS + 1);
for (let l = 1; l <= LEVELS; l++) OFF[l] = OFF[l - 1] + (64 >> (l - 1)) ** 2;
const PYR = OFF[LEVELS];
const MAX_BINS = 160, MIN_BIN = 0.006, MAX_STEPS = 256, R0 = 1.5;

export class Occlusion {
  // the tiles' pyramids, each at an offset in one pool (by tile index ty * nx + tx; free: offsets given back), and the
  // grid over their box (gx0, gy0, gw x gh tiles: the offset, -1 none); hollow: those of the tiles with rooms, the
  // rooms left open, which the grid takes within a tile of the camera's (cx, cy)
  private readonly tiles = new Map<number, number>();
  private readonly hollow = new Map<number, number>();
  private cx = -1e9; private cy = -1e9;
  private pool = new Uint8Array(0);
  private readonly free: number[] = [];
  private grid = new Int32Array(0);
  private gx0 = 0; private gy0 = 0; private gw = 0; private gh = 0;
  private gridDirty = false;
  private readonly colH: Uint8Array;
  // per frame
  private readonly key = new Float64Array(32);
  private built = false;
  private none = true;
  private ex = 0; private ey = 0; private ez = 0;
  private aRef = 0; private aMin = 0; private delta = 0; private nb = 0; private full = false; private K = 0; private top = Infinity;
  private readonly rs = new Float32Array(MAX_STEPS);
  private readonly stepL = new Uint8Array(MAX_STEPS);
  private readonly hor = new Float32Array(MAX_BINS * MAX_STEPS);
  private readonly kEnd = new Int32Array(MAX_BINS);
  private readonly v = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  // opaque: per palette entry, 1 where its voxels hide what is behind them
  // nx: the map's tiles in a row (the tiles' index)
  constructor(private readonly nx: number, private readonly opaque: Uint8Array, private readonly maxY: number, private readonly T = TILE_N) {
    this.colH = new Uint8Array((T + 2) * (T + 2));
  }

  // what it holds (tools): tiles, bytes
  get stats() { return { tiles: this.tiles.size, hollow: this.hollow.size, bytes: this.pool.byteLength + this.grid.byteLength + this.hor.byteLength }; }

  // the occluder heights of a T x T m tile from the column data drawn there (each source: 1 m or a coarser level
  // covering it; the least of them where several), or none: it blocks nothing
  setTile(tx: number, ty: number, sources: ColumnData[]) {
    const key = ty * this.nx + tx;
    if (!sources.length) { this.drop(this.tiles, key); this.drop(this.hollow, key); return; }
    this.pyramid(this.slot(this.tiles, key), tx, ty, sources, true);
    if (sources.some((d) => d.rooms)) this.pyramid(this.slot(this.hollow, key), tx, ty, sources, false);
    else this.drop(this.hollow, key);
  }

  // the pool's offset of the tile's pyramid in map, a new one if it has none
  private slot(map: Map<number, number>, key: number) {
    let o = map.get(key);
    if (o === undefined) {
      if (!this.free.length) {
        // (a quarter more room at a time)
        const n = this.pool.length / PYR, more = Math.max(16, n >> 2), pool = new Uint8Array((n + more) * PYR);
        pool.set(this.pool);
        this.pool = pool;
        for (let k = n + more - 1; k >= n; k--) this.free.push(k * PYR);
      }
      o = this.free.pop()!;
      map.set(key, o);
      this.gridDirty = true;
    }
    return o;
  }

  private drop(map: Map<number, number>, key: number) {
    const o = map.get(key);
    if (o !== undefined) { map.delete(key); this.free.push(o); this.gridDirty = true; }
  }

  // the tile's pyramid at offset o0 of the pool (rooms: filled, else open)
  private pyramid(o0: number, tx: number, ty: number, sources: ColumnData[], rooms: boolean) {
    const T = this.T, x0 = tx * T, y0 = ty * T, S = T + 2, colH = this.colH;
    const P = this.pool.subarray(o0, o0 + PYR);
    // the tile's columns and one all round (from the sources' aprons)
    for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
      const X = x0 + c - 1, Y = y0 + r - 1;
      let h = 255;
      for (const d of sources) {
        const cx = Math.floor((X - d.x0) / d.s) + 1, cy = Math.floor((Y - d.y0) / d.s) + 1;
        if (cx < 0 || cy < 0 || cx >= d.S || cy >= d.S) { h = 0; break; }
        h = Math.min(h, this.column(d, cx + d.S * cy, rooms));
      }
      colH[r * S + c] = h === 255 ? 0 : h;
    }
    // 2 m cells: the least of their 2 x 2 columns and the ring around them (eroded by a column)
    const n = T / 2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let m = 255;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) m = Math.min(m, colH[(2 * j + dy) * S + 2 * i + dx]);
      P[j * n + i] = m;
    }
    // (a 128 m tile's cells of 2 << l m nest in it: no cell of a level lies across two tiles)
    for (let l = 1; l < LEVELS; l++) {
      const a = OFF[l - 1], aw = n >> (l - 1), b = OFF[l], bw = n >> l;
      for (let j = 0; j < bw; j++) for (let i = 0; i < bw; i++) {
        const k = a + 2 * j * aw + 2 * i;
        P[b + j * bw + i] = Math.min(P[k], P[k + 1], P[k + aw], P[k + aw + 1]);
      }
    }
  }

  // the grid over the tiles held, again if they changed
  private regrid() {
    if (!this.gridDirty) return;
    this.gridDirty = false;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (const k of this.tiles.keys()) {
      const x = k % this.nx, y = Math.floor(k / this.nx);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x1 < 0) { this.grid = new Int32Array(0); this.gw = this.gh = 0; return; }
    this.gx0 = x0; this.gy0 = y0; this.gw = x1 - x0 + 1; this.gh = y1 - y0 + 1;
    this.grid = new Int32Array(this.gw * this.gh).fill(-1);
    for (const [k, o] of this.tiles) {
      const x = k % this.nx, y = Math.floor(k / this.nx), h = this.hollow.get(k);
      this.grid[(y - y0) * this.gw + x - x0] = h !== undefined && Math.abs(x - this.cx) <= 1 && Math.abs(y - this.cy) <= 1 ? h : o;
    }
  }

  // the occluder height of level l's cell (i, j) (cells of 2 << l m from the map's corner; 0 where no tile is held)
  private at(l: number, i: number, j: number) {
    const sh = 6 - l, tx = (i >> sh) - this.gx0, ty = (j >> sh) - this.gy0;
    if (tx < 0 || ty < 0 || tx >= this.gw || ty >= this.gh) return 0;
    const o = this.grid[ty * this.gw + tx];
    if (o < 0) return 0;
    const m = (1 << sh) - 1;
    return this.pool[o + OFF[l] + ((j & m) << sh) + (i & m)];
  }

  // a column's occluder height in metres: opaque runs from the bottom up, unbroken, less one cell; with its rooms
  // (rooms: as the solid they were), a run within them not breaking it either
  private column(d: ColumnData, i: number, rooms: boolean) {
    const R = d.runs, M = rooms && d.roomOff ? d.rooms! : null;
    let h = 0, q = M ? d.roomOff![i] : 0;
    const qe = M ? d.roomOff![i + 1] : 0;
    for (let k = d.off[i], e = d.off[i + 1]; ;) {
      if (q < qe && M![q * 4 + 1] <= h) { h = Math.max(h, M![q * 4 + 1] + M![q * 4 + 2]); q++; continue; }
      if (k >= e) break;
      const z0 = R[k * 3], z1 = z0 + R[k * 3 + 1];
      if (z1 <= h) { k++; continue; }
      if (z0 > h || !this.opaque[R[k * 3 + 2]]) break;
      h = z1; k++;
    }
    return Math.min(254, Math.max(0, (h - 1) * d.s));
  }

  // the horizons for this camera, built again only when it moved (or force); true when built. (Not for the TAA's
  // sub-pixel jitter, taa.ts: the projection's elements 8 and 9, a far smaller shift than the bins' margins.)
  prepare(camera: THREE.PerspectiveCamera, force = false) {
    const k = this.key, a = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
    let same = this.built && !force;
    for (let i = 0; i < 16; i++) { if (k[i] !== a[i] || (i !== 8 && i !== 9 && k[16 + i] !== p[i])) same = false; k[i] = a[i]; k[16 + i] = p[i]; }
    if (same) return false;
    this.build(camera);
    return true;
  }

  private build(camera: THREE.PerspectiveCamera) {
    this.built = true;
    const ex = this.ex = camera.matrixWorld.elements[12], ey = this.ey = camera.matrixWorld.elements[13], ez = this.ez = camera.matrixWorld.elements[14];
    const v = this.v, fwd = camera.getWorldDirection(this.fwd);
    // the azimuths in view: from the frustum's corners, unless it holds the zenith or the nadir (then all round)
    this.aRef = Math.abs(fwd.y) < 0.999 ? Math.atan2(fwd.z, fwd.x) : 0;
    let full = false;
    for (const s of [1, -1]) {
      v.set(ex, ey + s * 10, ez).project(camera);
      if (Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z < 1 && v.z > -1) full = true;
    }
    let lo = Infinity, hi = -Infinity;
    if (!full) for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1]]) {
      v.set(x, y, 0.5).unproject(camera);
      const az = wrap(Math.atan2(v.z - ez, v.x - ex) - this.aRef);
      lo = Math.min(lo, az); hi = Math.max(hi, az);
    }
    if (full || hi - lo > Math.PI * 1.5) { full = true; lo = -Math.PI; hi = Math.PI; }
    else { lo -= 0.01; hi += 0.01; }
    this.full = full;
    // the steepest ray in view (along the frustum's top edge), as a tangent: nothing above it needs hiding
    let top = Infinity;
    if (!full) {
      top = -Infinity;
      for (const x of [-1, 0, 1]) { v.set(x, 1, 0.5).unproject(camera); top = Math.max(top, (v.y - ey) / Math.hypot(v.x - ex, v.z - ez)); }
      top += 0.02;
    }
    this.top = top;
    const nb = this.nb = Math.max(1, Math.min(MAX_BINS, Math.ceil((hi - lo) / MIN_BIN)));
    const delta = this.delta = (hi - lo) / nb;
    this.aMin = lo;
    // the steps, the same for every bin: a metre apart, then 4 % of the distance; out to the furthest tile held (the
    // grid again when the camera moved to another tile and some tile has rooms: their pyramids near it are open)
    const T = this.T, ctx = Math.floor(ex / T), cty = Math.floor(ez / T);
    if (ctx !== this.cx || cty !== this.cy) { this.cx = ctx; this.cy = cty; if (this.hollow.size) this.gridDirty = true; }
    this.regrid();
    const gx0 = this.gx0 * T, gx1 = (this.gx0 + this.gw) * T, gz0 = this.gy0 * T, gz1 = (this.gy0 + this.gh) * T;
    const far = this.gw ? Math.min(camera.far, Math.hypot(Math.max(ex - gx0, gx1 - ex), Math.max(ez - gz0, gz1 - ez)) + 1) : 0;
    let K = 0;
    for (let r = R0; r < far && K < MAX_STEPS; K++) {
      this.rs[K] = r;
      const w = r * delta * 1.02 + 1e-3;
      let l = 0;
      while (l < LEVELS - 1 && 2 << l < w) l++;
      this.stepL[K] = 2 << l >= w ? l : 255;
      r += Math.max(1, 0.04 * r);
    }
    this.K = K;
    const cosHalf = Math.cos(delta / 2), cap = this.maxY - ey, hor = this.hor;
    const pool = this.pool, grid = this.grid, gX = this.gx0, gY = this.gy0, gw = this.gw, gh = this.gh;
    // standing inside the occluders (in a wall, under ground): nothing is hidden -- by the eye's own 2 m cell, not by all
    // of the cells within a metre of it (an eye inside a building sees out through its walls' back faces, and the march
    // had the building hide the street beyond them); above all of the city: hardly anything (a building would hide only
    // what is lower still, behind it), not worth the march
    this.none = ey > this.maxY || this.cellMin(0, ex, ez, ex, ez) > ey - 0.5;
    if (this.none) return;
    for (let b = 0; b < nb; b++) {
      const a = this.aRef + lo + b * delta, c0 = Math.cos(a), s0 = Math.sin(a), c1 = Math.cos(a + delta), s1 = Math.sin(a + delta);
      let H = -Infinity, k = 0;
      const base = b * MAX_STEPS;
      for (; k < K; k++) {
        const r = this.rs[k], l = this.stepL[k];
        if (l !== 255) {
          const inv = 1 / (2 << l);
          const ax = ex + r * c0, az = ez + r * s0, bx = ex + r * c1, bz = ez + r * s1;
          const xl = ax < bx ? ax : bx, xh = ax < bx ? bx : ax, zl = az < bz ? az : bz, zh = az < bz ? bz : az;
          const i0 = (xl * inv) | 0, i1 = (xh * inv) | 0, j0 = (zl * inv) | 0, j1 = (zh * inv) | 0;
          if (xl >= 0 && zl >= 0) {
            let h: number;
            const sh = 6 - l, tx = (i0 >> sh) - gX, ty = (j0 >> sh) - gY;
            if ((i1 >> sh) - gX === tx && (j1 >> sh) - gY === ty) {
              // (all in one tile, as mostly: its pyramid looked up once)
              const o = tx < 0 || ty < 0 || tx >= gw || ty >= gh ? -1 : grid[ty * gw + tx];
              if (o < 0) h = 0;
              else {
                const m = (1 << sh) - 1, b = o + OFF[l];
                h = pool[b + ((j0 & m) << sh) + (i0 & m)];
                if (i1 !== i0) h = Math.min(h, pool[b + ((j0 & m) << sh) + (i1 & m)]);
                if (j1 !== j0) { h = Math.min(h, pool[b + ((j1 & m) << sh) + (i0 & m)]); if (i1 !== i0) h = Math.min(h, pool[b + ((j1 & m) << sh) + (i1 & m)]); }
              }
            } else {
              h = this.at(l, i0, j0);
              if (h > 0 && i1 !== i0) h = Math.min(h, this.at(l, i1, j0));
              if (h > 0 && j1 !== j0) { h = Math.min(h, this.at(l, i0, j1)); if (h > 0 && i1 !== i0) h = Math.min(h, this.at(l, i1, j1)); }
            }
            if (h > 0) {
              const t = h >= ey ? (h - ey) / r : (h - ey) / (r * cosHalf);
              if (t > H) H = t;
            }
          }
        }
        hor[base + k] = H;
        // above all that could stand further out, or above the view
        if (H > top || H > (cap > 0 ? cap / r : 0)) break;
      }
      this.kEnd[b] = Math.min(k, K - 1);
    }
  }

  private cellMin(l: number, x0: number, z0: number, x1: number, z1: number) {
    const cs = 2 << l;
    let m = 255;
    for (let j = Math.floor(z0 / cs); j <= Math.floor(z1 / cs); j++) for (let i = Math.floor(x0 / cs); i <= Math.floor(x1 / cs); i++)
      m = Math.min(m, i >= 0 && j >= 0 ? this.at(l, i, j) : 0);
    return m;
  }

  // is the box (world space, a mesh's bounding box) hidden from the camera prepared?
  hidden(box: THREE.Box3) {
    if (!this.built || this.none) return false;
    // a margin: roof slopes rise up to a metre over their voxels' box (voxelMaterial.ts SUB_Y)
    const x0 = box.min.x - 1, x1 = box.max.x + 1, z0 = box.min.z - 1, z1 = box.max.z + 1, y1 = box.max.y + 2;
    const { ex, ey, ez } = this;
    const dx = Math.max(x0 - ex, 0, ex - x1), dz = Math.max(z0 - ez, 0, ez - z1), rmin = Math.hypot(dx, dz);
    if (rmin <= this.rs[0] || this.K === 0) return false;
    const rmax = Math.hypot(Math.max(ex - x0, x1 - ex), Math.max(ez - z0, z1 - ez));
    // (what rises above the view is out of it anyway)
    const tb = Math.min(this.top, y1 > ey ? (y1 - ey) / rmin : (y1 - ey) / rmax);
    // the last step wholly nearer than the box
    let lo = 0, hi = this.K - 1;
    if (this.rs[0] >= rmin) return false;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.rs[m] < rmin) lo = m; else hi = m - 1; }
    const k = lo;
    // the footprint's azimuths, relative to its middle (it is outside the footprint: less than half a turn)
    const mid = Math.atan2((z0 + z1) / 2 - ez, (x0 + x1) / 2 - ex);
    let dmin = 0, dmax = 0;
    for (let c = 0; c < 4; c++) {
      const d = wrap(Math.atan2((c & 2 ? z1 : z0) - ez, (c & 1 ? x1 : x0) - ex) - mid);
      dmin = Math.min(dmin, d); dmax = Math.max(dmax, d);
    }
    const rel = wrap(mid - this.aRef) - this.aMin, nb = this.nb, delta = this.delta;
    let b0 = Math.floor((rel + dmin) / delta) - 1, b1 = Math.floor((rel + dmax) / delta) + 1;
    if (!this.full) {
      if (b1 < 0 || b0 >= nb) return false; // out of the bins: leave it to the frustum
      b0 = Math.max(0, b0); b1 = Math.min(nb - 1, b1);
    } else if (b1 - b0 >= nb) return false;
    for (let b = b0; b <= b1; b++) {
      const bb = ((b % nb) + nb) % nb, ke = this.kEnd[bb];
      if (!(this.hor[bb * MAX_STEPS + Math.min(k, ke)] > tb)) return false;
    }
    return true;
  }
}

const wrap = (a: number) => (a > Math.PI ? a - 2 * Math.PI : a <= -Math.PI ? a + 2 * Math.PI : a);
