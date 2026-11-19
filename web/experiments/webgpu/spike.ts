// WebGPU spike: is the city's voxel rendering faster through three's WebGPURenderer than through WebGLRenderer?
// Standalone (vite dev: /experiments/webgpu/?r=gl|gpu|gpuc&view=overview); not part of the app or its build.
// It loads the very tile meshes the app shows at a view (sets/<view>.json, dumped from the running app), meshed by the
// app's own mesher worker, and draws them with a material doing the same work in both: the vFace-style face decode,
// the palette, baked AO, Lambert sun + sky light and one 2048 PCF shadow map, at 1400 x 900, no post-processing.
//   r=gl    WebGLRenderer, the material patched through shader chunks (gl.ts), facing culling by WEBGL_multi_draw
//   r=gpu   WebGPURenderer + TSL (gpu.ts), the vertex data as three uploads it (integers widened to 32 bits)
//   r=gpuc  the same with the vertex data kept 8/16-bit (normalized formats, scaled back in the shader)
// Facing culling on WebGPU: one drawIndexedIndirect per run (WebGPU has no multi-draw; three's BatchedMesh also loops
// drawIndexed per range). window.__spike.measure() times frames: CPU (render call, culling included), GPU (timestamp
// queries / EXT_disjoint_timer_query_webgl2) and the rAF interval with vsync off. bench.mjs drives it.
import * as THREE from 'three';
import type { MeshOut, MeshReply, MeshRequest } from '../../src/mesher.worker';
import type { Meta } from '../../src/types';
import { MAT } from '../../src/voxelMaterial';
import { PAL_ROOF, PAL_WALL } from '../../src/chamfer';
import { fetchGzip, fetchJson } from '../../src/util';

export interface FrameOut { cpu: number; quads: number; tris: number }
export interface Variant {
  name: string;
  info: Record<string, unknown>;
  domElement: HTMLCanvasElement;
  makeMaterial(palette: THREE.Texture, foliage: boolean): THREE.Material;
  prepareGeometry?(geo: THREE.BufferGeometry): void;
  prepare(mesh: THREE.Mesh, key: string): void;
  setCull(on: boolean, meshes: THREE.Mesh[]): void;
  frame(scene: THREE.Scene, camera: THREE.Camera, timed: boolean, k: number, sun: THREE.DirectionalLight): FrameOut;
  // WebGPU: this frame's GPU time (timestamp queries, all passes)
  frameGpu?(): Promise<number>;
  // WebGL: the timed frames' GPU times, once they are all in
  gpuTimes(): Promise<number[]>;
  // wait until the GPU has done all submitted so far
  sync(): Promise<void>;
}
interface SetFile { cam: { pos: number[]; quat: number[]; fov: number }; sun: number[]; nodes: { key: string; quads: number }[] }

const W = 1400, H = 900;
const status = document.getElementById('status')!;
const say = (s: string) => { status.textContent = s; };
const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
const WALLS = new Set<number>([MAT.SOLID, MAT.WALL, MAT.GLASS, MAT.FLOODLIT, MAT.CONCRETE, MAT.BRONZE, MAT.RIBBON, MAT.CLASSIC, MAT.WINDOW, MAT.TENEMENT]);

