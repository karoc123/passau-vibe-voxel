import * as THREE from 'three';
import type { Fields } from './tile-data';
import { dataTexture } from './util';

// What the shader knows per cell besides the voxels -- the rivers' levels and bed, foliage, the light of lit windows
// on the street (scripts/tile_fields.py) -- comes with each node's file (tile-data.ts Fields), at the node's own cell
// size, and is read from the nodes shown, never from a map of the whole: a node shown (city.ts) gets a page in two
// array textures, a node hidden gives it back, so what is on the GPU is the shown nodes' share, at most the view's.
//   uPageF  RGBA8, per page N x N cells of s m: the level the river reaches the cell at (m over the base, 255: never),
//           the river bed (dm), foliage class and tree
//   uPageS  RG8, per page (N/2 + 2)^2 cells of 2s m with a one-cell apron (bilinear across the node's edge): the
//           window light (two kinds), a soft light blurred over ~6 m
// Four pages to a layer (2 x 2: array layers are few on some GPUs, 256 at least), layers added as more nodes show
// (a quarter more at a time: the textures hold little more than the pages shown at the most so far).
// uPageIdx: per 128 m tile of the map (a few hundred bytes; 235 x 235 for 30 km), the page of the node shown over it
// and its cell size -- the shader's way from a point to its page (FIELDS_GLSL pageAt).
const N = 128, M = N / 2 + 2, T = 128;
const F_W = 2 * N, S_W = 2 * M, F_LAYER = F_W * F_W * 4, S_LAYER = S_W * S_W * 2;

export interface FieldUniforms {
  uPageIdx: { value: THREE.Texture };
  uPageF: { value: THREE.DataArrayTexture };
  uPageS: { value: THREE.DataArrayTexture };
}

function arrayTexture(data: Uint8Array, w: number, layers: number, format: THREE.PixelFormat, filter: THREE.TextureFilter) {
  const t = new THREE.DataArrayTexture(data, w, w, layers);
  t.format = format;
  t.type = THREE.UnsignedByteType;
  t.magFilter = t.minFilter = filter as THREE.MagnificationTextureFilter & THREE.MinificationTextureFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export function fieldUniforms(): FieldUniforms {
  const one = (bytes: number, w: number, f: THREE.PixelFormat, filter: THREE.TextureFilter) => arrayTexture(new Uint8Array(bytes), w, 1, f, filter);
  return {
    uPageIdx: { value: dataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat) },
    uPageF: { value: one(F_LAYER, F_W, THREE.RGBAFormat, THREE.NearestFilter) },
    uPageS: { value: one(S_LAYER, S_W, THREE.RGFormat, THREE.LinearFilter) },
  };
}

export class FieldPages {
  private readonly idx: Uint8Array;
  private readonly idxTex: THREE.DataTexture;
  private layers = 0;
  private f = new Uint8Array(0);
  private s = new Uint8Array(0);
  private readonly free: number[] = [];
  private readonly slot = new Map<string, { slot: number; s: number; tx: number; ty: number }>();
  private readonly dirty = new Set<number>();
  private idxDirty = false;
  private grown = false;
  // the most layers the GPU takes
  maxLayers = 256;

  constructor(private readonly U: FieldUniforms, private readonly nx: number, private readonly ny: number) {
    this.idx = new Uint8Array(nx * ny * 4);
    this.idxTex = dataTexture(this.idx, nx, ny, THREE.RGBAFormat);
    this.idxTex.magFilter = this.idxTex.minFilter = THREE.NearestFilter;
    U.uPageIdx.value = this.idxTex;
    this.grow(8);
  }

  // on the GPU now: layers, pages in use, bytes
  get stats() { return { layers: this.layers, pages: this.slot.size, bytes: this.f.byteLength + this.s.byteLength + this.idx.byteLength }; }

  private grow(layers: number) {
    const f = new Uint8Array(layers * F_LAYER), s = new Uint8Array(layers * S_LAYER);
    f.set(this.f); s.set(this.s);
    for (let k = layers * 4 - 1; k >= this.layers * 4; k--) this.free.push(k);
    this.f = f; this.s = s; this.layers = layers;
    this.grown = true;
  }

  // node (s, tx, ty) shown, with its fields (none: an empty node, nothing to read there)
  show(key: string, s: number, tx: number, ty: number, fields: Fields | null | undefined) {
    if (this.slot.has(key) || !fields) return;
    if (!this.free.length) {
      if (this.layers >= this.maxLayers) { console.warn('fields: no page left for', key); return; }
      this.grow(Math.min(this.maxLayers, this.layers + Math.max(4, this.layers >> 2)));
    }
    const k = this.free.pop()!, layer = k >> 2, qx = k & 1, qy = (k >> 1) & 1;
    // the page into its quarter of the layer, row by row
    for (let r = 0; r < N; r++) this.f.set(fields.cell.subarray(r * N * 4, (r + 1) * N * 4), layer * F_LAYER + ((qy * N + r) * F_W + qx * N) * 4);
    for (let r = 0; r < M; r++) this.s.set(fields.spill.subarray(r * M * 2, (r + 1) * M * 2), layer * S_LAYER + ((qy * M + r) * S_W + qx * M) * 2);
    this.dirty.add(layer);
    this.slot.set(key, { slot: k, s, tx, ty });
    this.mark(s, tx, ty, k);
  }

