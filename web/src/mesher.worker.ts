// Fetches, unzips and greedy-meshes one tile (scripts/tiles.py), with baked ambient occlusion.
// Data coordinates: x east, y south, z up. Positions go out in three.js axes (x, z, y), metres.
// A tile is N x N cells of s metres plus a 1-cell apron. The distance levels (2, 4 and 8 m, scripts/tiles.py
// LOD_LEVELS) are meshed as level 1 is, in cells -- roof planes, chamfered walls, sloped roofs -- and scaled to metres
// on the way out.
import { chamferWalls, PAL_ROOF, PAL_WATER, SLANT, type ChamferMemo, type Prism, type Staircase } from './chamfer';
import { grow, meets, perSide, roofsChanged, SEC, sectionBox, sectionOf, sectionsMeeting, union, type Box } from './sections';
import { capField, capRamped, capSlot, cornerQ, diagonal02, edgeCorners, NONE, type CapField } from './core/surface';
import { slopeBase, slopeRoofs, wallTopCode, type SlopeBase, type SlopeParts } from './roofs';
import { decodeTile, type Columns, type Fields, type RawColumns } from './tile-data';
import { fetchGzip } from './fetch';

export interface MeshRequest {
  key: string;
  // the node's file (tiles/<key>.bin); or, in its place, its columns already decoded (cols: an edited node,
  // stream.ts replaceColumns; meshed as the same columns from the file are, no fields)
  url?: string;
  cols?: Columns | null;
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
  // an edited level-1 node meshed in sections (sections.ts, meshSections): only those an edit can have changed
  sections?: SectionJob | null;
}

// hot: the columns an edit changed (apron coordinates), null: every section; bids: the buildings whose roofs (columns'
// tops) it changed -- their slopes are fitted to the whole roof
// id: this job's (stream.ts: the edit job's key), from: the job whose sections the node shows (the worker's memo of the
// node is of that job: what changed since is found from it)
export interface SectionJob { hot: Box | null; bids?: number[]; id?: string; from?: string | null }
// the sections meshed (sections.ts numbering) and their meshes
export interface SectionMeshes { ids: number[]; meshes: MeshOut[] }

// what the base tile is meshed with (as for its own request), and which palette entries are leaves (not cover: they
// can be discarded, autumn and winter)
export interface BaseRemesh { roof: Uint8Array | null; leaf: Uint8Array }

// box: the vertices' bounds, min x y z then max (the geometry's bounding box, made here rather than on the main thread)
export interface MeshOut { pos: Int16Array; attr: Uint8Array; pal: Uint16Array; bld: Uint16Array | null; quads: number; faces: Uint32Array; normals: Float32Array; cuts: Uint32Array; box: Float32Array }

export type MeshReply =
  | ({ type: 'node'; key: string; dataOnly: boolean; data: Columns | null; base?: MeshOut; fields?: Fields | null; sec?: SectionMeshes; baseSec?: SectionMeshes } & MeshOut)
  | { type: 'error'; key: string; dataOnly: boolean; error: string };

const post = (msg: MeshReply, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: MeshReply, t: Transferable[]): void }).postMessage(msg, transfer);

// (runs, rooms and caps are decodeTile's own copies already)
const copyColumns = (c: Columns): Columns => ({ counts: c.counts.slice(), ground: c.ground.slice(), runs: c.runs, planes: c.planes?.slice() ?? null, bld: c.bld?.slice() ?? null, rooms: c.rooms ?? null, caps: c.caps ?? null });
const columnBuffers = (c: Columns) => [c.counts.buffer, c.ground.buffer, c.runs.buffer, ...(c.planes ? [c.planes.buffer] : []), ...(c.bld ? [c.bld.buffer] : []), ...(c.rooms ? [c.rooms.buffer] : []), ...(c.caps ? [c.caps.buffer] : [])];

// One request's meshes: the tile's own (out), a foliage tile's base tile meshed again (base), and the column data kept
// (keep; dataOnly: that alone, no mesh). load: a tile file, unzipped (tools/tris.mjs reads them from disk)
// (the buildings of the columns, bld, come with the tile: every level's own; a foliage tile has none)
export async function meshJob(m: MeshRequest, load: (url: string) => Promise<ArrayBuffer>) {
  const { counts, ground, runs, planes = null, bld = null, rooms = null, caps = null, fields = null } = m.cols ? { ...m.cols, fields: null } : decodeTile(await load(m.url!), m.N);
  const keep = m.keep || m.dataOnly ? copyColumns({ counts, ground, runs, planes, bld, rooms, caps }) : null;
  if (m.dataOnly) return { keep, out: null, base: undefined, fields: null };
  const under = typeof m.under === 'string' ? decodeTile(await load(m.under), m.N) : m.under ?? null;
  if (m.sections && m.s === 1) {
    const ucols = m.base && under && 'ground' in under ? under as Columns : null;
    const node = m.key.split('!')[0];
    const sec = meshSections(m.N, m.x0, m.y0, { counts, ground, runs, caps }, m.roof ? bld : null, under, m.roof, planes, m.see ?? null, m.sections,
      ucols && m.base ? { feet: true } : null, m.roof ? node : null);
    const baseSec = ucols && m.base ? meshSections(m.N, m.x0, m.y0, ucols, ucols.bld ?? null, null, m.base.roof, ucols.planes ?? null, null, m.sections,
      { fol: { counts, runs }, leaf: m.base.leaf }, `${node} cover`) : undefined;
    return { keep, out: emptyMesh(), base: undefined, fields, sec, baseSec };
  }
  // (a foliage tile: its trunks reach down to the base's caps)
  const feet = m.base && m.s === 1 && under && 'ground' in under ? capField(m.N, under as Columns, offsetsOf(under.counts, (m.N + 2) ** 2)) : null;
  const out = meshTile(m.N, m.s, m.x0, m.y0, { counts, ground, runs, caps }, m.roof ? bld : null, under, m.roof, planes, null, feet?.any ? feet : null, m.see ?? null);
  const base = m.base && under && 'ground' in under
    ? meshTile(m.N, m.s, m.x0, m.y0, under as Columns, (under as Columns).bld ?? null, null, m.base.roof, (under as Columns).planes ?? null, coverOf(m.N, { counts, runs }, m.base.leaf)) : undefined;
  return { keep, out, base, fields, sec: undefined, baseSec: undefined };
}

const emptyMesh = (): MeshOut => ({ pos: new Int16Array(), attr: new Uint8Array(), pal: new Uint16Array(), bld: null, quads: 0, faces: new Uint32Array(GROUPS + 1), normals: new Float32Array(GROUPS * 6), cuts: new Uint32Array(8), box: new Float32Array(6) });
const meshBuffers = (o: MeshOut) => [o.pos.buffer, o.attr.buffer, o.pal.buffer, o.faces.buffer, o.normals.buffer, o.cuts.buffer, ...(o.bld ? [o.bld.buffer] : [])];