async function main() {
  const qs = new URLSearchParams(location.search), r = qs.get('r') ?? 'gl', view = qs.get('view') ?? 'overview';
  const root = `${location.origin}/`;
  const [meta, set, zbuf] = await Promise.all([fetchJson<Meta>(`${root}data/meta.json`), fetchJson<SetFile>(`./sets/${view}.json`), fetchGzip(`${root}data/zones.bin`)]);
  const N = meta.tiles.N, bld = new Uint16Array(zbuf, meta.W * meta.D * 2, meta.W * meta.D);
  const v: Variant = r === 'gl' ? await (await import('./gl')).makeGl(document.body, W, H)
    : await (await import('./gpu')).makeGpu(document.body, W, H, r === 'gpuc');

  // the app's palette texture (voxelMaterial.ts makePaletteTexture, without the ground classes)
  const pdata = new Uint8Array(64 * 64 * 4);
  meta.palette.forEach((p, i) => pdata.set([p[0], p[1], p[2], p[3]], i * 4));
  const palette = new THREE.DataTexture(pdata, 64, 64, THREE.RGBAFormat);
  palette.magFilter = palette.minFilter = THREE.NearestFilter;
  palette.needsUpdate = true;
  const mat = v.makeMaterial(palette, false), folMat = v.makeMaterial(palette, true);

  // mesh the set with the app's worker, requested as stream.ts does
  const roofPal = Uint8Array.from(meta.palette, (p) => (p[3] === MAT.ROOF ? PAL_ROOF : WALLS.has(p[3]) ? PAL_WALL : 0));
  const leafPal = Uint8Array.from(meta.palette, (p) => (p[3] === MAT.LEAF ? 1 : 0));
  const S = N + 2;
  const buildingIds = (x0: number, y0: number, s: number) => {
    const out = new Uint16Array(S * S);
    if (s === 1) {
      const xa = Math.max(0, x0 - 1), xb = Math.min(x0 + S - 1, meta.W);
      for (let rr = 0; rr < S; rr++) { const y = y0 - 1 + rr; if (y >= 0 && y < meta.D) out.set(bld.subarray(y * meta.W + xa, y * meta.W + xb), rr * S + xa - (x0 - 1)); }
      return out;
    }
    const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < meta.W && y < meta.D ? bld[y * meta.W + x] : 0), h = s >> 1;
    for (let rr = 0; rr < S; rr++) for (let c = 0; c < S; c++) {
      const X = x0 + (c - 1) * s, Y = y0 + (rr - 1) * s;
      let b = at(X + h, Y + h);
      for (let k = 0; !b && k < s * s; k++) b = at(X + (k % s), Y + Math.floor(k / s));
      out[rr * S + c] = b;
    }
    return out;
  };
  const file = (k: string) => `${root}data/tiles/${k}.bin`;
  const reqs: MeshRequest[] = set.nodes.map(({ key }) => {
    const [lv, rest] = key.split('/'), [tx, ty] = rest.split('_').map(Number), s = lv === 'f' ? 1 : +lv, x0 = tx * N * s, y0 = ty * N * s;
    if (lv === 'f') return { key, N, s: 1, x0, y0, url: file(`1f/${tx}_${ty}`), under: file(`1/${tx}_${ty}`), keep: false, dataOnly: false, bld: null, roof: null,
      base: { bld: buildingIds(x0, y0, 1), roof: roofPal, leaf: leafPal } };
    return { key, N, s, x0, y0, url: file(key), keep: false, dataOnly: false, bld: buildingIds(x0, y0, s), roof: roofPal };
  });
  const t0 = performance.now(), outs = new Map<string, MeshReply>();
  const nw = Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));
  await Promise.all(Array.from({ length: nw }, async () => {
    const w = new Worker(new URL('../../src/mesher.worker.ts', import.meta.url), { type: 'module' });
    while (reqs.length) {
      const q = reqs.shift()!;
      const m = await new Promise<MeshReply>((res) => { w.onmessage = (e) => res(e.data); w.postMessage(q); });
      if (m.type === 'error') throw new Error(m.error);
      outs.set(q.key, m);
      say(`meshed ${outs.size} / ${set.nodes.length}`);
    }
    w.terminate();
  }));
  const meshMs = performance.now() - t0;

  let maxQuads = 0;
  for (const m of outs.values()) if (m.type === 'node') maxQuads = Math.max(maxQuads, m.quads, m.base?.quads ?? 0);
  const idx = new Uint32Array(maxQuads * 6);
  for (let q = 0, b = 0; q < maxQuads; q++, b += 4) idx.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
  const index = new THREE.BufferAttribute(idx, 1);
  const makeGeometry = ({ pos, attr, pal, bld: b, quads, faces, normals, cuts }: MeshOut) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('vattr', new THREE.BufferAttribute(attr, 4));
    geo.setAttribute('vpal', new THREE.BufferAttribute(pal, 1));
    geo.setAttribute('vbld', new THREE.BufferAttribute(b ?? new Uint16Array(pal.length), 1));
    geo.setIndex(index);
    geo.setDrawRange(0, quads * 6);
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    Object.assign(geo.userData, { faces, normals, cuts, quads });
    v.prepareGeometry?.(geo);
    return geo;
  };
  // a foliage tile's base: the base tile meshed again without what the grass covers (stream.ts coverBase)
  const geos = new Map<string, THREE.BufferGeometry>();
  for (const [k, m] of outs) {
    if (m.type !== 'node') continue;
    if (m.quads) geos.set(k, makeGeometry(m));
    if (k.startsWith('f/') && m.base?.quads) geos.set(`1/${k.slice(2)}`, makeGeometry(m.base));
  }
  const scene = new THREE.Scene(), meshes: THREE.Mesh[] = [];
  scene.background = new THREE.Color(0x9fb3c8);
  let quads = 0;
  for (const [k, geo] of geos) {
    const mesh = new THREE.Mesh(geo, k.startsWith('f/') ? folMat : mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    v.prepare(mesh, k);
    scene.add(mesh); meshes.push(mesh);
    quads += geo.userData.quads;
  }
  const camera = new THREE.PerspectiveCamera(set.cam.fov, W / H, 0.5, 9000);
  camera.position.fromArray(set.cam.pos); camera.quaternion.fromArray(set.cam.quat);
  camera.updateMatrixWorld();
  // the sun as the app had it at 14:00 on 21 June, its shadow box around the view's target
  const target = new THREE.Vector3(...(meta.views[view]?.target ?? [meta.W / 2, 30, meta.D / 2]));
  const sun = new THREE.DirectionalLight(0xffffff, 3), R = 1000;
  sun.position.copy(target).addScaledVector(new THREE.Vector3(...set.sun).normalize(), 2500);
  sun.target.position.copy(target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 5000 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target, new THREE.HemisphereLight(0xcfe0ff, 0x6b5f50, 1.2));
  sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
  sun.shadow.updateMatrices(sun);

  const measure = async ({ cull = false, shadow = 'static', frames = 40, warm = 10 }: { cull?: boolean; shadow?: 'static' | 'every'; frames?: number; warm?: number } = {}) => {
    v.setCull(cull, meshes);
    sun.shadow.autoUpdate = shadow === 'every';
    sun.shadow.needsUpdate = true;
    for (let k = 0; k < warm; k++) { await raf(); v.frame(scene, camera, false, k, sun); if (v.frameGpu) await v.frameGpu(); }
    const cpu: number[] = [], gpuF: number[] = [];
    let last: FrameOut = { cpu: 0, quads: 0, tris: 0 };
    for (let k = 0; k < frames; k++) {
      await raf();
      last = v.frame(scene, camera, true, k, sun);
      cpu.push(last.cpu);
      if (v.frameGpu) gpuF.push(await v.frameGpu());
    }
    const gpu = v.frameGpu ? gpuF : await v.gpuTimes();
    // the frame time end to end, vsync off: frames rendered from rAF, then waited for until the GPU is done with all
    // of them (the rAF interval alone said ~1 ms for WebGL frames that take the GPU 25: Chrome queued them)
    await v.sync();
    const tA = await raf();
    for (let k = 0; k < frames; k++) { if (k) await raf(); v.frame(scene, camera, false, k, sun); if (v.frameGpu) void v.frameGpu(); }
    await v.sync();
    const interval = [(performance.now() - tA) / frames];
    if (v.frameGpu) await v.frameGpu();
    return { cull, shadow, cpu, gpu, interval, drawnQuads: last.quads, tris: last.tris };
  };
  await raf(); v.frame(scene, camera, false, 0, sun); if (v.frameGpu) await v.frameGpu();
  const bytesPerVertex = r === 'gl' ? 14 : r === 'gpu' ? 36 : 16;
  const info = { variant: v.name, view, ...v.info, meshes: meshes.length, quads, meshMs: Math.round(meshMs), vertexMB: Math.round((quads * 4 * bytesPerVertex) / 1e6), dpr: devicePixelRatio };
  say(JSON.stringify(info));
  Object.assign(window, { __spike: { info, measure, ready: true } });
}

main().catch((e) => { say(`error: ${e?.message ?? e}`); console.error(e); Object.assign(window, { __spike: { error: String(e?.stack ?? e) } }); });
