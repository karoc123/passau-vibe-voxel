import * as THREE from 'three';
import { SLANT, SLANT_STEPS } from '../../src/chamfer';
import { WALL_TOP } from '../../src/roofs';
import { shadowRuns, viewRuns } from './cull';
import type { Variant } from './spike';

// WebGL2: three's Lambert material patched through its shader chunks as src/voxelMaterial.ts does, doing the same work
// as gpu.ts's TSL material: the staircase/roof/chamfer normal from vattr, the packed vFace varying decoded per
// fragment (palette entry, facing -> the cell -> its hash), the palette fetch, the baked AO, the sun's PCF shadow.
const NORMAL_FROM_IDX = `
  vec3 normalFromIdx(float i) {
    if (i < 0.5) return vec3(-1., 0., 0.);
    if (i < 1.5) return vec3(1., 0., 0.);
    if (i < 2.5) return vec3(0., 0., -1.);
    if (i < 3.5) return vec3(0., 0., 1.);
    if (i < 4.5) return vec3(0., -1., 0.);
    return vec3(0., 1., 0.);
  }`;
const SUB_Y = 'floor(vattr.y / 4.0 + 0.01) / 64.0';

export function makeGlMaterial(palette: THREE.Texture, foliage: boolean) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (foliage) { mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -2; }
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPalette = { value: palette };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 vattr; attribute float vpal; attribute float vbld;
        varying vec3 vVox; varying vec4 vFace; varying float vAO; varying vec3 vLitN; ${NORMAL_FROM_IDX}`)
      .replace('#include <beginnormal_vertex>', `float nAx = mod(vattr.x, 8.0), nAng = floor(vattr.x / 8.0 + 0.01), nRoof = vattr.w;
        float litAng = nAng;
        if (nRoof > ${SLANT - 0.5}) { litAng = 1.0 + (nRoof - ${SLANT}.0) * ${(24 / SLANT_STEPS).toFixed(6)}; nRoof = 0.0; }
        if (nRoof > ${WALL_TOP - 0.5}) nRoof = 0.0;
        float rSl = nAng * 0.0436332, rAz = (nRoof - 1.0) * 0.0981748;
        vec3 objectNormal = nRoof > 0.5 ? vec3(sin(rSl) * cos(rAz), cos(rSl), sin(rSl) * sin(rAz))
          : litAng > 0.5 ? vec3(cos((litAng - 1.0) * 0.261799), 0., sin((litAng - 1.0) * 0.261799)) : normalFromIdx(nAx);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.y += ${SUB_Y};
        vVox = transformed;
        {
          float kind = vattr.w > ${SLANT - 0.5} ? 2.0 : vattr.w > 0.5 && vattr.w < ${WALL_TOP - 0.5} ? 1.0 : 0.0;
          vFace = vec4(floor(vpal + 0.5), (kind == 1.0 ? mod(vattr.x, 8.0) : vattr.x) + 256.0 * kind, vbld, vattr.z);
        }
        vAO = mod(vattr.y, 4.0) / 3.0; vLitN = transformedNormal;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uPalette;
        varying vec3 vVox; varying vec4 vFace; varying float vAO; varying vec3 vLitN; ${NORMAL_FROM_IDX}
        float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vLitN); nonPerturbedNormal = normal;`)
      .replace('#include <color_fragment>', `{
        float a = floor(vFace.x + 0.5);
        int pal = int(a) & 4095, b = int(vFace.y + 0.5);
        vec3 vN = normalFromIdx(float(b & 7));
        vec3 cell = floor(vVox - vN * 0.5 + 1e-3);
        float h = hash13(cell);
        vec3 base = pow(texelFetch(uPalette, ivec2(pal % 64, pal / 64), 0).rgb, vec3(2.2));
        diffuseColor.rgb = base * (0.97 + 0.06 * h) * mix(0.62, 1.0, vAO);
      }`);
  };
  mat.customProgramCacheKey = () => `spike-voxel${foliage ? '-fol' : ''}`;
  return mat;
}

// the rest of a tile's runs, drawn straight after three's own draw of the first (src/stream.ts drawRest)
type MultiDraw = { multiDrawElementsWEBGL(m: number, c: Int32Array, co: number, t: number, o: Int32Array, oo: number, n: number): void };
const _starts = new Int32Array(64), _counts = new Int32Array(64), _runs: number[] = [];
let _restOf: THREE.Mesh | null = null, _md: MultiDraw | null = null, _cull = false, drawnQuads = 0;
function setFirst(mesh: THREE.Mesh, geo: THREE.BufferGeometry, ok: boolean) {
  _restOf = null;
  const all = (geo.userData.quads as number) * 6; // (the shared index buffer is longer than any one tile's)
  if (!ok) { geo.setDrawRange(0, all); drawnQuads += all / 6; return; }
  if (!_runs.length) { geo.setDrawRange(0, 0); return; }
  geo.setDrawRange(_runs[0] * 6, (_runs[1] - _runs[0]) * 6);
  for (let i = 0; i < _runs.length; i += 2) drawnQuads += _runs[i + 1] - _runs[i];
  if (_runs.length > 2) _restOf = mesh;
}
function drawRest(mesh: THREE.Mesh, r: THREE.WebGLRenderer, geo: THREE.BufferGeometry) {
  if (_restOf !== mesh) return;
  _restOf = null;
  const gl = r.getContext() as WebGL2RenderingContext;
  let n = 0;
  for (let i = 2; i < _runs.length && n < 64; i += 2, n++) { _starts[n] = _runs[i] * 24; _counts[n] = (_runs[i + 1] - _runs[i]) * 6; r.info.update(_counts[n], gl.TRIANGLES, 1); }
  if (_md) _md.multiDrawElementsWEBGL(gl.TRIANGLES, _counts, 0, gl.UNSIGNED_INT, _starts, 0, n);
  else for (let i = 0; i < n; i++) gl.drawElements(gl.TRIANGLES, _counts[i], gl.UNSIGNED_INT, _starts[i]);
  void geo;
}

export async function makeGl(canvasParent: HTMLElement, W: number, H: number): Promise<Variant> {
  const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  r.setPixelRatio(1);
  r.setSize(W, H);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.toneMapping = THREE.NoToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  canvasParent.appendChild(r.domElement);
  const gl = r.getContext() as WebGL2RenderingContext, X = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  _md = r.extensions.has('WEBGL_multi_draw') ? r.extensions.get('WEBGL_multi_draw') as MultiDraw : null;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const pending: { q: WebGLQuery; i: number }[] = [];
  return {
    name: 'webgl2',
    info: { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?', multiDraw: !!_md, timer: !!X },
    domElement: r.domElement,
    makeMaterial: (pal, fol) => makeGlMaterial(pal, fol),
    prepare(mesh) {
      mesh.onBeforeRender = (_r, _s, camera, geo) => { if (_cull) setFirst(mesh, geo, viewRuns(geo, camera, _runs)); };
      mesh.onAfterRender = (rr, _s, _c, geo) => { if (_cull) drawRest(mesh, rr, geo); };
      mesh.onBeforeShadow = (_r, _o, _c, sc, geo) => { if (_cull) setFirst(mesh, geo, shadowRuns(geo, sc, _runs)); };
      mesh.onAfterShadow = (rr, _o, _c, _sc, geo) => { if (_cull) drawRest(mesh, rr, geo); };
    },
    setCull(on, meshes) { _cull = on; if (!on) for (const m of meshes) m.geometry.setDrawRange(0, (m.geometry.userData.quads as number) * 6); },
    frame(scene, camera, timed, k) {
      drawnQuads = 0;
      const t0 = performance.now();
      let q: WebGLQuery | null = null;
      if (timed && X) { q = gl.createQuery(); gl.beginQuery(X.TIME_ELAPSED_EXT, q); }
      r.render(scene, camera);
      if (q) { gl.endQuery(X!.TIME_ELAPSED_EXT); pending.push({ q, i: k }); }
      return { cpu: performance.now() - t0, quads: drawnQuads, tris: r.info.render.triangles };
    },
    // everything submitted so far done (a one-pixel read waits for it)
    async sync() { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); },
    async gpuTimes() {
      gl.finish();
      const out: number[] = [];
      for (let tries = 0; tries < 200 && pending.length; tries++) {
        await new Promise((res) => requestAnimationFrame(res));
        while (pending.length && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
          const { q, i } = pending.shift()!;
          const disjoint = gl.getParameter(X!.GPU_DISJOINT_EXT);
          out[i] = disjoint ? NaN : gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
          gl.deleteQuery(q);
        }
      }
      pending.length = 0;
      return out;
    },
  };
}
