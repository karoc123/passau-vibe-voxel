// ?dig=1 (a developer's switch, off by default): a click on the city carves a sphere of DIG_R m out of it where the
// view's ray meets the voxels. The edit is the world's: a command to the world sim's client (sim/sim-client.ts edit;
// core/world-edits.ts apply: every 1 m node it touches, their foliage with them); whatever draws or collides with the
// world hears of it (core/live-edits.ts: the streamer meshes the nodes again in place, stream.ts onLive; the physics;
// the world sim).
// Transient (docs/adr/0001-world-layers.md L2): the page loaded again is as before.
// Each edit's time goes to the console: the carving and encoding, then until the new meshes are in.
import * as THREE from 'three';
import { cellToAbsZ, frameOf, mapToGrid, type WorldOp } from './core/layers';
import type { SimClient } from './sim/sim-client';
import { LOCAL_PLAYER } from './sim/world-sim';
import type { TileStreamer } from './stream';

const DIG_R = 3;

export function installDig(S: TileStreamer, camera: THREE.Camera, dom: HTMLElement, sim: Promise<SimClient>) {
  const frame = frameOf(S.meta), ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let client: SimClient | null = null;
  void sim.then((c) => { client = c; });
  let down: { x: number; y: number; t: number } | null = null;
  dom.addEventListener('pointerdown', (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; });
  dom.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || !client || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 500) return;
    const r = dom.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const o = ray.ray.origin, dir = ray.ray.direction, t = S.world.raycast(o, dir);
    if (!Number.isFinite(t)) return;
    // the cell hit (three.js x, y up, z = map x, height, row), in the project grid
    const p = o.clone().addScaledVector(dir, t + 0.01), [col, row] = mapToGrid(frame, Math.floor(p.x), Math.floor(p.z));
    dig({ kind: 'sphere', col, row, z: cellToAbsZ(frame, Math.floor(p.y)), r: DIG_R, colour: 0 });
  });

  function dig(op: Extract<WorldOp, { kind: 'sphere' }>) {
    const t0 = performance.now();
    client!.edit(LOCAL_PLAYER, op).then((nodes) => {
      const t1 = performance.now();
      return S.editsMeshed().then(() => {
        console.log(`dig (${op.col}, ${op.row}, ${op.z}): ${nodes.length} node(s), edit ${(t1 - t0).toFixed(1)} ms, meshed in ${(performance.now() - t0).toFixed(1)} ms`);
      });
    }).catch((e) => console.warn('dig', e));
  }
}
