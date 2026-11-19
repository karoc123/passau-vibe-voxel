import * as THREE from 'three';
import { CLOUD_GLSL, cloudUniforms } from './clouds';
import type { FloodInfo, Meta } from './types';
import { MAT, REFL_MAX, type VoxelUniforms } from './voxelMaterial';
import { fetchJson } from './util';
import { FIELDS_GLSL } from './fields';

// The rivers' level (scripts/flood.py). The voxels hold the rivers as on the survey day. Above that, one sheet of water
// covers every cell the river reaches at that level (an embankment keeps the land behind it dry until topped), sloping
// with the surveyed surface; below it, the shallows of the schematic bed turn into sandbanks (uDrop). Where the river
// reaches at which level, and its bed, come with the tiles (scripts/tile_fields.py flod, fields.ts): the sheet shows
// over the nodes shown.
const BUCKET = 512;
export class Flood {
  info: FloodInfo | null = null;
  private mesh: THREE.Mesh | null = null;
  private readonly uLevel = { value: 0 };
  // the river's points (flood.json, every 24 m) by BUCKET m square, row-major
  private river = new Map<number, THREE.Vector3[]>();
  private bw = 1;
  private readonly frustum = new THREE.Frustum();

  constructor(private readonly scene: THREE.Scene, private readonly U: VoxelUniforms, private readonly meta: Meta) {}

  async load() {
    const info = await fetchJson<FloodInfo>('data/flood.json');
    const { W, D } = this.meta, r = info.river ?? [];
    this.info = info;
    this.bw = Math.ceil(W / BUCKET);
    for (let k = 0; k < r.length; k += 2) {
      const x = r[k], y = r[k + 1], b = Math.floor(y / BUCKET) * this.bw + Math.floor(x / BUCKET);
      (this.river.get(b) ?? this.river.set(b, []).get(b)!).push(new THREE.Vector3(x, info.surface0 + info.fall * y - info.base, y));
    }
    const g = new THREE.PlaneGeometry(W, D, 1, 1).rotateX(-Math.PI / 2).translate(W / 2, 0, D / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, info.surface0 + info.fall * p.getZ(i) - info.base);
    this.mesh = new THREE.Mesh(g, this.material());
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);
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
    if (!this.info || !this.mesh) return;
    const level = cm / 100;
    this.uLevel.value = level;
    this.mesh.visible = level > 0.02;
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

  private material() {
    // 92 % opaque by a constant, so that what it writes into the alpha is the river's mark for the reflections (post.ts)
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0.3, transparent: true,
      blending: THREE.CustomBlending, blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.ZeroFactor, blendAlpha: 0.92 });
    const uRiver = { value: this.riverColour() };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uPageIdx: this.U.uPageIdx, uPageF: this.U.uPageF, uPageS: this.U.uPageS, uLevel: this.uLevel, uTime: this.U.uTime, uHorizon: this.U.uHorizon, uRiver, ...cloudUniforms });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uLevel; varying vec3 vW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += uLevel; vW = transformed;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${FIELDS_GLSL}\nuniform float uTime; uniform vec3 uHorizon; uniform vec3 uRiver; varying vec3 vW;\n${CLOUD_GLSL}`)
        .replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>\n{ float cs = cloudShade(vW); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float spill = riverAt(floor(vW.xz) + 0.5).x;
          if (spill >= vW.y) discard;
          vec2 cl = floor(vW.xz);
          float r = sin(cl.x * 0.9 + uTime * 1.3) * sin(cl.y * 1.1 - uTime) * 0.5 + 0.5;
          float land = step(4.5, spill); // silt over land the river doesn't usually cover
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
