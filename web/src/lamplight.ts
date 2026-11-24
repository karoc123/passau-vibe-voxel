import type { Meta } from './core/meta';
import { hash } from './util';
import { TILE_N as T } from './core/tile-data';

// The light on the ground at night, per node shown (fields.ts uPageL, a page beside its other fields), drawn here from
// the lists of lamps, never as a map of the whole:
//   rgb  pools of street light (cells of 2s m for a node of s m cells: of 2 m at 1 m, as the old whole-map texture; coarser,
//        the mean of the 2 m ones in each): bright under the lamp and falling off fast, with a faint skirt, the lamps of three kinds, as
//        in a German town: warm-white lanterns (most, the old town's), the last orange sodium lamps, and cold white
//        LEDs (lampColour, by where the lamp stands); and an even wash over floodlit pitches
//   a    the floodlit landmark (voxelMaterial.ts floodAt) reaching the cell's 8 m cell, 1 + its index (0: none): the
//        nearest relative to its radius, so the shader weighs that one alone
// Lamps: mapped ones (meta.json lamps), floodlit pitches (floods) and those placed along the streets (streetlamps.ts,
// data/streetlamps.json, added when they arrive: every page shown is drawn again).
export const LAMP_COLOURS: [number, number, number][] = [[255, 196, 132], [255, 156, 70], [212, 226, 255]];
// (by its place in the project grid: map cells + origin, meta.origin, so a lamp keeps its colour whatever the map's extent)
export const lampColour = (x: number, y: number, origin: readonly [number, number] = [0, 0]) => {
  const h = hash(Math.floor(x + origin[0]) * 0.1271 + Math.floor(y + origin[1]) * 0.3117);
  return LAMP_COLOURS[h < 0.6 ? 0 : h < 0.82 ? 1 : 2];
};
// a pool's alpha by its distance over its radius: a lamp's, a pitch's floodlight
const LAMP_STOPS: [number, number][] = [[0, 0.8], [0.12, 0.66], [0.3, 0.34], [0.52, 0.11], [0.8, 0.025], [1, 0]];
const FLOOD_STOPS: [number, number][] = [[0, 0.6], [0.7, 0.52], [1, 0]];
const FLOOD_RGB: [number, number, number] = [225, 235, 255];
const LIT_CELL = 8;
// a page's side: a node's cells (of 2s m: as fields.ts uPageS) and one all round
export const LAMP_PAGE = T / 2 + 2;

// Passau floodlights its cathedral, both fortresses, the town hall's tower and the churches above the rivers. Each is
// a capsule in plan (from the label, a and b in metres off it, radius r) whose walls catch a warm wash at night,
// strongest on the faces turned out from it, where the lights stand. w: how white the light falls on it (the lamps'
// warm tint multiplied into red brick burned the Rathaus tower orange; it is lit nearer white, its brick toned down).
// still: not mirrored in the river (St. Michael stands back from the Inn, behind the Innkai's lamps: its capsule, mirrored,
// lay on the water as a soft round patch).
export const FLOODLIT: Record<string, { a?: [number, number]; b?: [number, number]; r: number; k?: number; w?: number; still?: boolean }> = {
  'Dom St. Stephan': { a: [4, 22], b: [91, 22], r: 30, k: 1.2 },
  'Veste Oberhaus': { a: [-45, -2], b: [60, 53], r: 48, k: 0.9 },
  'Veste Niederhaus': { r: 30 },
  'Altes Rathaus': { r: 24, k: 0.6, w: 0.75 },
  'Wallfahrtskirche Mariahilf': { r: 30 },
  'St. Michael': { r: 28, k: 0.8, still: true },
  'St. Paul': { r: 28, k: 0.8 },
  Schaiblingsturm: { r: 10 },
};
export const LIT_N = 8;
export interface Capsule { ax: number; ay: number; bx: number; by: number; r: number; k: number; w: number; still: boolean }
export function floodCapsules(meta: Meta) {
  const out: Capsule[] = [];
  for (const l of meta.labels) {
    const f = FLOODLIT[l.name];
    if (!f || out.length >= LIT_N) continue;
    const a = f.a ?? [0, 0], b = f.b ?? a;
    out.push({ ax: l.x + 0.5 + a[0], ay: l.y + 0.5 + a[1], bx: l.x + 0.5 + b[0], by: l.y + 0.5 + b[1], r: f.r, k: f.k ?? 1, w: f.w ?? 0, still: !!f.still });
  }
  return out;
}

interface Pool { x: number; y: number; R: number; c: [number, number, number]; stops: [number, number][] }

export class LampLight {
  // the pools by the 128 m tile of their middle
  private readonly pools = new Map<number, Pool[]>();
  private readonly caps: Capsule[];
  private reach = 0;
  // raised when lamps are added (the pages shown are drawn again)
  version = 0;
  // 2 m samples (rgb, float) of the page being drawn
  private acc = new Float32Array(0);

  constructor(private readonly meta: Meta) {
    for (const [x, y] of meta.lamps) this.add(x + 0.5, y + 0.5, 18, lampColour(x, y, meta.origin), LAMP_STOPS);
    for (const [x, y, r] of meta.floods ?? []) this.add(x, y, r * 1.35, FLOOD_RGB, FLOOD_STOPS);
    this.caps = floodCapsules(meta);
  }

