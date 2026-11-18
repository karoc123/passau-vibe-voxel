import * as THREE from 'three';
import type { ColumnData } from './types';

// Occlusion culling of the city's tile meshes against the city itself, on the CPU, each frame, for the main camera
// only (the sun's shadow map draws every caster, as before).
//
// The city is a heightfield, nearly: each column is solid from the bottom up to some height (its occluder height:
// the runs from z = 0 up, unbroken, of opaque voxels -- not leaves, water or fountain jets -- less a metre for roof
// slopes, eroded by a column all round for chamfered corners). Those heights, the minimum over 2 m cells and then over
// 4, 8 .. 128 m cells (a min-pyramid), stand for what blocks the view; where a tile is not in, or not all shown yet,
// its cells are 0 and block nothing.
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
const MAX_BINS = 160, MIN_BIN = 0.006, MAX_STEPS = 256, R0 = 1.5;

export class Occlusion {
  private readonly lv: Uint8Array[] = [];
  private readonly lw: number[] = [];
  private readonly lh: number[] = [];
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
  constructor(private readonly W: number, private readonly D: number, private readonly opaque: Uint8Array, private readonly maxY: number, private readonly T = 128) {
    let w = Math.ceil(W / 2), h = Math.ceil(D / 2);
    for (let l = 0; l < LEVELS; l++) { this.lv.push(new Uint8Array(w * h)); this.lw.push(w); this.lh.push(h); w = Math.ceil(w / 2); h = Math.ceil(h / 2); }
    this.colH = new Uint8Array((T + 2) * (T + 2));
  }

