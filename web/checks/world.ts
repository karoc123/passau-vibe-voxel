// The checks' synthetic worlds, one module: the voxel world as node files (makeWorld: the real VoxelCollision reads
// them through a stubbed fetch), as the Rapier car's map (synthMap) -- both laid out by columnTile from a column
// function -- and the plane's world of boxes (BoxWorld, swept analytically, no node files).
import type { Meta } from '../src/core/meta';
import { VoxelCollision, type CollisionOptions } from '../src/sim/craft/voxel-collision';
import { TileCache } from '../src/core/tile-cache';
import { liveEdits } from '../src/core/live-edits';
import { fetchGzip } from '../src/fetch';
import { MAT } from '../src/core/materials';
import { TILE_MAGIC as MAGIC, TILE_N } from '../src/tile-data';
import { encodeCaps } from '../src/core/surface';
import { terrainTile, terrainPalette } from '../src/physics/rapier/terrain';
import { component, type Vec3 } from '../src/core/vec';
import { PLANE, type PlaneWorld } from '../src/sim/craft/plane-flight';
import type { ImpactKind, Sweep } from '../src/sim/craft/sweep';

// a column's run: [bottom, length, material], bottom up
export type Run = [number, number, number];

// Tile (tx, tz) of N m of a W x D m column world with its 1-column apron (past the map's edge, the edge columns
// repeated): each column's ground top g and its runs from `column`, which gets the map column (x, z), its index k in
// the tile and its grid position (X, Z) before the clamp to the map
export function columnTile(N: number, W: number, D: number, tx: number, tz: number,
  column: (x: number, z: number, k: number, X: number, Z: number) => { g: number; runs: Run[] }) {
  const S = N + 2, ground = new Uint8Array(S * S), counts = new Uint16Array(S * S), runs: number[] = [];
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const X = tx * N + i - 1, Z = tz * N + j - 1, k = i + S * j;
    const c = column(Math.min(W - 1, Math.max(0, X)), Math.min(D - 1, Math.max(0, Z)), k, X, Z);
    ground[k] = c.g;
    for (const r of c.runs) runs.push(...r);
    counts[k] = c.runs.length;
  }
  return { ground, counts, runs: Uint16Array.from(runs) };
}

// ---- the node files (VXT2, as scripts/tilefile.py): a ground height per column and boxes on it (walls, decks,
// water), rooms recorded in them. Columns as the data has them: soil from 0 to the ground's top voxel, that voxel in
// the surface's colour, the boxes' runs above.

// Palette entries quantised as voxelize.py does (to 4), so voxelMaterial.ts recognises the paved ones
export const PAL = {
  soil: [120, 92, 68, MAT.SOIL],
  road: [96, 100, 108, MAT.SOLID], // asphalt #5f636b: paved
  earth: [128, 112, 80, MAT.SOLID], // bare ground, not paved: no ramps, sharp 1 m steps
  wall: [200, 192, 184, MAT.WALL],
  deck: [188, 184, 176, MAT.SOLID], // concrete #bdbab2
  water: [60, 96, 112, MAT.WATER],
  leaf: [64, 120, 48, MAT.LEAF],
} as const;
export type Surface = keyof typeof PAL;
const IDS = Object.fromEntries(Object.keys(PAL).map((k, i) => [k, i])) as Record<Surface, number>;

// [x0, x1) x [z0, z1) in metres, from y0 up to y1 (voxel tops are whole metres)
export interface Box { x0: number; z0: number; x1: number; z1: number; y0: number; y1: number; mat: Surface }

export interface WorldSpec {
  size: [number, number]; // W, D in metres (at most 256 x 256: the collision keeps the 3 x 3 tiles around the body)
  ground: (x: number, z: number) => number; // the ground's top at column (x, z), whole metres >= 1
  surface?: (x: number, z: number) => Surface; // the ground's top voxel (default road)
  boxes?: Box[];
  // rooms (scripts/interiors.py): the voids recorded in the node files' room section, mat the fill (what stood there);
  // their voxels must hold no box
  rooms?: Box[];
}

function encode(sections: [string, ArrayBufferView][]) {
  const pad = (n: number) => n + (-n & 3);
  let size = 8 + 8 * sections.length;
  for (const [, v] of sections) size += pad(v.byteLength);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, sections.length, true);
  let at = 8 + 8 * sections.length;
  sections.forEach(([tag, v], k) => {
    for (let i = 0; i < 4; i++) out[8 + 8 * k + i] = tag.charCodeAt(i);
    dv.setUint32(8 + 8 * k + 4, v.byteLength, true);
    out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), at);
    at += pad(v.byteLength);
  });
  return out;
}

