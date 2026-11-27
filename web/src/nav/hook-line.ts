import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

/** the grappling hook's line as drawn: a thin dark rod from the hand to where the hook holds (a mesh, as a 1 px line
 * is lost against the houses) */
export class HookLine {
  readonly mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 5, 1, true), new THREE.MeshBasicMaterial({ color: 0x1c1c1c }));
  private readonly d = new THREE.Vector3();

  constructor() { this.mesh.visible = false; }

  /** from a to b this frame; null: no line out */
  show(a: THREE.Vector3 | null, b?: { x: number; y: number; z: number } | null) {
    const m = this.mesh;
    m.visible = !!a && !!b;
    if (!a || !b) return;
    const d = this.d.set(b.x - a.x, b.y - a.y, b.z - a.z), l = d.length() || 1;
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(UP, d.divideScalar(l));
    m.scale.set(1, l, 1);
  }
}
