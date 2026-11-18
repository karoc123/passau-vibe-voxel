// Pitched roofs as slopes (1 m tiles). A pitched roof in 1 m voxels is a staircase: a light top and a dark riser per
// metre, a ragged ridge, its gable a stepped pyramid. Where the tile ships a column's roof plane (planes: LoD2's, or a
// fitted roof's; scripts/voxelize.py plane_codes) its top is drawn as that plane instead, one sloped surface:
//
// - the columns of one roof plane (the same plane code and building, heights consistent with it) are a region; its
//   plane's height is fitted to their tops (a top is the plane at the column's centre, rounded; the gradient from the
//   code, or fitted too where the region is big enough to tell), in 1/64 m
// - each grid point gets one height per region around it, so neighbouring columns of a region share their corners;
//   where regions meet (of one building, or within a metre of each other) they take one height there: the lower
//   plane's at a ridge or hip (the roof is the planes' minimum there), the higher one's in a valley, else their mean;
//   kept within its rise of the column's top (a corner is the column's centre height, rounded to its top, give or
//   take half a metre of slope), so nothing floats off the voxels
// - lit by its plane (the plane code's normal, as the voxel roofs are); where regions meet, by the plane the height
//   is taken from, so the light turns over a ridge where it runs, not along its cells' staircase
// - the column's top face and its side faces from where the surface comes down to are not drawn (hidden); the surface
//   is, merged into one quad over a rectangle of a region where it is the plane itself, and on each edge a vertical
//   face closes it from below wherever it is higher than what is beside it: an eave's edge, a gable's triangle (in
//   the wall's material), the step to a lower roof; against a taller wall or roof, that wall comes down to it
// - a flat roof cell of the same building beside a slope (the flat ridge of a fitted roof) is a level region of its
//   own, so a slope runs up to it instead of stopping a step short
//
// On a tile's edge the neighbour's corners are only estimated (its region goes on out of this tile): the face over
// that edge is always drawn, as a skirt down into the roof, so a slightly different estimate leaves no crack.
// Heights below a metre ride in vattr.y's top 6 bits (the AO takes the low 2; voxelMaterial.ts adds them back).
import { PAL_ROOF } from './chamfer';

export interface SlopeSink {
  reserve(n: number): void;
  // q: height in 1/64 m
  vertexQ(x: number, q: number, z: number, normal: number, ao: number, ground: number, roof: number, palette: number, building: number): void;
}

const Q = 64;
// A wall's face carries where the wall ends above it, in vattr.w (voxelMaterial.ts: no window past it): WALL_TOP + its
// height over the ground in metres, up to 61; 127 for 62 and more (no limit). (0 on a wall: not known; 1-64 a roof's
// plane, SLANT and up a chamfer's)
export const WALL_TOP = 65;
export const wallTopCode = (m: number) => (m >= 62 ? 127 : WALL_TOP + Math.max(0, m));
// corner k of a cell: (0, 0), (1, 0), (1, 1), (0, 1)
const CX = [0, 1, 1, 0], CY = [0, 0, 1, 1];
// the 4 neighbours
const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];
// the 4 edges: [axis, dir, corner a, corner b] (a before b along the edge)
const EDGES = [[0, -1, 0, 3], [0, 1, 1, 2], [1, -1, 0, 1], [1, 1, 3, 2]] as const;

interface Region {
  code: number; bid: number; flat: boolean; cells: number[];
  gx: number; gy: number; e0: number; gxq: number; gyq: number; // its plane: rise per metre east, south; in 1/64 m
  lit: number; nx: number; ny: number; nz: number; // the normal it is lit by (its code's), as a code and a vector
  span: number; // how far a corner may be off its column's top
}

