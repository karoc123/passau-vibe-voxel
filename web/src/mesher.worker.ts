// Fetches, unzips and greedy-meshes one tile (scripts/tiles.py), with baked ambient occlusion.
// Data coordinates: x east, y south, z up. Positions go out in three.js axes (x, z, y), metres.
// A tile is N x N cells of s metres plus a 1-cell apron. The distance levels (2, 4 and 8 m, scripts/tiles.py
// LOD_LEVELS) are meshed as level 1 is, in cells -- roof planes, chamfered walls, sloped roofs -- and scaled to metres
// on the way out.
import { chamferWalls, PAL_ROOF, SLANT, type Prism } from './chamfer';
import { cornerQ, PINNED, rampDiagonal02, ramped, rampField, type RampField } from './ramps';
import { slopeRoofs, wallTopCode } from './roofs';
import { decodeTile, type Columns, type Fields, type RawColumns } from './tile-data';
import { fetchGzip } from './fetch';

export interface MeshRequest {
  key: string;
  url: string;
  under?: RawColumns | Columns | string;
  N: number;
  s: number;
  x0: number;
  y0: number;
  keep: boolean;
  dataOnly: boolean;
  // per palette entry, flags (chamfer.ts): PAL_ROOF, roof material, its staircases shaded as the roof
  // plane; PAL_WALL, a building's wall, its diagonal staircases chamfered flat
  roof: Uint8Array | null;
  // per palette entry: 1 leaves, 2 wood -- a tree's trunk and branches are meshed where they meet its leaves too, so
  // they show where the leaves go (autumn, winter: voxelMaterial.ts); none: as before (tile-request.ts seePal)
  see?: Uint8Array | null;
  // a foliage tile only: mesh its base tile (under) again too, without the faces its grass and trunks cover
  base?: BaseRemesh | null;
}

// what the base tile is meshed with (as for its own request), and which palette entries are leaves (not cover: they
// can be discarded, autumn and winter)
export interface BaseRemesh { roof: Uint8Array | null; leaf: Uint8Array }

// box: the vertices' bounds, min x y z then max (the geometry's bounding box, made here rather than on the main thread)
export interface MeshOut { pos: Int16Array; attr: Uint8Array; pal: Uint16Array; bld: Uint16Array | null; quads: number; faces: Uint32Array; normals: Float32Array; cuts: Uint32Array; box: Float32Array }

export type MeshReply =
  | ({ type: 'node'; key: string; dataOnly: boolean; data: Columns | null; base?: MeshOut; fields?: Fields | null } & MeshOut)
  | { type: 'error'; key: string; dataOnly: boolean; error: string };

const post = (msg: MeshReply, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: MeshReply, t: Transferable[]): void }).postMessage(msg, transfer);

const copyColumns = (c: Columns): Columns => ({ counts: c.counts.slice(), ground: c.ground.slice(), runs: c.runs, planes: c.planes?.slice() ?? null, bld: c.bld?.slice() ?? null });
const columnBuffers = (c: Columns) => [c.counts.buffer, c.ground.buffer, c.runs.buffer, ...(c.planes ? [c.planes.buffer] : []), ...(c.bld ? [c.bld.buffer] : [])];

// One request's meshes: the tile's own (out), a foliage tile's base tile meshed again (base), and the column data kept
// (keep; dataOnly: that alone, no mesh). load: a tile file, unzipped (tools/tris.mjs reads them from disk)
// (the buildings of the columns, bld, come with the tile: every level's own; a foliage tile has none)
export async function meshJob(m: MeshRequest, load: (url: string) => Promise<ArrayBuffer>) {
  const { counts, ground, runs, planes, bld, fields } = decodeTile(await load(m.url), m.N);
  const keep = m.keep || m.dataOnly ? copyColumns({ counts, ground, runs, planes, bld }) : null;
  if (m.dataOnly) return { keep, out: null, base: undefined, fields: null };
  const under = typeof m.under === 'string' ? decodeTile(await load(m.under), m.N) : m.under ?? null;
  // (a foliage tile: its trunks reach down to the base's ramps, ramps.ts)
  const feet = m.base && m.s === 1 && under && 'ground' in under ? rampField(m.N, under.counts, offsetsOf(under.counts, (m.N + 2) ** 2), under.runs, (under as Columns).ground, m.base.roof ?? new Uint8Array()) : null;
  const out = meshTile(m.N, m.s, m.x0, m.y0, { counts, ground, runs }, m.roof ? bld : null, under, m.roof, planes, null, feet?.any ? feet : null, m.see ?? null);
  const base = m.base && under && 'ground' in under
    ? meshTile(m.N, m.s, m.x0, m.y0, under as Columns, (under as Columns).bld ?? null, null, m.base.roof, (under as Columns).planes ?? null, coverOf(m.N, { counts, runs }, m.base.leaf)) : undefined;
  return { keep, out, base, fields };
}

self.onmessage = async (e: MessageEvent<MeshRequest>) => {
  const m = e.data;
  try {
    const { keep, out, base, fields } = await meshJob(m, fetchGzip);
    if (!out) {
      post({ type: 'node', key: m.key, dataOnly: true, data: keep, pos: new Int16Array(), attr: new Uint8Array(), pal: new Uint16Array(), bld: null, quads: 0, faces: new Uint32Array(GROUPS + 1), normals: new Float32Array(GROUPS * 6), cuts: new Uint32Array(8), box: new Float32Array(6) }, columnBuffers(keep!));
      return;
    }
    const transfer: Transferable[] = [];
    for (const o of base ? [out, base] : [out]) transfer.push(o.pos.buffer, o.attr.buffer, o.pal.buffer, o.faces.buffer, o.normals.buffer, o.cuts.buffer, ...(o.bld ? [o.bld.buffer] : []));
    if (keep) transfer.push(...columnBuffers(keep));
    if (fields) transfer.push(fields.cell.buffer, fields.spill.buffer);
    post({ type: 'node', key: m.key, dataOnly: false, data: keep, ...out, base, fields }, transfer);
  } catch (err) {
    post({ type: 'error', key: m.key, dataOnly: m.dataOnly, error: String(err) });
  }
};

