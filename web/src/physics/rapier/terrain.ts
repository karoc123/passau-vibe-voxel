// Rapier (approach B): the city's voxels as Rapier colliders, only near the bodies that move.
//
// The same per-tile data the collision code reads (nav/voxel-collision.ts: data/tiles/1 and 1f, 128 m tiles with a
// 1-column apron): per column the ground (solid from 0 up to it) and runs of voxels (base and foliage). Grass is not
// solid, as there. Water is not solid either (the river's top voxel is the ground's: the ground ends under it); its
// top per column is kept for waterAt (the car sinks).
//
// The world is cut in CHUNK x CHUNK m chunks. A chunk within REACH of a dynamic body gets one Voxels collider (only the
// voxels with a face to the air: the shell) and, where the node has caps (core/surface.ts: its caps section, sloped
// streets and bridge decks), one trimesh of the caps' triangles in place of their runs' top voxels, met by every body as
// the mesher draws it. A node without caps, or a column without one, is its voxels. Neighbouring chunks' voxel colliders are coupled (combineVoxelStates), so a body
// sliding across a chunk border meets no inner edge there. Chunks are built nearest first within a time budget per
// frame, those ahead of a moving body (along its velocity) before those behind. Chunks no body has needed for a while
// are removed. Physics coordinates are the world's minus `origin` (f32 precision near the action).
import RAPIER from '@dimforge/rapier3d-compat';
import { capField, capSlot, cornerQ, diagonal02, surfaceAt, type CapField } from '../../core/surface';
import { liveEdits, type Region } from '../../core/live-edits';
import { TileCache } from '../../core/tile-cache';
import type { Meta } from '../../types';
import { fetchGzip } from '../../fetch';
import { paletteMask, RULES, semanticTable } from '../../core/semantics';

export const CHUNK = 16;
// collision groups (membership << 16 | filter). The car's chassis (and its wheels' rays) are G_CAR; what only the car
// meets (the steps' wedges: car.ts) G_CAR_ONLY; other bodies, and queries that should see the city as drawn, use
// WORLD_GROUPS. The terrain's colliders (voxels and caps) are in every group.
export const G_CAR = 1 << 0, G_CAR_ONLY = 1 << 1;
export const CAR_GROUPS = (G_CAR << 16) | 0xffff;
// the wheels' rays: as the car
export const WHEEL_GROUPS = CAR_GROUPS;
export const CAR_ONLY_GROUPS = (G_CAR_ONLY << 16) | G_CAR;
export const WORLD_GROUPS = ((0xffff & ~(G_CAR | G_CAR_ONLY)) << 16) | 0xffff;
const REACH = 40; // chunks within this of a body are built
const LEAD_S = 1.2; // ... and within REACH of where it will be in this many seconds
const KEEP_MS = 3000; // a chunk not needed for this long is removed
const NEED_NOW = 12; // a body with an unbuilt chunk within this is frozen
const BUILD_BUDGET_MS = 2;

export interface TerrainTile {
  S: number;
  ground: Uint8Array;
  // per column: the top of its highest cap (a bridge deck's where it has one), else the ground (core/surface.ts)
  top: Uint8Array;
  // per column c (S x S, apron included): its merged solid intervals [lo, hi), sorted, as pairs in
  // iv[off[c] .. off[c + 1])
  iv: Uint16Array;
  off: Uint32Array;
  // per column: the top of its water (m), 0: none
  water: Uint16Array;
  // the node's caps (core/surface.ts), the one surface for every body; null: none, its voxels
  caps: CapField | null;
}

// the columns of a tile as decodeTile gives them (base: with the ground, and its caps section if it has one)
export interface TileColumns { counts: Uint16Array; runs: Uint16Array; ground?: Uint8Array; caps?: Uint16Array | null }

// palette flags: solid (not grass, not water), water
export function terrainPalette(palette: Meta['palette']) {
  const t = semanticTable(palette);
  return {
    solid: paletteMask(t, RULES.solidForCar),
    water: paletteMask(t, RULES.water),
  };
}
export type TerrainPalette = ReturnType<typeof terrainPalette>;

