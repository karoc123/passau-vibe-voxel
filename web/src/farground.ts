import * as THREE from 'three';
import type { Meta } from './core/meta';
import { CUT_T } from './daylight';
import { CHUNK, chunkTexture, fetchChunk, gridQuads, type TerrainChunk } from './terrain';
import { TILE_N as T } from './core/tile-data';

// The ground beyond the view distance (settings.ts dist): the bare terrain (scripts/terrain.py, data/terrain/far{k}),
// no buildings, under the fog -- at the distance the fog is full (daylight.ts), so what it shows is the land's outline
// against the sky: the hills over the rivers, not an empty band of haze under the horizon. Where the city's tiles are
// drawn (or the first moment's terrain, city.ts) it gives way: per 128 m tile a bit, looked up per pixel, discards it
// there. It casts and takes no shadow and is not in the depth pre-pass. Its fog thins again past the distance (FAR_T):
// a little of the land shows through, so the hills beyond stand out faintly against the sky. A metre under the ground,
// so that where it meets a tile its edge stays under the tile's.
// In chunks, as a clipmap: level k has a vertex every 16 * 4^k m, a chunk 256 of those a side, in 4 x 4 pieces of
// 64 x 64 quads (culled by the view's frustum; level 0's pieces 1024 m, 8 x 8 tiles). The coarsest level's chunks are
// always there (one covers the map, or up to the level of 64 m the map's chunks: see terrain.py); a chunk of a finer
// level k is fetched while the camera is within NEAR * its side of it (or a tile in it is covered), and once it is
// in, its coarser parent's piece over it is not drawn. Only while the far ground is on (a view distance set); what is
// held follows the camera, not the map's area. Level 0 alone carries the tiles' mask (64 bits a piece, a uniform).
const STEP = 16, Q = 64, NEAR = 0.25, KEEP = 1.5;
// past the view distance the far ground's fog thins again, from full at the distance to FAR_T of the way up its ramp
// (smoothstep(0.7): 0.78 of the fog) at FAR_OUT times it
const FAR_T = 0.7, FAR_OUT = 1.6;

interface Chunk {
  k: number; cx: number; cy: number; key: string;
  ready: boolean; gone: boolean;
  pieces: (Piece | null)[];
  tex?: THREE.DataTexture;
  bytes: number;
}
interface Piece { mesh: THREE.Mesh; mask: Uint32Array; origin: THREE.Vector2 }

export class FarGround {
  readonly group = new THREE.Group();
  private readonly top: number;
  private readonly chunks = new Map<string, Chunk>();
  // level 0's pieces (by index py * pw + px): the covered tiles' bits, where any
  private readonly bits = new Map<number, Uint32Array>();
  private readonly pw: number;
  // per level 0 chunk (by index), its covered tiles
  private readonly coveredIn = new Map<number, number>();
  private changed = true;
  private enabled = false;

  constructor(private readonly meta: Meta, private readonly nx: number, private readonly ny: number) {
    // the levels as terrain.py writes them: up to the first whose one chunk covers the map
    let k = 0;
    while (CHUNK * STEP * 4 ** k < Math.max(meta.W, meta.D)) k++;
    this.top = k;
    this.pw = Math.ceil(nx / 8);
    this.group.visible = false;
    this.group.name = 'farground';
  }

  // a level's vertex step, and its chunks' side (metres), and how many chunks a side over the map
  private step(k: number) { return STEP * 4 ** k; }
  private side(k: number) { return CHUNK * this.step(k); }
  private count(k: number) {
    const s = this.step(k), nc = Math.ceil(this.meta.W / s) + 1, nr = Math.ceil(this.meta.D / s) + 1;
    return [Math.max(1, Math.ceil((nc - 1) / CHUNK)), Math.max(1, Math.ceil((nr - 1) / CHUNK))];
  }

  private fetch(k: number, cx: number, cy: number) {
    const key = `${k}/${cx}_${cy}`, c: Chunk = { k, cx, cy, key, ready: false, gone: false, pieces: [], bytes: 0 };
    this.chunks.set(key, c);
    fetchChunk(`far${k}`, cx, cy).then((d) => { if (!c.gone) this.build(c, d); })
      .catch((e) => { console.warn('far ground', key, e); });
    return c;
  }

