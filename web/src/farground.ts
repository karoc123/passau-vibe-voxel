import * as THREE from 'three';
import type { Meta } from './types';
import { dataTexture, fetchGzip } from './util';
import { CUT_T } from './daylight';

// The ground beyond the view distance (settings.ts dist): the bare terrain (terrain.bin, scripts/terrain.py) at STEP m,
// no buildings, in pieces of PIECE m (culled by the view's frustum), under the fog -- at the distance the fog is full
// (daylight.ts), so what it shows is the land's outline against the sky: the hills over the rivers, not an empty
// band of haze under the horizon. Where the city's tiles are drawn (or the first moment's terrain, city.ts
// loadTerrain) it gives way: a mask of the 128 m tiles, looked up per pixel, discards it there. It casts and
// takes no shadow and is not in the depth pre-pass. Its fog thins again past the distance (FAR_T): a little of the
// land shows through, so the hills beyond stand out faintly against the sky. A metre under the ground, so that where it meets a tile its edge
// stays under the tile's. Whole map: ~70 k triangles at 16 m.
const STEP = 16, PIECE = 1024, T = 128;
// past the view distance the far ground's fog thins again, from full at the distance to FAR_T of the way up its ramp
// (smoothstep(0.7): 0.78 of the fog) at FAR_OUT times it
const FAR_T = 0.7, FAR_OUT = 1.6;

export class FarGround {
  readonly group = new THREE.Group();
  private readonly mask: Uint8Array;
  private readonly maskTex: THREE.DataTexture;

  constructor(meta: Meta, private readonly nx: number, private readonly ny: number) {
    this.mask = new Uint8Array(nx * ny);
    this.maskTex = dataTexture(this.mask, nx, ny, THREE.RedFormat);
    this.group.visible = false;
    this.group.name = 'farground';
    void this.build(meta).catch((e) => console.warn('far ground', e));
  }

  private async build(meta: Meta) {
    const { W, D } = meta, buf = await fetchGzip('data/terrain.bin');
    const tw = Math.ceil(W / 4), th = Math.ceil(D / 4), hd = new Uint16Array(buf, 0, tw * th);
    // the colours every 2 m, averaged to every 8 m
    const cw = Math.floor(W / 2), ch = Math.floor(D / 2), rgb = new Uint8Array(buf, tw * th * 2, cw * ch * 3);
    const w8 = Math.floor(cw / 4), h8 = Math.floor(ch / 4), col = new Uint8Array(w8 * h8 * 4);
    for (let y = 0; y < h8; y++) for (let x = 0; x < w8; x++) {
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) s += rgb[((4 * y + j) * cw + 4 * x + i) * 3 + k];
        col[(y * w8 + x) * 4 + k] = s >> 4;
      }
      col[(y * w8 + x) * 4 + 3] = 255;
    }
    const tex = dataTexture(col, w8, h8, THREE.RGBAFormat);
    Object.assign(tex, { colorSpace: THREE.SRGBColorSpace, magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true });
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uFarMask = { value: this.maskTex };
      // the view distance's fog full at the distance, where the city's tiles end (no seam with theirs), then thinner
      // again further out: the far hills' shape shows faintly against the sky, as through haze (the weather's fog,
      // where it is denser, still is). Not as a fog would be, but there is nothing in that ring to see either way.
      if (!sh.vertexShader.includes('#include <fog_vertex>') || !THREE.ShaderChunk.fog_vertex.includes(CUT_T)) throw new Error('three: lambert without fog_vertex');
      sh.vertexShader = sh.vertexShader.replace('#include <fog_vertex>', THREE.ShaderChunk.fog_vertex
        .replace(CUT_T, `min( ${CUT_T}, 1.0 - ${(1 - FAR_T).toFixed(3)} * smoothstep( fogCut.y, fogCut.y * ${FAR_OUT.toFixed(2)}, fogM ) )`));
      // the pixel's place on the map from its view-space position (Lambert's vViewPosition): no varying of its own
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uFarMask;')
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          { vec3 wp = transpose(mat3(viewMatrix)) * -vViewPosition + cameraPosition;
            ivec2 n = textureSize(uFarMask, 0), t = clamp(ivec2(floor(wp.xz / ${T}.0)), ivec2(0), n - 1);
            if (texelFetch(uFarMask, t, 0).r > 0.5) discard; }`);
    };
    mat.customProgramCacheKey = () => 'farground';
    const hAt = (c: number, r: number) => hd[Math.min(th - 1, r) * tw + Math.min(tw - 1, c)] / 10 - 1;
    const k = STEP / 4, P = PIECE / STEP;
    for (let py = 0; py * PIECE < D; py++) for (let px = 0; px * PIECE < W; px++) {
      const c0 = px * P, r0 = py * P, nc = Math.min(P, Math.ceil(W / STEP) - c0) + 1, nr = Math.min(P, Math.ceil(D / STEP) - r0) + 1;
      const pos = new Float32Array(nc * nr * 3), uv = new Float32Array(nc * nr * 2), idx = new Uint16Array((nc - 1) * (nr - 1) * 6);
      for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
        const x = Math.min(W, (c0 + c) * STEP), z = Math.min(D, (r0 + r) * STEP), i = r * nc + c;
        pos.set([x, hAt((c0 + c) * k, (r0 + r) * k), z], i * 3);
        uv.set([x / (w8 * 8), z / (h8 * 8)], i * 2);
      }
      for (let r = 0, j = 0; r < nr - 1; r++) for (let c = 0; c < nc - 1; c++, j += 6) { const i = r * nc + c; idx.set([i, i + nc, i + 1, i + 1, i + nc, i + nc + 1], j); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.matrixAutoUpdate = false;
      m.name = 'farground';
      // after the city (opaque things sort by renderOrder first): where a tile is drawn the depth test throws its
      // pixels out before the shader (which discards, so it would get no early test of its own)
      m.renderOrder = 1;
      m.userData.tiles = [px * (PIECE / T), py * (PIECE / T)];
      this.group.add(m);
    }
    this.cull();
  }

  // where the city stands in (1: some tile drawn over the whole of that 128 m square); a piece under the city
  // all over is not drawn at all
  setMask(cover: Uint8Array) {
    let changed = false;
    for (let i = 0; i < cover.length; i++) { const v = cover[i] ? 255 : 0; if (v !== this.mask[i]) { this.mask[i] = v; changed = true; } }
    if (!changed) return;
    this.maskTex.needsUpdate = true;
    this.cull();
  }

  private cull() {
    const n = PIECE / T;
    for (const m of this.group.children) {
      const [x0, y0] = m.userData.tiles as number[];
      let open = false;
      for (let y = y0; y < Math.min(this.ny, y0 + n) && !open; y++) for (let x = x0; x < Math.min(this.nx, x0 + n); x++) if (!this.mask[y * this.nx + x]) { open = true; break; }
      m.visible = open;
    }
  }

  set on(v: boolean) { this.group.visible = v; }
}