// vol, colTop as in mesher.worker.ts (S x S columns with the apron; vol index (z + 1)); hidden: per voxel, its faces
// not to draw (bit: normal index); returns null when there are no slopes
export function slopeRoofs(N: number, vol: Uint16Array, colTop: Uint16Array, roofPal: Uint8Array, bidAt: (x: number, y: number) => number,
  shipped: Uint16Array, hidden: Uint8Array) {
  const S = N + 2, SS = S * S;
  const T = colTop; // the top face's height (the top voxel is at z = T - 1)
  const bid = new Int32Array(SS), roofTop = new Uint8Array(SS);
  let any = false;
  for (let c = 0; c < SS; c++) {
    bid[c] = bidAt((c % S) - 1, Math.floor(c / S) - 1);
    if (T[c] <= 0 || !bid[c]) continue;
    const v = vol[c + SS * T[c]];
    if (v < roofPal.length && roofPal[v] & PAL_ROOF) { roofTop[c] = 1; if (shipped[c]) any = true; }
  }
  if (!any) return null;
  const planes = tidyPlanes(S, T, shipped, bid, roofTop);
  let wallTops = false;
  if (!planes.some((p, c) => p > 0 && roofTop[c] > 0)) return null;
  const grad = (p: number) => {
    const t = Math.tan(((p - 1) >> 6) * (Math.PI / 72)), a = ((p - 1) & 63) * (Math.PI / 32);
    return [-t * Math.cos(a), -t * Math.sin(a)]; // rise per metre east (x) and south (y)
  };
  // regions
  const reg = new Int32Array(SS).fill(-1), regions: Region[] = [];
  const stack: number[] = [];
  for (let c0 = 0; c0 < SS; c0++) {
    if (!roofTop[c0] || reg[c0] >= 0) continue;
    const code = planes[c0], flat = code === 0;
    const [gx, gy] = flat ? [0, 0] : grad(code);
    const th = flat ? 0 : ((code - 1) >> 6) * (Math.PI / 72), az = flat ? 0 : ((code - 1) & 63) * (Math.PI / 32);
    const r: Region = { code, bid: bid[c0], gx, gy, e0: 0, gxq: 0, gyq: 0, flat, cells: [],
      span: 0, lit: flat ? 1 : code, nx: Math.sin(th) * Math.cos(az), ny: Math.cos(th), nz: Math.sin(th) * Math.sin(az) };
    const id = regions.length;
    regions.push(r);
    reg[c0] = id; stack.push(c0);
    while (stack.length) {
      const c = stack.pop()!;
      r.cells.push(c);
      const x = c % S, y = (c - x) / S;
      for (let k = 0; k < 4; k++) {
        const dx = DX[k], dy = DY[k], X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
        const n = X + S * Y;
        if (!roofTop[n] || reg[n] >= 0 || planes[n] !== code || bid[n] !== r.bid) continue;
        if (Math.abs(T[n] - T[c] - gx * dx - gy * dy) > (flat ? 0.5 : 1.5)) continue;
        reg[n] = id; stack.push(n);
      }
    }
  }
  // a level region counts only beside a slope of its building: a flat roof elsewhere stays voxels
  const slopeNext = (r: Region) => {
    let k = 0;
    for (const c of r.cells) {
      const x = c % S, y = (c - x) / S;
      for (let d = 0; d < 4; d++) {
        const X = x + DX[d], Y = y + DY[d], n = X + S * Y;
        if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
        if (reg[n] >= 0 && !regions[reg[n]].flat && bid[n] === r.bid) { k++; break; }
      }
    }
    return k;
  };
  for (const r of regions) {
    if (r.flat && (r.cells.length > 400 || slopeNext(r) * 4 < r.cells.length)) { for (const c of r.cells) reg[c] = -1; r.cells = []; continue; }
    fit(r, S, T);
  }
  // corner heights per cell (1/64 m), whether each is its region's plane itself, and the normal it is lit by there
  const hq = new Int32Array(SS * 4), pure = new Uint8Array(SS * 4), nq = new Uint16Array(SS * 4);
  const seam = tileSeams(N, T, planes, bid, roofTop);
  // a region's plane, bent near the tile's edges to the height both tiles agree on there (tileSeams)
  const planeQ = (r: Region, GX: number, GY: number) => r.e0 + r.gxq * GX + r.gyq * GY + seam.bend(r, GX, GY);
  // which corner of cell c grid point (GX, GY) is
  const cornerIdx = (c: number, GX: number, GY: number) => { const dx = GX - (c % S), dy = GY - Math.floor(c / S); return dy ? (dx ? 2 : 3) : dx; };
  const cs = new Int32Array(4), vs = new Int32Array(4), hs = new Int32Array(4), grp = new Int32Array(4);
  const nv = [0, 0, 0];
  // (a corner is its column's centre height, rounded to its top, give or take half a metre's rise)
  const span = (i: number) => regions[reg[cs[i]]].span;
  const fits = (i: number, h: number) => Math.abs(h - T[cs[i]] * Q) <= span(i);
  // one height for each group: the planes' lowest at a ridge or a hip (each rises towards the other), the highest
  // in a valley, else their mean; a cell it would take more than its span off its own top keeps its own
  const meet = (mem: number[]) => {
    let ridge = false, valley = false, lo = Infinity, hi = -Infinity, sum = 0;
    for (const i of mem) {
      lo = Math.min(lo, vs[i]); hi = Math.max(hi, vs[i]); sum += vs[i];
      for (const j of mem) {
        const ri = regions[reg[cs[i]]], rj = regions[reg[cs[j]]];
        if (j <= i || ri === rj) continue;
        const ux = (cs[j] % S) - (cs[i] % S), uy = Math.floor(cs[j] / S) - Math.floor(cs[i] / S);
        const sl = (ri.gx - rj.gx) * ux + (ri.gy - rj.gy) * uy;
        if (sl > 0.1) ridge = true; else if (sl < -0.1) valley = true;
      }
    }
    return ridge && !valley ? lo : valley && !ridge ? hi : Math.round(sum / mem.length);
  };
  // lit there by the plane (or planes) the height is taken from: the one that is the roof at this point, so the light
  // turns over the ridge where it runs, not along its cells' staircase
  const light = (mem: number[], h: number) => {
    nv[0] = nv[1] = nv[2] = 0;
    for (const i of mem) {
      if (Math.abs(vs[i] - h) > Q / 8 && mem.some((j) => Math.abs(vs[j] - h) <= Q / 8)) continue;
      const r = regions[reg[cs[i]]];
      nv[0] += r.nx; nv[1] += r.ny; nv[2] += r.nz;
    }
    return normalCode(nv[0], nv[1], nv[2]);
  };
  for (let GY = 0; GY <= S; GY++) for (let GX = 0; GX <= S; GX++) {
    let n = 0, one = true;
    for (let k = 0; k < 4; k++) {
      const X = GX - 1 + (k & 1), Y = GY - 1 + (k >> 1);
      if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
      const c = X + S * Y;
      if (reg[c] < 0) continue;
      cs[n] = c; vs[n] = planeQ(regions[reg[c]], GX, GY);
      if (reg[c] !== reg[cs[0]]) one = false;
      n++;
    }
    if (!n) continue;
    // the cells that meet here: of one building, or of two whose roofs come within a metre (a step that small drawn
    // as a wall zigzags along the cells)
    for (let i = 0; i < n; i++) grp[i] = one ? 0 : i;
    if (!one) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const d = Math.abs(vs[i] - vs[j]);
      if (d <= Q || (bid[cs[i]] === bid[cs[j]] && d <= 2 * Q)) { const gi = grp[i], gj = grp[j]; for (let k = 0; k < n; k++) if (grp[k] === gj) grp[k] = gi; }
    }
    for (let i = 0; i < n; i++) hs[i] = Math.min(T[cs[i]] * Q + span(i), Math.max(T[cs[i]] * Q - span(i), vs[i]));
    if (!one) for (let g = 0; g < n; g++) {
      let mem: number[] = [];
      for (let i = 0; i < n; i++) if (grp[i] === g) mem.push(i);
      if (mem.length < 2) continue;
      let h = meet(mem);
      const ok = mem.filter((i) => fits(i, h));
      if (ok.length < mem.length) { mem = ok; if (mem.length < 2) continue; h = meet(mem); if (!mem.every((i) => fits(i, h))) continue; }
      for (const i of mem) hs[i] = h;
      if (mem.some((i) => h !== vs[i])) {
        const code = light(mem, h);
        for (const i of mem) nq[cs[i] * 4 + cornerIdx(cs[i], GX, GY)] = code;
      }
    }
    for (let i = 0; i < n; i++) {
      const c = cs[i], k = cornerIdx(c, GX, GY);
      hq[c * 4 + k] = hs[i]; pure[c * 4 + k] = hs[i] === vs[i] ? 1 : 0;
      if (!nq[c * 4 + k] || hs[i] === vs[i]) nq[c * 4 + k] = regions[reg[c]].lit;
    }
  }
  return {
    hidden,
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
      for (let Y = 1; Y <= N; Y++) for (let X = 1; X <= N; X++) {
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
    // tops: mark the walls' faces with where the wall ends (wallTopCode; 1 m tiles)
    emit(out: SlopeSink, x0: number, y0: number, ground: Uint8Array, tops = false) {
      wallTops = tops;
      emitTops(out, x0, y0, ground);
      for (let Y = 1; Y <= N; Y++) for (let X = 1; X <= N; X++) {
        const c = X + S * Y;
        if (reg[c] >= 0) for (const e of EDGES) emitEdge(out, c, e, x0, y0, ground);
      }
    },
  };

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

  function emitTops(out: SlopeSink, x0: number, y0: number, ground: Uint8Array) {
    const done = new Uint8Array(SS);
    const ok = (c: number) => reg[c] >= 0 && pure[c * 4] && pure[c * 4 + 1] && pure[c * 4 + 2] && pure[c * 4 + 3] && !seam.bent(regions[reg[c]], c);
    for (let Y = 1; Y <= N; Y++) for (let X = 1; X <= N; X++) {
      const c = X + S * Y;
      if (reg[c] < 0 || done[c]) continue;
      const r = regions[reg[c]], pal = vol[c + SS * T[c]];
      let w = 1, h = 1;
      if (ok(c)) {
        const same = (k: number) => !done[k] && reg[k] === reg[c] && ok(k) && vol[k + SS * T[k]] === pal;
        while (X + w <= N && same(c + w)) w++;
        outer: while (Y + h <= N) {
          for (let i = 0; i < w; i++) if (!same(c + i + S * h)) break outer;
          h++;
        }
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) done[c + i + S * j] = 1;
      const q = w === 1 && h === 1 ? [hq[c * 4], hq[c * 4 + 1], hq[c * 4 + 2], hq[c * 4 + 3]]
        : [planeQ(r, X, Y), planeQ(r, X + w, Y), planeQ(r, X + w, Y + h), planeQ(r, X, Y + h)];
      const px = [X, X + w, X + w, X], py = [Y, Y, Y + h, Y + h];
      // a cell a ridge, hip or valley runs across is split along the diagonal whose middle comes nearest its own plane
      // at its centre (its top is that plane's there): split the other way the ridge sagged a notch into every cell
      // it crossed, a sawtooth along each hip; a plane's own cell splits either way alike
      let d02 = Math.abs(q[0] - q[2]) <= Math.abs(q[1] - q[3]);
      if (w === 1 && h === 1 && !(pure[c * 4] && pure[c * 4 + 1] && pure[c * 4 + 2] && pure[c * 4 + 3])) {
        const ctr = (planeQ(r, X, Y) + planeQ(r, X + 1, Y) + planeQ(r, X + 1, Y + 1) + planeQ(r, X, Y + 1)) / 4;
        const a = Math.abs((q[0] + q[2]) / 2 - ctr), b = Math.abs((q[1] + q[3]) / 2 - ctr);
        if (Math.abs(a - b) > 1) d02 = a < b;
      }
      const ord = d02 ? [0, 3, 2, 1] : [1, 0, 3, 2];
      out.reserve(4);
      for (const k of ord) {
        const lit = w === 1 && h === 1 ? nq[c * 4 + k] : r.lit;
        out.vertexQ(px[k] - 1 + x0, q[k], py[k] - 1 + y0, 5 + 8 * ((lit - 1) >> 6), 3, ground[c], 1 + ((lit - 1) & 63), pal, bid[c]);
      }
    }
  }

  function emitEdge(out: SlopeSink, c: number, e: readonly number[], x0: number, y0: number, ground: Uint8Array) {
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
    // a skirt over the tile's edge (only seen where the two tiles' estimates differ) is a sliver of the roof
    const skirt = border && reg[n] >= 0;
    // how much the roof falls towards this edge: an eave (its edge in the roof's material, lit as the roof, as a
    // riser was), else a gable or the side of a step (the wall's)
    const az = ((r.code - 1) & 63) * (Math.PI / 32), ox = e[0] === 0 ? e[1] : 0, oy = e[0] === 1 ? e[1] : 0;
    const fall = r.flat ? 0 : Math.cos(az) * ox + Math.sin(az) * oy;
    const pal = fall < 0.4 && wallBelow && !skirt ? below : top;
    const lit = skirt ? r.lit : pal === top && fall > 0.05 ? r.code : 0;
    vertical(out, e[0], e[1], X, Y, e, lo * Q, lo * Q, a0, a1, pal, lit, ground[c], bid[c], x0, y0);
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

// The shipped planes, tidied before they become slopes (per column: its code, roofTop: roof material on top, bid: the
// building):
// - a roof of steep planes on a small footprint -- a tower's helm, a turret, a spire's foot (60° and steeper on the
//   average, under 64 columns, apart from the rest of the roof by a step or a flat rim) -- stays voxels: a handful of
//   cells per plane, each slope a sliver, fitted and met at their corners, came out a crumpled cone (the Altes
//   Rathaus's tower)
// - a fragment of a plane (up to 3 columns of one code) inside another plane of the same building takes that plane's
//   code where its tops fit it within a metre, and so does a column with no plane (0) with 3 or 4 sides in one plane:
//   each was a region of its own, a facet with a crease round it, or a voxel step, in the middle of a smooth roof
function tidyPlanes(S: number, T: Uint16Array, shipped: Uint16Array, bid: Int32Array, roofTop: Uint8Array) {
  const SS = S * S, pc = shipped.slice();
  const slope = (p: number) => (p - 1) >> 6;
  const grad = (p: number) => {
    const t = Math.tan(slope(p) * (Math.PI / 72)), a = ((p - 1) & 63) * (Math.PI / 32);
    return [-t * Math.cos(a), -t * Math.sin(a)];
  };
  const lab = new Int32Array(SS).fill(-1), stack: number[] = [], cells: number[] = [];
  // the steep small roofs: slope cells of one building, joined where their tops are within 3 m
  for (let c0 = 0; c0 < SS; c0++) {
    if (!roofTop[c0] || !pc[c0] || lab[c0] >= 0) continue;
    cells.length = 0; lab[c0] = c0; stack.push(c0);
    let k = 0, edge = false;
    while (stack.length) {
      const c = stack.pop()!, x = c % S, y = (c - x) / S;
      cells.push(c); k += slope(pc[c]);
      if (x === 0 || y === 0 || x === S - 1 || y === S - 1) edge = true;
      for (let d = 0; d < 4; d++) {
        const X = x + DX[d], Y = y + DY[d];
        if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
        const n = X + S * Y;
        if (!roofTop[n] || !pc[n] || lab[n] >= 0 || bid[n] !== bid[c] || Math.abs(T[n] - T[c]) > 3) continue;
        lab[n] = c0; stack.push(n);
      }
    }
    // (one that reaches the apron may go on in the next tile: left as it is)
    if (!edge && cells.length < 64 && k >= 24 * cells.length) for (const c of cells) pc[c] = 0;
  }
  // fragments: components of one code
  const size = new Int32Array(SS);
  lab.fill(-1);
  for (let c0 = 0; c0 < SS; c0++) {
    if (!roofTop[c0] || !pc[c0] || lab[c0] >= 0) continue;
    cells.length = 0; lab[c0] = c0; stack.push(c0);
    while (stack.length) {
      const c = stack.pop()!, x = c % S, y = (c - x) / S;
      cells.push(c);
      for (let d = 0; d < 4; d++) {
        const X = x + DX[d], Y = y + DY[d];
        if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
        const n = X + S * Y;
        if (!roofTop[n] || pc[n] !== pc[c] || lab[n] >= 0 || bid[n] !== bid[c]) continue;
        lab[n] = c0; stack.push(n);
      }
    }
    for (const c of cells) size[c] = cells.length;
  }
  const out = pc.slice(), codes = [0, 0, 0, 0], cnt = [0, 0, 0, 0], fit = [0, 0, 0, 0];
  for (let c = 0; c < SS; c++) {
    if (!roofTop[c] || (pc[c] && size[c] > 3)) continue;
    const x = c % S, y = (c - x) / S;
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const X = x + DX[d], Y = y + DY[d];
      if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
      const n = X + S * Y, p = pc[n];
      if (!roofTop[n] || !p || p === pc[c] || bid[n] !== bid[c] || size[n] <= 3) continue;
      // n's plane carried over to c: how far c's top is off it
      const [gx, gy] = grad(p), off = Math.abs(T[c] - (T[n] + gx * -DX[d] + gy * -DY[d]));
      let i = 0;
      while (i < m && codes[i] !== p) i++;
      if (i === m) { codes[m] = p; cnt[m] = 0; fit[m] = 0; m++; }
      cnt[i]++; if (off <= 1) fit[i]++;
    }
    let best = -1;
    for (let i = 0; i < m; i++) if (fit[i] === cnt[i] && (best < 0 || cnt[i] > cnt[best])) best = i;
    if (best >= 0 && cnt[best] >= (pc[c] ? 2 : 3)) out[c] = codes[best];
  }
  return out;
}

// Where a roof runs over the tile's edge, each tile fits its plane to the part of it that it has: the two came out
// up to a metre apart there (a step along the tile's edge, closed by a skirt, read as a line across the roof). So at
// the edge both take the height that the columns either side of it give (the edge's own column and the apron's,
// which both tiles have): the plane of the cells' code through their tops within 8 m along the edge, in exact
// integers so both tiles get the same; a region's plane bends to it over the last 8 m before the edge.
const SEAM = 8;
function tileSeams(N: number, T: Uint16Array, planes: Uint16Array, bid: Int32Array, roofTop: Uint8Array) {
  const S = N + 2, Lx = [1, N + 1];
  const target = new Map<number, number>(), touch = new Map<Region, number>();
  const gq = (code: number) => {
    if (!code) return [0, 0];
    const t = Math.tan(((code - 1) >> 6) * (Math.PI / 72)), a = ((code - 1) & 63) * (Math.PI / 32);
    return [Math.round(-t * Math.cos(a) * Q), Math.round(-t * Math.sin(a) * Q)];
  };
  const vals: number[] = [];
  // the roof's height (1/64 m) at grid point `along` of line L (axis 0: x = L), for the plane `code` of building b
  const at = (axis: number, L: number, along: number, code: number, b: number) => {
    const key = ((axis * (S + 1) + L) * (S + 1) + along) * 4096 * 16384 + code * 16384 + (b & 16383);
    const got = target.get(key);
    if (got !== undefined) return got;
    const [gx, gy] = gq(code);
    vals.length = 0;
    for (let k = along - SEAM; k < along + SEAM; k++) {
      if (k < 0 || k >= S) continue;
      for (const m of [L - 1, L]) {
        const c = axis === 0 ? m + S * k : k + S * m;
        if (!roofTop[c] || planes[c] !== code || bid[c] !== b) continue;
        const cx = c % S, cy = (c - cx) / S, X2 = axis === 0 ? 2 * L : 2 * along, Y2 = axis === 0 ? 2 * along : 2 * L;
        vals.push(2 * T[c] * Q + gx * (X2 - 2 * cx - 1) + gy * (Y2 - 2 * cy - 1)); // twice the height, an integer
      }
    }
    let h = NaN;
    if (vals.length >= 4) {
      vals.sort((p, q) => p - q);
      const med = vals[vals.length >> 1];
      let sum = 0, n = 0;
      for (const v of vals) if (Math.abs(v - med) <= 2 * Q) { sum += v; n++; }
      h = Math.round(sum / n / 2);
    }
    target.set(key, h);
    return h;
  };
  // which of the 4 edge lines (bits: x = 1, x = N + 1, y = 1, y = N + 1) a region reaches
  const touches = (r: Region) => {
    let t = touch.get(r);
    if (t === undefined) {
      t = 0;
      for (const c of r.cells) {
        const x = c % S, y = (c - x) / S;
        if (x <= 1) t |= 1; if (x >= N) t |= 2; if (y <= 1) t |= 4; if (y >= N) t |= 8;
      }
      touch.set(r, t);
    }
    return t;
  };
  const bend = (r: Region, GX: number, GY: number) => {
    const t = touches(r);
    if (!t) return 0;
    let d = 0;
    for (let axis = 0; axis < 2; axis++) for (let e = 0; e < 2; e++) {
      if (!(t & (1 << (axis * 2 + e)))) continue;
      const L = Lx[e], p = axis === 0 ? GX : GY, along = axis === 0 ? GY : GX, w = 1 - Math.abs(p - L) / SEAM;
      if (w <= 0) continue;
      const h = at(axis, L, Math.min(S, Math.max(0, along)), r.code, r.bid);
      if (Number.isNaN(h)) continue;
      const own = axis === 0 ? r.e0 + r.gxq * L + r.gyq * GY : r.e0 + r.gxq * GX + r.gyq * L;
      if (Math.abs(h - own) <= 1.5 * Q) d += Math.min(1, w) * (h - own);
    }
    return Math.round(d);
  };
  return {
    bend,
    // whether any corner of cell c (of region r) is bent
    bent(r: Region, c: number) {
      const x = c % S, y = (c - x) / S;
      return !!touches(r) && (x < SEAM + 1 || y < SEAM + 1 || x > N - SEAM || y > N - SEAM)
        && (bend(r, x, y) !== 0 || bend(r, x + 1, y) !== 0 || bend(r, x + 1, y + 1) !== 0 || bend(r, x, y + 1) !== 0);
    },
  };
}

// a normal (x east, y up, z south) as a plane code: 1 + slope in 2.5° steps (0 to 30) x 64 + downhill direction
function normalCode(x: number, y: number, z: number) {
  const k = Math.min(30, Math.round(Math.acos(y / Math.hypot(x, y, z)) / (Math.PI / 72)));
  return 1 + k * 64 + (k ? (Math.round(Math.atan2(z, x) / (Math.PI / 32)) + 64) % 64 : 0);
}

// the region's plane: its gradient from the code (or fitted, over a region big and wide enough to tell), its height
// fitted to the tops; snapped to 1/64 m per metre so it is exact at every grid point
function fit(r: Region, S: number, T: Uint16Array) {
  const n = r.cells.length;
  let mx = 0, my = 0, mt = 0;
  for (const c of r.cells) { mx += (c % S) + 0.5; my += Math.floor(c / S) + 0.5; mt += T[c]; }
  mx /= n; my /= n; mt /= n;
  let gx = r.gx, gy = r.gy;
  // (by the code's slope, not the fitted one: the same in the tiles either side of an edge, tileSeams)
  r.span = Math.round((0.75 + 0.5 * (Math.abs(gx) + Math.abs(gy))) * Q);
  if (!r.flat && n >= 16) {
    let sxx = 0, sxy = 0, syy = 0, sxt = 0, syt = 0;
    for (const c of r.cells) {
      const x = (c % S) + 0.5 - mx, y = Math.floor(c / S) + 0.5 - my, t = T[c] - mt;
      sxx += x * x; sxy += x * y; syy += y * y; sxt += x * t; syt += y * t;
    }
    const det = sxx * syy - sxy * sxy;
    if (det > 1e-6 && sxx > 2 * n * 0.25 && syy > 2 * n * 0.25) {
      const fx = (sxt * syy - syt * sxy) / det, fy = (syt * sxx - sxt * sxy) / det;
      if (Math.hypot(fx - gx, fy - gy) < 0.1 + 0.1 * Math.hypot(gx, gy)) { gx = fx; gy = fy; }
    }
  }
  r.gxq = Math.round(gx * Q); r.gyq = Math.round(gy * Q);
  // the plane through the tops' mean at their mean position; e0: its height at grid point (0, 0)
  r.e0 = Math.round(mt * Q - r.gxq * mx - r.gyq * my);
  r.gx = r.gxq / Q; r.gy = r.gyq / Q;
}