export function terrainTile(N: number, base: TileColumns & { ground: Uint8Array }, fol: TileColumns, pal: TerrainPalette): TerrainTile {
  const S = N + 2, C = S * S;
  const offs = (counts: Uint16Array) => { const o = new Uint32Array(counts.length + 1); for (let i = 0; i < counts.length; i++) o[i + 1] = o[i] + counts[i]; return o; };
  const bo = offs(base.counts), fo = offs(fol.counts);
  const water = new Uint16Array(C), off = new Uint32Array(C + 1);
  let out = new Uint16Array(C * 4), n = 0;
  const tmp = new Int32Array(1024);
  for (let c = 0; c < C; c++) {
    let m = 0;
    // (the river's water is the ground's top voxel(s): the ground solid only up to the water's bottom)
    let g = base.ground[c];
    for (let pass = 0; pass < 2; pass++) {
      const runs = pass ? fol.runs : base.runs, o = pass ? fo : bo;
      for (let k = o[c]; k < o[c + 1]; k++) {
        const z0 = runs[k * 3], z1 = z0 + runs[k * 3 + 1], mat = runs[k * 3 + 2];
        if (pal.solid[mat]) { if (m < tmp.length - 2) { tmp[m++] = z0; tmp[m++] = z1; } } else if (pal.water[mat]) {
          if (z1 > water[c]) water[c] = z1;
          if (!pass && z1 >= base.ground[c] && z0 < g) g = z0;
        }
      }
    }
    if (g > 0) { tmp[m++] = 0; tmp[m++] = g; }
    // sorted by their bottoms (insertion sort: a column has a few), merged where they touch
    for (let i = 2; i < m; i += 2) {
      const lo = tmp[i], hi = tmp[i + 1];
      let j = i - 2;
      for (; j >= 0 && tmp[j] > lo; j -= 2) { tmp[j + 2] = tmp[j]; tmp[j + 3] = tmp[j + 1]; }
      tmp[j + 2] = lo; tmp[j + 3] = hi;
    }
    if (n + m > out.length) { const o2 = new Uint16Array(out.length * 2 + m); o2.set(out); out = o2; }
    const start = n;
    for (let i = 0; i < m; i += 2) {
      if (n > start && tmp[i] <= out[n - 1]) { if (tmp[i + 1] > out[n - 1]) out[n - 1] = tmp[i + 1]; } else { out[n++] = tmp[i]; out[n++] = tmp[i + 1]; }
    }
    off[c + 1] = n;
  }
  // (the caps section: one surface for all, core/surface.ts)
  const cf = capField(N, base, bo), caps = cf?.any ? cf : null;
  return { S, ground: base.ground, top: caps?.top ?? base.ground, iv: out.slice(0, n), off, water, caps };
}