// corner order per quad so that the one shared index pattern (0 1 2, 0 2 3) gives its winding and AO diagonal,
// by [AO diagonal flipped][facing +]
const QUAD_ORDER = [[1, 2, 3, 0], [1, 0, 3, 2], [0, 1, 2, 3], [0, 3, 2, 1]];
const SOLID_BELOW = 65535;
const OCC = 65534; // the base tile under a foliage tile: solid for culling and AO, never meshed
// Faces out through the tile's border are drawn even where the next tile is solid there (it may not be shown yet: a
// level's node swaps whole); such a face's top edge lay exactly on the edge of the tops meeting over the border, and
// where they left a pixel between them it showed through, a hairline along the tile's edge. INNER marks them (in
// meshFaces' second mask, beside a wall's top) and they are drawn with their top edge sunk 1/64 m
const INNER = 1;
// A face of wood towards leaves (meshFaces see): vattr.w 127, which the shader reads as a wall's top out of reach
// (roofs.ts wallTopCode: nothing) -- and, while every tree is in full leaf, as a face to leave out (voxelMaterial.ts
// uWoodHid: the branches cost nothing in summer). (A foliage tile's faces carry no wall tops.)
export const THRU = 127;

class QuadBuffer {
  private cap = 1 << 14;
  pos = new Int16Array(this.cap * 3);
  attr = new Uint8Array(this.cap * 4);
  pal = new Uint16Array(this.cap);
  bld = new Uint16Array(this.cap);
  count = 0;
  axisEnd = -1; // vertices from here on face off the six axes (chamfers, roof slopes): grouped by their normals

  reserve(n: number) {
    if (this.count + n <= this.cap) return;
    this.cap *= 2;
    const grow = <T extends Int16Array | Uint8Array | Uint16Array>(a: T, k: number) => { const b = new (a.constructor as new (n: number) => T)(this.cap * k); b.set(a); return b; };
    this.pos = grow(this.pos, 3); this.attr = grow(this.attr, 4); this.pal = grow(this.pal, 1); this.bld = grow(this.bld, 1);
  }

  vertex(x: number, y: number, z: number, normal: number, ao: number, ground: number, roof: number, palette: number, building: number) {
    const v = this.count++;
    this.pos[v * 3] = x; this.pos[v * 3 + 1] = y; this.pos[v * 3 + 2] = z;
    this.attr[v * 4] = normal; this.attr[v * 4 + 1] = ao; this.attr[v * 4 + 2] = ground; this.attr[v * 4 + 3] = roof;
    this.pal[v] = palette; this.bld[v] = building;
  }

  // a vertex at height q / 64 m: the whole metres in the position, the rest in vattr.y's top 6 bits (roofs.ts)
  vertexQ(x: number, q: number, z: number, normal: number, ao: number, ground: number, roof: number, palette: number, building: number) {
    const y = Math.floor(q / 64);
    this.vertex(x, y, z, normal, ao | ((q - y * 64) << 2), ground, roof, palette, building);
  }
}

function offsetsOf(counts: Uint16Array, n: number) {
  const off = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + counts[i];
  return off;
}

function topOf(c: RawColumns, off: Uint32Array, n: number) {
  let zmax = 0;
  for (let i = 0; i < n; i++) {
    const k = c.counts[i];
    if (k) { const r = (off[i] + k - 1) * 3; zmax = Math.max(zmax, c.runs[r] + c.runs[r + 1]); }
  }
  return zmax;
}

// bldIds (1 m tiles): the building of each column, apron included (scripts/zones.py, 0: none); faces never merge across
// buildings
export function meshTile(N: number, s: number, x0: number, y0: number, cols: Columns, bldIds: Uint16Array | null, under: RawColumns | null,
  roofPal: Uint8Array | null, planes: Uint16Array | null, cover: Uint8Array | null = null, feet: RampField | null = null,
  see: Uint8Array | null = null): MeshOut {
  const S = N + 2, SS = S * S, { ground } = cols;
  const off = offsetsOf(cols.counts, SS), uoff = under && offsetsOf(under.counts, SS);
  const zmax = Math.max(topOf(cols, off, SS), under && uoff ? topOf(under, uoff, SS) : 0);
  const sz = zmax + 2, vol = new Uint16Array(SS * sz);
  const fill = (c: RawColumns, o: Uint32Array, value: (v: number) => number) => {
    for (let i = 0; i < SS; i++) for (let k = o[i], e = o[i] + c.counts[i]; k < e; k++) {
      const z0 = c.runs[k * 3], len = c.runs[k * 3 + 1], v = value(c.runs[k * 3 + 2]);
      for (let z = z0; z < z0 + len; z++) vol[i + SS * (z + 1)] = v;
    }
  };
  if (under && uoff) fill(under, uoff, () => OCC);
  for (let i = 0; i < SS; i++) vol[i] = SOLID_BELOW; // z = -1 is solid, so the slab's bottom is never meshed
  fill(cols, off, (v) => v);
  const bidAt = (x: number, y: number) => (bldIds ? bldIds[(y + 1) * S + x + 1] : 0);
  const out = new QuadBuffer();
  if (cover && cover.length < vol.length) { const c = new Uint8Array(vol.length); c.set(cover); cover = c; }
  // (1 m tiles) paved ground on a slope as ramps (ramps.ts)
  const ramps = roofPal && s === 1 ? rampField(N, cols.counts, off, cols.runs, ground, roofPal) : null;
  meshFaces(N, s, x0, y0, vol, sz, ground, bidAt, roofPal, planes, out, cover, ramps?.any ? ramps : null, feet, see);
  return byFacing(out, !!bldIds, N, s, x0, y0);
}

// --- culling helpers (kept apart from the meshing itself) ---