self.onmessage = async (e: MessageEvent<MeshRequest>) => {
  const m = e.data;
  try {
    const { keep, out, base, fields, sec, baseSec } = await meshJob(m, fetchGzip);
    if (!out) {
      post({ type: 'node', key: m.key, dataOnly: true, data: keep, ...emptyMesh() }, columnBuffers(keep!));
      return;
    }
    const transfer: Transferable[] = [];
    for (const o of [out, ...(base ? [base] : []), ...(sec?.meshes ?? []), ...(baseSec?.meshes ?? [])]) transfer.push(...meshBuffers(o));
    if (keep) transfer.push(...columnBuffers(keep));
    if (fields) transfer.push(fields.cell.buffer, fields.spill.buffer);
    post({ type: 'node', key: m.key, dataOnly: false, data: keep, ...out, base, fields, sec, baseSec }, transfer);
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
  roofPal: Uint8Array | null, planes: Uint16Array | null, cover: Uint8Array | null = null, feet: CapField | null = null,
  see: Uint8Array | null = null): MeshOut {
  const out = new QuadBuffer();
  meshInto(N, s, x0, y0, cols, bldIds, under, roofPal, planes, cover, feet, see, out, null);
  return byFacing(out, !!bldIds, N, s, x0, y0);
}

// Meshing sections of a node (meshSections): the buffer of each section meshed (null: not meshed), and the boxes
// (apron coordinates) each analysis runs in -- emit: the sections meshed; rv: the volume filled; rch: chamfers' steps
// looked for; rs: slopes; rl: roof planes and wall tops; hot, rel: chamfer.ts ChamferWindow. check: the
// staircases found (chamfer.ts), whether they let the meshing go on (else it is begun again, meshSections)
interface Win {
  N: number;
  outs: (QuadBuffer | null)[];
  emit: Box; rv: Box; rch: Box; rs: Box; rl: Box;
  hot: Box | null; rel: Box[];
  check(comps: Staircase[], changed: { X: number; Y: number }[]): boolean;
  // the roofs' regions (null: none), the steps kept (chamfer.ts ChamferMemo); found: the steps of this meshing
  slopes: SlopeBase | null; steps: ChamferMemo | null; found: ChamferMemo['steps'] | null;
  // the eaves' steps found (roofs.ts), likewise
  checkSteps(steps: { X: number; Y: number }[]): boolean;
}
// the buffer of node cell (x, y)'s section, null if it is not meshed
const outAt = (w: Win, x: number, y: number) => w.outs[sectionOf(w.N, x, y)];
// the end (exclusive) of cell i's section along an axis of n cells
const secEnd = (i: number, n: number) => Math.min(n, (Math.floor(i / SEC) + 1) * SEC);

// meshTile's work, into out -- or (win) into the sections' buffers; false: to be begun again (win.check)
function meshInto(N: number, s: number, x0: number, y0: number, cols: Columns, bldIds: Uint16Array | null, under: RawColumns | null,
  roofPal: Uint8Array | null, planes: Uint16Array | null, cover: Uint8Array | null, feet: CapField | null,
  see: Uint8Array | null, out: QuadBuffer, win: Win | null): boolean {
  const S = N + 2, SS = S * S, { ground } = cols;
  const off = offsetsOf(cols.counts, SS), uoff = under && offsetsOf(under.counts, SS);
  const zmax = Math.max(topOf(cols, off, SS), under && uoff ? topOf(under, uoff, SS) : 0);
  const sz = zmax + 2, vol = new Uint16Array(SS * sz);
  const rv = win ? win.rv : { x0: 0, y0: 0, x1: S, y1: S };
  const fill = (c: RawColumns, o: Uint32Array, value: (v: number) => number) => {
    for (let Y = rv.y0; Y < rv.y1; Y++) for (let i = rv.x0 + S * Y, ie = rv.x1 + S * Y; i < ie; i++) for (let k = o[i], e = o[i] + c.counts[i]; k < e; k++) {
      const z0 = c.runs[k * 3], len = c.runs[k * 3 + 1], v = value(c.runs[k * 3 + 2]);
      for (let z = z0; z < z0 + len; z++) vol[i + SS * (z + 1)] = v;
    }
  };
  if (under && uoff) fill(under, uoff, () => OCC);
  for (let i = 0; i < SS; i++) vol[i] = SOLID_BELOW; // z = -1 is solid, so the slab's bottom is never meshed
  fill(cols, off, (v) => v);
  const bidAt = (x: number, y: number) => (bldIds ? bldIds[(y + 1) * S + x + 1] : 0);
  if (cover && cover.length < vol.length) { const c = new Uint8Array(vol.length); c.set(cover); cover = c; }
  // (1 m tiles) the ground's caps (core/surface.ts: the node's caps section, live in these columns): sloped ground and
  // decks; none: its voxels' tops
  const caps = roofPal && s === 1 ? capField(N, cols, off) : null;
  return meshFaces(N, s, x0, y0, vol, sz, ground, bidAt, roofPal, planes, out, cover, caps?.any ? caps : null, feet, see,
    columnSpans(SS, cols, off, under, uoff, see, win ? rv : null), win);
}

// Sections of a level-1 node (sections.ts) meshed, each as meshTile meshes the node but only the faces, caps, prisms
// and slopes of its own columns (greedy merges stop at its edges), so that together they are the node's mesh: those an
// edit (job.hot) can have changed, or all. Each analysis runs in a box round the sections meshed (meshInto's boxes) in
// the node's own coordinates, and comes out there as for the whole node. A column's faces depend on what lies within
// INFLUENCE columns of it, apart from
// - a building's slopes (roofs.ts), fitted to its whole roof: the roofs' regions and corners are made from the whole
//   node's columns' tops (slopeBase), and an edit that changed a building's roof meshes again every section within
//   ROOF_REACH of it;
// - a filled step of an eave (roofs.ts eaveSteps): it depends on the steps next to it, and on what lies under it (an
//   edit there meshes its sections again);
// - a staircase's chamfers (chamfer.ts): each step on the staircase's others, which may reach far: an edit meshes again
//   the sections of every staircase it can have changed, and where one reaches beyond the box looked in, the box
//   grows. A node's steps are kept between its jobs (memo): only those near the edit are looked for again.
// What meshing asks for more is found as it goes, and it begins again with it. extra: a foliage tile's caps under its
// trunks (feet; under is the base), or a base's cover (fol: its foliage tile's columns,
// leaf: leafPal). memo: where this worker keeps the node's state for its next job (job.id, job.from).
const INFLUENCE = 6, ROOF_REACH = 26;
// a node's state between its sectioned jobs in this worker (stream.ts sends a node's edits to one worker): the columns
// of job id, its steps (chamfer.ts) and its roofs' regions (roofs.ts slopeBase)
interface SectionMemo { id: string; cols: RawColumns; steps: ChamferMemo['steps'] | null; slopes: SlopeBase | null }
const memos = new Map<string, SectionMemo>();
// (per job and pass, for tools/section-check.mjs: passes, and the parts of the node read: the volume, chamfers, slopes;
// jobs that found their node's memo)
export const sectionStats = { jobs: 0, passes: 0, read: 0, rch: 0, rs: 0, memo: 0 };
export function meshSections(N: number, x0: number, y0: number, cols: Columns, bldIds: Uint16Array | null, under: RawColumns | Columns | null,
  roofPal: Uint8Array | null, planes: Uint16Array | null, see: Uint8Array | null, job: SectionJob,
  extra: { feet?: boolean; fol?: RawColumns; leaf?: Uint8Array } | null = null, memo: string | null = null): SectionMeshes {
  const S = N + 2, SS = S * S, per = perSide(N), all: Box = { x0: 0, y0: 0, x1: S, y1: S };
  const bidAt = (x: number, y: number) => (bldIds ? bldIds[(y + 1) * S + x + 1] : 0);
  const was = memo !== null && job.from ? memos.get(memo) : undefined, kept = was && was.id === job.from ? was : null;
  let hot = job.hot, bids = job.bids ?? [];
  if (kept && hot) {
    // (what changed since the memo's columns, rather than what the job says: all of it)
    hot = changedBox(S, kept.cols, cols);
    if (!hot) { kept.id = job.id ?? ''; return { ids: [], meshes: [] }; }
    bids = roofsChanged(N, kept.cols, cols, bldIds, hot);
  }
  // the roofs' regions, from the whole node's tops (the memo's while no roof changed)
  let slopeB: SlopeBase | null = null;
  if (roofPal && planes) {
    if (kept && !bids.length) slopeB = kept.slopes;
    else {
      const T = new Uint16Array(SS), top = new Uint16Array(SS);
      for (let c = 0, k = 0; c < SS; c++) {
        const e = k + cols.counts[c] * 3;
        for (let q = e - 3; q >= k; q -= 3) if (cols.runs[q + 1] && cols.runs[q + 2]) { T[c] = cols.runs[q] + cols.runs[q + 1]; top[c] = cols.runs[q + 2]; break; }
        k = e;
      }
      slopeB = slopeBase(N, T, (c) => top[c], roofPal, bidAt, planes);
    }
  }
  const want = new Set<number>();
  if (!hot) for (let k = 0; k < per * per; k++) want.add(k);
  else {
    for (const k of sectionsMeeting(N, grow(hot, INFLUENCE, S))) want.add(k);
    // (a roof changed: its regions' corners, and the steps of the eaves next to them -- with the memo's regions, only
    // the cells whose slope changed: within 8 of one, or, where a cell's region came or went, within ROOF_REACH)
    const cell = (c: number, m: number) => grow({ x0: c % S, y0: Math.floor(c / S), x1: c % S + 1, y1: Math.floor(c / S) + 1 }, m, S);
    if (bldIds && roofPal && planes && bids.length) for (let c = 0; c < SS; c++) {
      const m = kept ? slopeChange(kept.slopes, slopeB, c, S) : bids.includes(bldIds[c]) ? ROOF_REACH : 0;
      if (m) for (const k of sectionsMeeting(N, cell(c, m))) want.add(k);
    }
  }
  // (the steps kept near the edit, whose prisms read round them: their sections at once, not after a first pass)
  if (hot && kept?.steps) {
    const h = grow(hot, 10, S);
    for (const zs of kept.steps) for (const t of zs) if (t.X + 1 >= h.x0 && t.X + 1 < h.x1 && t.Y + 1 >= h.y0 && t.Y + 1 < h.y1) for (const k of sectionsMeeting(N, { x0: t.X - 6, y0: t.Y - 6, x1: t.X + 9, y1: t.Y + 9 })) want.add(k);
  }
  const hotNear = hot ? grow(hot, 7, S) : null;
  const redo = kept?.steps && hot ? grow(hot, 8, S) : null;
  let rch: Box | null = null;
  // (a box within another, or reaching the node's apron where it does not)
  const within = (a: Box, b: Box) => (a.x0 >= b.x0 || b.x0 <= 1) && (a.y0 >= b.y0 || b.y0 <= 1) && (a.x1 <= b.x1 || b.x1 >= S - 1) && (a.y1 <= b.y1 || b.y1 >= S - 1);
  const add = (b: Box) => { let more = false; for (const k of sectionsMeeting(N, b)) if (!want.has(k)) { want.add(k); more = true; } return more; };
  sectionStats.jobs++;
  if (kept) sectionStats.memo++;
  for (let pass = 0; ; pass++) {
    sectionStats.passes++;
    // (all of it read, at last)
    const full = !hot || pass >= 6;
    if (full) for (let k = 0; k < per * per; k++) want.add(k);
    const ids = [...want].sort((a, b) => a - b), rel = ids.map((k) => sectionBox(N, k));
    const emit = rel.reduce<Box | null>((a, b) => union(a, b), null)!;
    // (slopes: the eaves' steps within 7 and those next to them, within 12 more; roof planes and wall tops within 12;
    // chamfers: the steps within 7, every step next to them within 12 more, read within 8 -- or all of them, the memo's
    // and those near the edit; caps: the node's, per column)
    let rs = grow(emit, 20, S), rl = grow(emit, 12, S);
    rch = redo ? all : union(rch, grow(emit, 20, S));
    let rv = union(grow(emit, 16, S), redo ? grow(hot!, 16, S) : grow(rch, 8, S));
    if (full) { rch = rs = rv = rl = all; }
    const outs: (QuadBuffer | null)[] = Array.from({ length: per * per }, (_, k) => (want.has(k) ? new QuadBuffer() : null));
    const r = rch;
    const win: Win = { N, outs, emit, rv, rch: r, rs, rl, hot, rel, slopes: slopeB, steps: redo ? { steps: kept!.steps!, redo } : null, found: null,
      check(comps, changed) {
        if (full) return true;
        let ok = true;
        // (the steps kept: those whose prisms can have changed -- a prism, and the faces it hides, within 7 of its step)
        for (const t of changed) if (add({ x0: t.X - 6, y0: t.Y - 6, x1: t.X + 9, y1: t.Y + 9 })) ok = false;
        for (const c of comps) {
          if (c.hot && add(grow(c.box, 7, S))) ok = false;
          // (every step of it is found as for the whole node, and so is every step next to one of them)
          if (!within(grow(c.box, 12, S), r)) { rch = union(rch, grow(c.box, 13, S)); ok = false; }
        }
        return ok;
      },
      checkSteps(steps) {
        if (full || !hotNear) return true;
        let ok = true;
        // a step an edit can have changed (its triangle within 7 of its inner corner): its sections meshed again
        for (const f of steps) if (meets({ x0: f.X, y0: f.Y, x1: f.X + 1, y1: f.Y + 1 }, hotNear) && add(grow({ x0: f.X, y0: f.Y, x1: f.X + 1, y1: f.Y + 1 }, 7, S))) ok = false;
        return ok;
      } };
    const ucols = under && 'ground' in under ? under : null;
    const feet = extra?.feet && ucols ? capField(N, ucols, offsetsOf(ucols.counts, SS)) : null;
    const cover = extra?.fol && extra.leaf ? coverOf(N, extra.fol, extra.leaf, rv) : null;
    sectionStats.read += ((rv.x1 - rv.x0) * (rv.y1 - rv.y0)) / SS; sectionStats.rch += ((r.x1 - r.x0) * (r.y1 - r.y0)) / SS; sectionStats.rs += ((rs.x1 - rs.x0) * (rs.y1 - rs.y0)) / SS;
    if (!meshInto(N, 1, x0, y0, cols, bldIds, under, roofPal, planes, cover, feet?.any ? feet : null, see, new QuadBuffer(), win)) continue;
    if (memo !== null && job.id) {
      // (the steps of the whole node: all looked for, or the memo's and those near the edit)
      const steps = roofPal && (full || redo) ? win.found ?? [] : null;
      memos.delete(memo);
      memos.set(memo, { id: job.id, cols: { counts: cols.counts, runs: cols.runs }, steps, slopes: slopeB });
      for (const k of memos.keys()) if (memos.size > 8) memos.delete(k);
    }
    return { ids, meshes: ids.map((k) => byFacing(outs[k]!, !!bldIds, N, 1, x0, y0)) };
  }
}

// How far round column c a change of the roofs' regions (roofs.ts slopeBase, a before b) reaches: 0 none; 8 its
// slope (its corners, their light, its region's plane, which of its neighbours share its region: a merged top); a
// cell that came into a region or left one, ROOF_REACH (the steps of the eaves round it, and those next to them)
function slopeChange(a: SlopeBase | null, b: SlopeBase | null, c: number, S: number) {
  const ra = a ? a.reg[c] : -1, rb = b ? b.reg[c] : -1;
  if ((ra >= 0) !== (rb >= 0)) return ROOF_REACH;
  if (ra < 0) return 0;
  const A = a!, B = b!, p = A.regions[ra], q = B.regions[rb];
  if (p.code !== q.code || p.lit !== q.lit || p.flat !== q.flat || p.bid !== q.bid || A.seam.bent(p, c) !== B.seam.bent(q, c)) return 8;
  for (let k = 0; k < 4; k++) if (A.hq[c * 4 + k] !== B.hq[c * 4 + k] || A.pure[c * 4 + k] !== B.pure[c * 4 + k] || A.nq[c * 4 + k] !== B.nq[c * 4 + k]) return 8;
  // (a merged top: its plane at its corners, and whether the cells beside it are of its region)
  if (p.e0 !== q.e0 || p.gxq !== q.gxq || p.gyq !== q.gyq) return 8;
  for (const n of [c - 1, c + 1, c - S, c + S]) if (n >= 0 && n < S * S && (A.reg[n] === ra) !== (B.reg[n] === rb)) return 8;
  return 0;
}

// the box of the columns whose runs differ between a and b (null: none)
function changedBox(S: number, a: RawColumns, b: RawColumns): Box | null {
  let box: Box | null = null;
  for (let c = 0, ka = 0, kb = 0; c < S * S; c++) {
    const na = a.counts[c] * 3, nb = b.counts[c] * 3;
    let same = na === nb;
    for (let i = 0; same && i < na; i++) same = a.runs[ka + i] === b.runs[kb + i];
    if (!same) { const X = c % S, Y = (c - X) / S; box = union(box, { x0: X, y0: Y, x1: X + 1, y1: Y + 1 }); }
    ka += na; kb += nb;
  }
  return box;
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
    for (let k = 0; k < 3; k++) {
      const n = g < 6 ? AXIS_N[g][k] : nrm[(q - axisQ) * 3 + k];
      lo[g * 3 + k] = Math.min(lo[g * 3 + k], n); hi[g * 3 + k] = Math.max(hi[g * 3 + k], n);
    }
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
    // (copied value by value: a subarray per quad cost more than the copy)
    for (let k = 0; k < 12; k++) pos[t * 12 + k] = P[q * 12 + k];
    for (let k = 0; k < 16; k++) attr[t * 16 + k] = A[q * 16 + k];
    for (let k = 0; k < 4; k++) pal[t * 4 + k] = out.pal[q * 4 + k];
    if (bld) for (let k = 0; k < 4; k++) bld[t * 4 + k] = out.bld[q * 4 + k];
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
// (box: its columns only)
function coverOf(N: number, fol: RawColumns, leaf: Uint8Array, box: Box | null = null) {
  const S = N + 2, SS = S * S, off = offsetsOf(fol.counts, SS), sz = topOf(fol, off, SS) + 2, cv = new Uint8Array(SS * sz);
  const b = box ?? { x0: 0, y0: 0, x1: S, y1: S };
  for (let Y = b.y0; Y < b.y1; Y++) for (let i = b.x0 + S * Y, ie = b.x1 + S * Y; i < ie; i++) for (let k = off[i], e = off[i] + fol.counts[i]; k < e; k++) {
    const z0 = fol.runs[k * 3], len = fol.runs[k * 3 + 1], v = fol.runs[k * 3 + 2];
    for (let z = z0; z < z0 + len; z++) cv[i + SS * (z + 1)] = v < leaf.length && leaf[v] ? 2 : 1;
  }
  return cv;
}

// a face of a base cell (vol index a) towards its empty neighbour (ni) that foliage hides for good: the cell is grass
// (its own face is there, unless leaves are in front of it, which may go), or the neighbour is grass or a trunk
const coveredFace = (cover: Uint8Array, a: number, ni: number) => (cover[ni] === 1 || (cover[a] === 1 && cover[ni] !== 2));

// Each column's top: the volume's z of its highest cell not empty (0: none); and how far up from the bottom it is solid
// without a gap and without leaves (which wood's faces see through), its bottom: no face is there towards such a cell,
// apart from out through the border (meshFaces' scan starts above). From the runs (each column's in order, z up; a
// foliage tile's over its base's, under, which they overwrite in the volume); null where a run is of nothing (palette
// 0, or no cells), which the volume would not show as the runs do: then meshFaces reads them off the volume
// (box: its columns only, the others' 0)
function columnSpans(SS: number, c: RawColumns, off: Uint32Array, under: RawColumns | null, uoff: Uint32Array | null, see: Uint8Array | null,
  box: Box | null = null) {
  const R = c.runs, U = under?.runs, top = new Uint16Array(SS), bot = new Uint16Array(SS), S = Math.round(Math.sqrt(SS));
  const b = box ?? { x0: 0, y0: 0, x1: S, y1: S };
  if (!box) {
    for (let k = 0, e = off[SS]; k < e; k++) if (R[k * 3 + 1] === 0 || R[k * 3 + 2] === 0) return null;
    if (U && uoff) for (let k = 0, e = uoff[SS]; k < e; k++) if (U[k * 3 + 1] === 0) return null;
  } else for (let Y = b.y0; Y < b.y1; Y++) for (let i = b.x0 + S * Y, ie = b.x1 + S * Y; i < ie; i++) {
    for (let k = off[i]; k < off[i + 1]; k++) if (R[k * 3 + 1] === 0 || R[k * 3 + 2] === 0) return null;
    if (U && uoff) for (let k = uoff[i]; k < uoff[i + 1]; k++) if (U[k * 3 + 1] === 0) return null;
  }
  for (let Y = b.y0; Y < b.y1; Y++) for (let i = b.x0 + S * Y, ie = b.x1 + S * Y; i < ie; i++) {
    let a = off[i], b = uoff ? uoff[i] : 0, z = 0;
    const ae = off[i + 1], be = uoff ? uoff[i + 1] : 0;
    top[i] = Math.max(ae > a ? R[(ae - 1) * 3] + R[(ae - 1) * 3 + 1] : 0, U && be > b ? U[(be - 1) * 3] + U[(be - 1) * 3 + 1] : 0);
    // (z: the first cell not known to be of the bottom; a run of the tile's own is what is there where it lies)
    for (;;) {
      while (a < ae && R[a * 3] + R[a * 3 + 1] <= z) a++;
      if (a < ae && R[a * 3] <= z) {
        const v = R[a * 3 + 2];
        if (see && v < see.length && see[v] === 1) break;
        z = R[a * 3] + R[a * 3 + 1];
        continue;
      }
      if (!U) break;
      while (b < be && U[b * 3] + U[b * 3 + 1] <= z) b++;
      if (b < be && U[b * 3] <= z) { z = Math.min(U[b * 3] + U[b * 3 + 1], a < ae ? R[a * 3] : Infinity); continue; }
      break;
    }
    bot[i] = z;
  }
  return { top, bot };
}

function meshFaces(N: number, s: number, x0: number, y0: number, vol: Uint16Array, sz: number, ground: Uint8Array,
  bidAt: (x: number, y: number) => number, roofPal: Uint8Array | null, planes: Uint16Array | null, out: QuadBuffer,
  cover: Uint8Array | null = null, rp: CapField | null = null, feet: CapField | null = null, see: Uint8Array | null = null,
  spans: { top: Uint16Array; bot: Uint16Array } | null = null, win: Win | null = null): boolean {
  const S = N + 2, sx = S, sy = S;
  // wood's faces towards leaves (see): drawn, their AO as if the leaves were not there (they are not, in winter)
  const seeLeaf = see ? (k: number) => vol[k] < see.length && see[vol[k]] === 1 : undefined;
  // Caps (core/surface.ts): the top of a capped run's voxel is drawn as the cap's quad (capTops: column, palette,
  // building, slot) and its sides by emitCaps against what is beside it. A cap's AO is that of its ground alone: a step
  // that became a slope casts none.
  const capTops: number[] = [], SS = S * S;
  const capAO = rp ? (k: number) => { const c = k % SS; return capSlot(rp, c, (k - c) / SS) >= 0; } : undefined;
  const dims = [N, N, sz - 2];
  const wetPal = s > 1 ? roofPal : null; // (a distance level's water, emitMerged)
  // each column's top and bottom (columnSpans), else off the volume (z by z: column by column each cell was a cache
  // line of its own)
  const ST = [1, sx, sx * sy], colTop = spans?.top ?? new Uint16Array(SS), colBot = spans?.bot ?? new Uint16Array(SS);
  if (!spans) {
    const solid = new Uint8Array(SS).fill(1);
    for (let z = 1; z < sz; z++) for (let c = 0, o = SS * z; c < SS; c++) {
      const w = vol[o + c];
      if (w !== 0) colTop[c] = z;
      if (solid[c]) { if (w !== 0 && !(see && w < see.length && see[w] === 1)) colBot[c] = z; else solid[c] = 0; }
    }
  }
  const cell = (X: number, Y: number, z: number) => vol[(X + 1) + sx * ((Y + 1) + sy * (z + 1))];
  const roofs = roofPal ? roofPlanes(N, vol, colTop, roofPal, bidAt, planes, win ? win.rl : null) : null;
  const ch = roofPal ? chamferWalls(N, vol, sz, ground, colTop, roofPal, bidAt, win ? { box: win.rch, hot: win.hot, rel: win.rel } : null, win?.steps ?? null) : null;
  if (win) win.found = ch?.steps ?? null;
  if (win && !win.check(ch?.comps ?? [], ch?.changed ?? [])) return false;
  // pitched roofs as slopes (roofs.ts): they hide the voxel faces they stand for
  const slopes = roofPal && planes && (!win || win.slopes) ? slopeRoofs(N, vol, colTop, roofPal, bidAt, planes, ch?.hidden ?? new Uint8Array(S * S * sz), win ? win.rs : null, win?.slopes ?? null) : null;
  if (win && slopes && !win.checkSteps(slopes.steps)) return false;
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
  // The faces of each slice go into a mask of merge keys (k1: palette, wall top code, wall or roof plane angle -- never
  // 0 where a face is, a's palette entry is not; k2: ground, AO, building), merged greedily (emitMerged), which leaves
  // the mask all 0 again: only the faces are written. Only the cells that can have a face are visited, row by row of
  // the mask (cells: their mask indices i + j nu, in that order): a cell above its column's top (colTop) is empty; one
  // whose neighbour is in the neighbour's solid bottom (colBot; a distance level's water: and the cell over the
  // neighbour too) has no face but out through the border. rlo / rhi: per row of the mask the first and last face in
  // it (rhi < rlo: none)
  let cells = new Int32Array(N * Math.max(N, sz));
  // (sections: the columns meshed, ex0 .. ex1 by ey0 .. ey1, those of a section meshed; node cells)
  const ex0 = win ? win.emit.x0 - 1 : 0, ex1 = win ? win.emit.x1 - 1 : N, ey0 = win ? win.emit.y0 - 1 : 0, ey1 = win ? win.emit.y1 - 1 : N;
  const skip = (x: number, y: number) => win !== null && outAt(win, x, y) === null;
  const rowN = new Int32Array(Math.max(N, sz) + 1), rowAt = new Int32Array(Math.max(N, sz) + 1);
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3, nu = dims[u], nv = dims[v];
    const k1s = new Uint32Array(nu * nv), k2s = new Uint32Array(nu * nv);
    const rlo = new Int32Array(nv).fill(nu), rhi = new Int32Array(nv).fill(-1);
    const sd = ST[d], su = ST[u], sv = ST[v];
    for (const dir of [-1, 1]) {
      const normalIdx = d * 2 + (dir > 0 ? 1 : 0);
      // (z faces: the cells of every slice at once, slice by slice, in each column by column: rows of the mask in turn)
      let zAt: Int32Array | null = null;
      if (d === 2) {
        const ns = dims[2], lo = (c: number) => (dir > 0 ? Math.max(0, colBot[c] - 1) : colBot[c] + 1);
        zAt = new Int32Array(ns + 2);
        for (let j = ey0; j < ey1; j++) for (let i = ex0; i < ex1; i++) {
          if (skip(i, j)) continue;
          const c = (i + 1) + S * (j + 1), b = lo(c), t = colTop[c];
          if (b < t) { zAt[b + 2]++; zAt[t + 2]--; }
        }
        for (let z = 3; z < ns + 2; z++) zAt[z] += zAt[z - 1]; // (each slice's count, at z + 2)
        for (let z = 2; z < ns + 2; z++) zAt[z] += zAt[z - 1]; // (where each slice starts, at z + 1)
        if (cells.length < zAt[ns + 1]) cells = new Int32Array(zAt[ns + 1]);
        for (let j = ey0; j < ey1; j++) for (let i = ex0; i < ex1; i++) {
          if (skip(i, j)) continue;
          const c = (i + 1) + S * (j + 1), t = colTop[c];
          for (let z = lo(c); z < t; z++) cells[zAt[z + 1]++] = i + j * nu;
        }
        // (now each slice's start at z, its end at z + 1)
      }
      for (let sl = d === 0 ? ex0 : d === 1 ? ey0 : 0, se = d === 0 ? ex1 : d === 1 ? ey1 : dims[d]; sl < se; sl++) {
        let j0 = nv, j1 = -1, k0 = 0, ke = 0;
        // faces out through the tile's border are always emitted: the neighbour may not be loaded yet
        const border = d < 2 && ((dir < 0 && sl === 0) || (dir > 0 && sl === N - 1));
        const wb = border ? -1 : wetPal ? 1 : 0;
        if (d === 2) { k0 = sl ? zAt![sl] : 0; ke = zAt![sl + 1]; }
        else if (d === 1) {
          // (y faces: rows j = x, in each the column's z range)
          for (let j = ex0; j < ex1; j++) {
            if (skip(j, sl)) continue;
            const c = (j + 1) + S * (sl + 1), ie = Math.min(nu, colTop[c]);
            for (let i = wb >= 0 ? Math.max(0, colBot[c + dir * S] - wb) : 0; i < ie; i++) cells[ke++] = i + j * nu;
          }
        } else {
          // (x faces: rows j = z, i = y; the columns' z ranges sorted into rows by counting)
          let jl = nv, jh = 0;
          for (let i = ey0; i < ey1; i++) {
            if (skip(sl, i)) continue;
            const c = (sl + 1) + S * (i + 1), t = colTop[c], b = wb < 0 ? 0 : Math.max(0, colBot[c + dir] - wb);
            if (b >= t) continue;
            for (let j = b; j < t; j++) rowN[j]++;
            if (b < jl) jl = b;
            if (t > jh) jh = t;
          }
          for (let j = jl; j < jh; j++) { rowAt[j] = ke; ke += rowN[j]; rowN[j] = 0; }
          for (let i = ey0; i < ey1; i++) {
            if (skip(sl, i)) continue;
            const c = (sl + 1) + S * (i + 1), t = colTop[c], b = wb < 0 ? 0 : Math.max(0, colBot[c + dir] - wb);
            for (let j = b; j < t; j++) cells[rowAt[j]++] = i + j * nu;
          }
        }
        for (let k = k0; k < ke; k++) {
          const m = cells[k], i = m % nu, j = (m - i) / nu;
          const idx = (sl + 1) * sd + (i + 1) * su + (j + 1) * sv, a = vol[idx];
          if (a === 0 || a === SOLID_BELOW || a === OCC) continue;
          const ni = idx + dir * sd, nb = vol[ni];
          const thru = see !== null && nb !== 0 && nb < see.length && see[nb] === 1 && a < see.length && see[a] === 2;
          // (a distance level: the river's top block, whose faces end at the river's surface under the block's
          // top, emitMerged, is open to the side of a bank beside it -- else a slot stood between the bank and the
          // water -- and to the side of water whose surface stands higher -- else a crack at the step)
          const wet = wetPal !== null && d < 2 && nb !== 0 && nb < wetPal.length && (wetPal[nb] & PAL_WATER) !== 0
            && vol[ni + sx * sy] === 0 && a < wetPal.length && (!(wetPal[a] & PAL_WATER) || ground[(idx % SS) + (d === 0 ? dir : dir * S)] < ground[idx % SS]);
          const free = nb === 0 || wet;
          if (!((free || thru || (border && nb !== SOLID_BELOW && nb !== OCC)) && !(hidden && hidden[idx] & (1 << normalIdx))
            && !(cover && coveredFace(cover, idx, ni)))) continue;
          const px = d === 0 ? sl : u === 0 ? i : j, py = d === 1 ? sl : u === 1 ? i : j;
          const gm = ground[(px + 1) + S * (py + 1)];
          const pz = d === 2 ? sl : d === 0 ? j : i;
          if (rp) {
            const c = (px + 1) + S * (py + 1);
            // (the cap of the run whose top voxel this is: a street's, a bridge deck's: the top as its quad, the voxel's
            // sides by emitCaps against what is beside it)
            if (capSlot(rp, c, pz + 1) >= 0 && (d < 2 || dir > 0)) {
              if (d === 2) capTops.push(c, a, bidAt(px, py), capSlot(rp, c, pz + 1));
              continue;
            }
          }
          const rc = roofs && free && roofPal![a] & PAL_ROOF ? roofs.code(px, py, pz, d, dir) : 0;
          const ang = rc ? 24 + rc : d < 2 && free ? wallAngle(N, px, py, pz, d, dir, cell) : 0;
          const aob = thru ? faceAO(vol, ni, su, sv, -1, null, seeLeaf) : free ? faceAO(vol, ni, su, sv, rc ? -1 : ang ? d : -1, rc ? roofPal : null) : 255;
          const top = thru ? THRU : !free ? INNER : wallTop && d < 2 && !rc && !(roofPal![a] & PAL_ROOF) ? wallTopCode(wallTop[(px + 1) + S * (py + 1)] - gm) : 0;
          // (a: palette < 4096; top < 128; ang < 25 (a wall's direction) or 25 + a roof's plane < 2009; the building's
          // 16-bit id)
          k1s[m] = a + top * 4096 + ang * 524288;
          k2s[m] = gm + aob * 256 + bidAt(px, py) * 65536;
          if (i < rlo[j]) rlo[j] = i;
          rhi[j] = i;
          if (j < j0) j0 = j;
          j1 = j;
        }
        if (j1 >= 0) emitMerged(k1s, k2s, rlo, rhi, j0, j1, nu, nv, d, dir, normalIdx, sl, s, x0, y0, out, roofPal, win);
      }
    }
  }
  // (a section's buffer by column, apron coordinates)
  const pick = win ? (c: number) => outAt(win, (c % S) - 1, Math.floor(c / S) - 1) : null;
  if (rp) emitCaps(rp, capTops, vol, x0, y0, out, capAO!, (c) => bidAt((c % S) - 1, Math.floor(c / S) - 1), pick);
  if (feet) emitFeet(feet, vol, x0, y0, out, pick);
  out.axisEnd = out.count; // (what follows faces off the axes)
  if (win) for (const o of win.outs) if (o) o.axisEnd = o.count;
  // (a section's prisms: those of the steps in its columns)
  if (ch) for (const p of ch.prisms) {
    const o = win ? outAt(win, p.px - (p.sx > 0 ? 1 : 0), p.py - (p.sy > 0 ? 1 : 0)) : out;
    if (o) emitPrism(p, s, x0, y0, o, roofPal!, roofs, slopes, rp);
  }
  const parts: SlopeParts | null = win ? { at: (X, Y) => outAt(win, X - 1, Y - 1), last: (V) => secEnd(V - 1, N) } : null;
  // (at s > 1 the slopes come out in cells: scaled to metres here, heights in 1/64 of a cell to 1/64 m)
  slopes?.emit(s === 1 ? out : { reserve: (n) => out.reserve(n), vertexQ: (x, q, z, n, ao, g, w, pal, b) => out.vertexQ(x * s + x0, q * s, z * s + y0, n, ao, g, w, pal, b) },
    s === 1 ? x0 : 0, s === 1 ? y0 : 0, ground, s === 1, parts);
  return true;
}

// the grid points ((S + 1)^2, as CapField.low) at the ends of column c's edge facing along axis d (0 x, 1 y), dir
function edgePoints(S: number, c: number, d: number, dir: number) {
  const V = S + 1, X = c % S, Y = (c - X) / S;
  return d === 0 ? [X + (dir > 0 ? 1 : 0) + V * Y, X + (dir > 0 ? 1 : 0) + V * (Y + 1)] : [X + V * (Y + (dir > 0 ? 1 : 0)), X + 1 + V * (Y + (dir > 0 ? 1 : 0))];
}

// the lowest corner of a cap off its run's top (CapField.low) over grid points x0..x1, y0..y1 (cells) if within a metre
// under q (1/64 m), else null: how far something standing there at q has to reach down to meet it
function capBelow(rp: CapField, x0: number, y0: number, x1: number, y1: number, q: number) {
  const V = rp.S + 1;
  let m = q;
  for (let y = Math.max(0, y0 + 1); y <= Math.min(rp.S, y1 + 1); y++) for (let x = Math.max(0, x0 + 1); x <= Math.min(rp.S, x1 + 1); x++) {
    const h = rp.low[x + V * y];
    if (h !== NONE && h < m && h >= q - 64) m = h;
  }
  return m < q ? m : null;
}

// A foliage tile over caps (feet: its base tile's, core/surface.ts): what stands on a capped column (a trunk) has its
// sides go down to the cap where it falls below the voxel's foot
function emitFeet(feet: CapField, vol: Uint16Array, x0: number, y0: number, sink: QuadBuffer, pick: ((c: number) => QuadBuffer | null) | null = null) {
  const { S } = feet, SS = S * S;
  for (let Y = 1; Y < S - 1; Y++) for (let X = 1; X < S - 1; X++) for (let sl = 0; sl < 2; sl++) {
    const c = X + S * Y, g = feet.z[2 * c + sl];
    if (!g || !capRamped(feet, c, sl)) continue;
    const v = vol[c + SS * (g + 1)], out = pick ? pick(c) : sink;
    if (!out) continue;
    if (v === 0 || v === OCC || v === SOLID_BELOW) continue;
    const q = [0, 1, 2, 3].map((k) => Math.min(cornerQ(feet, c, sl, k), g * 64)), x = X - 1, y = Y - 1, top = g * 64;
    // sides -x, +x, -y, +y (emitMerged's corners, as emitCaps' sides), its ends' corners (0 .. 3 as cornerQ's)
    for (const [d, dir, k1, k2] of [[0, -1, 0, 3], [0, 1, 1, 2], [1, -1, 0, 1], [1, 1, 3, 2]]) {
      if (q[k1] >= top && q[k2] >= top) continue;
      const xa = d === 0 ? x + (dir > 0 ? 1 : 0) : x, ya = d === 1 ? y + (dir > 0 ? 1 : 0) : y;
      const P = d === 0 ? [[xa, ya, q[k1]], [xa, ya + 1, q[k2]], [xa, ya + 1, top], [xa, ya, top]] : [[xa, ya, q[k1]], [xa, ya, top], [xa + 1, ya, top], [xa + 1, ya, q[k2]]];
      out.reserve(4);
      for (const i of QUAD_ORDER[dir > 0 ? 1 : 0]) out.vertexQ(P[i][0] + x0, P[i][2], P[i][1] + y0, d * 2 + (dir > 0 ? 1 : 0), 3, g, 0, v, 0);
    }
  }
}

// The caps' faces (meshFaces): each in the axis groups (byFacing) as the voxel face it stands for -- a cap's top as an
// up face (lit as flat ground: a street's slope is a few degrees, and in the shadow map it stays a top), its sides
// (capEdges) as the sides they replace. Corners as emitMerged's, so the same winding (QUAD_ORDER).
function emitCaps(rp: CapField, tops: number[], vol: Uint16Array, x0: number, y0: number, sink: QuadBuffer, skip: (k: number) => boolean,
  bidOf: (c: number) => number, pick: ((c: number) => QuadBuffer | null) | null = null) {
  // (ZT: a top's run top, its cap's; under: the tile's ground, the faces' gm as the voxels')
  const { S, under } = rp, SS = S * S;
  // (sections, pick: each column's into its section's buffer -- the tops' and sides' columns are in sections meshed --
  // and a slope's caps merged within its section)
  let out = sink;
  const put = (P: number[][], d: number, dir: number, ord: number[], aos: number[], gm: number, pal: number, bid: number) => {
    out.reserve(4);
    for (const c of ord) out.vertexQ(P[c][0] + x0, P[c][2], P[c][1] + y0, d * 2 + (dir > 0 ? 1 : 0), aos[c], gm, 0, pal, bid);
  };
  const lastOf = (V0: number) => (pick ? secEnd(V0 - 1, S - 2) + 1 : S - 1);
  // caps that lie in one plane (a slope as even as their 1/64 m corners allow) and are not darkened merge into one
  // quad along x (or else along y): the same plane, split either way
  const nt = tops.length / 4, Q = new Int32Array(nt * 4), AO = new Uint8Array(nt), ZT = new Uint16Array(nt), of = new Int32Array(SS * 2).fill(-1), done = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    const c = tops[t * 4], sl = tops[t * 4 + 3];
    of[2 * c + sl] = t;
    ZT[t] = rp.z[2 * c + sl];
    for (let k = 0; k < 4; k++) Q[t * 4 + k] = cornerQ(rp, c, sl, k);
    AO[t] = faceAO(vol, c + SS * (ZT[t] + 1), 1, S, -1, null, skip);
  }
  // (the top of the neighbour cn in the same slot as top t, -1: none)
  const next = (t: number, cn: number) => of[2 * cn + tops[t * 4 + 3]];
  const like = (t: number, u: number) => u >= 0 && !done[u] && AO[u] === 255 && tops[u * 4 + 1] === tops[t * 4 + 1] && tops[u * 4 + 2] === tops[t * 4 + 2]
    && ZT[u] === ZT[t] && under[tops[u * 4]] === under[tops[t * 4]];
  for (let t = 0; t < nt; t++) {
    if (done[t]) continue;
    const c = tops[t * 4], X = c % S, Y = (c - X) / S, x = X - 1, y = Y - 1, q = Q.slice(t * 4, t * 4 + 4), ao = AO[t];
    const dx = q[1] - q[0], dy = q[3] - q[0], lx = lastOf(X), ly = lastOf(Y);
    if (pick) out = pick(c)!;
    let w = 1, h = 1;
    if (ao === 255 && q[2] - q[3] === dx) { // (planar)
      for (let u; X + w < lx && like(t, u = next(t, c + w)) && Q[u * 4] === q[1] && Q[u * 4 + 3] === q[2] && Q[u * 4 + 1] - Q[u * 4] === dx && Q[u * 4 + 2] - Q[u * 4 + 3] === dx; w++) {
        done[u] = 1; q[1] += dx; q[2] += dx;
      }
      if (w === 1) for (let u; Y + h < ly && like(t, u = next(t, c + h * S)) && Q[u * 4] === q[3] && Q[u * 4 + 1] === q[2] && Q[u * 4 + 3] - Q[u * 4] === dy && Q[u * 4 + 2] - Q[u * 4 + 1] === dy; h++) {
        done[u] = 1; q[3] += dy; q[2] += dy;
      }
    }
    done[t] = 1;
    const P = [[x, y, q[0]], [x + w, y, q[1]], [x + w, y + h, q[2]], [x, y + h, q[3]]];
    put(P, 2, 1, QUAD_ORDER[(diagonal02(q[0], q[1], q[2], q[3]) ? 2 : 0) + 1], [ao & 3, (ao >> 2) & 3, (ao >> 4) & 3, (ao >> 6) & 3], under[c], tops[t * 4 + 1], tops[t * 4 + 2]);
  }
  capEdges(rp, tops, vol, x0, y0, sink, bidOf, pick);
}

