import * as THREE from 'three';
import { CLOUD_GLSL, cloudUniforms } from './clouds';
import type { FloodInfo, Meta } from './types';
import { MAT, REFL_MAX, type VoxelUniforms } from './voxelMaterial';
import { fetchJson } from './util';
import { FIELDS_GLSL } from './fields';

// The rivers' level (scripts/flood.py). The voxels hold the rivers as on the survey day. Above that, a sheet of water
// covers every cell the river reaches at that level (an embankment keeps the land behind it dry until topped), sloping
// with the surveyed surface; below it, the shallows of the schematic bed turn into sandbanks (uDrop). Where the map
// spans a weir the rivers stand at more than one level (flood.json stretches, scripts/map.json): one sheet per stretch,
// each over its box at its own level, a cell drawn by its stretch's sheet only (the first box that holds it), the
// slider the same metres over each stretch's level. Where the river reaches at which level, and its bed, come with the
// tiles (scripts/tile_fields.py flod, fields.ts): the sheets show over the nodes shown.
const BUCKET = 512;
const MAX_STRETCHES = 32;
export class Flood {
  info: FloodInfo | null = null;
  private meshes: THREE.Mesh[] = [];
  private readonly uLevel = { value: 0 };
  // the stretches' boxes (map cells x0, z0, x1, z1) and their count (flood.json)
  private readonly uBoxes = { value: Array.from({ length: MAX_STRETCHES }, () => new THREE.Vector4()) };
  private readonly uNS = { value: 0 };
  private readonly uSpill0 = { value: 3 };
  // the river's points (flood.json, every 24 m) by BUCKET m square, row-major
  private river = new Map<number, THREE.Vector3[]>();
  private bw = 1;
  private readonly frustum = new THREE.Frustum();

  constructor(private readonly scene: THREE.Scene, private readonly U: VoxelUniforms, private readonly meta: Meta) {}

  async load() {
    const info = await fetchJson<FloodInfo>('data/flood.json');
    const { W, D } = this.meta, r = info.river ?? [];
    this.info = info;
    const st = (info.stretches ?? []).slice(0, MAX_STRETCHES);
    if ((info.stretches ?? []).length > MAX_STRETCHES) console.warn('flood: more stretches than', MAX_STRETCHES);
    st.forEach((s, k) => this.uBoxes.value[k].set(s.box[0], s.box[1], s.box[2], s.box[3]));
    this.uNS.value = st.length;
    this.uSpill0.value = info.spill0 ?? 3;
    // the surveyed surface at a cell: its stretch's level, else the sloping surface below the stretches
    const surface = (x: number, z: number) => {
      const s = st.find(({ box: b }) => x >= b[0] && x < b[2] && z >= b[1] && z < b[3]);
      return (s ? s.level : info.surface0 + info.fall * z) - info.base;
    };
    this.bw = Math.ceil(W / BUCKET);
    for (let k = 0; k < r.length; k += 2) {
      const x = r[k], y = r[k + 1], b = Math.floor(y / BUCKET) * this.bw + Math.floor(x / BUCKET);
      (this.river.get(b) ?? this.river.set(b, []).get(b)!).push(new THREE.Vector3(x, surface(x + 0.5, y + 0.5), y));
    }
    // the sheet below the stretches over the whole map (sloping), then one flat sheet per stretch over its box
    const sheets: [number, number, number, number, number][] = [[0, 0, W, D, -1],
      ...st.map((s, k): [number, number, number, number, number] => [Math.max(0, s.box[0]), Math.max(0, s.box[1]), Math.min(W, s.box[2]), Math.min(D, s.box[3]), k])];
    for (const [x0, z0, x1, z1, k] of sheets) {
      if (x1 <= x0 || z1 <= z0) continue;
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 1, 1).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, k < 0 ? info.surface0 + info.fall * p.getZ(i) - info.base : st[k].level - info.base);
      const mesh = new THREE.Mesh(g, this.material(k));
      mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  // some of the river within far of the camera and in its view (only the squares within far are looked at)
  inView(camera: THREE.Camera, far: number) {
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const c = camera.position, bh = Math.ceil(this.meta.D / BUCKET);
    for (let by = Math.max(0, Math.floor((c.z - far) / BUCKET)); by <= Math.min(bh - 1, Math.floor((c.z + far) / BUCKET)); by++)
      for (let bx = Math.max(0, Math.floor((c.x - far) / BUCKET)); bx <= Math.min(this.bw - 1, Math.floor((c.x + far) / BUCKET)); bx++)
        if (this.river.get(by * this.bw + bx)?.some((p) => this.frustum.containsPoint(p) && p.distanceTo(c) < far)) return true;
    return false;
  }