// The quads grouped by the way they face, so that stream.ts draws only the groups that can face a camera, or (in the
// sun's shadow map) face away from the sun: the six axes' faces each in a group, and what faces off them (chamfers'
// walls, lids and floors; roof slopes) in seventeen: down; wall or up, by the direction its normal points to in plan.
// In the buffer in the order FACE_ORDER, which keeps what a view from above, or the sun, takes mostly in one or two
// runs. faces: where each group starts, in quads, and the end; normals: each group's normals' bounds (min x y z, max
// x y z, three.js axes), what stream.ts judges a group by. (A quad of no area -- none of it ever rasterized -- is left out.)
// The x and z axes' groups are in the order of their faces' planes, west to east (north to south), so that where the
// camera is over the tile, between its sides, the part of such a group that faces it is one run too. cuts: x0, z0, s,
// N (the tile's corner and cell in metres, its cells), where in FACE_ORDER the -x, +x, -z, +z groups are, then for the -x, +x, -z, +z groups in turn (N + 2 each) where
// the quads of plane x0 + i s start in the group, i = 0 .. N + 1 (the last: the group's end).
const AXIS_N = [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0]]; // by normal index (mesher axis * 2 + positive)
// slanted: 6 down; walls 7-14, ups 15-22 by the direction their normal points to in plan, in 8 steps of 45° (centred
// on the axes and the diagonals: a chamfer's wall is mostly at 45°, a roof's slope often along an axis)
const SL_DOWN = 6, SL_WALL = 7, SL_UP = 15;
const FACE_ORDER = [4, SL_DOWN, 2, 1, ...Array.from({ length: 16 }, (_, i) => SL_WALL + i), 5, 0, 3]; // down, north, east, slanted, up, west, south
const GROUPS = FACE_ORDER.length;
function byFacing(out: QuadBuffer, withBld: boolean, N: number, s: number, x0: number, y0: number): MeshOut {
  const nq = out.count / 4, axisQ = out.axisEnd < 0 ? nq : out.axisEnd / 4;
  const gid = new Int8Array(nq), nrm = new Float32Array(Math.max(0, nq - axisQ) * 3), P = out.pos, A = out.attr;
  // the plane of an x (z) axis's face, as i of x0 + i s (y0 + i s)
  const plane = new Uint16Array(axisQ), cuts = new Uint32Array(8 + 4 * (N + 2));
  cuts.set([x0, y0, s, N, ...[0, 1, 2, 3].map((g) => FACE_ORDER.indexOf(g))]);
  for (let q = 0; q < axisQ; q++) {
    const g = gid[q] = A[q * 16] % 8;
    if (g < 4) {
      plane[q] = Math.max(0, Math.min(N, Math.round(g < 2 ? (P[q * 12] - x0) / s : (P[q * 12 + 2] - y0) / s)));
      cuts[8 + g * (N + 2) + plane[q] + 1]++;
    }
  }
  for (let g = 0; g < 4; g++) for (let i = 1, o = 8 + g * (N + 2); i < N + 2; i++) cuts[o + i] += cuts[o + i - 1];
  // a slanted quad's normal from its corners (y with its 1/64 m part: vattr.y's top 6 bits), its first triangle's or else its second's
  const y = (v: number) => P[v * 3 + 1] + (A[v * 4 + 1] >> 2) / 64;
  const tri = (a: number, b: number, c: number, o: number) => {
    const ux = P[b * 3] - P[a * 3], uy = y(b) - y(a), uz = P[b * 3 + 2] - P[a * 3 + 2];
    const wx = P[c * 3] - P[a * 3], wy = y(c) - y(a), wz = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz);
    if (l < 1e-6) return false;
    nrm[o] = nx / l; nrm[o + 1] = ny / l; nrm[o + 2] = nz / l;
    return true;
  };
  for (let q = axisQ; q < nq; q++) {
    const v = q * 4, o = (q - axisQ) * 3;
    if (!tri(v, v + 1, v + 2, o) && !tri(v, v + 2, v + 3, o)) { gid[q] = -1; continue; }
    const ny = nrm[o + 1];
    gid[q] = ny < -0.3 ? SL_DOWN : (ny > 0.3 ? SL_UP : SL_WALL) + ((Math.round(Math.atan2(nrm[o + 2], nrm[o]) / (Math.PI / 4)) % 8) + 8) % 8;
  }
  const cnt = new Uint32Array(GROUPS), lo = new Float32Array(GROUPS * 3).fill(2), hi = new Float32Array(GROUPS * 3).fill(-2);
  for (let q = 0; q < nq; q++) {
    const g = gid[q];
    if (g < 0) continue;
    cnt[g]++;
    const n = g < 6 ? AXIS_N[g] : nrm.subarray((q - axisQ) * 3, (q - axisQ) * 3 + 3);
    for (let k = 0; k < 3; k++) { lo[g * 3 + k] = Math.min(lo[g * 3 + k], n[k]); hi[g * 3 + k] = Math.max(hi[g * 3 + k], n[k]); }
  }
  const faces = new Uint32Array(GROUPS + 1), normals = new Float32Array(GROUPS * 6), at = new Uint32Array(GROUPS);
  FACE_ORDER.forEach((g, k) => {
    at[g] = faces[k]; faces[k + 1] = faces[k] + cnt[g];
    for (let c = 0; c < 3; c++) { normals[k * 6 + c] = lo[g * 3 + c]; normals[k * 6 + 3 + c] = hi[g * 3 + c]; }
  });
  const kept = faces[GROUPS], put = cuts.slice(); // (the cuts within the group; put: where its next quad of each plane goes)
  const pos = new Int16Array(kept * 12), attr = new Uint8Array(kept * 16), pal = new Uint16Array(kept * 4), bld = withBld ? new Uint16Array(kept * 4) : null;
  for (let q = 0; q < nq; q++) {
    const g = gid[q];
    if (g < 0) continue;
    const t = g < 4 ? at[g] + put[8 + g * (N + 2) + plane[q]]++ : at[g]++;
    pos.set(out.pos.subarray(q * 12, q * 12 + 12), t * 12);
    attr.set(out.attr.subarray(q * 16, q * 16 + 16), t * 16);
    pal.set(out.pal.subarray(q * 4, q * 4 + 4), t * 4);
    if (bld) bld.set(out.bld.subarray(q * 4, q * 4 + 4), t * 4);
  }
  const box = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < pos.length; i += 3) for (let c = 0; c < 3; c++) {
    const v = pos[i + c];
    if (v < box[c]) box[c] = v;
    if (v > box[3 + c]) box[3 + c] = v;
  }
  return { pos, attr, pal, bld, quads: kept, faces, normals, cuts, box };
}

// What of a base tile its foliage tile covers, per cell of the meshing volume: 1 grass or a trunk (always drawn,
// opaque), 2 leaves. The foliage tile's grass sits in the base's top cells: the base's own faces there lie under the
// grass's (drawn over them with a polygon offset) and are left out (meshFaces).
function coverOf(N: number, fol: RawColumns, leaf: Uint8Array) {
  const S = N + 2, SS = S * S, off = offsetsOf(fol.counts, SS), sz = topOf(fol, off, SS) + 2, cv = new Uint8Array(SS * sz);
  for (let i = 0; i < SS; i++) for (let k = off[i], e = off[i] + fol.counts[i]; k < e; k++) {
    const z0 = fol.runs[k * 3], len = fol.runs[k * 3 + 1], v = fol.runs[k * 3 + 2];
    for (let z = z0; z < z0 + len; z++) cv[i + SS * (z + 1)] = v < leaf.length && leaf[v] ? 2 : 1;
  }
  return cv;
}

// a face of a base cell (vol index a) towards its empty neighbour (ni) that foliage hides for good: the cell is grass
// (its own face is there, unless leaves are in front of it, which may go), or the neighbour is grass or a trunk
const coveredFace = (cover: Uint8Array, a: number, ni: number) => (cover[ni] === 1 || (cover[a] === 1 && cover[ni] !== 2));