  // the occluder heights of a T x T m tile from the column data drawn there (each source: 1 m or a coarser level
  // covering it; the least of them where several), or none: it blocks nothing
  setTile(tx: number, ty: number, sources: ColumnData[]) {
    const T = this.T, x0 = tx * T, y0 = ty * T, S = T + 2, colH = this.colH;
    // the tile's columns and one all round (from the sources' aprons)
    if (!sources.length) colH.fill(0);
    else for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
      const X = x0 + c - 1, Y = y0 + r - 1;
      let h = 255;
      for (const d of sources) {
        const cx = Math.floor((X - d.x0) / d.s) + 1, cy = Math.floor((Y - d.y0) / d.s) + 1;
        if (cx < 0 || cy < 0 || cx >= d.S || cy >= d.S) { h = 0; break; }
        h = Math.min(h, this.column(d, cx + d.S * cy));
      }
      colH[r * S + c] = h === 255 ? 0 : h;
    }
    // 2 m cells: the least of their 2 x 2 columns and the ring around them (eroded by a column)
    const L0 = this.lv[0], w0 = this.lw[0], h0 = this.lh[0], n = T / 2, c0 = x0 / 2, r0 = y0 / 2;
    for (let j = 0; j < n && r0 + j < h0; j++) for (let i = 0; i < n && c0 + i < w0; i++) {
      let m = 255;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) m = Math.min(m, colH[(2 * j + dy) * S + 2 * i + dx]);
      L0[(r0 + j) * w0 + c0 + i] = m;
    }
    for (let l = 1; l < LEVELS; l++) {
      const a = this.lv[l - 1], aw = this.lw[l - 1], ah = this.lh[l - 1], b = this.lv[l], bw = this.lw[l], bh = this.lh[l];
      const span = Math.max(1, (T / 2) >> l), bc = Math.floor(c0 / (1 << l)), br = Math.floor(r0 / (1 << l));
      for (let j = br; j < Math.min(bh, br + span); j++) for (let i = bc; i < Math.min(bw, bc + span); i++) {
        let m = 255;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const y = 2 * j + dy, x = 2 * i + dx;
          m = Math.min(m, y < ah && x < aw ? a[y * aw + x] : 0);
        }
        b[j * bw + i] = m;
      }
    }
  }

  // a column's occluder height in metres: opaque runs from the bottom up, unbroken, less one cell
  private column(d: ColumnData, i: number) {
    const R = d.runs;
    let h = 0;
    for (let k = d.off[i], e = d.off[i + 1]; k < e; k++) {
      const z0 = R[k * 3];
      if (z0 > h || !this.opaque[R[k * 3 + 2]]) break;
      h = Math.max(h, z0 + R[k * 3 + 1]);
    }
    return Math.min(254, Math.max(0, (h - 1) * d.s));
  }

  // the horizons for this camera, built again only when it moved (or force); true when built
  prepare(camera: THREE.PerspectiveCamera, force = false) {
    const k = this.key, a = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
    let same = this.built && !force;
    for (let i = 0; i < 16; i++) { if (k[i] !== a[i] || k[16 + i] !== p[i]) same = false; k[i] = a[i]; k[16 + i] = p[i]; }
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
    // the steps, the same for every bin: a metre apart, then 4 % of the distance
    const far = Math.min(camera.far, Math.hypot(Math.max(ex, this.W - ex), Math.max(ez, this.D - ez)));
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
    const cosHalf = Math.cos(delta / 2), cap = this.maxY - ey, hor = this.hor, lvs = this.lv, lws = this.lw, lhs = this.lh;
    // standing inside the occluders (in a wall, under ground): nothing is hidden -- by the eye's own 2 m cell, not by all
    // of the cells within a metre of it (an eye inside a building sees out through its walls' back faces, and the march
    // had the building hide the street beyond them); above all of the city: hardly anything (a building would hide only
    // what is lower still, behind it), not worth the march
    this.none = ey > this.maxY || this.cellMin(0, ex, ez, ex, ez) > ey - 0.5;
    if (this.none) return;
    for (let b = 0; b < nb; b++) {
      const a = this.aRef + lo + b * delta, c0 = Math.cos(a), s0 = Math.sin(a), c1 = Math.cos(a + delta), s1 = Math.sin(a + delta);
      let T = -Infinity, k = 0;
      const base = b * MAX_STEPS;
      for (; k < K; k++) {
        const r = this.rs[k], l = this.stepL[k];
        if (l !== 255) {
          const inv = 1 / (2 << l), L = lvs[l], w = lws[l], hgt = lhs[l];
          const ax = ex + r * c0, az = ez + r * s0, bx = ex + r * c1, bz = ez + r * s1;
          const xl = ax < bx ? ax : bx, xh = ax < bx ? bx : ax, zl = az < bz ? az : bz, zh = az < bz ? bz : az;
          const i0 = (xl * inv) | 0, i1 = (xh * inv) | 0, j0 = (zl * inv) | 0, j1 = (zh * inv) | 0;
          if (xl >= 0 && zl >= 0 && i1 < w && j1 < hgt) {
            let h = L[j0 * w + i0];
            if (i1 !== i0 && L[j0 * w + i1] < h) h = L[j0 * w + i1];
            if (j1 !== j0) { if (L[j1 * w + i0] < h) h = L[j1 * w + i0]; if (i1 !== i0 && L[j1 * w + i1] < h) h = L[j1 * w + i1]; }
            if (h > 0) {
              const t = h >= ey ? (h - ey) / r : (h - ey) / (r * cosHalf);
              if (t > T) T = t;
            }
          }
        }
        hor[base + k] = T;
        // above all that could stand further out, or above the view
        if (T > top || T > (cap > 0 ? cap / r : 0)) break;
      }
      this.kEnd[b] = Math.min(k, K - 1);
    }
  }

  private cellMin(l: number, x0: number, z0: number, x1: number, z1: number) {
    const cs = 2 << l, w = this.lw[l], h = this.lh[l], L = this.lv[l];
    let m = 255;
    for (let j = Math.floor(z0 / cs); j <= Math.floor(z1 / cs); j++) for (let i = Math.floor(x0 / cs); i <= Math.floor(x1 / cs); i++)
      m = Math.min(m, i >= 0 && j >= 0 && i < w && j < h ? L[j * w + i] : 0);
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
