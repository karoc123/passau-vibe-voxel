// Rapier spike (approach B): the city's voxels as Rapier colliders, only near the bodies that move.
//
// The same per-tile data the collision code reads (nav/voxel-collision.ts: data/tiles/1 and 1f, 128 m tiles with a
// 1-column apron): per column the ground (solid from 0 up to it) and runs of voxels (base and foliage). Grass is not
// solid, as there. Water counts as solid (as voxel-collision's sweep has it).
//
// The world is cut in CHUNK x CHUNK m chunks. A chunk within REACH of a dynamic body gets one Voxels collider (only the
// voxels with a face to the air: the shell) and, where the street is a ramp (ramps.ts), a trimesh of the ramp's
// triangles in place of the top voxel. Chunks no body has needed for a while are removed. Physics coordinates are
// the world's minus `origin` (f32 precision near the action).
import RAPIER from '@dimforge/rapier3d-compat';
import { PAL_GROUND } from '../../chamfer';
import { rampDiagonal02, ramped, rampField, cornerQ, type RampField } from '../../ramps';
import { decodeTile } from '../../tile-data';
import type { Meta } from '../../types';
import { fetchGzip } from '../../util';
import { MAT, pavedGround } from '../../voxelMaterial';

export const CHUNK = 16;
const REACH = 40; // chunks within this of a body are built
const KEEP_MS = 3000; // a chunk not needed for this long is removed
const NEED_NOW = 12; // a body with an unbuilt chunk within this is frozen
const BUILD_BUDGET_MS = 4;

interface Tile {
  S: number;
  ground: Uint8Array;
  // per column (S x S, apron included): merged solid intervals [lo, hi) as flat pairs
  solid: Uint16Array[];
  ramps: RampField | null;
}

interface Chunk { colliders: RAPIER.Collider[]; usedAt: number; voxels: number; tris: number }

export interface TerrainStats {
  chunks: number; voxels: number; tris: number; tilesLoading: number;
  builds: number; buildMsTotal: number; buildJsMsTotal: number; buildMsMax: number; lastFrameBuildMs: number;
}

export class RapierTerrain {
  readonly N: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly solidMat: Uint8Array; // palette index -> 1 solid
  private readonly paved: Uint8Array;
  private readonly tiles = new Map<number, Tile | 'loading' | 'failed'>();
  private readonly chunks = new Map<number, Chunk>();
  readonly stats: TerrainStats = { chunks: 0, voxels: 0, tris: 0, tilesLoading: 0, builds: 0, buildMsTotal: 0, buildJsMsTotal: 0, buildMsMax: 0, lastFrameBuildMs: 0 };

  constructor(private readonly R: typeof RAPIER, private readonly world: RAPIER.World, meta: Meta, readonly origin: { x: number; z: number }) {
    this.N = meta.tiles.N;
    this.nx = Math.ceil(meta.W / this.N);
    this.nz = Math.ceil(meta.D / this.N);
    this.solidMat = Uint8Array.from(meta.palette, (p) => (p[3] === MAT.GRASS ? 0 : 1));
    this.paved = Uint8Array.from(meta.palette, (p) => (pavedGround(p) ? PAL_GROUND : 0));
  }