function meshFaces(N: number, s: number, x0: number, y0: number, vol: Uint16Array, sz: number, ground: Uint8Array,
  bidAt: (x: number, y: number) => number, roofPal: Uint8Array | null, planes: Uint16Array | null, out: QuadBuffer,
  cover: Uint8Array | null = null, rp: RampField | null = null, feet: RampField | null = null, see: Uint8Array | null = null) {
  const S = N + 2, sx = S, sy = S;
  // wood's faces towards leaves (see): drawn, their AO as if the leaves were not there (they are not, in winter)
  const seeLeaf = see ? (k: number) => vol[k] < see.length && see[vol[k]] === 1 : undefined;
  // Ramps (ramps.ts): the top of paved ground with a corner off its voxel's top is drawn as its own quad (rampTops:
  // column, palette, building), and the side of its voxel towards paved ground across an edge with a free point is
  // left out: where the two tops do not meet there (one end pinned), a fill between them, out through the tile's
  // border a skirt from the voxel's foot up to the ramp (rampSides: column, neighbour, axis, direction, border, palette,
  // building). Ramps' AO is that of their ground alone: a step that became a ramp casts none.
  const rampTops: number[] = [], rampSides: number[] = [], SS = S * S;
  const rampAO = rp ? (k: number) => { const c = k % SS; return rp.paved[c] === 1 && (k - c) / SS === rp.ground[c]; } : undefined;
  const dims = [N, N, sz - 2];
  // the tallest column in each row and each column of the slab: slices are scanned only up to it
  const ST = [1, sx, sx * sy], colTop = new Uint16Array(S * S);
  for (let c = 0; c < S * S; c++) { let z = sz - 1; while (z > 0 && vol[c + sx * sy * z] === 0) z--; colTop[c] = z; }
  const topX = new Uint16Array(S), topY = new Uint16Array(S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const t = colTop[x + S * y]; if (t > topX[x]) topX[x] = t; if (t > topY[y]) topY[y] = t; }
  const cell = (X: number, Y: number, z: number) => vol[(X + 1) + sx * ((Y + 1) + sy * (z + 1))];
  const roofs = roofPal ? roofPlanes(N, vol, colTop, roofPal, bidAt, planes) : null;
  const ch = roofPal ? chamferWalls(N, vol, sz, ground, colTop, roofPal, bidAt) : null;
  // pitched roofs as slopes (roofs.ts): they hide the voxel faces they stand for
  const slopes = roofPal && planes ? slopeRoofs(N, vol, colTop, roofPal, bidAt, planes, ch?.hidden ?? new Uint8Array(S * S * sz)) : null;
  slopes?.hide();
  const hidden = ch?.hidden ?? (slopes ? slopes.hidden : undefined);
  // (1 m tiles) where each column's wall ends: under the run of roof voxels on top, else its top. Its walls' faces carry
  // it (WALL_TOP + metres above the ground, in vattr.w) so the facade draws no window that would run up past it: under
  // an eave, in a gable under its slope, a window row cut through by the roof read as a row of black slivers
  const wallTop = roofPal && s === 1 ? new Uint16Array(S * S) : null;
  if (wallTop) for (let c = 0; c < S * S; c++) {
    let z = colTop[c];
    while (z > 1) { const w = vol[c + sx * sy * z]; if (!(w < roofPal!.length && roofPal![w] & PAL_ROOF)) break; z--; }
    wallTop[c] = z; // the top face of the wall's highest voxel (the volume's z is shifted by one)
  }
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3, nu = dims[u], nv = dims[v];
    const mask = new Float64Array(nu * nv), top = new Uint8Array(nu * nv);
    const sd = ST[d], su = ST[u], sv = ST[v];
    for (const dir of [-1, 1]) {
      const normalIdx = d * 2 + (dir > 0 ? 1 : 0);
      for (let sl = 0; sl < dims[d]; sl++) {
        let any = false;
        // faces out through the tile's border are always emitted: the neighbour may not be loaded yet
        const border = d < 2 && ((dir < 0 && sl === 0) || (dir > 0 && sl === N - 1));
        const zt = d === 0 ? Math.max(topX[sl + 1], topX[sl + 1 + dir]) : d === 1 ? Math.max(topY[sl + 1], topY[sl + 1 + dir]) : nv;
        const jn = v === 2 ? Math.min(nv, zt) : nv, in_ = u === 2 ? Math.min(nu, zt) : nu;
        if (d === 2) mask.fill(0);
        else for (let j = 0; j < nv; j++) for (let i = j < jn ? in_ : 0; i < nu; i++) mask[i + j * nu] = 0;
        for (let j = 0; j < jn; j++) {
          if (d === 2 && topY[j + 1] <= sl) continue;
          for (let i = 0; i < in_; i++) {
            const idx = (sl + 1) * sd + (i + 1) * su + (j + 1) * sv, a = vol[idx];
            let key = 0;
            if (a !== 0 && a !== SOLID_BELOW && a !== OCC) {
              const ni = idx + dir * sd, nb = vol[ni];
              const thru = see !== null && nb !== 0 && nb < see.length && see[nb] === 1 && a < see.length && see[a] === 2;
              if ((nb === 0 || thru || (border && nb !== SOLID_BELOW && nb !== OCC)) && !(hidden && hidden[idx] & (1 << normalIdx))
                && !(cover && coveredFace(cover, idx, ni))) {
                const px = d === 0 ? sl : u === 0 ? i : j, py = d === 1 ? sl : u === 1 ? i : j;
                const gm = ground[(px + 1) + S * (py + 1)];
                const pz = d === 2 ? sl : d === 0 ? j : i;
                let aoSkip: ((k: number) => boolean) | undefined;
                if (rp) {
                  const c = (px + 1) + S * (py + 1);
                  // (rp.ground: a bridge deck's top where it is one, ramps.ts)
                  if (rp.paved[c] && pz === rp.ground[c] - 1) {
                    if (d === 2) {
                      if (ramped(rp, c)) { rampTops.push(c, a, bidAt(px, py)); mask[i + j * nu] = 0; continue; }
                      aoSkip = rampAO;
                    } else {
                      const nc = c + (d === 0 ? dir : dir * S), [p1, p2] = edgePoints(S, c, d, dir);
                      if (rp.paved[nc] && (rp.h[p1] !== PINNED || rp.h[p2] !== PINNED)) {
                        rampSides.push(c, nc, d, dir, border ? 1 : 0, a, bidAt(px, py));
                        mask[i + j * nu] = 0;
                        continue;
                      }
                    }
                  }
                }
                const rc = roofs && nb === 0 && roofPal![a] & PAL_ROOF ? roofs.code(px, py, pz, d, dir) : 0;
                const ang = rc ? 24 + rc : d < 2 && nb === 0 ? wallAngle(N, px, py, pz, d, dir, cell) : 0;
                const aob = thru ? faceAO(vol, ni, su, sv, -1, null, seeLeaf) : nb === 0 ? faceAO(vol, ni, su, sv, rc ? -1 : ang ? d : -1, rc ? roofPal : null, aoSkip) : 255;
                // < 2^53: ang < 25 (a wall's direction) or 25 + a roof's plane < 2009, palette < 4096, ids < 16384
                key = (((ang * 4096 + a) * 256 + aob) * 256 + gm) * 16384 + bidAt(px, py) + 1;
                top[i + j * nu] = thru ? THRU : nb !== 0 ? INNER : wallTop && d < 2 && !rc && !(roofPal![a] & PAL_ROOF) ? wallTopCode(wallTop[(px + 1) + S * (py + 1)] - gm) : 0;
                any = true;
              }
            }
            mask[i + j * nu] = key;
          }
        }
        if (any) emitMerged(mask, top, nu, nv, d, u, v, dir, normalIdx, sl, s, x0, y0, out);
      }
    }
  }
  if (rp) emitRamps(rp, rampTops, rampSides, vol, x0, y0, out, rampAO!, (c) => bidAt((c % S) - 1, Math.floor(c / S) - 1));
  if (feet) emitFeet(feet, vol, x0, y0, out);
  out.axisEnd = out.count; // (what follows faces off the axes)
  if (ch) for (const p of ch.prisms) emitPrism(p, s, x0, y0, out, roofPal!, roofs, slopes, rp);
  // (at s > 1 the slopes come out in cells: scaled to metres here, heights in 1/64 of a cell to 1/64 m)
  slopes?.emit(s === 1 ? out : { reserve: (n) => out.reserve(n), vertexQ: (x, q, z, n, ao, g, w, pal, b) => out.vertexQ(x * s + x0, q * s, z * s + y0, n, ao, g, w, pal, b) },
    s === 1 ? x0 : 0, s === 1 ? y0 : 0, ground, s === 1);
}

