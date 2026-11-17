import * as THREE from 'three';
import type { FloodInfo, Meta } from './types';
import { MAT, type VoxelUniforms } from './voxelMaterial';
import { dataTexture, fetchGzip, fetchJson } from './util';

// The rivers' level (scripts/flood.py). The voxels hold the rivers as on the survey day. Above that, one sheet of water
// covers every cell the river reaches at that level (an embankment keeps the land behind it dry until topped), sloping
// with the surveyed surface; below it, the shallows of the schematic bed turn into sandbanks (uDrop).
export class Flood {
  info: FloodInfo | null = null;
  private mesh: THREE.Mesh | null = null;
  private readonly uLevel = { value: 0 };
  private river: THREE.Vector3[] = [];
  private readonly frustum = new THREE.Frustum();

  constructor(private readonly scene: THREE.Scene, private readonly U: VoxelUniforms, private readonly meta: Meta) {}

  async load() {
    const [info, buf] = await Promise.all([fetchJson<FloodInfo>('data/flood.json'), fetchGzip('data/flood.bin')]);
    const { W, D } = this.meta, n = W * D, a = new Uint8Array(buf), rg = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) { rg[2 * i] = a[i]; rg[2 * i + 1] = a[n + i]; }
    const tex = dataTexture(rg, W, D, THREE.RGFormat);
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    this.info = info;
    for (let y = 0; y < D; y += 24) for (let x = 0; x < W; x += 24) {
      if (a[n + y * W + x] > 0) this.river.push(new THREE.Vector3(x, info.surface0 + info.fall * y - info.base, y));
    }
    this.U.uFlood.value = tex;
    const g = new THREE.PlaneGeometry(W, D, 1, 1).rotateX(-Math.PI / 2).translate(W / 2, 0, D / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, info.surface0 + info.fall * p.getZ(i) - info.base);
    this.mesh = new THREE.Mesh(g, this.material());
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);
  }

  inView(camera: THREE.Camera, far: number) {
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    return this.river.some((p) => this.frustum.containsPoint(p) && p.distanceTo(camera.position) < far);
  }

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
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0.3, transparent: true, opacity: 0.92 });
    const uRiver = { value: this.riverColour() };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uFlood: this.U.uFlood, uLevel: this.uLevel, uTime: this.U.uTime, uHorizon: this.U.uHorizon, uRiver });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uLevel; varying vec3 vW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += uLevel; vW = transformed;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uFlood; uniform float uTime; uniform vec3 uHorizon; uniform vec3 uRiver; varying vec3 vW;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float spill = texelFetch(uFlood, ivec2(floor(vW.xz)), 0).r * 255.0;
          if (spill >= vW.y) discard;
          vec2 cl = floor(vW.xz);
          float r = sin(cl.x * 0.9 + uTime * 1.3) * sin(cl.y * 1.1 - uTime) * 0.5 + 0.5;
          float land = step(4.5, spill); // silt over land the river doesn't usually cover
          // shaded as the river voxels are (voxelMaterial.ts, water), a little murkier with the silt it carries
          diffuseColor.rgb = mix(uRiver * mix(0.72, 1.12, r * r) * 0.9, vec3(0.16, 0.13, 0.07), land * 0.3);
          vec3 V = normalize(cameraPosition - vW);
          float g = 1.0 - clamp(V.y, 0.0, 1.0); g *= g;
          diffuseColor.rgb = mix(diffuseColor.rgb, uHorizon * 0.8, clamp(0.08 + 0.55 * g * g, 0.0, 0.55));`);
    };
    return mat;
  }
}
