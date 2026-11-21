// ?dig=1 (a developer's switch, off by default): a click on the city carves a sphere of DIG_R m out of it where the
// view's ray meets the voxels -- out of every 1 m node it touches (core/columns.ts touchedNodes: the margins too), their
// foliage with them -- and the nodes are meshed again in place (stream.ts replaceColumns); the physics hear of it
// (core/live-edits.ts). Transient (docs/adr/0001-world-layers.md L2): a node loaded again, or the page, is as before.
// Each edit's time goes to the console: the carving and encoding here, then until the new meshes are in.
import * as THREE from 'three';
import { EditableNode, touchedNodes, type CellOp, type NodeColumns } from './core/columns';
import type { TileStreamer } from './stream';

const DIG_R = 3;

export function installDig(S: TileStreamer, camera: THREE.Camera, dom: HTMLElement) {
  S.editing = true;
  const N = S.N, { nx, ny } = S.dims[1], ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down: { x: number; y: number; t: number } | null = null;
  dom.addEventListener('pointerdown', (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; });
  dom.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 500) return;
    const r = dom.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const o = ray.ray.origin, dir = ray.ray.direction, t = S.world.raycast(o, dir);
    if (!Number.isFinite(t)) return;
    // the cell hit (three.js x, y up, z = map x, height, row)
    const p = o.clone().addScaledVector(dir, t + 0.01);
    dig({ kind: 'sphere', x: Math.floor(p.x), y: Math.floor(p.z), z: Math.floor(p.y), r: DIG_R, id: 0 });
  });

  function dig(op: Extract<CellOp, { kind: 'sphere' }>) {
    const t0 = performance.now(), waits: Promise<void>[] = [];
    let nodes = 0;
    for (const [tx, ty] of touchedNodes(op, N, nx, ny)) {
      const key = S.key(1, tx, ty), base = S.columns(key);
      if (!base) continue;
      const e = new EditableNode(N, base as NodeColumns, tx, ty);
      e.apply(op);
      const enc = e.encode(), fd = S.nodes.get(`f/${tx}_${ty}`)?.data;
      let fol: NodeColumns | null = null;
      if (fd) {
        const f = new EditableNode(N, fd as NodeColumns, tx, ty);
        f.apply(op);
        // (a foliage tile's ground is its base's, in the files too: tools/remesh-bench.mjs)
        fol = { ...f.encode(), ground: enc.ground };
      }
      const done = S.replaceColumns(key, { ...enc, planes: base.planes, bld: base.bld, caps: base.caps, roofCaps: base.roofCaps }, fol,
        [op.x - op.r, op.y - op.r, op.x + op.r + 1, op.y + op.r + 1]);
      if (done) { waits.push(done); nodes++; }
    }
    const t1 = performance.now();
    S.pump();
    Promise.all(waits).then(() => {
      console.log(`dig (${op.x}, ${op.y}, ${op.z}): ${nodes} node(s), edit ${(t1 - t0).toFixed(1)} ms, meshed in ${(performance.now() - t0).toFixed(1)} ms`);
    });
  }
}
