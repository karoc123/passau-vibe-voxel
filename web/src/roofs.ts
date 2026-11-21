// Pitched roofs as slopes (all levels). A pitched roof in voxels is a staircase: a light top and a dark riser per
// cell, a ragged ridge, its gable a stepped pyramid. Where the node ships a column's roof cap (its `roof` section:
// scripts/caps.py roof_section, from the roof planes voxelize.py rounded the roof from -- LoD2's, or a fitted roof's --
// met at ridges, hips and valleys on the map's grid, so two nodes hold the same corners for the columns they share)
// its top is drawn as that cap's quad instead, one sloped surface:
//
// - lit by its plane (the column's plane code, plns: the normal, as the voxel roofs are); where planes meet at a
//   corner its own plane does not pass through, by the planes that do, so the light turns over a ridge where it runs,
//   not along its cells' staircase
// - the column's top face and its side faces from where the surface comes down to are not drawn (hidden); the surface
//   is, merged over a rectangle of cells of one plane whose corners lie in one plane (as near as 1/64 m: one quad, or
//   a ladder of quads through the corners of what lies beside its sides: emitTops, no T-junctions), and on each edge a
//   vertical face closes it from below wherever it is higher than what is beside it: an eave's edge, a gable's
//   triangle (in the wall's material), the step to a lower roof; against a taller wall or roof, that wall comes down
//   to it
//
// - an edge of the roof at an angle to the grid (a diagonal eave, or a gable over a diagonal wall) is a staircase of
//   cells in plan, and each cell's side under its slope rises from the step's outer corner to its inner one: a row of
//   teeth along the eave, its shadow on the street a sawtooth. Each inner corner of such a staircase (as chamfer.ts
//   finds them in the walls: legs of 1 and up to MAX_LEG cells, next to another step) is filled: the roof's surface
//   goes on over the triangle from the step's inner corner to its two outer ones, a slanted fascia closes it from the
//   outer corners down to where the cells' sides began, and a floor under it -- the eave runs straight from outer
//   corner to outer corner, the line the chamfered wall under it takes. The cells' sides inside it are not drawn, and
//   a chamfer's prism under it (mesher.worker.ts) stops where the fascia begins.
//
// On a node's edge the face over it is drawn down from the slope even where the next node's roof goes on (it may not
// be shown yet: a level's nodes swap whole), its top 1/64 m under the slope's edge there (as a voxel face out through
// the border, mesher.worker.ts INNER).
// Heights below a metre ride in vattr.y's top 6 bits (the AO takes the low 2; voxelMaterial.ts adds them back).
import { MAX_LEG, PAL_ROOF } from './chamfer';
import type { Box } from './sections';

export interface SlopeSink {
  reserve(n: number): void;
  // q: height in 1/64 m
  vertexQ(x: number, q: number, z: number, normal: number, ao: number, ground: number, roof: number, palette: number, building: number): void;
}

// Meshing a part of a node (sections.ts): the sink of column (X, Y) (apron coordinates), null for one not meshed; last(V):
// the last column of V's section along either axis (a merged top stops there)
export interface SlopeParts { at(X: number, Y: number): SlopeSink | null; last(V: number): number }

const Q = 64;
// how far (1/64 m) a corner of a merged top may be off the plane it is drawn in: the caps' corners are their planes
// rounded to 1/64 m each, a plane's cells' corners in one plane to about that
const MERGE_TOL = 1;
// A wall's face carries where the wall ends above it, in vattr.w (voxelMaterial.ts: no window past it): WALL_TOP + its
// height over the ground in metres, up to 61; 127 for 62 and more (no limit). (0 on a wall: not known; 1-64 a roof's
// plane, SLANT and up a chamfer's)
export const WALL_TOP = 65;
export const wallTopCode = (m: number) => (m >= 62 ? 127 : WALL_TOP + Math.max(0, m));
// corner k of a cell: (0, 0), (1, 0), (1, 1), (0, 1)
const CX = [0, 1, 1, 0], CY = [0, 0, 1, 1];
// the 4 edges: [axis, dir, corner a, corner b] (a before b along the edge)
const EDGES = [[0, -1, 0, 3], [0, 1, 1, 2], [1, -1, 0, 1], [1, 1, 3, 2]] as const;