// the grid points (ramps.ts RampField.h) at the ends of column c's edge facing along axis d (0 x, 1 y), dir
function edgePoints(S: number, c: number, d: number, dir: number) {
  const V = S + 1, X = c % S, Y = (c - X) / S;
  return d === 0 ? [X + (dir > 0 ? 1 : 0) + V * Y, X + (dir > 0 ? 1 : 0) + V * (Y + 1)] : [X + V * (Y + (dir > 0 ? 1 : 0)), X + 1 + V * (Y + (dir > 0 ? 1 : 0))];
}

// the lowest of a ramp's free points (ramps.ts) over grid points x0..x1, y0..y1 (cells) if within a metre under q
// (1/64 m), else null: how far something standing there at q has to reach down to meet it
function rampBelow(rp: RampField, x0: number, y0: number, x1: number, y1: number, q: number) {
  const V = rp.S + 1;
  let m = q;
  for (let y = Math.max(0, y0 + 1); y <= Math.min(rp.S, y1 + 1); y++) for (let x = Math.max(0, x0 + 1); x <= Math.min(rp.S, x1 + 1); x++) {
    const h = rp.h[x + V * y];
    if (h !== PINNED && h < m && h >= q - 64) m = h;
  }
  return m < q ? m : null;
}

// A foliage tile over ramps (feet: its base tile's, ramps.ts): what stands on a ramp's column (a trunk) has its sides
// go down to the ramp where it falls below the voxel's foot
function emitFeet(feet: RampField, vol: Uint16Array, x0: number, y0: number, out: QuadBuffer) {
  const { S, ground } = feet, SS = S * S;
  for (let Y = 1; Y < S - 1; Y++) for (let X = 1; X < S - 1; X++) {
    const c = X + S * Y, g = ground[c], v = vol[c + SS * (g + 1)];
    if (v === 0 || v === OCC || v === SOLID_BELOW || !ramped(feet, c)) continue;
    const q = [0, 1, 2, 3].map((k) => Math.min(cornerQ(feet, c, k), g * 64)), x = X - 1, y = Y - 1, top = g * 64;
    // sides -x, +x, -y, +y (emitMerged's corners, as emitRamps' fills), its ends' corners (0 .. 3 as cornerQ's)
    for (const [d, dir, k1, k2] of [[0, -1, 0, 3], [0, 1, 1, 2], [1, -1, 0, 1], [1, 1, 3, 2]]) {
      if (q[k1] >= top && q[k2] >= top) continue;
      const xa = d === 0 ? x + (dir > 0 ? 1 : 0) : x, ya = d === 1 ? y + (dir > 0 ? 1 : 0) : y;
      const P = d === 0 ? [[xa, ya, q[k1]], [xa, ya + 1, q[k2]], [xa, ya + 1, top], [xa, ya, top]] : [[xa, ya, q[k1]], [xa, ya, top], [xa + 1, ya, top], [xa + 1, ya, q[k2]]];
      out.reserve(4);
      for (const i of QUAD_ORDER[dir > 0 ? 1 : 0]) out.vertexQ(P[i][0] + x0, P[i][2], P[i][1] + y0, d * 2 + (dir > 0 ? 1 : 0), 3, g, 0, v, 0);
    }
  }
}

