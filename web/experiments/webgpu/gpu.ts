import * as THREE from 'three/webgpu';
import {
  Fn, attribute, cos, dot, float, floor, fract, int, ivec2, mix, mod, positionGeometry, pow, select, sin, textureLoad,
  transformNormalToView, varying, vec3, vec4,
} from 'three/tsl';
import { SLANT, SLANT_STEPS } from '../../src/chamfer';
import { WALL_TOP } from '../../src/roofs';
import { shadowRuns, viewRuns } from './cull';
import type { Variant } from './spike';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any; // (the spike keeps TSL's node types loose)
type AnyNode = any;

// WebGPU: the same shading as gl.ts in TSL on three's Lambert node material.
// compact: the tiles' 8- and 16-bit vertex data as they are (unorm8x4, snorm16x4, unorm16), scaled back in the shader.
// Without it three widens every integer attribute that is not `normalized` to 32 bits on upload
// (WebGPUAttributeUtils: Int16 -> Int32, Uint8/Uint16 -> Uint32): 14 bytes a vertex become 36.
export function makeGpuMaterial(palette: THREE.Texture, foliage: boolean, compact: boolean) {
  const mat = new THREE.MeshLambertNodeMaterial({ color: 0xffffff });
  if (foliage) { mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -2; }
  const round = (n: AnyNode): AnyNode => floor(n.add(0.5));
  const A = (compact ? round(attribute('vattr', 'vec4').mul(255)) : attribute('vattr', 'vec4')) as unknown as ReturnType<typeof vec4>;
  // (compact: palette and building in one unorm16x2 attribute: a lone 16-bit attribute has a 2-byte stride, which
  // WebGPU does not allow -- vertex strides are multiples of 4)
  const PB: AnyNode = compact ? round(attribute('vpb', 'vec2').mul(65535)) : null;
  const PAL = (compact ? PB.x : attribute('vpal', 'float')) as AnyNode;
  const BLD = (compact ? PB.y : attribute('vbld', 'float')) as AnyNode;
  const P = (compact ? floor(positionGeometry.mul(32767).add(0.5)) : positionGeometry) as unknown as ReturnType<typeof vec3>;

  const nfi = (i: AnyNode) => select(i.lessThan(0.5), vec3(-1, 0, 0), select(i.lessThan(1.5), vec3(1, 0, 0),
    select(i.lessThan(2.5), vec3(0, 0, -1), select(i.lessThan(3.5), vec3(0, 0, 1), select(i.lessThan(4.5), vec3(0, -1, 0), vec3(0, 1, 0))))));
  const hash13 = Fn(([p0]: [AnyNode]) => {
    const p: AnyNode = fract(p0.mul(0.1031)).toVar();
    p.addAssign(dot(p, p.zyx.add(31.32)));
    return fract(p.x.add(p.y).mul(p.z));
  });

  // vertex: the lifted position, the lit normal (staircase / roof plane / chamfer), the packed face
  const pos = P.add(vec3(0, floor(A.y.div(4).add(0.01)).div(64), 0));
  mat.positionNode = pos as unknown as N;
  const objN = Fn(() => {
    const nAx = mod(A.x, 8), nAng = floor(A.x.div(8).add(0.01));
    const w = A.w;
    const slant = w.greaterThan(SLANT - 0.5), wallTop = w.greaterThan(WALL_TOP - 0.5);
    const litAng = select(slant, w.sub(SLANT).mul(24 / SLANT_STEPS).add(1), nAng);
    const nRoof = select(slant.or(wallTop), float(0), w);
    const rSl = nAng.mul(0.0436332), rAz = nRoof.sub(1).mul(0.0981748), wa = litAng.sub(1).mul(0.261799);
    return select(nRoof.greaterThan(0.5), vec3(sin(rSl).mul(cos(rAz)), cos(rSl), sin(rSl).mul(sin(rAz))),
      select(litAng.greaterThan(0.5), vec3(cos(wa), 0, sin(wa)), nfi(nAx)));
  });
  const vLitN = varying(transformNormalToView(objN()), 'vLitN');
  mat.normalNode = vLitN.normalize() as unknown as N;
  const kind = select(A.w.greaterThan(SLANT - 0.5), float(2), select(A.w.greaterThan(0.5).and(A.w.lessThan(WALL_TOP - 0.5)), float(1), float(0)));
  const vFace = varying(vec4(floor(PAL.add(0.5)), select(kind.equal(1), mod(A.x, 8), A.x).add(kind.mul(256)), BLD, A.z), 'vFace');
  const vVox = varying(pos, 'vVox');
  const vAO = varying(mod(A.y, 4).div(3), 'vAO');

  // fragment: the face decoded, its cell and hash, the palette entry
  mat.colorNode = Fn(() => {
    const pal = int(floor(vFace.x.add(0.5))).bitAnd(4095), b = int(vFace.y.add(0.5));
    const vN = nfi(float(b.bitAnd(7)));
    const cell = floor(vVox.sub(vN.mul(0.5)).add(1e-3));
    const h = hash13(cell);
    const base = pow(textureLoad(palette, ivec2(pal.mod(64), pal.div(64))).rgb, vec3(2.2));
    return vec4(base.mul(h.mul(0.06).add(0.97)).mul(mix(0.62, 1.0, vAO)), 1);
  })() as unknown as N;
  return mat;
}