  // Builds what the bodies at `points` (world coordinates) need, within the frame's budget. Returns, per point,
  // whether its close surroundings are built (a body whose aren't should be frozen).
  update(points: { x: number; z: number }[]): boolean[] {
    const now = performance.now(), start = now;
    const want: { key: number; d: number }[] = [];
    const seen = new Set<number>();
    for (const p of points) {
      const c0x = Math.floor((p.x - REACH) / CHUNK), c1x = Math.floor((p.x + REACH) / CHUNK);
      const c0z = Math.floor((p.z - REACH) / CHUNK), c1z = Math.floor((p.z + REACH) / CHUNK);
      for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
        if (cx < 0 || cz < 0 || cx * CHUNK >= this.nx * this.N || cz * CHUNK >= this.nz * this.N) continue;
        const key = cx + cz * 4096;
        const d = this.chunkDist(cx, cz, p);
        if (d > REACH) continue;
        const ch = this.chunks.get(key);
        if (ch) { ch.usedAt = now; continue; }
        if (!seen.has(key)) { seen.add(key); want.push({ key, d }); }
      }
    }
    want.sort((a, b) => a.d - b.d);
    let spent = 0;
    for (const { key } of want) {
      if (spent > BUILD_BUDGET_MS) break;
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
    this.stats.tilesLoading = [...this.tiles.values()].filter((t) => t === 'loading').length;
    this.stats.lastFrameBuildMs = performance.now() - start;
    return points.map((p) => this.ready(p));
  }