  private build(c: Chunk, d: TerrainChunk) {
    const { W, D } = this.meta, s = this.step(c.k), X0 = c.cx * this.side(c.k), Z0 = c.cy * this.side(c.k), cs = s / 2;
    const tex = c.tex = chunkTexture(d);
    Object.assign(tex, { colorSpace: THREE.SRGBColorSpace, magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true });
    c.bytes = d.cw * d.ch * 4;
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const c0 = px * Q, r0 = py * Q, nc = Math.min(Q, d.hw - 1 - c0) + 1, nr = Math.min(Q, d.hh - 1 - r0) + 1;
      if (nc < 2 || nr < 2) { c.pieces.push(null); continue; }
      const pos = new Float32Array(nc * nr * 3), uv = new Float32Array(nc * nr * 2), idx = new Uint16Array((nc - 1) * (nr - 1) * 6);
      for (let r = 0; r < nr; r++) for (let q = 0; q < nc; q++) {
        const x = Math.min(W, X0 + (c0 + q) * s), z = Math.min(D, Z0 + (r0 + r) * s), i = r * nc + q;
        pos.set([x, d.h[(r0 + r) * d.hw + c0 + q] / 10 - 1, z], i * 3);
        uv.set([(x - X0) / (d.cw * cs), (z - Z0) / (d.ch * cs)], i * 2);
      }
      const n = gridQuads(idx, nc, nr, (i) => d.h[(r0 + Math.floor(i / nc)) * d.hw + c0 + i % nc] > 0);
      if (!n) { c.pieces.push(null); continue; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx.subarray(0, n), 1));
      g.computeVertexNormals();
      const p: Piece = { mesh: null!, mask: new Uint32Array(2), origin: new THREE.Vector2(X0 + c0 * s, Z0 + r0 * s) };
      const m = p.mesh = new THREE.Mesh(g, this.material(tex, p));
      m.matrixAutoUpdate = false;
      m.name = 'farground';
      // after the city (opaque things sort by renderOrder first): where a tile is drawn the depth test throws its
      // pixels out before the shader (which discards, so it would get no early test of its own)
      m.renderOrder = 1;
      m.visible = false;
      c.pieces.push(p);
      this.group.add(m);
    }
    c.ready = true;
    this.changed = true;
  }

  // (level 0) the piece's index over the map
  private pieceAt(c: Chunk, px: number, py: number) { return (c.cy * 4 + py) * this.pw + c.cx * 4 + px; }

  private material(tex: THREE.Texture, p: Piece) {
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const uMask = { value: p.mask }, uOrigin = { value: p.origin };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uFarMask = uMask;
      sh.uniforms.uFarOrigin = uOrigin;
      // the view distance's fog full at the distance, where the city's tiles end (no seam with theirs), then thinner
      // again further out: the far hills' shape shows faintly against the sky, as through haze (the weather's fog,
      // where it is denser, still is). Not as a fog would be, but there is nothing in that ring to see either way.
      if (!sh.vertexShader.includes('#include <fog_vertex>') || !THREE.ShaderChunk.fog_vertex.includes(CUT_T)) throw new Error('three: lambert without fog_vertex');
      sh.vertexShader = sh.vertexShader.replace('#include <fog_vertex>', THREE.ShaderChunk.fog_vertex
        .replace(CUT_T, `min( ${CUT_T}, 1.0 - ${(1 - FAR_T).toFixed(3)} * smoothstep( fogCut.y, fogCut.y * ${FAR_OUT.toFixed(2)}, fogM ) )`));
      // the pixel's place on the map from its view-space position (Lambert's vViewPosition): no varying of its own;
      // its tile's bit in the piece's mask
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform uvec2 uFarMask; uniform vec2 uFarOrigin;')
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          { vec3 wp = transpose(mat3(viewMatrix)) * -vViewPosition + cameraPosition;
            ivec2 t = clamp(ivec2(floor((wp.xz - uFarOrigin) / ${T}.0)), ivec2(0), ivec2(7));
            int b = t.y * 8 + t.x;
            if ((((b < 32 ? uFarMask.x : uFarMask.y) >> uint(b & 31)) & 1u) != 0u) discard; }`);
    };
    mat.customProgramCacheKey = () => 'farground';
    return mat;
  }

  private free(c: Chunk) {
    c.gone = true;
    this.chunks.delete(c.key);
    for (const p of c.pieces) if (p) { this.group.remove(p.mesh); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose(); }
    c.tex?.dispose();
    this.changed = true;
  }

  // some tile covered under level k's chunk (x, y) (a level 0 chunk is fetched for it even out of NEAR, as after a jump)
  private coveredUnder(k: number, x: number, y: number) {
    const f = 4 ** k, w = Math.ceil(this.nx / 32);
    for (const ck of this.coveredIn.keys()) if (Math.floor((ck % w) / f) === x && Math.floor(Math.floor(ck / w) / f) === y) return true;
    return false;
  }

  // where the city stands in (some tile drawn over the whole of that 128 m square), tile by tile as it changes; a
  // piece under the city all over is not drawn at all. Shown at the next flush
  mark(i: number, covered: boolean) {
    const tx = i % this.nx, ty = Math.floor(i / this.nx), k = (ty >> 3) * this.pw + (tx >> 3), b = (ty & 7) * 8 + (tx & 7);
    let m = this.bits.get(k);
    const was = m ? (m[b >> 5] >>> (b & 31)) & 1 : 0;
    if (was === +covered) return;
    if (!m) this.bits.set(k, m = new Uint32Array(2));
    m[b >> 5] ^= 1 << (b & 31);
    if (!m[0] && !m[1]) this.bits.delete(k);
    const ck = (ty >> 5) * Math.ceil(this.nx / 32) + (tx >> 5), n = (this.coveredIn.get(ck) ?? 0) + (covered ? 1 : -1);
    if (n) this.coveredIn.set(ck, n); else this.coveredIn.delete(ck);
    this.changed = true;
  }

  // the chunks wanted near the camera (at: its place), fetched or freed; the pieces' masks and which are drawn
  flush(at: THREE.Vector3) {
    if (!this.enabled) return;
    const want = new Set<string>(), near = (k: number, cx: number, cy: number, r: number) => {
      const L = this.side(k);
      return Math.hypot(Math.max(cx * L - at.x, 0, at.x - (cx + 1) * L), Math.max(cy * L - at.z, 0, at.z - (cy + 1) * L)) < r * L;
    };
    const visit = (k: number, cx: number, cy: number) => {
      const [n, m] = this.count(k);
      if (cx >= n || cy >= m) return;
      want.add(`${k}/${cx}_${cy}`);
      if (!k) return;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const x = cx * 4 + i, y = cy * 4 + j, held = this.chunks.has(`${k - 1}/${x}_${y}`);
        if (near(k - 1, x, y, held ? NEAR * KEEP : NEAR) || this.coveredUnder(k - 1, x, y)) visit(k - 1, x, y);
      }
    };
    const [n, m] = this.count(this.top);
    for (let cy = 0; cy < m; cy++) for (let cx = 0; cx < n; cx++) visit(this.top, cx, cy);
    for (const c of [...this.chunks.values()]) if (!want.has(c.key)) this.free(c);
    for (const key of want) if (!this.chunks.has(key)) { const [k, xy] = key.split('/'), [x, y] = xy.split('_').map(Number); this.fetch(+k, x, y); }
    if (!this.changed) return;
    this.changed = false;
    for (const c of this.chunks.values()) {
      if (!c.ready) continue;
      c.pieces.forEach((p, j) => {
        if (!p) return;
        const px = j & 3, py = j >> 2;
        if (c.k === 0) {
          // drawn while some tile of it within the map is not covered
          const pk = this.pieceAt(c, px, py), b = this.bits.get(pk), tx0 = (c.cx * 4 + px) * 8, ty0 = (c.cy * 4 + py) * 8;
          p.mask[0] = b?.[0] ?? 0; p.mask[1] = b?.[1] ?? 0;
          const tiles = Math.max(0, Math.min(8, this.nx - tx0)) * Math.max(0, Math.min(8, this.ny - ty0));
          p.mesh.visible = popcount(p.mask[0]) + popcount(p.mask[1]) < tiles;
        } else {
          // drawn while the finer chunk over it is not in
          p.mesh.visible = !this.chunks.get(`${c.k - 1}/${c.cx * 4 + px}_${c.cy * 4 + py}`)?.ready;
        }
      });
    }
  }

  set on(v: boolean) {
    if (v !== this.enabled) this.changed = true;
    this.enabled = this.group.visible = v;
  }

  // what is held (tools): chunks by level, the colour textures' bytes
  get stats() {
    const by: Record<number, number> = {};
    let bytes = 0;
    for (const c of this.chunks.values()) { by[c.k] = (by[c.k] ?? 0) + 1; bytes += c.bytes; }
    return { chunks: by, bytes };
  }
}

function popcount(v: number) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