// The colliders' data of chunk (cx, cz) in `tile` (N m a side): the shell voxels (chunk-local grid coordinates) and the
// caps' triangles (chunk-local metres): each cap's run's top voxel left out of the shell (the one under it kept, a
// floor), its quad in the one trimesh every body meets (core/surface.ts: as the mesher draws it)
export function chunkShapes(tile: TerrainTile, N: number, cx: number, cz: number) {
  const { S, iv, off, ground: under, caps: f } = tile;
  const lx0 = (cx * CHUNK) % N, lz0 = (cz * CHUNK) % N;
  const vox: number[] = [], verts: number[] = [], idx: number[] = [];
  const quad = (i: number, j: number, q0: number, q1: number, q2: number, q3: number) => {
    const b = verts.length / 3;
    verts.push(i, q0, j, i + 1, q1, j, i + 1, q2, j + 1, i, q3, j + 1);
    // (counter-clockwise seen from above: normals up)
    if (diagonal02(q0, q1, q2, q3)) idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    else idx.push(b, b + 3, b + 1, b + 1, b + 3, b + 2);
  };
  // (a column's open voxels: its caps' runs' top voxels, -1 none)
  const o0 = f ? (c: number) => f.z[2 * c] - 1 : () => -1, o1 = f ? (c: number) => f.z[2 * c + 1] - 1 : () => -1;
  for (let j = 0; j < CHUNK; j++) for (let i = 0; i < CHUNK; i++) {
    const c = lx0 + i + 1 + S * (lz0 + j + 1), ns = [c - 1, c + 1, c - S, c + S];
    const a0 = o0(c), a1 = o1(c);
    // below the lowest neighbouring ground all four sides are solid: nothing to see there but an interval's ends
    const deep = Math.min(under[ns[0]], under[ns[1]], under[ns[2]], under[ns[3]], a0 >= 0 ? under[c] : 1e9) - 2;
    for (let k = off[c]; k < off[c + 1]; k += 2) {
      const lo = iv[k], hi = iv[k + 1];
      for (let y = lo; y < hi; y++) {
        if (y > lo && y < deep && y < hi - 1) y = Math.min(deep, hi - 1);
        if (y === a0 || y === a1) continue;
        let shell = y === hi - 1 || (y === lo && lo > 0) || y === a0 - 1 || y === a1 - 1;
        for (let q = 0; q < 4 && !shell; q++) { const n = ns[q]; shell = y === o0(n) || y === o1(n) || !inside(tile, n, y); }
        if (shell) vox.push(i, y, j);
      }
    }
    if (f) for (let sl = 0; sl < 2; sl++) if (f.z[2 * c + sl]) quad(i, j, cornerQ(f, c, sl, 0) / 64, cornerQ(f, c, sl, 1) / 64, cornerQ(f, c, sl, 2) / 64, cornerQ(f, c, sl, 3) / 64);
  }
  return { vox: new Int32Array(vox), verts: new Float32Array(verts), idx: new Uint32Array(idx) };
}

interface Chunk { colliders: RAPIER.Collider[]; vox: RAPIER.Collider | null; usedAt: number; voxels: number; tris: number }

export interface TerrainStats {
  chunks: number; voxels: number; tris: number; tilesLoading: number;
  builds: number; buildMsTotal: number; buildJsMsTotal: number; buildMsMax: number; lastFrameBuildMs: number; frameBuildMsMax: number;
  // the slowest build's parts (ms): chunkShapes, the voxels' collider, the rest (coupling, caps); n: its voxels
  slowest: { ms: number; js: number; voxels: number; rest: number; n: number };
  decodeMsMax: number; // a tile's decoding into the collision form, the slowest
}

export interface TerrainOptions {
  // the nodes' files (core/tile-cache.ts; e.g. the viewer's shared one); default: its own, with `load`
  cache?: TileCache;
  // a tile's bytes (ungzipped) by its path under data/tiles/ ('1/3_4.bin'); default: fetched
  load?: (path: string) => Promise<ArrayBuffer>;
  budgetMs?: number;
  couple?: boolean; // couple neighbouring chunks' voxels (default true)
}

export class RapierTerrain {
  readonly N: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly pal: TerrainPalette;
  private readonly tiles = new Map<number, TerrainTile | 'loading' | 'failed'>();
  private readonly chunks = new Map<number, Chunk>();
  private readonly cache: TileCache;
  budgetMs: number;
  couple: boolean;
  private readonly unlisten: () => void;
  readonly stats: TerrainStats = { chunks: 0, voxels: 0, tris: 0, tilesLoading: 0, builds: 0, buildMsTotal: 0, buildJsMsTotal: 0, buildMsMax: 0, lastFrameBuildMs: 0, frameBuildMsMax: 0, slowest: { ms: 0, js: 0, voxels: 0, rest: 0, n: 0 }, decodeMsMax: 0 };

  constructor(private readonly R: typeof RAPIER, private readonly world: RAPIER.World, meta: { W: number; D: number; tiles: { N: number }; palette: Meta['palette'] },
    readonly origin: { x: number; z: number }, opts: TerrainOptions = {}) {
    this.N = meta.tiles.N;
    this.nx = Math.ceil(meta.W / this.N);
    this.nz = Math.ceil(meta.D / this.N);
    this.pal = terrainPalette(meta.palette);
    this.cache = opts.cache ?? new TileCache({ N: this.N, load: opts.load ?? ((p) => fetchGzip(`data/tiles/${p}`)), edits: liveEdits });
    this.budgetMs = opts.budgetMs ?? BUILD_BUDGET_MS;
    this.couple = opts.couple ?? true;
    // (an edited node, core/live-edits.ts: its tile and the chunks it changed built again)
    this.unlisten = liveEdits.listen((tx, tz, _n, region) => this.invalidate(tx, tz, region));
  }

