import * as THREE from 'three';

// Depth pre-pass for the city's tiles. Their fragment shader (voxelMaterial.ts) is most of a frame's GPU time, and the
// tiles overdraw 2-3x: each tile is drawn first into depth alone, with a material that moves its vertices and discards
// its fragments exactly as the real one does (makeVoxelPrepassMaterial), then in colour with the depth test LessEqual
// and no depth write, so that the costly shader runs about once per pixel. Hooked into the scene's onBeforeRender, so
// every render of the scene gets it (the composer's RenderPass, or a plain renderer.render); n8ao's own renders of the
// scene's transparent things find every tile hidden and draw nothing here. What is not a registered tile material (the
// clay) is left out of it, and drawn as before.
export class DepthPrepass {
  enabled = true;
  private readonly pre = new Map<THREE.Material, THREE.Material>();
  private readonly swapped: THREE.Mesh[] = [];
  private readonly mains: THREE.Material[] = [];
  private readonly hidden: THREE.Object3D[] = [];

  constructor(private readonly group: THREE.Group, scene: THREE.Scene) {
    const before = scene.onBeforeRender.bind(scene);
    scene.onBeforeRender = (...a) => { before(...a); this.render(a[0], a[2]); };
  }

  // tiles drawn with main are drawn first with pre (with main's polygon offset: both must land on the same depth)
  add(main: THREE.Material, pre: THREE.Material) {
    Object.assign(pre, { polygonOffset: main.polygonOffset, polygonOffsetFactor: main.polygonOffsetFactor,
      polygonOffsetUnits: main.polygonOffsetUnits, side: main.side });
    this.pre.set(main, pre);
  }

  private render(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    const on = this.enabled;
    for (const m of this.pre.keys()) { m.depthWrite = !on; m.depthFunc = THREE.LessEqualDepth; }
    if (!on || !this.group.visible) return;
    for (const o of this.group.children) {
      if (!o.visible) continue;
      const mesh = o as THREE.Mesh, main = mesh.material as THREE.Material, pre = this.pre.get(main);
      if (pre) { mesh.material = pre; this.swapped.push(mesh); this.mains.push(main); } else { o.visible = false; this.hidden.push(o); }
    }
    if (this.swapped.length) renderer.render(this.group, camera);
    this.swapped.forEach((m, i) => { m.material = this.mains[i]; });
    for (const o of this.hidden) o.visible = true;
    this.swapped.length = this.mains.length = this.hidden.length = 0;
  }
}
