import type { Meta } from './core/meta';

// OSM maps few of Passau's street lamps (123, most on the bridges), so the lanes and alleys stood dark. Every street and
// footway in the built-up town is lit: a pool every ~26 m along it, unless a lamp (mapped or placed) is already within
// 16 m -- a road mapped both ways, or a pavement beside it, gets one row. Only the light is drawn; there is no lamp post.
// Out of town they stay dark: a footpath through the woods or the grass (the Oberhaus slope, the parks), with next to no
// building beside it and not along a river (the promenades, the Dreiflüsseeck's, stay lit), and a road through the
// woods or the fields.
// Placed once, when the data is built (web/tools/lamps.mjs: data/streetlamps.json), from maps of the whole: the viewer
// draws their light (lamplight.ts, into the pages of the nodes shown) and heads (lamps.ts) from the list.
// buildings: per 1 m column non-zero on a building (zones.py), trees: per 2 m cell the foliage class (phenology.py),
// terrain: data/terrain.bin (terrain.py: its ground colours every 2 m)
export type Ground = { buildings: ArrayLike<number>; trees: ArrayLike<number>; terrain: ArrayBuffer };
type Way = { p: [number, number, number][]; dark?: number };

function townMask(meta: Meta, g: Ground) {
  // per 2 m cell: building, and wild ground: under trees, or grass or bare soil in the terrain's ground colours (city.ts)
  // -- not paving, not water
  const tw = Math.ceil(meta.W / 4), th = Math.ceil(meta.D / 4), cw = meta.W >> 1, ch = meta.D >> 1;
  const rgb = new Uint8Array(g.terrain, tw * th * 2, cw * ch * 3), bld = new Uint8Array(cw * ch), wild = new Uint8Array(cw * ch), water = new Uint8Array(cw * ch);
  for (let y = 0; y < meta.D; y++) for (let x = 0; x < meta.W; x++) if (g.buildings[y * meta.W + x]) bld[(y >> 1) * cw + (x >> 1)] = 1;
  for (let i = 0; i < cw * ch; i++) {
    const r = rgb[3 * i], gr = rgb[3 * i + 1], b = rgb[3 * i + 2];
    const grass = gr > r + 20 && gr > b + 40, soil = Math.abs(r - 168) + Math.abs(gr - 152) + Math.abs(b - 124) < 12;
    water[i] = gr > r + 6 && gr < b + 30 ? 1 : 0; // the rivers' greens (grass is far greener than blue)
    wild[i] = !water[i] && (g.trees[i] || grass || soil) ? 1 : 0;
  }
  const sum = (a: Uint8Array, cx: number, cy: number, R: number) => {
    let s = 0, n = 0;
    for (let y = Math.max(0, cy - R); y < Math.min(ch, cy + R); y++) for (let x = Math.max(0, cx - R); x < Math.min(cw, cx + R); x++) { s += a[y * cw + x]; n++; }
    return [s, n];
  };
  return (x: number, y: number) => {
    const cx = Math.floor(x / 2), cy = Math.floor(y / 2), [b] = sum(bld, cx, cy, 5), [w, n] = sum(wild, cx, cy, 6), [r] = sum(water, cx, cy, 7);
    // m² of building within ~10 m, the share of wild ground within ~12 m, m² of river within ~14 m
    return { built: b * 4, wild: n ? w / n : 0, water: r * 4 };
  };
}

// the lamps placed: x, y, ground
export function placeStreetLamps(meta: Meta, roads: Way[], peds: Way[], ground: Ground) {
  const placed: [number, number, number][] = [];
  const G = 16, cells = new Map<number, [number, number][]>(), key = (x: number, y: number) => Math.floor(y / G) * 4096 + Math.floor(x / G);
  const near = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      for (const [px, py] of cells.get(key(x + dx * G, y + dy * G)) ?? []) if (Math.hypot(px - x, py - y) < G) return true;
    return false;
  };
  const add = (x: number, y: number) => {
    const c = key(x, y);
    (cells.get(c) ?? cells.set(c, []).get(c)!).push([x, y]);
  };
  for (const [x, y] of meta.lamps) add(x + 0.5, y + 0.5);
  const town = townMask(meta, ground);
  const lit = (x: number, y: number, ped: boolean) => {
    const { built, wild, water } = town(x, y);
    return built >= 20 || water >= 40 || wild < (ped ? 0.5 : 0.75);
  };
  for (const { p, ped } of [...roads.filter((w) => !w.dark).map((w) => ({ p: w.p, ped: false })), ...peds.map((w) => ({ p: w.p, ped: true }))]) {
    let next = 6;
    for (let i = 0, d = 0; i + 1 < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1], l = Math.hypot(bx - ax, by - ay);
      while (next <= d + l) {
        const t = (next - d) / l, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = p[i][2] + (p[i + 1][2] - p[i][2]) * t;
        next += 26;
        if (x < 0 || y < 0 || x >= meta.W || y >= meta.D || near(x, y) || !lit(x, y, ped)) continue;
        add(x, y); placed.push([x, y, z]);
      }
      d += l;
    }
  }
  return placed;
}
