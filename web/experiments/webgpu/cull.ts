import * as THREE from 'three';

// Facing culling as in src/stream.ts (copied, not imported: there it is private and wired to the WebGL renderer's
// onAfterRender). runsOf gives the quad ranges [a0, b0, a1, b1, ...] of a tile that can face the eye (or, with a
// light direction, face away from the light: the shadow map draws back faces), or null where the tile has no groups.

// (eye - p) . n at its largest over p in [min, max], n in [lo, hi], along one axis
const most = (e: number, min: number, max: number, lo: number, hi: number) => Math.max((e - min) * lo, (e - min) * hi, (e - max) * lo, (e - max) * hi);
function cutGroups(cuts: Uint32Array, groups: number) {
  const c = new Int8Array(groups).fill(-1);
  for (let g = 0; g < 4; g++) c[cuts[4 + g]] = g;
  return c;
}
function runs(geo: THREE.BufferGeometry, show: (n: Float32Array, k: number) => boolean, eye: THREE.Vector3 | null, out: number[]) {
  const f = geo.userData.faces as Uint32Array | undefined, nb = geo.userData.normals as Float32Array | undefined;
  out.length = 0;
  if (!f || !nb) return false;
  const cuts = geo.userData.cuts as Uint32Array, cg: Int8Array = geo.userData.cutGroups ??= cutGroups(cuts, f.length - 1);
  let open = -1, end = 0;
  for (let k = 0; k < f.length - 1; k++) {
    if (f[k + 1] === f[k]) continue;
    let a = f[k], b = f[k + 1];
    if (eye && cg[k] >= 0 && cuts.length > 8) {
      const g = cg[k], N = cuts[3], o = 8 + g * (N + 2), i = ((g < 2 ? eye.x : eye.z) - cuts[g < 2 ? 0 : 1]) / cuts[2];
      if (g & 1) b = a + cuts[o + Math.max(0, Math.min(N + 1, Math.ceil(i + 0.01)))];
      else a += cuts[o + Math.max(0, Math.min(N + 1, Math.floor(i - 0.01) + 1))];
    }
    if (a < b && show(nb, k * 6)) {
      if (open >= 0 && a !== end) { out.push(open, end); open = -1; }
      if (open < 0) open = a;
      end = b;
    } else if (open >= 0) { out.push(open, end); open = -1; }
  }
  if (open >= 0) out.push(open, end);
  return true;
}

const _c = new THREE.Vector3(), _l = new THREE.Vector3();
export function viewRuns(geo: THREE.BufferGeometry, camera: THREE.Camera, out: number[]) {
  const bb = geo.boundingBox!;
  _c.setFromMatrixPosition(camera.matrixWorld);
  return runs(geo, (n, k) => most(_c.x, bb.min.x, bb.max.x, n[k], n[k + 3]) + most(_c.y, bb.min.y, bb.max.y + 1, n[k + 1], n[k + 4])
    + most(_c.z, bb.min.z, bb.max.z, n[k + 2], n[k + 5]) > -0.01, _c, out);
}
// (an orthographic sun; the shadow pass draws back faces, as three does for a FrontSide material)
export function shadowRuns(geo: THREE.BufferGeometry, shadowCamera: THREE.Camera, out: number[]) {
  _l.setFromMatrixColumn(shadowCamera.matrixWorld, 2).normalize();
  const lx = -_l.x, ly = -_l.y, lz = -_l.z;
  return runs(geo, (n, k) => Math.max(lx * n[k], lx * n[k + 3]) + Math.max(ly * n[k + 1], ly * n[k + 4]) + Math.max(lz * n[k + 2], lz * n[k + 5]) > -1e-4, null, out);
}
