import * as THREE from 'three';

// Depth pre-pass for the city's tiles. Their fragment shader (voxelMaterial.ts) is most of a frame's GPU time, and the
// tiles overdraw 2-3x: each tile is drawn first into depth alone, with a material that moves its vertices and discards
// its fragments as the real one does (makeVoxelPrepassMaterial), then in colour with the depth test Equal, no depth
// write and no discards (PREPASSED), so that the costly shader runs about once per pixel. Hooked into the scene's
// onBeforeRender, so every render of the scene gets it (the composer's RenderPass, or a plain renderer.render); n8ao's
// own renders of the scene's transparent things find every tile hidden and draw nothing here. What is not a registered
// tile material (the clay) is left out of it, and drawn as before.
export class DepthPrepass {
  // Set from the graphics settings (?prepass=1|0, the panel; or window.__three.prepass().enabled): on by default only on
  // an Intel GPU through Direct3D 11 (settings.ts prepassPays), where it halves the scene pass at Oberhaus. On an Iris Xe
  // under WSL (D3D12) it cost more than it saved -- the depth pass ~3.5-5 ms, the colour pass after it no cheaper
  // (tools/gputime.mjs, close-up view)
  enabled = false;
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
    for (const m of this.pre.keys()) {
      m.depthWrite = !on;
      m.depthFunc = on ? THREE.EqualDepth : THREE.LessEqualDepth;
      if (!!m.defines?.PREPASSED !== on) { m.defines = { ...m.defines }; if (on) m.defines.PREPASSED = ''; else delete m.defines.PREPASSED; m.needsUpdate = true; }
    }
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