// the sides an inner corner's cells can be on
const SIDES = [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const;
// a filled step of a roof's edge (the header): its inner corner, an empty cell (X, Y) with the roof on its (sx, sy)
// side, at grid point (px, py); its legs, along x and along y; where its fascia starts (1/64 m)
interface Fill { X: number; Y: number; sx: number; sy: number; a: number; b: number; px: number; py: number; floor: number }

interface Region {
  code: number; bid: number; flat: boolean;
  gxq: number; gyq: number; // its code's plane: rise per metre east, south, in 1/64 m
  lit: number; nx: number; ny: number; nz: number; // the normal it is lit by (its code's), as a code and a vector
}

// vol, colTop as in mesher.worker.ts (S x S columns with the apron; vol index (z + 1)); planes: the plane codes (plns);
// rf: the node's roof caps (roofField); hidden: per voxel, its faces not to draw (bit: normal index); returns null when
// there are no slopes. box: only its columns (apron coordinates; meshing a part of a node, sections.ts)
export function slopeRoofs(N: number, vol: Uint16Array, colTop: Uint16Array, roofPal: Uint8Array, bidAt: (x: number, y: number) => number,
  planes: Uint16Array | null, rf: RoofField, hidden: Uint8Array, box: Box | null = null) {
  const S = N + 2, SS = S * S;
  const T = colTop; // the top face's height (the top voxel is at z = T - 1)
  const bx0 = box ? box.x0 : 0, bx1 = box ? box.x1 : S, by0 = box ? box.y0 : 0, by1 = box ? box.y1 : S;
  const B = slopeBase(N, colTop, (c) => vol[c + SS * colTop[c]], roofPal, bidAt, planes, rf, box);
  if (!B) return null;
  const { bid, reg, regions, hq, nq, ctr, cornerIdx } = B;
  let wallTops = false;
  const { fills, covered, fillFloor, cand } = eaveSteps();
  return {
    hidden,
    // a filled step's fascia starts at this height (1/64 m) over the inner corner at grid point (X, Y) (tile
    // coordinates) on the side (sx, sy) of it, as a chamfer's prism (chamfer.ts) has them; undefined: none
    fillFloor,
    // the steps of the eaves that could be filled, as found (each depends on the others next to it, and on what lies
    // under its triangle: mesher.worker.ts meshSections)
    steps: cand,
    // the surface's height at grid point (X, Y) (tile coordinates) over the slope cells around it (their lowest), in m
    heightAt(X: number, Y: number) {
      let h = Infinity;
      for (let k = 0; k < 4; k++) {
        const cx = X + (k & 1) - 1, cy = Y + (k >> 1) - 1;
        if (cx < -1 || cy < -1 || cx > N || cy > N) continue;
        const c = (cx + 1) + S * (cy + 1);
        if (reg[c] < 0) continue;
        const kk = [2, 3, 1, 0][k]; // the grid point is this corner of the cell
        h = Math.min(h, hq[c * 4 + kk] / Q);
      }
      return h;
    },
    hide() {
      for (let Y = Math.max(1, by0); Y <= Math.min(N, by1 - 1); Y++) for (let X = Math.max(1, bx0); X <= Math.min(N, bx1 - 1); X++) {
        const c = X + S * Y;
        if (reg[c] < 0) continue;
        hidden[c + SS * T[c]] |= 1 << 5;
        for (const e of EDGES) {
          const lo = edgeFloor(c, e);
          const bit = 1 << (e[0] * 2 + (e[1] > 0 ? 1 : 0));
          for (let z = lo; z < T[c]; z++) hidden[c + SS * (z + 1)] |= bit;
        }
      }
    },
    // tops: mark the walls' faces with where the wall ends (wallTopCode; 1 m tiles); parts: a part of the node only;
    // last(V): where a merged top stops along either axis (the end of V's section at level 1: sections.ts -- meshed
    // whole or in sections the node's tops are the same; null: the node's edge)
    emit(out: SlopeSink, x0: number, y0: number, ground: Uint8Array, tops = false, parts: SlopeParts | null = null, last: ((V: number) => number) | null = null) {
      wallTops = tops;
      emitTops(out, x0, y0, ground, parts, parts ? parts.last : last);
      for (let Y = 1; Y <= N; Y++) for (let X = 1; X <= N; X++) {
        const c = X + S * Y;
        if (reg[c] < 0) continue;
        const o = parts ? parts.at(X, Y) : out;
        if (o) for (const e of EDGES) emitEdge(o, c, e, x0, y0, ground);
      }
      for (const f of fills) {
        const o = parts ? parts.at(f.X, f.Y) : out;
        if (o) emitFill(o, f, x0, y0, ground);
      }
    },
  };

  // The staircases of the roofs' edges in plan (the header): for each inner corner -- an empty cell (X, Y) of no
  // region with cells of one building's slopes on its side (sx, sy) -- its legs, as chamfer.ts measures them in a
  // layer of walls; the ones next to another (sharing an outer corner) are filled where what lies under the triangle
  // stays below the fascia
  function eaveSteps() {
    const fills: Fill[] = [], covered = new Uint8Array(SS), floors = new Map<number, number>();
    const inS = (x: number, y: number) => x >= 0 && y >= 0 && x < S && y < S;
    const sol = (x: number, y: number, b: number) => inS(x, y) && reg[x + S * y] >= 0 && bid[x + S * y] === b;
    // from (X, Y) along (ux, uy), the roof on the (ox, oy) side: the cells up to the outer corner
    const leg = (X: number, Y: number, ux: number, uy: number, ox: number, oy: number, b: number) => {
      for (let k = 0; k <= MAX_LEG; k++) {
        const ex = X + ux * k, ey = Y + uy * k;
        if (!inS(ex, ey) || !inS(ex + ox, ey + oy) || sol(ex, ey, b)) return 0;
        if (!sol(ex + ox, ey + oy, b)) return k;
      }
      return 0;
    };
    const cand: Fill[] = [], ends = new Map<number, Fill[]>();
    const pk = (x: number, y: number) => x * 4096 + y;
    for (let Y = by0; Y < by1; Y++) for (let X = bx0; X < bx1; X++) {
      for (const [sx, sy] of SIDES) {
        if (!inS(X + sx, Y + sy)) continue;
        const C = X + sx + S * (Y + sy);
        if (reg[C] < 0 || sol(X, Y, bid[C]) || !sol(X + sx, Y, bid[C]) || !sol(X, Y + sy, bid[C])) continue;
        const a = leg(X, Y, -sx, 0, 0, sy, bid[C]), b = leg(X, Y, 0, -sy, sx, 0, bid[C]);
        if (!a || !b || Math.min(a, b) !== 1 || Math.max(a, b) > MAX_LEG) continue;
        const px = X + (sx > 0 ? 1 : 0), py = Y + (sy > 0 ? 1 : 0);
        const f: Fill = { X, Y, sx, sy, a, b, px, py, floor: 0 };
        cand.push(f);
        for (const k of [pk(px - a * sx, py), pk(px, py - b * sy)]) (ends.get(k) ?? ends.set(k, []).get(k)!).push(f);
      }
    }
    const along = (f: Fill, k: number) => ends.get(k)!.some((n) => n !== f && n.sx === f.sx && n.sy === f.sy);
    for (const f of cand) {
      const { X, Y, sx, sy, a, b, px, py } = f;
      if (X < 1 || Y < 1 || X > N || Y > N || !(along(f, pk(px - a * sx, py)) || along(f, pk(px, py - b * sy)))) continue;
      // the cells' sides it covers: of leg a facing -sy, of leg b facing -sx; the fascia comes down as far as they do
      let lo = Infinity;
      for (let k = 0; k < a; k++) lo = Math.min(lo, edgeFloor(X - k * sx + S * (Y + sy), EDGES[sy > 0 ? 2 : 3]));
      for (let k = 0; k < b; k++) lo = Math.min(lo, edgeFloor(X + sx + S * (Y - k * sy), EDGES[sx > 0 ? 0 : 1]));
      f.floor = lo * Q;
      // it stands above its floor, and nothing under the triangle comes up through it: a street, or a lower roof
      // (what stands above the floor is inside it, behind the fascia)
      const cs = fillCorners(f);
      if (Math.min(cs[0][0], cs[1][0], cs[2][0]) <= f.floor) continue;
      let ok = true;
      for (let k = 0; k < a && ok; k++) ok = clear(f, cs, X - k * sx, Y);
      for (let k = 1; k < b && ok; k++) ok = clear(f, cs, X, Y - k * sy);
      if (!ok) continue;
      fills.push(f);
      for (let k = 0; k < a; k++) covered[X - k * sx + S * (Y + sy)] |= 1 << (sy > 0 ? 2 : 3);
      for (let k = 0; k < b; k++) covered[X + sx + S * (Y - k * sy)] |= 1 << (sx > 0 ? 0 : 1);
      floors.set(((px - 1) * 4096 + (py - 1)) * 4 + (sx > 0 ? 1 : 0) + (sy > 0 ? 2 : 0), f.floor);
    }
    // whether what is in cell (x, y) (its top; a slope's surface) stays under the fill's triangle where the two
    // overlap: compared at the corners of the triangle clipped to the cell, both being planes there (a slope's cell
    // nearly: taken bilinear)
    function clear(f: Fill, cs: number[][], x: number, y: number) {
      const P = [f.px, f.py, cs[0][0]], L = [f.px - f.a * f.sx, f.py, cs[1][0]], R = [f.px, f.py - f.b * f.sy, cs[2][0]];
      let poly = [P, L, R];
      for (const [ax, lim, keep] of [[0, x, 1], [0, x + 1, -1], [1, y, 1], [1, y + 1, -1]]) {
        const out: number[][] = [];
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i], q = poly[(i + 1) % poly.length], dp = (p[ax] - lim) * keep, dq = (q[ax] - lim) * keep;
          if (dp >= 0) out.push(p);
          if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]); }
        }
        poly = out;
        if (!poly.length) return true;
      }
      const c = x + S * y;
      for (const [gx, gy, h] of poly) {
        const u = gx - x, v = gy - y;
        const top = reg[c] >= 0
          ? (1 - u) * (1 - v) * hq[c * 4] + u * (1 - v) * hq[c * 4 + 1] + u * v * hq[c * 4 + 2] + (1 - u) * v * hq[c * 4 + 3] : T[c] * Q;
        if (top > h - Q / 16) return false;
      }
      return true;
    }
    return {
      fills, covered, cand,
      fillFloor: (X: number, Y: number, sx: number, sy: number) => floors.get((X * 4096 + Y) * 4 + (sx > 0 ? 1 : 0) + (sy > 0 ? 2 : 0)),
    };
  }

  // a fill's inner corner P and outer corners L (end of leg a) and R: [height, lit code, cell] each, from the cells
  // whose sides run along its edges, so the triangle meets them exactly
  function fillCorners(f: Fill) {
    const { X, Y, sx, sy, a, b, px, py } = f;
    const at = (c: number, GX: number, GY: number) => { const k = c * 4 + cornerIdx(c, GX, GY); return [hq[k], nq[k], c]; };
    const pa = at(X + S * (Y + sy), px, py), pb = at(X + sx + S * Y, px, py);
    return [pa[0] <= pb[0] ? pa : pb, at(X - (a - 1) * sx + S * (Y + sy), px - a * sx, py), at(X + sx + S * (Y - (b - 1) * sy), px, py - b * sy)];
  }

  function emitFill(out: SlopeSink, f: Fill, x0: number, y0: number, ground: Uint8Array) {
    const { X, Y, sx, sy, a, b, px, py } = f;
    const [cp, cl, cr] = fillCorners(f);
    const P = [px, py], A = [px - a * sx, py], B = [px, py - b * sy];
    const hOf = new Map([[P, cp], [A, cl], [B, cr]]);
    const c0 = cp[2], r = regions[reg[c0]], top = vol[c0 + SS * T[c0]], gm = ground[c0], bd = bid[c0];
    const v = (q: number[], h: number, nrm: number, w: number, pal: number) => out.vertexQ(q[0] - 1 + x0, h, q[1] - 1 + y0, nrm, 3, gm, w, pal, bd);
    // the slope over the triangle (P, A, B counter-clockwise from above: as emitPrism's lid). Its long leg runs along
    // the cells' sides, a corner of theirs at every grid point on it, a little off the straight line from end to end
    // (each rounded, or bent): through them, as a fan from the short leg's end (as one edge it left slivers open along
    // the leg, a dotted line). The points: the lower of the two cells' corners there, as at P
    const up = -a * b * sx * sy > 0, [l1, l2] = up ? [A, B] : [B, A];
    const long = a >= b, apex = long ? B : A, n = long ? a : b;
    const ux = long ? -sx : 0, uy = long ? 0 : -sy, row = long ? S * (Y + sy) : X + sx;
    const legCell = (k: number) => (long ? X - k * sx + row : row + S * (Y - k * sy));
    const legPt = (k: number) => {
      if (k === 0) return cp;
      if (k === n) return long ? cl : cr;
      const g = [px + ux * k, py + uy * k], c1 = legCell(k - 1), c2 = legCell(k);
      const p1 = [hq[c1 * 4 + cornerIdx(c1, g[0], g[1])], nq[c1 * 4 + cornerIdx(c1, g[0], g[1])]];
      const p2 = [hq[c2 * 4 + cornerIdx(c2, g[0], g[1])], nq[c2 * 4 + cornerIdx(c2, g[0], g[1])]];
      return p1[0] <= p2[0] ? p1 : p2;
    };
    // (the fan's triangles turn as (P, l1, l2): from the apex along the leg if the apex is l2, else back)
    const fwd = apex === l2, sv = (q: number[], hl: number[]) => v(q, hl[0], 5 + 8 * ((hl[1] - 1) >> 6), 1 + ((hl[1] - 1) & 63), top);
    const ha = hOf.get(apex)!;
    if (n === 1) {
      out.reserve(4);
      for (const q of [P, l1, l2, l2]) sv(q, hOf.get(q)!);
    } else for (let k = 0; k < n; k += 2) {
      const m = Math.min(k + 2, n), ks: number[] = [];
      for (let i = k; i <= m; i++) ks.push(i);
      if (!fwd) ks.reverse();
      if (ks.length === 2) ks.push(ks[1]);
      out.reserve(4);
      sv(apex, ha);
      for (const i of ks) sv([px + ux * i, py + uy * i], legPt(i));
    }
    // the fascia from A to B: an eave's in the roof's material, lit as the roof (as emitEdge's); else (the slope runs
    // along it) a gable's, in the wall's material under it, lit as a wall in that direction (a staircase wall's
    // 15° steps, mesher.worker.ts wallAngle) and ending at its foot (wallTopCode: no window up into it)
    const nx = -b * sx, ny = -a * sy, nl = Math.hypot(nx, ny);
    const axis = Math.abs(nx) >= Math.abs(ny) ? (nx > 0 ? 1 : 0) : ny > 0 ? 3 : 2;
    const az = ((r.code - 1) & 63) * (Math.PI / 32), fall = r.flat ? 0 : (Math.cos(az) * nx + Math.sin(az) * ny) / nl;
    const below = T[c0] >= 2 ? vol[c0 + SS * (T[c0] - 1)] : 0;
    const wallBelow = below !== 0 && below < roofPal.length && !(roofPal[below] & PAL_ROOF) && below < 65534;
    let nrm = axis + 8 * ((r.lit - 1) >> 6), w = 1 + ((r.lit - 1) & 63), pal = top;
    if (fall <= 0.4 && wallBelow) {
      pal = below;
      nrm = axis + 8 * (1 + (Math.round(Math.atan2(ny, nx) / (Math.PI / 12)) + 24) % 24);
      w = wallTops ? wallTopCode(Math.floor(f.floor / Q) - gm) : 0;
    }
    const [L, R] = (B[1] - A[1]) * -nx + (B[0] - A[0]) * ny >= 0 ? [A, B] : [B, A];
    out.reserve(4);
    v(L, f.floor, nrm, w, pal); v(R, f.floor, nrm, w, pal); v(R, hOf.get(R)![0], nrm, w, pal); v(L, hOf.get(L)![0], nrm, w, pal);
    // ... and its floor
    out.reserve(4);
    for (const q of [P, l2, l1, l1]) v(q, f.floor, 4, 0, top);
  }

  // the lowest voxel of c whose face along edge e is the slope's to draw
  function edgeFloor(c: number, e: readonly number[]) {
    const n = neighbour(c, e);
    let lo = Math.min(T[c] - 1, Math.floor(Math.min(hq[c * 4 + e[2]], hq[c * 4 + e[3]]) / Q));
    if (reg[n] >= 0) lo = Math.min(lo, Math.floor(Math.min(cornerOf(n, c, e, 0), cornerOf(n, c, e, 1)) / Q));
    return Math.max(lo, 0);
  }
  function neighbour(c: number, e: readonly number[]) { return c + (e[0] === 0 ? e[1] : e[1] * S); }
  // the height of n (beside c over edge e) at the edge's end i (0: e's corner a)
  function cornerOf(n: number, c: number, e: readonly number[], i: number) {
    const k = e[2 + i];
    const gx = (c % S) + CX[k], gy = Math.floor(c / S) + CY[k];
    const kx = gx - (n % S), ky = gy - Math.floor(n / S);
    return hq[n * 4 + (ky ? (kx ? 2 : 3) : kx)];
  }

  function emitTops(sink: SlopeSink, x0: number, y0: number, ground: Uint8Array, parts: SlopeParts | null, last: ((V: number) => number) | null) {
    // each top's rectangle (its first cell, w, h), and which one each cell is in
    const rid = new Int32Array(SS).fill(-1), rects: number[] = [];
    const pal = (c: number) => vol[c + SS * T[c]];
    // (the shared edge's two corners of a and its neighbour b alike: no step between them)
    const edgeEq = (a: number, b: number) => {
      const [ka, kb] = b === a + 1 ? [[1, 2], [0, 3]] : b === a - 1 ? [[0, 3], [1, 2]] : b === a + S ? [[3, 2], [0, 1]] : [[0, 1], [3, 2]];
      return hq[a * 4 + ka[0]] === hq[b * 4 + kb[0]] && hq[a * 4 + ka[1]] === hq[b * 4 + kb[1]];
    };
    // a cell that may be merged: its corners in one plane (to MERGE_TOL) and lit by its plane all round
    const flatish = (c: number) => {
      const r = regions[reg[c]];
      for (let k = 0; k < 4; k++) if (nq[c * 4 + k] !== r.lit) return false;
      return Math.abs(hq[c * 4] + hq[c * 4 + 2] - hq[c * 4 + 1] - hq[c * 4 + 3]) <= MERGE_TOL;
    };
    // the height at grid point (x, y) of the rectangle from cell (X, Y), w x h (its cells meet without steps)
    const at = (X: number, Y: number, w: number, h: number, x: number, y: number) => {
      const c = Math.min(x, X + w - 1) + S * Math.min(y, Y + h - 1);
      return hq[c * 4 + cornerIdx(c, x, y)];
    };
    // every corner of the rectangle within MERGE_TOL of the plane through its corners (X, Y), (X + w, Y), (X, Y + h)
    const planar = (X: number, Y: number, w: number, h: number) => {
      const q00 = at(X, Y, w, h, X, Y), a = (at(X, Y, w, h, X + w, Y) - q00) / w, b = (at(X, Y, w, h, X, Y + h) - q00) / h;
      for (let j = 0; j <= h; j++) for (let i = 0; i <= w; i++) if (Math.abs(at(X, Y, w, h, X + i, Y + j) - q00 - a * i - b * j) > MERGE_TOL) return false;
      return true;
    };
    for (let Y = 1; Y <= N; Y++) for (let X = 1; X <= N; X++) {
      const c = X + S * Y;
      if (reg[c] < 0 || rid[c] >= 0) continue;
      if (!(parts ? parts.at(X, Y) : sink)) continue;
      let w = 1, h = 1;
      if (flatish(c)) {
        const p = pal(c);
        const same = (k: number) => rid[k] < 0 && reg[k] === reg[c] && flatish(k) && pal(k) === p;
        // (merged within the section: last)
        const lx = last ? last(X) : N, ly = last ? last(Y) : N;
        while (X + w <= lx && same(c + w) && edgeEq(c + w - 1, c + w) && planar(X, Y, w + 1, 1)) w++;
        outer: while (Y + h <= ly) {
          for (let i = 0; i < w; i++) {
            const k = c + i + S * h;
            if (!same(k) || !edgeEq(k - S, k) || (i && !edgeEq(k - 1, k))) break outer;
          }
          if (!planar(X, Y, w, h + 1)) break;
          h++;
        }
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) rid[c + i + S * j] = rects.length / 3;
      rects.push(c, w, h);
    }
    // A merged top's side has a corner of what lies beside it at every grid point along it (a cell's top, the step or
    // eave face under each cell, another top's corner), unless the two cells beside the point are of one merged top of
    // the same plane that meets this one there without a step. A corner on the side's middle that the quad has not (a
    // T-junction) leaves a pixel open now and then: a sparse dotted line of what lies below, along the side. So the top
    // goes through every such point: it is drawn as a ladder of quads between two chains of its outline, from its
    // corner (X, Y) round either way to the opposite one
    // (the cells of another section always: they may be meshed again on their own, sections.ts -- in the whole node too,
    // to be the same)
    const apart = (n: number, c: number) => !!last && (last(n % S) !== last(c % S) || last(Math.floor(n / S)) !== last(Math.floor(c / S)));
    // (the point between outside cells n1, n2 beside inside cells i1, i2)
    const open = (n1: number, n2: number, i1: number, i2: number) =>
      !(rid[n1] >= 0 && rid[n1] === rid[n2] && reg[n1] === reg[i1] && edgeEq(i1, n1) && edgeEq(i2, n2)) || apart(n1, i1) || apart(n2, i1);
    const ch1: number[] = [], ch2: number[] = [];
    for (let k = 0; k < rects.length; k += 3) {
      const c = rects[k], w = rects[k + 1], h = rects[k + 2], X = c % S, Y = (c - X) / S;
      const out = parts ? parts.at(X, Y)! : sink;
      const r = regions[reg[c]], p = pal(c);
      if (w > 1 || h > 1) {
        // the chains as [x, y, s] (s: along the outline from (X, Y))
        ch1.length = ch2.length = 0;
        ch1.push(X, Y, 0); ch2.push(X, Y, 0);
        for (let i = 1; i < w; i++) if (open(c + i - 1 - S, c + i - S, c + i - 1, c + i)) ch1.push(X + i, Y, i);
        ch1.push(X + w, Y, w);
        for (let j = 1; j < h; j++) if (open(c + w + S * (j - 1), c + w + S * j, c + w - 1 + S * (j - 1), c + w - 1 + S * j)) ch1.push(X + w, Y + j, w + j);
        for (let j = 1; j < h; j++) if (open(c - 1 + S * (j - 1), c - 1 + S * j, c + S * (j - 1), c + S * j)) ch2.push(X, Y + j, j);
        ch2.push(X, Y + h, h);
        for (let i = 1; i < w; i++) if (open(c + i - 1 + S * h, c + i + S * h, c + i - 1 + S * (h - 1), c + i + S * (h - 1))) ch2.push(X + i, Y + h, h + i);
        ch1.push(X + w, Y + h, w + h); ch2.push(X + w, Y + h, w + h);
        const n = (ch1.length + ch2.length) / 3;
        // (its quads, ceil((n - 4) / 2), at most w + h - 1: never more than its cells)
        if (n > 6) { ladder(out, r, p, ground[c], bid[c], x0, y0, X, Y, w, h); continue; }
      }
      top(out, c, X, Y, w, h, r, p);
    }

    function top(out: SlopeSink, c: number, X: number, Y: number, w: number, h: number, r: Region, pal: number) {
      const q = w === 1 && h === 1 ? [hq[c * 4], hq[c * 4 + 1], hq[c * 4 + 2], hq[c * 4 + 3]]
        : [at(X, Y, w, h, X, Y), at(X, Y, w, h, X + w, Y), at(X, Y, w, h, X + w, Y + h), at(X, Y, w, h, X, Y + h)];
      const px = [X, X + w, X + w, X], py = [Y, Y, Y + h, Y + h];
      // a cell a ridge, hip or valley runs across is split along the diagonal whose middle comes nearest its own plane
      // at its centre (its top is that plane's there): split the other way the ridge sagged a notch into every cell
      // it crossed, a sawtooth along each hip; a plane's own cell splits either way alike
      let d02 = Math.abs(q[0] - q[2]) <= Math.abs(q[1] - q[3]);
      if (w === 1 && h === 1 && !flatish(c)) {
        const a = Math.abs((q[0] + q[2]) / 2 - ctr[c]), b = Math.abs((q[1] + q[3]) / 2 - ctr[c]);
        if (Math.abs(a - b) > 1) d02 = a < b;
      }
      const ord = d02 ? [0, 3, 2, 1] : [1, 0, 3, 2];
      out.reserve(4);
      for (const k of ord) {
        const lit = w === 1 && h === 1 ? nq[c * 4 + k] : r.lit;
        out.vertexQ(px[k] - 1 + x0, q[k], py[k] - 1 + y0, 5 + 8 * ((lit - 1) >> 6), 3, ground[c], 1 + ((lit - 1) & 63), pal, bid[c]);
      }
    }

    // the ladder: chords from chain 1's point i to chain 2's j, first (0, 0) and (1, 1), then on along the outline one
    // point at a time (whichever chain's next comes first), last the far corner; a quad between every other chord (a
    // triangle at the end). No chord but the first and last has an end on the other's side, so none is degenerate
    function ladder(out: SlopeSink, r: Region, pal: number, gm: number, b: number, x0: number, y0: number, X: number, Y: number, rw: number, rh: number) {
      const n1 = ch1.length / 3, n2 = ch2.length / 3, I = [0, 1], J = [0, 1];
      let i = 1, j = 1;
      while (i < n1 - 2 || j < n2 - 2) {
        if (j >= n2 - 2 || (i < n1 - 2 && ch1[i * 3 + 5] <= ch2[j * 3 + 5])) i++; else j++;
        I.push(i); J.push(j);
      }
      I.push(n1 - 1); J.push(n2 - 1);
      const p: number[] = [];
      const lit = 5 + 8 * ((r.lit - 1) >> 6), w = 1 + ((r.lit - 1) & 63);
      for (let s = 0; s + 1 < I.length; s += 2) {
        const e = Math.min(s + 2, I.length - 1);
        p.length = 0;
        const put = (x: number, y: number) => {
          if (p.length && p[p.length - 2] === x && p[p.length - 1] === y) return;
          if (p.length && p[0] === x && p[1] === y) return;
          p.push(x, y);
        };
        for (let a = I[s]; a <= I[e]; a++) put(ch1[a * 3], ch1[a * 3 + 1]);
        for (let a = J[e]; a >= J[s]; a--) put(ch2[a * 3], ch2[a * 3 + 1]);
        const n = p.length / 2;
        // facing up as emitTops' quads (clockwise in x, y), split along a diagonal with no point on the outline beside it
        let area = 0;
        for (let k = 0; k < n; k++) { const l = (k + 1) % n; area += p[k * 2] * p[l * 2 + 1] - p[l * 2] * p[k * 2 + 1]; }
        const ord = n === 3 ? [0, 1, 2] : [0, 1, 2, 3];
        if (area > 0) ord.reverse();
        const tri = (a: number, b2: number, c2: number) =>
          (p[ord[b2] * 2] - p[ord[a] * 2]) * (p[ord[c2] * 2 + 1] - p[ord[a] * 2 + 1]) - (p[ord[b2] * 2 + 1] - p[ord[a] * 2 + 1]) * (p[ord[c2] * 2] - p[ord[a] * 2]);
        const o = n === 3 ? [0, 1, 2, 2] : tri(0, 1, 2) === 0 || tri(0, 2, 3) === 0 ? [1, 2, 3, 0] : [0, 1, 2, 3];
        out.reserve(4);
        for (const k of o) {
          const x = p[ord[k] * 2], y = p[ord[k] * 2 + 1];
          out.vertexQ(x - 1 + x0, at(X, Y, rw, rh, x, y), y - 1 + y0, lit, 3, gm, w, pal, b);
        }
      }
    }
  }

  function emitEdge(out: SlopeSink, c: number, e: readonly number[], x0: number, y0: number, ground: Uint8Array) {
    if (covered[c] & (1 << (e[0] * 2 + (e[1] > 0 ? 1 : 0)))) return; // inside a filled step
    const n = neighbour(c, e), X = c % S, Y = (c - X) / S;
    const a0 = hq[c * 4 + e[2]], a1 = hq[c * 4 + e[3]];
    const lo = edgeFloor(c, e);
    const nX = n % S, nY = (n - nX) / S;
    const border = nX < 1 || nY < 1 || nX > N || nY > N;
    const r = regions[reg[c]];
    const top = vol[c + SS * T[c]], below = T[c] >= 2 ? vol[c + SS * (T[c] - 1)] : 0;
    const wallBelow = below !== 0 && below < roofPal.length && !(roofPal[below] & PAL_ROOF) && below < 65534;
    // the face up to the slope
    let up = false;
    if (reg[n] >= 0) up = border || a0 > cornerOf(n, c, e, 0) || a1 > cornerOf(n, c, e, 1);
    else {
      let m = lo;
      while (m < T[c] + 2 && vol[n + SS * (m + 1)] !== 0) m++;
      up = a0 > m * Q || a1 > m * Q;
      // ... and a taller wall beside it, down to the slope
      const tp = Math.min(m, T[c]);
      if (tp > lo && (a0 < tp * Q || a1 < tp * Q)) {
        const v = vol[n + SS * tp];
        if (v && v < 65534) vertical(out, e[0], -e[1], X, Y, e, Math.min(a0, tp * Q), Math.min(a1, tp * Q), tp * Q, tp * Q, v, 0, ground[n], bid[n], x0, y0);
      }
    }
    if (!up) return;
    // a skirt over the node's edge where the roof goes on in the next node (the same corners there: drawn for when that
    // node is not shown, a level's nodes swap whole) is a sliver of the roof
    const skirt = border && reg[n] >= 0;
    // how much the roof falls towards this edge: an eave (its edge in the roof's material, lit as the roof, as a
    // riser was), else a gable or the side of a step (the wall's)
    const az = ((r.code - 1) & 63) * (Math.PI / 32), ox = e[0] === 0 ? e[1] : 0, oy = e[0] === 1 ? e[1] : 0;
    const fall = r.flat ? 0 : Math.cos(az) * ox + Math.sin(az) * oy;
    // ... but a side of a cell on an eave that runs at an angle to the grid (a staircase of cells, the roof falling past
    // the cell's corner: its downhill neighbour is no part of the roof) is a notch in that eave, not a gable: as a
    // wall's it cut a row of wall-coloured triangles into the roof's edge
    let eave = false;
    if (!r.flat && !skirt && reg[n] < 0 && fall > -0.4 && fall < 0.4) {
      const cx = Math.cos(az), cy = Math.sin(az), dx = Math.abs(cx) > 0.38 ? Math.sign(cx) : 0, dy = Math.abs(cy) > 0.38 ? Math.sign(cy) : 0;
      const ddx = X + dx, ddy = Y + dy, dn = ddx + S * ddy;
      eave = ddx >= 0 && ddy >= 0 && ddx < S && ddy < S && (reg[dn] < 0 || bid[dn] !== r.bid || T[dn] < T[c] - 2);
    }
    // ... and a step of under a metre to another plane of the same roof is a crease in it (a fragment's edge, a curved
    // roof's facets), not a wall: in the wall's colour it was a dark or pale triangle in the roof
    if (!skirt && reg[n] >= 0 && bid[n] === r.bid && Math.max(a0 - cornerOf(n, c, e, 0), a1 - cornerOf(n, c, e, 1)) <= Q) eave = true;
    const pal = fall < 0.4 && wallBelow && !skirt && !eave ? below : top;
    const lit = skirt ? r.lit : eave ? r.lit : pal === top && fall > 0.05 ? r.code : 0;
    // (a skirt's top 1/64 m under the slope's edge where the next node's roof comes up to it: on it, it showed through
    // between the two nodes' slopes as a hairline. Where that roof is lower the skirt is the step down to it, seen, and
    // meets the edge: sunk, it left a slit under the edge, a dashed line of what lies behind)
    const k0 = skirt && cornerOf(n, c, e, 0) >= a0 ? 1 : 0, k1 = skirt && cornerOf(n, c, e, 1) >= a1 ? 1 : 0;
    vertical(out, e[0], e[1], X, Y, e, lo * Q, lo * Q, a0 - k0, a1 - k1, pal, lit, ground[c], bid[c], x0, y0);
  }

  // a vertical face on cell (X, Y)'s edge e, facing (axis d, dir), from low to high at the edge's two ends
  function vertical(out: SlopeSink, d: number, dir: number, X: number, Y: number, e: readonly number[], l0: number, l1: number, h0: number, h1: number,
    pal: number, lit: number, gm: number, b: number, x0: number, y0: number) {
    const ka = e[2], kb = e[3];
    const ax = X + CX[ka] - 1 + x0, ay = Y + CY[ka] - 1 + y0, bx = X + CX[kb] - 1 + x0, by = Y + CY[kb] - 1 + y0;
    const ni = d * 2 + (dir > 0 ? 1 : 0);
    const nrm = lit ? ni + 8 * ((lit - 1) >> 6) : ni, w = lit ? 1 + ((lit - 1) & 63) : 0;
    // a wall's face (a gable's triangle): its top along it, at each end (vattr.w interpolates between them)
    const wa = !lit && wallTops ? wallTopCode(Math.floor(h0 / Q) - gm) : w, wb = !lit && wallTops ? wallTopCode(Math.floor(h1 / Q) - gm) : w;
    const W = d === 0 ? [wa, wb, wb, wa] : [wa, wa, wb, wb];
    // corners in the order mesher.worker.ts's emitMerged gives them for this axis
    const P = d === 0
      ? [[ax, l0, ay], [bx, l1, by], [bx, h1, by], [ax, h0, ay]]
      : [[ax, l0, ay], [ax, h0, ay], [bx, h1, by], [bx, l1, by]];
    out.reserve(4);
    for (const k of dir > 0 ? [0, 3, 2, 1] : [0, 1, 2, 3]) out.vertexQ(P[k][0], P[k][1], P[k][2], nrm, 3, gm, W[k], pal, b);
  }
}