  // Node (tx, tz)'s columns changed (core/live-edits.ts, or its file again): the tile is decoded again from them (now
  // where the cache has the node: its files in, or both its base and foliage given; else loaded again), and the chunks
  // over region (map metres; null: the whole tile) and a column round it (a column's shell reads its neighbours; a cap
  // only its own column) are removed to be built again by the next update.
  invalidate(tx: number, tz: number, region: Region = null) {
    if (tx < 0 || tz < 0 || tx >= this.nx || tz >= this.nz) return;
    const key = tx + tz * this.nx, t = this.tiles.get(key), v = this.cache.view(tx, tz);
    if (t !== 'loading') {
      if (v) this.tiles.set(key, terrainTile(this.N, v.base, v.foliage, this.pal));
      else this.tiles.delete(key);
    } // (a load under way takes the live columns when it ends)
    const [x0, z0, x1, z1] = region ?? [tx * this.N, tz * this.N, (tx + 1) * this.N, (tz + 1) * this.N], m = 1;
    for (let cz = Math.floor((z0 - m) / CHUNK); cz <= Math.floor((z1 + m) / CHUNK); cz++) {
      for (let cx = Math.floor((x0 - m) / CHUNK); cx <= Math.floor((x1 + m) / CHUNK); cx++) {
        const ck = cx + cz * 4096, ch = this.chunks.get(ck);
        if (!ch) continue;
        for (const c of ch.colliders) this.world.removeCollider(c, false);
        this.chunks.delete(ck);
        this.stats.voxels -= ch.voxels;
        this.stats.tris -= ch.tris;
      }
    }
  }

  // a tile given directly (tests: synthetic terrain)
  setTile(tx: number, tz: number, t: TerrainTile) { this.tiles.set(tx + tz * this.nx, t); }