// The sides of the caps' top voxels (emitCaps): along each edge of a capped column, between its corners
// and what is beside it -- a cap on a run within a metre of its own (its corners), else the neighbour's voxels: open
// at the cap's voxel (its foot, a metre down), solid there but open over it (its top), solid over it too (a wall: its
// face goes on down to the cap where the cap dips under the voxel's top). The higher side draws the riser, so two caps
// that meet draw nothing. Out through the node's border, a skirt from the voxel's foot up to the cap (the neighbour
// may not be shown yet), sunk 1/64 m as INNER.
function capEdges(rp: CapField, tops: number[], vol: Uint16Array, x0: number, y0: number, sink: QuadBuffer, bidOf: (c: number) => number,
  pick: ((c: number) => QuadBuffer | null) | null) {
  const { S, under } = rp, SS = S * S, V = S + 1;
  let out = sink;
  const put = (P: number[][], d: number, dir: number, ord: number[], ao: number, gm: number, pal: number, bid: number) => {
    out.reserve(4);
    for (const c of ord) out.vertexQ(P[c][0] + x0, P[c][2], P[c][1] + y0, d * 2 + (dir > 0 ? 1 : 0), ao, gm, 0, pal, bid);
  };
  // a side quad along the edge from p1 (X, Y) (d 0: along y; d 1: along x), bottom b1, b2 to top t1, t2 (1/64 m)
  const side = (d: number, X: number, Y: number, b1: number, b2: number, t1: number, t2: number) =>
    d === 0 ? [[X, Y, b1], [X, Y + 1, b2], [X, Y + 1, t2], [X, Y, t1]] : [[X, Y, b1], [X, Y, t1], [X + 1, Y, t2], [X + 1, Y, b2]];
  for (let t = 0; t < tops.length; t += 4) {
    const c = tops[t], pal = tops[t + 1], bid = tops[t + 2], sl = tops[t + 3], z = rp.z[2 * c + sl], g = z * 64;
    if (pick) out = pick(c)!;
    for (const [d, dir] of [[0, -1], [0, 1], [1, -1], [1, 1]]) {
      const n = c + (d === 0 ? dir : dir * S), NX = n % S, NY = (n - NX) / S;
      const [k1, k2, n1, n2] = edgeCorners(d, dir), [p1] = edgePoints(S, c, d, dir);
      const X = p1 % V - 1, Y = (p1 - (p1 % V)) / V - 1;
      const t1 = cornerQ(rp, c, sl, k1), t2 = cornerQ(rp, c, sl, k2);
      if (NX === 0 || NY === 0 || NX === S - 1 || NY === S - 1) {
        const b = g - 65;
        if (t1 - 1 > b || t2 - 1 > b) put(side(d, X, Y, b, b, Math.max(b, t1 - 1), Math.max(b, t2 - 1)), d, dir, QUAD_ORDER[dir > 0 ? 1 : 0], 3, under[c], pal, bid);
        continue;
      }
      // (the neighbour's cap nearest this one's level, within a metre)
      let ns = -1;
      for (let s2 = 0; s2 < 2; s2++) { const zn = rp.z[2 * n + s2]; if (zn && Math.abs(zn - z) <= 1 && (ns < 0 || Math.abs(zn - z) < Math.abs(rp.z[2 * n + ns] - z))) ns = s2; }
      let b1: number, b2: number;
      if (ns >= 0) { b1 = cornerQ(rp, n, ns, n1); b2 = cornerQ(rp, n, ns, n2); }
      else if (vol[n + SS * z] === 0) b1 = b2 = g - 64; // (open at the cap's voxel)
      else {
        // its voxel beside the cap's: a wall's face down to the cap where the cap dips under it
        const w = Math.min(g, t1), w2 = Math.min(g, t2);
        if (w < g || w2 < g) put(side(d, X, Y, w, w2, g, g), d, -dir, QUAD_ORDER[dir < 0 ? 1 : 0], 2, under[n], vol[n + SS * z], bidOf(n));
        if (vol[n + SS * (z + 1)] !== 0) continue; // (a wall over it too: nothing over the voxel's top to fill)
        b1 = b2 = g;
      }
      if (t1 > b1 || t2 > b2) put(side(d, X, Y, Math.min(b1, t1), Math.min(b2, t2), t1, t2), d, dir, QUAD_ORDER[dir > 0 ? 1 : 0], 3, under[c], pal, bid);
    }
  }
}

