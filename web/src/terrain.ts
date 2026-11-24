import * as THREE from 'three';
import type { Meta } from './core/meta';
import { dataTexture, fetchGzip } from './util';
import { TILE_N as T } from './core/tile-data';

// The bare terrain (scripts/terrain.py), in square chunks of 256 height steps (257 samples a side, the last shared with
// the next chunk) and 512 colour texels, clipped at the map's edges: data/terrain/near (heights every 4 m, colours
// every 2 m: the first moment's ground, below) and data/terrain/far{k} (every 16 * 4^k and 8 * 4^k m: the far ground,
// farground.ts). Fetched by what is near the camera, never the whole map at once.
export const CHUNK = 256;

export interface TerrainChunk {
  // heights: hw x hh samples (decimetres over the base), colours: cw x ch texels (sRGB)
  hw: number; hh: number; cw: number; ch: number;
  h: Uint16Array; rgb: Uint8Array;
}

export async function fetchChunk(dir: string, cx: number, cy: number): Promise<TerrainChunk> {
  const buf = await fetchGzip(`data/terrain/${dir}/${cx}_${cy}.bin`);
  const [hw, hh, cw, ch] = new Uint16Array(buf, 0, 4);
  return { hw, hh, cw, ch, h: new Uint16Array(buf, 8, hw * hh), rgb: new Uint8Array(buf, 8 + hw * hh * 2, cw * ch * 3) };
}

// the colours as a texture (RGBA)
export function chunkTexture(c: TerrainChunk) {
  const n = c.cw * c.ch, rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { rgba[4 * i] = c.rgb[3 * i]; rgba[4 * i + 1] = c.rgb[3 * i + 1]; rgba[4 * i + 2] = c.rgb[3 * i + 2]; rgba[4 * i + 3] = 255; }
  return dataTexture(rgba, c.cw, c.ch, THREE.RGBAFormat);
}

// The first moment's ground: one piece per 128 m tile (heights every 4 m, ground colours every 2 m), for the tiles
// given (those in range of the view distance when the city starts: city.ts), each dropped once its tile is in -- under
// the real ground it would flicker through -- and a chunk's texture with its last piece.
export async function loadTerrain(meta: Meta, scene: THREE.Scene, nx: number, tiles: Iterable<number>) {
  const tw = Math.ceil(meta.W / 4), C = T / 4, per = (CHUNK * 4) / T;
  const byChunk = new Map<string, number[]>();
  for (const i of tiles) {
    const tx = i % nx, ty = Math.floor(i / nx), k = `${Math.floor(tx / per)}_${Math.floor(ty / per)}`;
    (byChunk.get(k) ?? byChunk.set(k, []).get(k)!).push(i);
  }
  const pieces = new Map<number, { mesh: THREE.Mesh; chunk: { n: number; tex: THREE.DataTexture } }>();
  await Promise.all([...byChunk].map(async ([k, list]) => {
    const [cx, cy] = k.split('_').map(Number);
    let c: TerrainChunk;
    try { c = await fetchChunk('near', cx, cy); } catch (e) { console.warn('terrain', k, e); return; }
    const tex = chunkTexture(c);
    Object.assign(tex, { colorSpace: THREE.SRGBColorSpace, magFilter: THREE.NearestFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, anisotropy: 8 });
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }), chunk = { n: 0, tex };
    for (const i of list) {
      const tx = i % nx, ty = Math.floor(i / nx), lc = (tx - cx * per) * C, lr = (ty - cy * per) * C;
      // (the map's last column of samples is tw - 1)
      const nc = Math.min(C, tw - 1 - tx * C) + 1, nr = Math.min(C, c.hh - 1 - lr) + 1;
      if (nc < 2 || nr < 2) continue;
      const pos = new Float32Array(nc * nr * 3), uv = new Float32Array(nc * nr * 2), idx = new Uint16Array((nc - 1) * (nr - 1) * 6);
      for (let r = 0; r < nr; r++) for (let q = 0; q < nc; q++) {
        const j = r * nc + q;
        pos.set([(tx * C + q) * 4, c.h[(lr + r) * c.hw + lc + q] / 10, (ty * C + r) * 4], j * 3);
        uv.set([(lc + q) * 2 / c.cw, (lr + r) * 2 / c.ch], j * 2);
      }
      for (let r = 0, j = 0; r < nr - 1; r++) for (let q = 0; q < nc - 1; q++, j += 6) { const a = r * nc + q; idx.set([a, a + nc, a + 1, a + 1, a + nc, a + nc + 1], j); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      scene.add(m);
      pieces.set(i, { mesh: m, chunk });
      chunk.n++;
    }
    if (!chunk.n) tex.dispose();
  }));
  return {
    // the tile's piece gone (true if there was one)
    drop(i: number) {
      const p = pieces.get(i);
      if (!p) return false;
      scene.remove(p.mesh); p.mesh.geometry.dispose(); pieces.delete(i);
      if (--p.chunk.n === 0) { p.chunk.tex.dispose(); (p.mesh.material as THREE.Material).dispose(); p.chunk.tex.image.data = null as unknown as Uint8Array; }
      return true;
    },
    // each tile where a piece still stands
    each(f: (i: number) => void) { for (const i of pieces.keys()) f(i); },
    // the colour textures' bytes held (tools)
    get bytes() { const s = new Set<THREE.DataTexture>(); for (const p of pieces.values()) s.add(p.chunk.tex); let b = 0; for (const t of s) b += t.image.data?.byteLength ?? 0; return b; },
  };
}