  // Builds what the bodies at `points` (world coordinates, with their velocity if they move) need, within the frame's
  // budget. Returns, per point, whether its close surroundings are built (a body whose aren't should be frozen).
  // `now`: the clock chunks age by (ms; default: performance.now()).
  update(points: { x: number; z: number; vx?: number; vz?: number }[], now = performance.now()): boolean[] {
    const start = performance.now();
    const want = new Map<number, number>();
    const consider = (x: number, z: number, bias: number) => {
      const c0x = Math.floor((x - REACH) / CHUNK), c1x = Math.floor((x + REACH) / CHUNK);
      const c0z = Math.floor((z - REACH) / CHUNK), c1z = Math.floor((z + REACH) / CHUNK);
      for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
        if (!this.onMap(cx, cz)) continue;
        const d = this.chunkDist(cx, cz, x, z);
        if (d > REACH) continue;
        const key = cx + cz * 4096, ch = this.chunks.get(key);
        if (ch) { ch.usedAt = now; continue; }
        const w = d + bias;
        if (!(want.get(key)! <= w)) want.set(key, w);
      }
    };
    for (const p of points) {
      consider(p.x, p.z, 0);
      // where it is heading: what it will reach soon, a little after what is close now
      if (p.vx !== undefined && p.vz !== undefined && Math.hypot(p.vx, p.vz) > 2) consider(p.x + p.vx * LEAD_S, p.z + p.vz! * LEAD_S, 6);
    }
    const order = [...want].sort((a, b) => a[1] - b[1]);
    let spent = 0;
    for (const [key] of order) {
      if (spent > this.budgetMs) break;
      const cx = key % 4096, cz = Math.floor(key / 4096);
      const tile = this.tile(Math.floor((cx * CHUNK) / this.N), Math.floor((cz * CHUNK) / this.N));
      if (!tile) continue;
      const t0 = performance.now();
      this.chunks.set(key, this.build(tile, cx, cz, now));
      const ms = performance.now() - t0;
      spent += ms;
      this.stats.builds++;
      this.stats.buildMsTotal += ms;
      this.stats.buildMsMax = Math.max(this.stats.buildMsMax, ms);
    }
    for (const [key, ch] of this.chunks) {
      if (now - ch.usedAt < KEEP_MS) continue;
      for (const c of ch.colliders) this.world.removeCollider(c, false);
      this.chunks.delete(key);
      this.stats.voxels -= ch.voxels;
      this.stats.tris -= ch.tris;
    }
    this.stats.chunks = this.chunks.size;
    let loading = 0;
    for (const t of this.tiles.values()) if (t === 'loading') loading++;
    this.stats.tilesLoading = loading;
    this.stats.lastFrameBuildMs = performance.now() - start;
    this.stats.frameBuildMsMax = Math.max(this.stats.frameBuildMsMax, this.stats.lastFrameBuildMs);
    return points.map((p) => this.ready(p));
  }

  // are the chunks within NEED_NOW of p built (or off the map)?
  ready(p: { x: number; z: number }) {
    const c0x = Math.floor((p.x - NEED_NOW) / CHUNK), c1x = Math.floor((p.x + NEED_NOW) / CHUNK);
    const c0z = Math.floor((p.z - NEED_NOW) / CHUNK), c1z = Math.floor((p.z + NEED_NOW) / CHUNK);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      if (this.onMap(cx, cz) && !this.chunks.has(cx + cz * 4096)) return false;
    }
    return true;
  }

  // The top of the water at world (x, z), or -1: none (or not loaded).
  waterAt(x: number, z: number) {
    const t = this.column(x, z);
    return t && t.tile.water[t.c] ? t.tile.water[t.c] : -1;
  }

  // The surface a body stands on at world (x, z), at or below `top`: the top of the highest solid interval, its cap's
  // where it has one (core/surface.ts). null: not loaded.
  groundAt(x: number, z: number, top: number) {
    const t = this.column(x, z);
    if (!t) return null;
    const { iv, off } = t.tile;
    let h = 0;
    for (let k = off[t.c]; k < off[t.c + 1]; k += 2) if (iv[k + 1] <= top + 1e-3) h = iv[k + 1];
    return surfaceAt(t.tile.caps, t.c, h, x - Math.floor(x), z - Math.floor(z));
  }

  // The top of the solid interval world point (x, y, z) is in, or -1: in the open (or not loaded). A cap's run's top
  // voxel is open (the cap is in it).
  solidTop(x: number, y: number, z: number) {
    const t = this.column(x, z);
    if (!t) return -1;
    const { iv, off, caps } = t.tile;
    for (let k = off[t.c]; k < off[t.c + 1]; k += 2) {
      if (y < iv[k] || y >= iv[k + 1]) continue;
      // (a cap's run: its top voxel open, for every body)
      if (caps && capSlot(caps, t.c, iv[k + 1]) >= 0) return y >= iv[k + 1] - 1 ? -1 : iv[k + 1] - 1;
      return iv[k + 1];
    }
    return -1;
  }

  // is world column (x, z) free of solid voxels from y to y + h? (not loaded: no)
  clear(x: number, z: number, y: number, h: number) {
    const t = this.column(x, z);
    if (!t) return false;
    const { iv, off } = t.tile;
    for (let k = off[t.c]; k < off[t.c + 1]; k += 2) if (iv[k] < y + h - 1e-3 && iv[k + 1] > y + 1e-3) return false;
    return true;
  }

  dispose() {
    this.unlisten();
    for (const ch of this.chunks.values()) for (const c of ch.colliders) this.world.removeCollider(c, false);
    this.chunks.clear();
  }

  private column(x: number, z: number) {
    const ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= this.nx * this.N || iz >= this.nz * this.N) return null;
    const tile = this.tiles.get(Math.floor(ix / this.N) + this.nx * Math.floor(iz / this.N));
    if (!tile || tile === 'loading' || tile === 'failed') return null;
    return { tile, c: (ix % this.N) + 1 + tile.S * ((iz % this.N) + 1) };
  }

  private onMap(cx: number, cz: number) { return cx >= 0 && cz >= 0 && cx * CHUNK < this.nx * this.N && cz * CHUNK < this.nz * this.N; }

  private chunkDist(cx: number, cz: number, x: number, z: number) {
    const dx = Math.max(cx * CHUNK - x, 0, x - (cx + 1) * CHUNK), dz = Math.max(cz * CHUNK - z, 0, z - (cz + 1) * CHUNK);
    return Math.hypot(dx, dz);
  }

  // The tile at world (x, z), loaded and decoded (null: off the map or failed)
  async prefetch(x: number, z: number): Promise<TerrainTile | null> {
    const tx = Math.floor(x / this.N), tz = Math.floor(z / this.N);
    if (tx < 0 || tz < 0 || tx >= this.nx || tz >= this.nz) return null;
    this.tile(tx, tz);
    await this.loads.get(tx + tz * this.nx);
    const t = this.tiles.get(tx + tz * this.nx);
    return t && typeof t !== 'string' ? t : null;
  }

  private readonly loads = new Map<number, Promise<void>>();

  private tile(tx: number, tz: number): TerrainTile | null {
    const key = tx + tz * this.nx, t = this.tiles.get(key);
    if (t === 'loading' || t === 'failed') return null;
    if (t) return t;
    const now = this.cache.view(tx, tz);
    if (now) { const lt = terrainTile(this.N, now.base, now.foliage, this.pal); this.tiles.set(key, lt); return lt; }
    this.tiles.set(key, 'loading');
    const path = `${tx}_${tz}.bin`;
    // (held only while decoded into the collision form: the cache keeps it for others, or drops it)
    const load = this.cache.acquire(tx, tz)
      .then((v) => {
        // (on the main thread: ~3 ms a tile, the first ~30 with the JIT's warm-up)
        const t0 = performance.now();
        try { this.tiles.set(key, terrainTile(this.N, v.base, v.foliage, this.pal)); } finally { this.cache.release(tx, tz); }
        this.stats.decodeMsMax = Math.max(this.stats.decodeMsMax, performance.now() - t0);
      })
      .catch((e) => { if (e) console.warn('rapier terrain tile', path, e); this.tiles.set(key, 'failed'); })
      .finally(() => this.loads.delete(key));
    this.loads.set(key, load);
    return null;
  }

  private build(tile: TerrainTile, cx: number, cz: number, now: number): Chunk {
    const { R } = this, t0 = performance.now();
    const { vox, verts, idx } = chunkShapes(tile, this.N, cx, cz);
    const t1 = performance.now();
    this.stats.buildJsMsTotal += t1 - t0;
    let t2 = t1;
    const tx = cx * CHUNK - this.origin.x, tz = cz * CHUNK - this.origin.z;
    const colliders: RAPIER.Collider[] = [];
    let vc: RAPIER.Collider | null = null;
    if (vox.length) {
      vc = this.world.createCollider(R.ColliderDesc.voxels(vox, { x: 1, y: 1, z: 1 }).setTranslation(tx, 0, tz).setFriction(0.9));
      colliders.push(vc);
      t2 = performance.now();
      if (this.couple) {
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const n = this.chunks.get(cx + dx + (cz + dz) * 4096);
          if (n?.vox) vc.combineVoxelStates(n.vox, dx * CHUNK, 0, dz * CHUNK);
        }
      }
    }
    if (idx.length) {
      // (the caps: every body's, as the voxels)
      colliders.push(this.world.createCollider(R.ColliderDesc.trimesh(verts, idx, R.TriMeshFlags.FIX_INTERNAL_EDGES).setTranslation(tx, 0, tz).setFriction(0.9)));
    }
    const t3 = performance.now();
    if (t3 - t0 > this.stats.slowest.ms) this.stats.slowest = { ms: t3 - t0, js: t1 - t0, voxels: t2 - t1, rest: t3 - t2, n: vox.length / 3 };
    this.stats.voxels += vox.length / 3;
    this.stats.tris += idx.length / 3;
    return { colliders, vox: vc, usedAt: now, voxels: vox.length / 3, tris: idx.length / 3 };
  }
}

function inside(t: TerrainTile, c: number, y: number) {
  const { iv, off } = t;
  for (let k = off[c]; k < off[c + 1]; k += 2) {
    if (y < iv[k]) return false;
    if (y < iv[k + 1]) return true;
  }
  return false;
}