// A chamfer (chamfer.ts): its slanted face, lit as the wall's plane (vattr.w = SLANT + its direction) and windowed along
// its staircase (vattr.x: face axis + 8 x the staircase's direction, as wallAngle's), a lid
// where nothing stands on it (the eave's top lit as its roof plane) and a floor where it hangs over nothing
function emitPrism(p: Prism, s: number, x0: number, y0: number, out: QuadBuffer, palFlags: Uint8Array, roofs: ReturnType<typeof roofPlanes> | null,
  slopes: ReturnType<typeof slopeRoofs>, rp: CapField | null) {
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
  // standing on a cap (core/surface.ts) that falls below its foot: its face goes on down to it
  const foot = rp ? capBelow(rp, Math.min(P[0], A[0], B[0]), Math.min(P[1], A[1], B[1]), Math.max(P[0], A[0], B[0]), Math.max(P[1], A[1], B[1]), p.z0 * 64) : null;
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
    const [b, c] = up ? [A, B] : [B, A], tb = b === L ? tL : tR, tc = c === L ? tL : tR;
    const n = Math.max(p.a, p.b);
    if (n > 1 && p.roof && slopes) {
      // under a slope its long leg runs along the slope's cells, a corner of theirs at every grid point on it, a little
      // off the straight line (as roofs.ts emitFill's): through them, a fan from the short leg's end (as one edge it
      // left slivers open along the leg)
      const long = p.a >= p.b, apex = long ? B : A, ux = long ? -p.sx : 0, uy = long ? 0 : -p.sy;
      const pt = (k: number) => [P[0] + ux * k, P[1] + uy * k];
      const fwd = apex === c, ta = apex === L ? tL : tR;
      for (let k = 0; k < n; k += 2) {
        const ks: number[] = [];
        for (let i = k; i <= Math.min(k + 2, n); i++) ks.push(i);
        if (!fwd) ks.reverse();
        if (ks.length === 2) ks.push(ks[1]);
        out.reserve(4);
        v(apex, ta, nrm, 3, w);
        for (const i of ks) { const q = pt(i); v(q, i === 0 ? tP : i === n ? (long ? (A === L ? tL : tR) : (B === L ? tL : tR)) : top(q), nrm, 3, w); }
      }
    } else {
      out.reserve(4);
      v(P, tP, nrm, 3, w); v(b, tb, nrm, 3, w); v(c, tc, nrm, 3, w); v(c, tc, nrm, 3, w);
    }
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
  planes: Uint16Array | null, box: Box | null = null) {
  const S = N + 2, SS = S * S;
  const H = new Int16Array(SS).fill(-1000), bid = new Int32Array(SS);
  // (box: its columns only; meshSections)
  const bx0 = box ? box.x0 : 0, bx1 = box ? box.x1 : S, by0 = box ? box.y0 : 0, by1 = box ? box.y1 : S;
  for (let Y0 = by0; Y0 < by1; Y0++) for (let c = bx0 + S * Y0, ce = bx1 + S * Y0; c < ce; c++) {
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
  for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
    const c = x + S * y;
    if (H[c] === -1000) continue;
    rx[c] = diff(c, 1, x > 0, x < S - 1); ry[c] = diff(c, S, y > 0, y < S - 1); ok[c] = 1;
  }
  const gx = new Float32Array(SS), gy = new Float32Array(SS);
  for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
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
// (skip: what doesn't count, a cap's ground)
function faceAO(vol: Uint16Array, ni: number, su: number, sv: number, stairAxis: number, roofPal: Uint8Array | null, skip?: (k: number) => boolean) {
  // (no closures: this runs for every face found)
  let s10 = occludes(vol, ni - su, roofPal, skip), s12 = occludes(vol, ni + su, roofPal, skip);
  let s01 = occludes(vol, ni - sv, roofPal, skip), s21 = occludes(vol, ni + sv, roofPal, skip);
  let c00 = 0, c20 = 0, c22 = 0, c02 = 0;
  if (stairAxis === 0) s10 = s12 = 0;
  else if (stairAxis === 1) s01 = s21 = 0;
  else {
    c00 = occludes(vol, ni - su - sv, roofPal, skip); c20 = occludes(vol, ni + su - sv, roofPal, skip);
    c22 = occludes(vol, ni + su + sv, roofPal, skip); c02 = occludes(vol, ni - su + sv, roofPal, skip);
  }
  return cornerAO(s10, s01, c00) | (cornerAO(s12, s01, c20) << 2) | (cornerAO(s12, s21, c22) << 4) | (cornerAO(s10, s21, c02) << 6);
}
const cornerAO = (a1: number, a2: number, c: number) => (a1 && a2 ? 0 : 3 - (a1 + a2 + c));
// what darkens a face's corner: a cell not empty -- on a roof's staircase (roofPal) not roof, else not skipped
function occludes(vol: Uint16Array, k: number, roofPal: Uint8Array | null, skip?: (k: number) => boolean) {
  const w = vol[k];
  if (w === 0) return 0;
  if (roofPal) return w < roofPal.length && roofPal[w] & PAL_ROOF ? 0 : 1;
  return skip && skip(k) ? 0 : 1;
}

function emitMerged(k1s: Uint32Array, k2s: Uint32Array, rlo: Int32Array, rhi: Int32Array, j0: number, j1: number, nu: number, nv: number,
  d: number, dir: number, normalIdx: number, sl: number, s: number, x0: number, y0: number, sink: QuadBuffer, pal: Uint8Array | null = null,
  win: Win | null = null) {
  const cd = sl + (dir > 0 ? 1 : 0);
  let out = sink, ue = nu, ve = nv;
  for (let j = j0; j <= j1; j++) {
    const row = j * nu, ie = rhi[j];
    for (let i = rlo[j]; i <= ie;) {
      const k1 = k1s[row + i];
      if (!k1) { i++; continue; }
      const k2 = k2s[row + i];
      if (win) {
        // (sections: into the cell's section's buffer, merged within it; u, v: y, z for an x face, z, x for y, x, y for z)
        out = outAt(win, d === 0 ? sl : d === 1 ? j : i, d === 0 ? i : d === 1 ? sl : j)!;
        if (d !== 1) ue = secEnd(i, nu);
        if (d !== 0) ve = secEnd(j, nv);
      }
      let w = 1;
      while (i + w < ue && k1s[row + i + w] === k1 && k2s[row + i + w] === k2) w++;
      let h = 1;
      outer: while (j + h < ve) {
        for (let k = 0, c = i + (j + h) * nu; k < w; k++, c++) if (k1s[c] !== k1 || k2s[c] !== k2) break outer;
        h++;
      }
      for (let jj = 0; jj < h; jj++) k1s.fill(0, i + (j + jj) * nu, i + w + (j + jj) * nu);
      const palIdx = k1 & 4095, wt = (k1 >>> 12) & 127, ang = k1 >>> 19, gm = k2 & 255, aoBits = (k2 >>> 8) & 255, bid = k2 >>> 16;
      // vattr.x: face axis + 8 x (a wall's direction, or a roof plane's slope in 2.5° steps); vattr.w: 1 + the roof
      // plane's downhill direction in 64 steps, 0 for anything else
      const roof = ang > 24 ? ang - 25 : -1, nrm = normalIdx + 8 * (roof >= 0 ? roof >> 6 : ang), rw = roof >= 0 ? 1 + (roof & 63) : wt === INNER ? 0 : wt;
      // (the corners' AO, 2 bits each: 255, none, is 3 at each)
      const ao0 = aoBits & 3, ao1 = (aoBits >> 2) & 3, ao2 = (aoBits >> 4) & 3, ao3 = (aoBits >> 6) & 3;
      out.reserve(4);
      const ord = QUAD_ORDER[(ao0 + ao2 < ao1 + ao3 ? 2 : 0) + (dir > 0 ? 1 : 0)];
      // A distance level's water: its top block is solid when a quarter of it is (scripts/tiles.py), so the surface
      // stood at the block's top, up to s - 1 m over the river's (at 299.75 m above the Kachlet, 12.75 m over the base:
      // 13 m at 1 m, 14 at 2, 16 at 4 and 8), and where nodes of two levels met, a step ran across the river. The
      // column's ground (gm) over water is the river's surface at 1 m (the first free voxel): the water's faces end
      // there, its top and the top of its sides, where they stand less than a block over it
      const sink = s > 1 && pal !== null && palIdx < pal.length && (pal[palIdx] & PAL_WATER) !== 0;
      // corners 0 .. 3: the base (cd along d, i along u, j along v), + w along u, + w along u + h along v, + h along v;
      // their z: corner 0's and 2's (an x face: u y, v z; a y face: u z, v x; a z face: all cd)
      const z0 = d === 0 ? j : d === 1 ? i : cd, z2 = d === 0 ? j + h : d === 1 ? i + w : cd;
      for (let q = 0; q < 4; q++) {
        const c = ord[q], cu = i + (c === 1 || c === 2 ? w : 0), cv = j + (c >= 2 ? h : 0), ao = (aoBits >> (2 * c)) & 3;
        const X = d === 0 ? cd : d === 1 ? cv : cu, Y = d === 0 ? cu : d === 1 ? cd : cv, Z = d === 0 ? cv : d === 1 ? cu : cd;
        if (sink && Z * s > gm && Z * s < gm + s) { out.vertex(X * s + x0, gm, Y * s + y0, nrm, ao, gm, rw, palIdx, bid); continue; }
        // (a face into the solid of the next tile: its top edge 1/64 m down, under the tops it meets there)
        if (wt === INNER && d < 2 && Z === z2 && Z > z0) out.vertex(X * s + x0, Z * s - 1, Y * s + y0, nrm, ao | (63 << 2), gm, rw, palIdx, bid);
        else out.vertex(X * s + x0, Z * s, Y * s + y0, nrm, ao, gm, rw, palIdx, bid);
      }
      i += w;
    }
    rlo[j] = nu; rhi[j] = -1;
  }
}