  // metres above (or below) the level on the survey day
  get level() { return this.uLevel.value; }

  // cm above (or below) the level on the survey day; no gauge is calibrated
  setLevel(cm: number) {
    if (!this.info || !this.meshes.length) return;
    const level = cm / 100;
    this.uLevel.value = level;
    for (const m of this.meshes) m.visible = level > 0.02;
    this.U.uDrop.value = Math.max(0, -level);
  }

  // the rivers' own colour (voxelize.py samples it per cell from the ortho; the palette holds those samples), averaged in
  // linear light, so the risen water reads as the same river instead of a sheet of blue laid over it
  private riverColour() {
    const w = this.meta.palette.filter((p) => p[3] === MAT.WATER), c = new THREE.Vector3();
    const lin = (v: number) => (v / 255) ** 2.2;
    for (const p of w) c.add(new THREE.Vector3(lin(p[0]), lin(p[1]), lin(p[2])));
    return w.length ? c.divideScalar(w.length) : new THREE.Vector3(0.1, 0.17, 0.13);
  }

  // the sheet of stretch k (-1: below the stretches)
  private material(k: number) {
    // 92 % opaque by a constant, so that what it writes into the alpha is the river's mark for the reflections (post.ts)
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0.3, transparent: true,
      blending: THREE.CustomBlending, blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.ZeroFactor, blendAlpha: 0.92 });
    const uRiver = { value: this.riverColour() }, uSheet = { value: k };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uPageIdx: this.U.uPageIdx, uPageF: this.U.uPageF, uPageS: this.U.uPageS, uLevel: this.uLevel, uTime: this.U.uTime, uHorizon: this.U.uHorizon, uRiver, uSheet, uBoxes: this.uBoxes, uNS: this.uNS, uSpill0: this.uSpill0, ...cloudUniforms });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uLevel; varying vec3 vW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += uLevel; vW = transformed;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${FIELDS_GLSL}\nuniform float uTime; uniform vec3 uHorizon; uniform vec3 uRiver; varying vec3 vW;
          uniform float uLevel; uniform int uSheet; uniform int uNS; uniform vec4 uBoxes[${MAX_STRETCHES}]; uniform float uSpill0;\n${CLOUD_GLSL}`)
        .replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>\n{ float cs = cloudShade(vW); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }')
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 cl = floor(vW.xz);
          // the slider's value at which the river reaches the cell (m over its stretch's surveyed level; 255: never)
          float sb = riverAt(cl + 0.5).x;
          float spill = sb * 0.1 - uSpill0;
          if (sb > 254.5 || spill >= uLevel) discard;
          // drawn by its own stretch's sheet only: the first box that holds it
          int si = -1;
          for (int k = 0; k < ${MAX_STRETCHES}; k++) {
            if (k >= uNS) break;
            vec4 b = uBoxes[k];
            if (cl.x + 0.5 >= b.x && cl.x + 0.5 < b.z && cl.y + 0.5 >= b.y && cl.y + 0.5 < b.w) { si = k; break; }
          }
          if (si != uSheet) discard;
          float r = sin(cl.x * 0.9 + uTime * 1.3) * sin(cl.y * 1.1 - uTime) * 0.5 + 0.5;
          float land = step(0.5, spill); // silt over land the river doesn't usually cover
          // shaded as the river voxels are (voxelMaterial.ts, water), a little murkier with the silt it carries
          diffuseColor.rgb = mix(uRiver * mix(0.72, 1.12, r * r) * 0.9, vec3(0.16, 0.13, 0.07), land * 0.3);
          vec3 V = normalize(cameraPosition - vW);
          float g = 1.0 - clamp(V.y, 0.0, 1.0); g *= g;
          diffuseColor.rgb = mix(diffuseColor.rgb, uHorizon * 0.8, clamp(0.08 + 0.55 * g * g, 0.0, 0.55));`)
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
          gl_FragColor.a = ${REFL_MAX.toFixed(2)} * (1.0 - 0.3 * land);`);
    };
    return mat;
  }
}