const RUNS = 32, ARGS = 5; // per mesh: RUNS view runs, then RUNS shadow runs, 5 u32 each (drawIndexedIndirect)
interface GpuMesh { mesh: THREE.Mesh; ind: THREE.IndirectStorageBufferAttribute; view: number[]; shadow: number[]; key: string }

export async function makeGpu(canvasParent: HTMLElement, W: number, H: number, compact: boolean): Promise<Variant> {
  const r = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance', trackTimestamp: true });
  r.setPixelRatio(1);
  r.setSize(W, H);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.toneMapping = THREE.NoToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  await r.init();
  const backend = r.backend as unknown as { isWebGPUBackend?: boolean; device?: GPUDevice };
  if (!backend.isWebGPUBackend) throw new Error('WebGPURenderer fell back to WebGL2');
  canvasParent.appendChild(r.domElement);
  const meshes: GpuMesh[] = [];
  let cull = false, shadowCam: THREE.Camera | null = null;
  const tmp: number[] = [];
  const fill = (g: GpuMesh, region: 0 | 1, ok: boolean, offs: number[]) => {
    offs.length = 0;
    const a = g.ind.array as Uint32Array;
    let changed = false;
    const n = ok ? Math.min(tmp.length / 2, RUNS) : 1;
    for (let i = 0; i < n; i++) {
      const o = (region * RUNS + i) * ARGS;
      const s = ok ? tmp[2 * i] : 0, e = ok ? tmp[2 * i + 1] : (g.mesh.geometry.userData.quads as number);
      const cnt = (e - s) * 6, first = s * 6;
      if (a[o] !== cnt || a[o + 2] !== first || a[o + 1] !== 1) { a[o] = cnt; a[o + 1] = 1; a[o + 2] = first; a[o + 3] = 0; a[o + 4] = 0; changed = true; }
      offs.push(o * 4);
    }
    return changed;
  };
  let drawnQuads = 0;
  return {
    name: compact ? 'webgpu-compact' : 'webgpu',
    info: { backend: 'webgpu', compact },
    domElement: r.domElement,
    makeMaterial: (pal, fol) => makeGpuMaterial(pal as THREE.Texture, fol, compact) as unknown as import('three').Material,
    prepareGeometry(geo) {
      if (!compact) return;
      for (const k of ['position', 'vattr']) (geo.getAttribute(k) as import('three').BufferAttribute).normalized = true;
      const pal = geo.getAttribute('vpal').array as Uint16Array, bld = geo.getAttribute('vbld')?.array as Uint16Array | undefined;
      const pb = new Uint16Array(pal.length * 2);
      for (let i = 0; i < pal.length; i++) { pb[2 * i] = pal[i]; pb[2 * i + 1] = bld ? bld[i] : 0; }
      geo.deleteAttribute('vpal'); geo.deleteAttribute('vbld');
      const a = new (THREE.BufferAttribute as unknown as typeof import('three').BufferAttribute)(pb, 2, true);
      geo.setAttribute('vpb', a);
    },
    prepare(mesh0, key) {
      const mesh = mesh0 as unknown as THREE.Mesh;
      const g: GpuMesh = { mesh, ind: new THREE.IndirectStorageBufferAttribute(new Uint32Array(2 * RUNS * ARGS), ARGS), view: [], shadow: [], key };
      meshes.push(g);
      // the runs worked out per draw, as the app does in onBeforeRender, only for what passed three's frustum test; the
      // indirect buffer is uploaded before this very draw (Geometries.updateForRender) if anything in it changed
      mesh.onBeforeRender = (_r, _s, camera) => {
        if (!cull) return;
        const geo = mesh.geometry as unknown as import('three').BufferGeometry;
        const sh = camera === shadowCam, offs = sh ? g.shadow : g.view;
        const ok = sh ? shadowRuns(geo, camera as unknown as import('three').Camera, tmp) : viewRuns(geo, camera as unknown as import('three').Camera, tmp);
        if (fill(g, sh ? 1 : 0, ok, offs)) g.ind.needsUpdate = true;
        for (let i = 0; i < tmp.length; i += 2) drawnQuads += tmp[i + 1] - tmp[i];
        mesh.geometry.indirectOffset = offs;
      };
    },
    setCull(on) {
      cull = on;
      for (const g of meshes) g.mesh.geometry.indirect = on ? g.ind : null;
    },
    frame(scene, camera, _timed, _k, sun) {
      const t0 = performance.now();
      drawnQuads = 0;
      shadowCam = (sun as unknown as THREE.DirectionalLight).shadow.camera;
      if (!cull) for (const g of meshes) if (g.mesh.visible) drawnQuads += g.mesh.geometry.userData.quads as number; // (frustum aside)
      r.render(scene as unknown as THREE.Scene, camera as unknown as THREE.Camera);
      return { cpu: performance.now() - t0, quads: drawnQuads, tris: r.info.render.triangles };
    },
    async sync() { await backend.device!.queue.onSubmittedWorkDone(); },
    async frameGpu() { return (await r.resolveTimestampsAsync(THREE.TimestampQuery.RENDER)) ?? NaN; },
    async gpuTimes() { return []; },
  };
}