  private add(x: number, y: number, R: number, c: [number, number, number], stops: [number, number][]) {
    const k = Math.floor(y / T) * 65536 + Math.floor(x / T);
    (this.pools.get(k) ?? this.pools.set(k, []).get(k)!).push({ x, y, R, c, stops });
    this.reach = Math.max(this.reach, R);
  }

  // the streets' lamps (streetlamps.ts, placed when the data is built)
  addStreets(placed: [number, number, number][]) {
    for (const [x, y] of placed) this.add(x, y, 16, lampColour(x, y, this.meta.origin), LAMP_STOPS);
    this.version++;
  }

  // node (s, tx, ty)'s page: LAMP_PAGE^2 cells, RGBA, row by row (out, from o, a row every stride bytes)
  paint(s: number, tx: number, ty: number, out: Uint8Array, o: number, stride: number) {
    const r = 2 * s, n = (T * s) / r, side = n + 2, sub = r / 2, ns = side * sub;
    // the page's first cell's corner (metres), and its 2 m samples
    const X0 = tx * T * s - r, Y0 = ty * T * s - r;
    if (this.acc.length < ns * ns * 3) this.acc = new Float32Array(ns * ns * 3);
    const acc = this.acc;
    acc.fill(0, 0, ns * ns * 3);
    const t0x = Math.floor((X0 - this.reach) / T), t1x = Math.floor((X0 + side * r + this.reach) / T);
    const t0y = Math.floor((Y0 - this.reach) / T), t1y = Math.floor((Y0 + side * r + this.reach) / T);
    for (let ty2 = t0y; ty2 <= t1y; ty2++) for (let tx2 = t0x; tx2 <= t1x; tx2++) for (const p of this.pools.get(ty2 * 65536 + tx2) ?? []) {
      // (the samples whose middle is within its radius: 2 m apart, the middles at odd metres, as the old lamp texture's texels)
      const i0 = Math.max(0, Math.ceil((p.x - p.R - X0 - 1) / 2)), i1 = Math.min(ns - 1, Math.floor((p.x + p.R - X0 - 1) / 2));
      const j0 = Math.max(0, Math.ceil((p.y - p.R - Y0 - 1) / 2)), j1 = Math.min(ns - 1, Math.floor((p.y + p.R - Y0 - 1) / 2));
      const st = p.stops, [cr, cg, cb] = p.c;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const t = Math.hypot(X0 + 2 * i + 1 - p.x, Y0 + 2 * j + 1 - p.y) / p.R;
        if (t >= 1) continue;
        let k = 1;
        while (st[k][0] < t) k++;
        const a = st[k - 1][1] + (st[k][1] - st[k - 1][1]) * (t - st[k - 1][0]) / (st[k][0] - st[k - 1][0]), q = (j * ns + i) * 3;
        acc[q] += cr * a; acc[q + 1] += cg * a; acc[q + 2] += cb * a;
      }
    }
    // the cells: the mean of their samples (each clamped to a byte, as the old whole-map lamp texture's texels were)
    const caps = this.caps, w8 = Math.ceil(this.meta.W / LIT_CELL), h8 = Math.ceil(this.meta.D / LIT_CELL);
    const near = caps.map((c) => {
      const e = c.r + LIT_CELL * 0.75;
      return Math.min(c.ax, c.bx) - e < X0 + side * r && Math.max(c.ax, c.bx) + e > X0 && Math.min(c.ay, c.by) - e < Y0 + side * r && Math.max(c.ay, c.by) + e > Y0;
    });
    const anyCap = near.some(Boolean);
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
      let sr = 0, sg = 0, sb = 0;
      for (let v = 0; v < sub; v++) for (let u = 0; u < sub; u++) {
        const q = ((j * sub + v) * ns + i * sub + u) * 3;
        sr += Math.min(255, Math.round(acc[q])); sg += Math.min(255, Math.round(acc[q + 1])); sb += Math.min(255, Math.round(acc[q + 2]));
      }
      const d = o + j * stride + i * 4, nn = sub * sub;
      out[d] = Math.round(sr / nn); out[d + 1] = Math.round(sg / nn); out[d + 2] = Math.round(sb / nn);
      out[d + 3] = anyCap ? this.capsuleAt(Math.floor((X0 + (i + 0.5) * r) / LIT_CELL), Math.floor((Y0 + (j + 0.5) * r) / LIT_CELL), near, w8, h8) : 0;
    }
  }

  // which capsule reaches the 8 m cell (x, y), the nearest relative to its radius (1 + its index, 0: none)
  private capsuleAt(x: number, y: number, near: boolean[], w8: number, h8: number) {
    if (x < 0 || y < 0 || x >= w8 || y >= h8) return 0;
    let best = Infinity, m = 0;
    this.caps.forEach((c, k) => {
      if (!near[k]) return;
      const reach = c.r + LIT_CELL * 0.75, bax = c.bx - c.ax, bay = c.by - c.ay, bb = Math.max(bax * bax + bay * bay, 1e-3);
      const px = (x + 0.5) * LIT_CELL - c.ax, py = (y + 0.5) * LIT_CELL - c.ay, t = Math.min(1, Math.max(0, (px * bax + py * bay) / bb));
      const d = Math.hypot(px - bax * t, py - bay * t);
      if (d < reach && d / c.r < best) { best = Math.fround(d / c.r); m = k + 1; }
    });
    return m;
  }
}