  hide(key: string) {
    const p = this.slot.get(key);
    if (!p) return;
    this.slot.delete(key);
    this.free.push(p.slot);
    this.mark(p.s, p.tx, p.ty, p.slot, true);
  }

  // the tiles under node (s, tx, ty) point to page k (or no longer, if they still did)
  private mark(s: number, tx: number, ty: number, k: number, clear = false) {
    for (let y = ty * s; y < Math.min(this.ny, (ty + 1) * s); y++) for (let x = tx * s; x < Math.min(this.nx, (tx + 1) * s); x++) {
      const i = (y * this.nx + x) * 4;
      if (clear) {
        if (this.idx[i + 3] && this.idx[i] + 256 * this.idx[i + 1] === k) this.idx.fill(0, i, i + 4);
      } else this.idx.set([k & 255, k >> 8, s, 255], i);
    }
    this.idxDirty = true;
  }

  // the changes to the GPU (before the frame is drawn)
  flush() {
    if (this.idxDirty) { this.idxTex.needsUpdate = true; this.idxDirty = false; }
    if (this.grown) {
      const U = this.U;
      U.uPageF.value.dispose(); U.uPageS.value.dispose();
      U.uPageF.value = arrayTexture(this.f, F_W, this.layers, THREE.RGBAFormat, THREE.NearestFilter);
      U.uPageS.value = arrayTexture(this.s, S_W, this.layers, THREE.RGFormat, THREE.LinearFilter);
      this.grown = false; this.dirty.clear();
      return;
    }
    if (!this.dirty.size) return;
    for (const l of this.dirty) { this.U.uPageF.value.addLayerUpdate(l); this.U.uPageS.value.addLayerUpdate(l); }
    this.U.uPageF.value.needsUpdate = this.U.uPageS.value.needsUpdate = true;
    this.dirty.clear();
  }
}

// The shader's side: from a point (metres, x and z) to the page of the node shown over it, and what it holds there.
export const FIELDS_GLSL = `
  uniform sampler2D uPageIdx; uniform highp sampler2DArray uPageF; uniform highp sampler2DArray uPageS;
  // the page of the node shown over p (x, -1: none) and the node's cell size (y)
  ivec2 pageAt(vec2 p) {
    ivec2 t = ivec2(floor(p * ${(1 / T).toFixed(7)})), sz = textureSize(uPageIdx, 0);
    if (any(lessThan(t, ivec2(0))) || any(greaterThanEqual(t, sz))) return ivec2(-1, 1);
    vec4 e = texelFetch(uPageIdx, t, 0) * 255.0 + 0.5;
    return e.w > 128.0 ? ivec2(int(e.x) + 256 * int(e.y), int(e.z)) : ivec2(-1, 1);
  }
  // the cell's texel at p: the river's level and bed, foliage class and tree, as bytes over 255; a = 0 where no node is
  // shown (else 1 + its slot)
  vec4 cellAt(vec2 p, out int a) {
    ivec2 pg = pageAt(p);
    a = pg.x + 1;
    if (pg.x < 0) return vec4(1.0, 0.0, 0.0, 0.0);
    ivec2 c = ivec2(floor(p / float(pg.y))) & ${N - 1}, o = ivec2(pg.x & 1, (pg.x >> 1) & 1) * ${N};
    return texelFetch(uPageF, ivec3(o + c, pg.x >> 2), 0);
  }
  // the river at p (scripts/flood.py): x the level at which it reaches the cell (m over the base, 255 never), y the bed
  // under the surveyed surface (m), -1 where no node is shown
  vec2 riverAt(vec2 p) {
    int a;
    vec2 v = cellAt(p, a).rg * 255.0;
    return a == 0 ? vec2(255.0, -1.0) : vec2(floor(v.x + 0.5), floor(v.y + 0.5) * 0.1);
  }
  // foliage at p (scripts/phenology.py): class and tree, as bytes over 255 (0: none, also where no node is shown)
  vec2 foliageAtP(vec2 p) { int a; return cellAt(p, a).ba; }
  // the light of lit windows on the street at p (scripts/tile_fields.py spill_map), bilinear: homes and hotels, offices
  // and public buildings
  vec2 spillAt(vec2 p) {
    ivec2 pg = pageAt(p);
    if (pg.x < 0) return vec2(0.0);
    float r = float(2 * pg.y);
    vec2 q = p / r - floor(p / (r * ${M - 2}.0)) * ${M - 2}.0 + 1.0, o = vec2(ivec2(pg.x & 1, (pg.x >> 1) & 1) * ${M});
    return texture(uPageS, vec3((o + q) / ${S_W}.0, float(pg.x >> 2))).rg;
  }`;