// The ramps' faces (meshFaces): each in the axis groups (byFacing) as the voxel face it stands for -- a ramp's top as an
// up face (lit as flat ground: a street's slope is a few degrees, and in the shadow map it stays a top), a fill or a
// skirt as the side it replaces. Corners as emitMerged's, so the same winding (QUAD_ORDER).
function emitRamps(rp: RampField, tops: number[], sides: number[], vol: Uint16Array, x0: number, y0: number, out: QuadBuffer, skip: (k: number) => boolean,
  bidOf: (c: number) => number) {
  // (ground: the ramps' surface, a deck's top where it is one; under: the tile's ground, the faces' gm as the voxels')
  const { S, ground, under } = rp, SS = S * S, V = S + 1;
  const put = (P: number[][], d: number, dir: number, ord: number[], aos: number[], gm: number, pal: number, bid: number) => {
    out.reserve(4);
    for (const c of ord) out.vertexQ(P[c][0] + x0, P[c][2], P[c][1] + y0, d * 2 + (dir > 0 ? 1 : 0), aos[c], gm, 0, pal, bid);
  };
  // a ramp's tops that lie in one plane (a slope as even as its points' 1/8 m allow) and are not darkened merge into one
  // quad along x (or else along y): the same plane, split either way
  const nt = tops.length / 3, Q = new Int32Array(nt * 4), AO = new Uint8Array(nt), of = new Int32Array(SS).fill(-1), done = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    const c = tops[t * 3];
    of[c] = t;
    for (let k = 0; k < 4; k++) Q[t * 4 + k] = cornerQ(rp, c, k);
    AO[t] = faceAO(vol, c + SS * (ground[c] + 1), 1, S, -1, null, skip);
  }
  const like = (t: number, u: number) => u >= 0 && !done[u] && AO[u] === 255 && tops[u * 3 + 1] === tops[t * 3 + 1] && tops[u * 3 + 2] === tops[t * 3 + 2]
    && ground[tops[u * 3]] === ground[tops[t * 3]] && under[tops[u * 3]] === under[tops[t * 3]];
  for (let t = 0; t < nt; t++) {
    if (done[t]) continue;
    const c = tops[t * 3], X = c % S, Y = (c - X) / S, x = X - 1, y = Y - 1, q = Q.slice(t * 4, t * 4 + 4), ao = AO[t];
    const dx = q[1] - q[0], dy = q[3] - q[0];
    let w = 1, h = 1;
    if (ao === 255 && q[2] - q[3] === dx) { // (planar)
      for (let u; X + w < S - 1 && like(t, u = of[c + w]) && Q[u * 4] === q[1] && Q[u * 4 + 3] === q[2] && Q[u * 4 + 1] - Q[u * 4] === dx && Q[u * 4 + 2] - Q[u * 4 + 3] === dx; w++) {
        done[u] = 1; q[1] += dx; q[2] += dx;
      }
      if (w === 1) for (let u; Y + h < S - 1 && like(t, u = of[c + h * S]) && Q[u * 4] === q[3] && Q[u * 4 + 1] === q[2] && Q[u * 4 + 3] - Q[u * 4] === dy && Q[u * 4 + 2] - Q[u * 4 + 1] === dy; h++) {
        done[u] = 1; q[3] += dy; q[2] += dy;
      }
    }
    done[t] = 1;
    const P = [[x, y, q[0]], [x + w, y, q[1]], [x + w, y + h, q[2]], [x, y + h, q[3]]];
    put(P, 2, 1, QUAD_ORDER[(rampDiagonal02(q[0], q[1], q[2], q[3]) ? 2 : 0) + 1], [ao & 3, (ao >> 2) & 3, (ao >> 4) & 3, (ao >> 6) & 3], under[c], tops[t * 3 + 1], tops[t * 3 + 2]);
  }
  const at = (p: number, c: number) => (rp.h[p] === PINNED ? ground[c] * 64 : rp.h[p]);
  for (let t = 0; t < sides.length; t += 7) {
    const [c, nc, d, dir, border, pal, bid] = sides.slice(t, t + 7), [p1, p2] = edgePoints(S, c, d, dir);
    // the top along the edge (p1 to p2: along y for d 0, along x for d 1), and the foot: the neighbour's top, or out
    // through the border from the voxel's foot (the faces below end there, 1/64 m sunk: INNER), up to the ramp a
    // 1/64 m down as there
    const t1 = at(p1, c) - border, t2 = at(p2, c) - border, b1 = border ? ground[c] * 64 - 65 : at(p1, nc), b2 = border ? ground[c] * 64 - 65 : at(p2, nc);
    if (t1 <= b1 && t2 <= b2) continue;
    const X = p1 % V - 1, Y = (p1 - (p1 % V)) / V - 1;
    // emitMerged's corners: d 0 (u y, v z): base, +y, +y +z, +z; d 1 (u z, v x): base, +z, +z +x, +x
    const P = d === 0 ? [[X, Y, b1], [X, Y + 1, b2], [X, Y + 1, t2], [X, Y, t1]] : [[X, Y, b1], [X, Y, t1], [X + 1, Y, t2], [X + 1, Y, b2]];
    put(P, d, dir, QUAD_ORDER[dir > 0 ? 1 : 0], [3, 3, 3, 3], under[c], pal, bid);
  }
  // under a wall (a free point beside it: ramps.ts) where the ramp falls below its voxel's top: the wall's face goes on
  // down to it, in the wall's colour and building, its foot's shade
  for (let t = 0; t < tops.length; t += 3) {
    const c = tops[t], g = ground[c] * 64;
    for (const [d, dir] of [[0, -1], [0, 1], [1, -1], [1, 1]]) {
      const n = c + (d === 0 ? dir : dir * S);
      if (rp.paved[n]) continue;
      const [p1, p2] = edgePoints(S, c, d, dir), b1 = Math.min(g, at(p1, c)), b2 = Math.min(g, at(p2, c));
      if (b1 >= g && b2 >= g) continue;
      const X = p1 % V - 1, Y = (p1 - (p1 % V)) / V - 1;
      const P = d === 0 ? [[X, Y, b1], [X, Y + 1, b2], [X, Y + 1, g], [X, Y, g]] : [[X, Y, b1], [X, Y, g], [X + 1, Y, g], [X + 1, Y, b2]];
      put(P, d, -dir, QUAD_ORDER[dir < 0 ? 1 : 0], [2, 2, 2, 2], under[n], vol[n + SS * ground[c]], bidOf(n));
    }
  }
}