async function gzip(b: Uint8Array) {
  const s = new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// a 1 m tile (base, or its empty foliage tile) with its 1-column apron
function tile(spec: WorldSpec, tx: number, ty: number, foliage: boolean) {
  const [W, D] = spec.size, rooms: number[] = [];
  const { ground, counts, runs } = columnTile(TILE_N, W, D, tx, ty, (x, z, c) => {
    const g = Math.max(1, Math.round(spec.ground(x, z)));
    if (foliage) return { g, runs: [] };
    const col: Run[] = [[0, g - 1, IDS.soil], [g - 1, 1, IDS[spec.surface?.(x, z) ?? 'road']]];
    for (const b of spec.boxes ?? []) if (x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1) col.push([b.y0, b.y1 - b.y0, IDS[b.mat]]);
    col.sort((a, b) => a[0] - b[0]);
    const sp = (spec.rooms ?? []).filter((b) => x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1).sort((a, b) => a.y0 - b.y0);
    for (const b of sp) rooms.push(c, b.y0, b.y1 - b.y0, IDS[b.mat]);
    return { g, runs: col.filter((r) => r[1] > 0) };
  });
  return encode([['cnts', counts], ['grnd', ground], ['runs', runs], ...(rooms.length ? [['room', new Uint16Array(rooms)] as [string, Uint16Array]] : [])]);
}

// a VoxelCollision as the viewer's crafts had theirs: its own TileCache of the node files fetched (data/tiles/: the stub
// below, or tools/lib.mjs serveTiles) with the live edits, on the wall clock
export const fetchedCollision = (meta: Meta, opts?: CollisionOptions) =>
  new VoxelCollision(meta, new TileCache({ N: meta.tiles.N, load: (p) => fetchGzip(`data/tiles/${p}`), edits: liveEdits }), () => performance.now(), opts);

export interface TestWorld { meta: Meta; collision: VoxelCollision; files: Map<string, Uint8Array> }

// The world's tiles, gzipped, at the paths VoxelCollision fetches (data/tiles/{1,1f}/x_y.bin)
export async function makeWorld(spec: WorldSpec): Promise<TestWorld> {
  const [W, D] = spec.size, nx = Math.ceil(W / TILE_N), nz = Math.ceil(D / TILE_N), files = new Map<string, Uint8Array>();
  let H = 0;
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) H = Math.max(H, spec.ground(x, z));
  for (const b of spec.boxes ?? []) H = Math.max(H, b.y1);
  for (let ty = 0; ty < nz; ty++) for (let tx = 0; tx < nx; tx++) for (const f of [false, true])
    files.set(`data/tiles/${f ? '1f' : '1'}/${tx}_${ty}.bin`, await gzip(tile(spec, tx, ty, f)));
  const meta = { W, D, H, base: 0, theta_deg: 0, tiles: { N: TILE_N, levels: [], tris: { 1: [], '1f': [], '1c': [] } },
    palette: Object.values(PAL).map((p) => [...p]), lamps: [], labels: [], views: {}, sources: { osm: '' } } as unknown as Meta;
  serve(files);
  return { meta, collision: fetchedCollision(meta), files };
}

// fetch() answers the test world's files (the last world made), anything else as before
let served = new Map<string, Uint8Array>();
let realFetch: typeof fetch | null = null;
export function serve(files: Map<string, Uint8Array>) {
  served = files;
  if (realFetch) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input), f = served.get(url.replace(/^.*?(data\/tiles\/)/, '$1'));
    if (f) return new Response(f as Uint8Array<ArrayBuffer>);
    if (url.includes('data/tiles/')) return new Response(null, { status: 404 });
    return realFetch!(input, init);
  }) as typeof fetch;
}

// ---- the Rapier car's map: tiles of 64 m as terrainTile builds them, with caps where the scenario gives a surface

// fixture palette: 0 earth (solid, not paved), 1 street (paved: capped where the scenario gives a surface), 2 wall, 3 water
const PALETTE: [number, number, number, number][] = [[120, 100, 80, MAT.SOIL], [90, 90, 90, MAT.MARK], [200, 190, 180, MAT.WALL], [40, 80, 120, MAT.WATER]];
export const EARTH = 0, STREET = 1, WALL = 2, WATER = 3;

// a column: its ground (top, m) and surface material; on it, optional runs [lo, hi, material]
export interface Col { g: number; mat?: number; runs?: [number, number, number][] }

// a map of `tiles` x `tiles` tiles of N m from a column function of world (x, z)
export type ScenarioMap = { meta: { W: number; D: number; tiles: { N: number }; palette: [number, number, number, number][] }; tiles: { tx: number; tz: number; tile: ReturnType<typeof terrainTile> }[] };