  // are the chunks within NEED_NOW of p built (or off the map)?
  ready(p: { x: number; z: number }) {
    const c0x = Math.floor((p.x - NEED_NOW) / CHUNK), c1x = Math.floor((p.x + NEED_NOW) / CHUNK);
    const c0z = Math.floor((p.z - NEED_NOW) / CHUNK), c1z = Math.floor((p.z + NEED_NOW) / CHUNK);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      if (cx < 0 || cz < 0 || cx * CHUNK >= this.nx * this.N || cz * CHUNK >= this.nz * this.N) continue;
      if (!this.chunks.has(cx + cz * 4096)) return false;
    }
    return true;
  }

  dispose() {
    for (const ch of this.chunks.values()) for (const c of ch.colliders) this.world.removeCollider(c, false);
    this.chunks.clear();
  }

  private chunkDist(cx: number, cz: number, p: { x: number; z: number }) {
    const dx = Math.max(cx * CHUNK - p.x, 0, p.x - (cx + 1) * CHUNK), dz = Math.max(cz * CHUNK - p.z, 0, p.z - (cz + 1) * CHUNK);
    return Math.hypot(dx, dz);
  }

  private tile(tx: number, tz: number): Tile | null {
    const key = tx + tz * this.nx, t = this.tiles.get(key);
    if (t === 'loading' || t === 'failed') return null;
    if (t) return t;
    this.tiles.set(key, 'loading');
    const path = `${tx}_${tz}.bin`;
    Promise.all(['1', '1f'].map((s) => fetchGzip(`data/tiles/${s}/${path}`)))
      .then(([base, foliage]) => this.tiles.set(key, this.decode(base, foliage)))
      .catch((e) => { console.warn('rapier terrain tile', path, e); this.tiles.set(key, 'failed'); });
    return null;
  }

  private decode(baseBuf: ArrayBuffer, foliageBuf: ArrayBuffer): Tile {
    const N = this.N, S = N + 2, base = decodeTile(baseBuf, N), fol = decodeTile(foliageBuf, N);
    const off = (counts: Uint16Array) => { const o = new Uint32Array(counts.length + 1); for (let i = 0; i < counts.length; i++) o[i + 1] = o[i] + counts[i]; return o; };
    const bo = off(base.counts), fo = off(fol.counts);
    const solid: Uint16Array[] = new Array(S * S);
    const iv: number[] = [];
    for (let c = 0; c < S * S; c++) {
      iv.length = 0;
      if (base.ground[c] > 0) iv.push(0, base.ground[c]);
      for (const [cols, o] of [[base, bo], [fol, fo]] as const) {
        for (let k = o[c]; k < o[c + 1]; k++) {
          const z0 = cols.runs[k * 3], n = cols.runs[k * 3 + 1], m = cols.runs[k * 3 + 2];
          if (this.solidMat[m]) iv.push(z0, z0 + n);
        }
      }
      solid[c] = merge(iv);
    }
    const f = rampField(N, base.counts, bo, base.runs, base.ground, this.paved);
    return { S, ground: base.ground, solid, ramps: f.any ? f : null };
  }

  private build(tile: Tile, cx: number, cz: number, now: number): Chunk {
    const { R } = this, N = this.N, S = tile.S, t0 = performance.now();
    const x0 = cx * CHUNK, z0 = cz * CHUNK, lx0 = x0 % N, lz0 = z0 % N;
    const vox: number[] = [], verts: number[] = [], idx: number[] = [];
    for (let j = 0; j < CHUNK; j++) for (let i = 0; i < CHUNK; i++) {
      const c = lx0 + i + 1 + S * (lz0 + j + 1);
      const iv = tile.solid[c];
      const nb = [c - 1, c + 1, c - S, c + S];
      // (a ramp's top voxel is not there: its neighbours' faces against it are open)
      const cut = nb.map((n) => (tile.ramps && ramped(tile.ramps, n) ? tile.ground[n] - 1 : -1));
      const ramp = tile.ramps && ramped(tile.ramps, c);
      const g = tile.ground[c];
      // below the lowest neighbouring ground all four sides are solid: nothing to see there but an interval's ends
      const deep = Math.min(tile.ground[nb[0]], tile.ground[nb[1]], tile.ground[nb[2]], tile.ground[nb[3]], ramp ? g : 1e9) - 2;
      for (let k = 0; k < iv.length; k += 2) {
        const lo = iv[k], hi = iv[k + 1];
        for (let y = lo; y < hi; y++) {
          if (y > lo && y < deep && y < hi - 1) y = Math.min(deep, hi - 1);
          // the ramp's column: its top voxel replaced by the ramp's triangles, the one below kept (a floor under them)
          if (ramp && y === g - 1) continue;
          const exposed = y === hi - 1 || (y === lo && lo > 0) || (ramp && y === g - 2) || nb.some((n, k) => cut[k] === y || !inside(tile.solid[n], y));
          if (exposed) vox.push(i, y, j);
        }
      }
      if (ramp) {
        const f = tile.ramps!, q = [0, 1, 2, 3].map((k) => cornerQ(f, c, k) / 64);
        const b = verts.length / 3;
        verts.push(i, q[0], j, i + 1, q[1], j, i + 1, q[2], j + 1, i, q[3], j + 1);
        // (counter-clockwise seen from above: normals up)
        if (rampDiagonal02(q[0], q[1], q[2], q[3])) idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
        else idx.push(b, b + 3, b + 1, b + 1, b + 3, b + 2);
      }
    }
    this.stats.buildJsMsTotal += performance.now() - t0;
    const tx = x0 - this.origin.x, tz = z0 - this.origin.z;
    const colliders: RAPIER.Collider[] = [];
    if (vox.length) colliders.push(this.world.createCollider(R.ColliderDesc.voxels(new Int32Array(vox), { x: 1, y: 1, z: 1 }).setTranslation(tx, 0, tz).setFriction(0.9)));
    if (idx.length) {
      colliders.push(this.world.createCollider(R.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx), R.TriMeshFlags.FIX_INTERNAL_EDGES)
        .setTranslation(tx, 0, tz).setFriction(0.9)));
    }
    this.stats.voxels += vox.length / 3;
    this.stats.tris += idx.length / 3;
    return { colliders, usedAt: now, voxels: vox.length / 3, tris: idx.length / 3 };
  }
}

function merge(iv: number[]) {
  const pairs: [number, number][] = [];
  for (let k = 0; k < iv.length; k += 2) pairs.push([iv[k], iv[k + 1]]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [a, b] of pairs) {
    if (out.length && a <= out[out.length - 1]) out[out.length - 1] = Math.max(out[out.length - 1], b);
    else out.push(a, b);
  }
  return Uint16Array.from(out);
}

function inside(iv: Uint16Array, y: number) {
  for (let k = 0; k < iv.length; k += 2) {
    if (y < iv[k]) return false;
    if (y < iv[k + 1]) return true;
  }
  return false;
}