// A chamfer (chamfer.ts): its slanted face, lit as the wall's plane (vattr.w = SLANT + its direction) and windowed along
// its staircase (vattr.x: face axis + 8 x the staircase's direction, as wallAngle's), a lid
// where nothing stands on it (the eave's top lit as its roof plane) and a floor where it hangs over nothing
function emitPrism(p: Prism, s: number, x0: number, y0: number, out: QuadBuffer, palFlags: Uint8Array, roofs: ReturnType<typeof roofPlanes> | null,
  slopes: ReturnType<typeof slopeRoofs>, rp: RampField | null) {
  const P = [p.px, p.py], A = [p.px - p.a * p.sx, p.py], B = [p.px, p.py - p.b * p.sy];
  const nx = -p.b * p.sx, ny = -p.a * p.sy; // outwards
  const axis = Math.abs(nx) >= Math.abs(ny) ? (nx > 0 ? 1 : 0) : ny > 0 ? 3 : 2;
  // corners counter-clockwise seen from outside
  const [L, R] = (B[1] - A[1]) * -nx + (B[0] - A[0]) * ny >= 0 ? [A, B] : [B, A];
  // where the roof's edge over this corner is filled (roofs.ts), its fascia goes on from where the prism stops
  const fill = slopes?.fillFloor(p.px, p.py, p.sx, p.sy);
  if (fill !== undefined && p.z0 * 64 >= fill) return;
  const capTop = p.capTop && fill === undefined;
  // an eave's prism under a sloped roof (roofs.ts) comes up to the slope, not to the top of its voxels (in 1/64 m)
  const top = (q: number[]) => {
    if (fill !== undefined) return Math.min(p.z1 * 64, fill);
    const h = p.roof && p.capTop && slopes ? slopes.heightAt(q[0], q[1]) : Infinity;
    return Number.isFinite(h) ? Math.min(p.z1 * 64, Math.max(p.z0 * 64 + 16, Math.round(h * 64))) : p.z1 * 64;
  };
  const tP = top(P), tL = top(L), tR = top(R);
  const v = (q: number[], z: number, nrm: number, ao: number, w: number) => out.vertexQ(q[0] * s + x0, z * s, q[1] * s + y0, nrm, ao, p.gm, w, p.pal, p.bid);
  const wall = (z0: number, zL: number, zR: number, ao: number) => {
    out.reserve(4);
    const n = axis + 8 * p.chain, w = SLANT + p.dir;
    v(L, z0, n, ao, w); v(R, z0, n, ao, w); v(R, zR, n, 3, w); v(L, zL, n, 3, w);
  };
  // standing on a ramp (ramps.ts) that falls below its foot: its face goes on down to it
  const foot = rp ? rampBelow(rp, Math.min(P[0], A[0], B[0]), Math.min(P[1], A[1], B[1]), Math.max(P[0], A[0], B[0]), Math.max(P[1], A[1], B[1]), p.z0 * 64) : null;
  if (foot !== null) wall(foot, p.z0 * 64, p.z0 * 64, p.aoBottom);
  if (p.aoBottom < 3 && p.z1 - p.z0 > 1 && Math.min(tL, tR) > (p.z0 + 1) * 64) { wall(p.z0 * 64, (p.z0 + 1) * 64, (p.z0 + 1) * 64, p.aoBottom); wall((p.z0 + 1) * 64, tL, tR, 3); }
  else wall(p.z0 * 64, tL, tR, p.aoBottom);
  const up = -p.a * p.b * p.sx * p.sy > 0; // P, A, B counter-clockwise from above
  if (capTop) {
    let nrm = 5, w = 0;
    if (roofs && palFlags[p.pal] & PAL_ROOF) {
      const rc = roofs.code(p.cx, p.cy, p.z1 - 1, 2, 1);
      if (rc) { nrm = 5 + 8 * ((rc - 1) >> 6); w = 1 + ((rc - 1) & 63); }
    }
    out.reserve(4);
    const [b, c] = up ? [A, B] : [B, A], tb = b === L ? tL : tR, tc = c === L ? tL : tR;
    v(P, tP, nrm, 3, w); v(b, tb, nrm, 3, w); v(c, tc, nrm, 3, w); v(c, tc, nrm, 3, w);
  }
  if (p.capBottom) {
    out.reserve(4);
    const [b, c] = up ? [B, A] : [A, B];
    v(P, p.z0 * 64, 4, 3, 0); v(b, p.z0 * 64, 4, 3, 0); v(c, p.z0 * 64, 4, 3, 0); v(c, p.z0 * 64, 4, 3, 0);
  }
}

// A wall at an angle to the grid is a staircase of x- and y-facing faces; it is lit as the plane it stands for. Its
// direction in plan comes from the occupied cells around it (24 steps of 15°; 0 = the face's own).
function wallAngle(N: number, px: number, py: number, cz: number, d: number, dir: number, cell: (x: number, y: number, z: number) => number) {
  let gx = 0, gy = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const Y = py + dy;
    if (Y < -1 || Y > N) continue;
    for (let dx = -2; dx <= 2; dx++) {
      const X = px + dx;
      if (X < -1 || X > N || (dx === 0 && dy === 0)) continue;
      const o = cell(X, Y, cz);
      if (o !== 0 && o !== OCC) { gx -= dx; gy -= dy; }
    }
  }
  const ax = d === 0 ? dir : 0, ay = d === 1 ? dir : 0;
  // a step of a staircase is short both ways along the wall; beside the corner of a straight wall there is a long run
  for (const sgn of [-1, 1]) {
    let k = 1;
    for (; k <= 4; k++) {
      const X = px + (d === 1 ? sgn * k : 0), Y = py + (d === 0 ? sgn * k : 0);
      if (X < -1 || X > N || Y < -1 || Y > N) break;
      const o = cell(X, Y, cz);
      if (o === 0 || o === OCC || cell(X + ax, Y + ay, cz) !== 0) break;
    }
    if (k > 4) return 0;
  }
  const gl = Math.hypot(gx, gy);
  return gl >= 3 && (gx * ax + gy * ay) / gl > 0.05 ? 1 + (Math.round(Math.atan2(gy, gx) / (Math.PI / 12)) + 24) % 24 : 0;
}

// A pitched roof at 1 m is a staircase of tops and risers, each lit by its own axis: grey and red roofs read as dark
// stripes. Its faces are lit as the plane instead, estimated from the roof's height field: central differences between
// columns of the same roof (roof material on top, the same building, within a riser's 4 m), smoothed over 3 x 3. A
// face's plane code: 1 + slope (2.5° steps, 10° to 75°) x 64 + downhill direction (64 steps); 0 where flat or no roof.
// Where the tile ships the plane itself (planes: LoD2's, or a fitted roof's, per column; scripts/voxelize.py) it is
// taken as it is: estimated from steps of whole metres a plane came out a mottle of light and dark voxels.
function roofPlanes(N: number, vol: Uint16Array, colTop: Uint16Array, roofPal: Uint8Array, bidAt: (x: number, y: number) => number,
  planes: Uint16Array | null) {
  const S = N + 2, SS = S * S;
  const H = new Int16Array(SS).fill(-1000), bid = new Int32Array(SS);
  for (let c = 0; c < SS; c++) {
    const v = vol[c + SS * colTop[c]];
    if (colTop[c] > 0 && v < roofPal.length && roofPal[v] & PAL_ROOF) H[c] = colTop[c] - 1;
    bid[c] = bidAt((c % S) - 1, Math.floor(c / S) - 1);
  }
  const same = (a: number, b: number) => H[b] > -1000 && bid[a] === bid[b] && Math.abs(H[a] - H[b]) <= 4;
  const rx = new Float32Array(SS), ry = new Float32Array(SS), ok = new Uint8Array(SS);
  // (the apron too, from what of it is there: a riser out of the tile is lit like its neighbours inside)
  const diff = (c: number, st: number, lo: boolean, hi: boolean) => {
    const a = lo && same(c, c - st), b = hi && same(c, c + st);
    return a && b ? (H[c + st] - H[c - st]) / 2 : a ? H[c] - H[c - st] : b ? H[c + st] - H[c] : 0;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const c = x + S * y;
    if (H[c] === -1000) continue;
    rx[c] = diff(c, 1, x > 0, x < S - 1); ry[c] = diff(c, S, y > 0, y < S - 1); ok[c] = 1;
  }
  const gx = new Float32Array(SS), gy = new Float32Array(SS);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const c = x + S * y;
    if (!ok[c]) continue;
    let sx = 0, sy = 0, n = 0;
    for (let dy = Math.max(-1, -y); dy <= Math.min(1, S - 1 - y); dy++) for (let dx = Math.max(-1, -x); dx <= Math.min(1, S - 1 - x); dx++) {
      const k = c + dx + S * dy;
      if (ok[k] && (k === c || same(c, k))) { sx += rx[k]; sy += ry[k]; n++; }
    }
    gx[c] = sx / n; gy[c] = sy / n;
  }
  const encode = (x: number, y: number) => {
    const g = Math.hypot(x, y), k = Math.min(30, Math.round(Math.atan(g) / (Math.PI / 72)));
    return k < 4 ? 0 : 1 + k * 64 + ((Math.round(Math.atan2(-y, -x) / (Math.PI / 32)) + 64) % 64);
  };
  // a shipped plane falling along (ox, oy): a step down on it faces that way
  const faces = (p: number, ox: number, oy: number) => {
    const a = ((p - 1) & 63) * (Math.PI / 32);
    return p > 0 && Math.cos(a) * ox + Math.sin(a) * oy > 0.05;
  };
  return {
    // the face of cell (px, py, pz) along axis d (2: up), outwards dir
    code(px: number, py: number, pz: number, d: number, dir: number) {
      const c = (px + 1) + S * (py + 1);
      if (!ok[c]) return 0;
      if (d === 2) return dir > 0 && pz === H[c] ? (planes && planes[c]) || encode(gx[c], gy[c]) : 0;
      // a riser: the step down to a lower column of the same roof, lit as the plane between the two
      const n = c + (d === 0 ? dir : dir * S);
      if (!ok[n] || !same(c, n) || H[n] >= pz) return 0;
      if (planes && (planes[c] || planes[n])) {
        // the plane the step is part of: the upper column's, or the lower one's (the step up from a valley's floor)
        const ox = d === 0 ? dir : 0, oy = d === 0 ? 0 : dir;
        if (faces(planes[c], ox, oy)) return planes[c];
        if (faces(planes[n], ox, oy)) return planes[n];
      }
      const x = (gx[c] + gx[n]) / 2, y = (gy[c] + gy[n]) / 2;
      // ... facing downhill; or a 1 m notch in it (a pit, a bump) either way
      if (H[c] - H[n] > 1 && -(d === 0 ? x : y) * dir < 0.3 * Math.hypot(x, y)) return 0;
      return encode(x, y);
    },
  };
}