// the roof section's records as they are: [column, ztop, q0, q1, q2, q3] per record (q absolute, 1/64 cell; scripts/caps.py
// encode_roof: as the caps section, but each corner a difference -- corner 0 from the record before's corner 1 where
// that is the column just before, else from ztop * 64; 1 from 0, 2 from 1, 3 from 0)
export function decodeRoofs(roof: Uint16Array): Int32Array {
  const n = Math.floor(roof.length / 6), out = new Int32Array(n * 6), uz = (u: number) => (u >>> 1) ^ -(u & 1);
  let c = 0, z = 0;
  for (let i = 0; i < n; i++) {
    c += roof[i];
    z += uz(roof[n + i]);
    const o = 6 * i, q0 = uz(roof[2 * n + i]) + (i && roof[i] === 1 ? out[o - 3] : z * 64), q1 = q0 + uz(roof[3 * n + i]);
    out[o] = c; out[o + 1] = z; out[o + 2] = q0; out[o + 3] = q1; out[o + 4] = q1 + uz(roof[4 * n + i]); out[o + 5] = q0 + uz(roof[5 * n + i]);
  }
  return out;
}

// A node's roof caps (scripts/caps.py roof_section, its `roof` section; null: none): per column the top of the run
// the cap is on (0: none) and its four corners (1/64 cell, corner order as cornerQ's). A record is kept only where its
// run is still the column's last (an edit that builds on the roof or digs into it leaves that column voxels).
export interface RoofField { z: Uint16Array; q: Int32Array }
export function roofField(N: number, cols: { counts: Uint16Array; runs: Uint16Array; roofCaps?: Uint16Array | null }, off?: Uint32Array): RoofField | null {
  if (!cols.roofCaps) return null;
  const S = N + 2, SS = S * S, { counts, runs } = cols;
  if (!off) { off = new Uint32Array(SS + 1); for (let i = 0; i < SS; i++) off[i + 1] = off[i] + counts[i]; }
  const f: RoofField = { z: new Uint16Array(SS), q: new Int32Array(SS * 4) }, recs = decodeRoofs(cols.roofCaps);
  let any = false;
  for (let r = 0; r < recs.length; r += 6) {
    const c = recs[r], z = recs[r + 1];
    if (c < 0 || c >= SS || z <= 0 || !counts[c] || f.z[c]) continue;
    const k = off[c] + counts[c] - 1;
    if (runs[3 * k] + runs[3 * k + 1] !== z) continue;
    f.z[c] = z;
    for (let i = 0; i < 4; i++) f.q[4 * c + i] = recs[r + 2 + i];
    any = true;
  }
  return any ? f : null;
}