// surf: the scenario's analytic road surface (m) at grid point (x, z) -- its caps, as scripts/caps.py would write them:
// on each STREET column's ground run with nothing on it, and on a STREET run topping a column over its ground (a deck),
// the four corners at surf, held within 60/64 m of the run's top (core/surface.ts). Every tile gets a caps section
// (empty without surf: a scenario of real steps, which stay voxels).
export function synthMap(tiles: number, col: (x: number, z: number) => Col, surf?: (x: number, z: number) => number): ScenarioMap {
  const N = 64, meta = { W: tiles * N, D: tiles * N, tiles: { N }, palette: PALETTE };
  const pal = terrainPalette(PALETTE), S = N + 2;
  const out: { tx: number; tz: number; tile: ReturnType<typeof terrainTile> }[] = [];
  for (let tz = 0; tz < tiles; tz++) for (let tx = 0; tx < tiles; tx++) {
    const fcounts = new Uint16Array(S * S), recs: number[][] = [];
    const { ground, counts, runs } = columnTile(N, meta.W, meta.D, tx, tz, (x, z, k, X, Z) => {
      const c = col(x, z);
      const r: [number, number, number][] = [[c.g - 1, c.g, c.mat ?? EARTH], ...(c.runs ?? [])];
      // (the capped run: the ground's with nothing on it, or the last over the ground, of STREET)
      const last = r[r.length - 1], zt = r.length === 1 ? c.g : last[0] > c.g ? last[1] : 0;
      if (surf && zt && last[2] === STREET) {
        const q = [[X, Z], [X + 1, Z], [X + 1, Z + 1], [X, Z + 1]].map(([a, b]) => Math.min(zt * 64 + 60, Math.max(zt * 64 - 60, Math.round(surf(a, b) * 64))));
        if (q.some((v) => v !== zt * 64)) recs.push([k, zt, ...q]);
      }
      return { g: c.g, runs: r.map(([lo, hi, m]): Run => [lo, hi - lo, m]) };
    });
    out.push({ tx, tz, tile: terrainTile(N, { ground, counts, runs, caps: encodeCaps(recs) }, { counts: fcounts, runs: new Uint16Array(0) }, pal) });
  }
  return { meta, tiles: out };
}

// ---- the plane's world of boxes (ground, hills, walls, roofs, a river whose water is the ground's top as in the
// voxels), swept the way VoxelCollision sweeps the fuselage's cube (the box grown by the radius, the first face met,
// its axis), so the checks cover any map size without node files

interface Block { x0: number; z0: number; x1: number; z1: number; top: number; kind: ImpactKind; water?: boolean; loading?: boolean }

export class BoxWorld implements PlaneWorld {
  readonly blocks: Block[] = [];
  constructor(readonly W: number, readonly D: number, readonly H: number, readonly ground: number, readonly R = PLANE.RADIUS) {}

  add(b: Block) { this.blocks.push(b); return b; }

  private at(x: number, z: number) {
    let top = this.ground, ground = this.ground, water = -1;
    for (const b of this.blocks) {
      if (x < b.x0 || x >= b.x1 || z < b.z0 || z >= b.z1) continue;
      if (b.water) { ground = b.top; top = b.top; water = b.top; continue; }
      if (b.kind === 'terrain') ground = Math.max(ground, b.top);
      top = Math.max(top, b.top);
    }
    return { ground, top, water };
  }

  surface(x: number, z: number) { const s = this.at(x, z); return { ground: s.ground, top: s.top }; }
  water(x: number, z: number) {
    if (this.blocks.some((b) => b.loading && x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1)) return null;
    return this.at(x, z).water;
  }

  sweep(p: Vec3, d: Vec3): Sweep {
    const R = this.R;
    let fraction = 1, hit: ImpactKind | null = null, axis = 0;
    const all: Block[] = [{ x0: -1e9, z0: -1e9, x1: 1e9, z1: 1e9, top: this.ground, kind: 'terrain' }, ...this.blocks];
    for (const b of all) {
      const lo = [b.x0 - R, -1e9, b.z0 - R], hi = [b.x1 + R, b.top + R, b.z1 + R];
      let enter = 0, leave = 1, ax = 0, miss = false;
      for (let i = 0; i < 3 && !miss; i++) {
        const s = component(p, i), m = component(d, i);
        if (Math.abs(m) < 1e-10) { if (s < lo[i] || s > hi[i]) miss = true; continue; }
        const a = (lo[i] - s) / m, c = (hi[i] - s) / m, e = Math.min(a, c);
        if (e >= enter) { enter = e; ax = -Math.sign(m) * (i + 1); }
        leave = Math.min(leave, Math.max(a, c));
        if (enter > leave) miss = true;
      }
      if (miss || enter > fraction) continue;
      if (b.loading) return 'loading';
      if (ax === 0) ax = 2;
      fraction = enter; hit = b.kind; axis = ax;
    }
    return hit ? { fraction, hit, axis } : { fraction, hit: null };
  }
}