// per-corner occlusion, 2 bits each; on a staircase wall (stairAxis >= 0) only what is above or below darkens it, on a
// roof's staircase (roofPal) only what isn't roof -- a chimney, a dormer's wall
// (skip: what doesn't count, a ramp's ground)
function faceAO(vol: Uint16Array, ni: number, su: number, sv: number, stairAxis: number, roofPal: Uint8Array | null, skip?: (k: number) => boolean) {
  const o = roofPal ? (k: number) => (vol[k] !== 0 && !(vol[k] < roofPal.length && roofPal[vol[k]] & PAL_ROOF) ? 1 : 0)
    : skip ? (k: number) => (vol[k] !== 0 && !skip(k) ? 1 : 0) : (k: number) => (vol[k] !== 0 ? 1 : 0);
  let s10 = o(ni - su), s12 = o(ni + su), s01 = o(ni - sv), s21 = o(ni + sv);
  let c00 = o(ni - su - sv), c20 = o(ni + su - sv), c22 = o(ni + su + sv), c02 = o(ni - su + sv);
  if (stairAxis === 0) { s10 = s12 = 0; c00 = c20 = c22 = c02 = 0; }
  else if (stairAxis === 1) { s01 = s21 = 0; c00 = c20 = c22 = c02 = 0; }
  const ao = (a1: number, a2: number, c: number) => (a1 && a2 ? 0 : 3 - (a1 + a2 + c));
  return ao(s10, s01, c00) | (ao(s12, s01, c20) << 2) | (ao(s12, s21, c22) << 4) | (ao(s10, s21, c02) << 6);
}

function emitMerged(mask: Float64Array, top: Uint8Array, nu: number, nv: number, d: number, u: number, v: number, dir: number, normalIdx: number,
  sl: number, s: number, x0: number, y0: number, out: QuadBuffer) {
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu;) {
      const key = mask[i + j * nu], wt = top[i + j * nu];
      if (!key) { i++; continue; }
      let w = 1;
      while (i + w < nu && mask[i + w + j * nu] === key && top[i + w + j * nu] === wt) w++;
      let h = 1;
      outer: while (j + h < nv) {
        for (let k = 0; k < w; k++) if (mask[i + k + (j + h) * nu] !== key || top[i + k + (j + h) * nu] !== wt) break outer;
        h++;
      }
      for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++) mask[i + ii + (j + jj) * nu] = 0;
      const k0 = key - 1, bid = k0 % 16384, k1 = Math.floor(k0 / 16384);
      const gm = k1 % 256, aoBits = Math.floor(k1 / 256) % 256, palIdx = Math.floor(k1 / 65536) % 4096, ang = Math.floor(k1 / (65536 * 4096));
      // vattr.x: face axis + 8 x (a wall's direction, or a roof plane's slope in 2.5° steps); vattr.w: 1 + the roof
      // plane's downhill direction in 64 steps, 0 for anything else
      const roof = ang > 24 ? ang - 25 : -1, nrm = normalIdx + 8 * (roof >= 0 ? roof >> 6 : ang), rw = roof >= 0 ? 1 + (roof & 63) : wt === INNER ? 0 : wt;
      const aos = aoBits === 255 ? [3, 3, 3, 3] : [aoBits & 3, (aoBits >> 2) & 3, (aoBits >> 4) & 3, (aoBits >> 6) & 3];
      const base = [0, 0, 0];
      base[d] = sl + (dir > 0 ? 1 : 0); base[u] = i; base[v] = j;
      const corners = [base, [...base], [...base], [...base]];
      corners[1][u] += w; corners[2][u] += w; corners[2][v] += h; corners[3][v] += h;
      out.reserve(4);
      const ord = QUAD_ORDER[(aos[0] + aos[2] < aos[1] + aos[3] ? 2 : 0) + (dir > 0 ? 1 : 0)];
      for (const c of ord) {
        const p = corners[c];
        // (a face into the solid of the next tile: its top edge 1/64 m down, under the tops it meets there)
        if (wt === INNER && d < 2 && p[2] === corners[2][2] && p[2] > corners[0][2]) out.vertex(p[0] * s + x0, p[2] * s - 1, p[1] * s + y0, nrm, aos[c] | (63 << 2), gm, rw, palIdx, bid);
        else out.vertex(p[0] * s + x0, p[2] * s, p[1] * s + y0, nrm, aos[c], gm, rw, palIdx, bid);
      }
      i += w;
    }
  }
}