// The roofs' cells and their corners (slopeRoofs; null: none), from the node's roof caps (rf): a cell with a live cap
// whose top is roof material, of a building. T: each column's top (as colTop), top(c): the palette entry of column c's
// top voxel, planes: each column's plane code (the light). box: only its columns (apron coordinates). What it makes of
// a column depends only on the column and those round it (an edit changes nothing further off: mesher.worker.ts
// meshSections)
export type SlopeBase = NonNullable<ReturnType<typeof slopeBase>>;
export function slopeBase(N: number, T: Uint16Array, top: (c: number) => number, roofPal: Uint8Array, bidAt: (x: number, y: number) => number,
  planes: Uint16Array | null, rf: RoofField, box: Box | null = null) {
  const S = N + 2, SS = S * S;
  const bx0 = box ? box.x0 : 0, bx1 = box ? box.x1 : S, by0 = box ? box.y0 : 0, by1 = box ? box.y1 : S;
  // a region: the cells of one plane code (the light) and one building
  const bid = new Int32Array(SS), reg = new Int32Array(SS).fill(-1), regions: Region[] = [], byKey = new Map<number, number>();
  const hq = new Int32Array(SS * 4), nq = new Uint16Array(SS * 4), ctr = new Float64Array(SS);
  let any = false;
  for (let Y0 = by0; Y0 < by1; Y0++) for (let c = bx0 + S * Y0, ce = bx1 + S * Y0; c < ce; c++) {
    bid[c] = bidAt((c % S) - 1, Math.floor(c / S) - 1);
    if (!rf.z[c] || rf.z[c] !== T[c] || !bid[c]) continue;
    const v = top(c);
    if (!(v < roofPal.length && roofPal[v] & PAL_ROOF)) continue;
    const code = planes ? planes[c] : 0, key = code * 65536 + bid[c];
    let id = byKey.get(key);
    if (id === undefined) { id = regions.length; byKey.set(key, id); regions.push(region(code, bid[c])); }
    reg[c] = id;
    any = true;
    const r = regions[id], e = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) { hq[c * 4 + k] = rf.q[c * 4 + k]; e[k] = hq[c * 4 + k] - r.gxq * (CX[k] - 0.5) - r.gyq * (CY[k] - 0.5); }
    // its own plane's height at its middle, as near as its code tells: the middle of what its corners say (a corner
    // met by another plane's, at a ridge or in a valley, is off it)
    e.sort((a, b) => a - b);
    ctr[c] = (e[1] + e[2]) / 2;
  }
  if (!any) return null;
  // which corner of cell c grid point (GX, GY) is
  const cornerIdx = (c: number, GX: number, GY: number) => { const dx = GX - (c % S), dy = GY - Math.floor(c / S); return dy ? (dx ? 2 : 3) : dx; };
  // the light at each corner: its own plane's, but where planes meet (one height at the point for the cells of
  // different planes) a corner its own plane does not pass through is lit by those planes that do -- the light turns
  // over a ridge where it runs, not along its cells' staircase
  const cs = [0, 0, 0, 0], own = [0, 0, 0, 0], nv = [0, 0, 0];
  for (let GY = by0; GY <= by1; GY++) for (let GX = bx0; GX <= bx1; GX++) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const X = GX - 1 + (k & 1), Y = GY - 1 + (k >> 1);
      if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
      const c = X + S * Y;
      if (reg[c] < 0) continue;
      const r = regions[reg[c]];
      cs[n] = c; own[n] = ctr[c] + r.gxq * (GX - X - 0.5) + r.gyq * (GY - Y - 0.5);
      n++;
    }
    for (let i = 0; i < n; i++) {
      const c = cs[i], k = cornerIdx(c, GX, GY), h = hq[c * 4 + k], r = regions[reg[c]];
      nq[c * 4 + k] = r.lit;
      if (Math.abs(own[i] - h) <= Q / 8) continue;
      let mixed = false, near = false;
      for (let j = 0; j < n; j++) {
        if (hq[cs[j] * 4 + cornerIdx(cs[j], GX, GY)] !== h) continue;
        if (regions[reg[cs[j]]].code !== r.code) mixed = true;
        if (Math.abs(own[j] - h) <= Q / 8) near = true;
      }
      if (!mixed) continue;
      nv[0] = nv[1] = nv[2] = 0;
      for (let j = 0; j < n; j++) {
        if (hq[cs[j] * 4 + cornerIdx(cs[j], GX, GY)] !== h || (near && Math.abs(own[j] - h) > Q / 8)) continue;
        const rj = regions[reg[cs[j]]];
        nv[0] += rj.nx; nv[1] += rj.ny; nv[2] += rj.nz;
      }
      nq[c * 4 + k] = normalCode(nv[0], nv[1], nv[2]);
    }
  }
  return { bid, reg, regions, hq, nq, ctr, cornerIdx };
}

// a plane code's region: its gradient (rise per metre east and south) in 1/64 m, its normal, how it is lit
function region(code: number, b: number): Region {
  const flat = code === 0, th = flat ? 0 : ((code - 1) >> 6) * (Math.PI / 72), az = flat ? 0 : ((code - 1) & 63) * (Math.PI / 32);
  const t = Math.tan(th);
  return { code, bid: b, flat, gxq: -t * Math.cos(az) * Q, gyq: -t * Math.sin(az) * Q,
    lit: flat ? 1 : code, nx: Math.sin(th) * Math.cos(az), ny: Math.cos(th), nz: Math.sin(th) * Math.sin(az) };
}

// a normal (x east, y up, z south) as a plane code: 1 + slope in 2.5° steps (0 to 30) x 64 + downhill direction
function normalCode(x: number, y: number, z: number) {
  const k = Math.min(30, Math.round(Math.acos(y / Math.hypot(x, y, z)) / (Math.PI / 72)));
  return 1 + k * 64 + (k ? (Math.round(Math.atan2(z, x) / (Math.PI / 32)) + 64) % 64 : 0);
}
