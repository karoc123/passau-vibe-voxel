import * as THREE from 'three';
import type { SimEvent } from '../../sim/contract/events';
import type { WeaponId } from '../../sim/contract/ids';

/** what a weapon's own events are (they name it) */
export type WeaponEvent = Extract<SimEvent, { weapon: WeaponId }>;

/** a weapon package's drawing (view/weapons/<name>/, listed in index.ts) */
export interface WeaponView {
  readonly id: WeaponId;
  readonly group: THREE.Object3D;
  /** an event of this weapon from the host; own: the page's player's (its flash was drawn when fired) */
  event(e: WeaponEvent, own: boolean): void;
  /** the page's player pulled the trigger and the host will be asked: drawn at once, from the muzzle along dir */
  fired(muzzle: THREE.Vector3, dir: THREE.Vector3): void;
  /** eye: where the frame is seen from */
  update(dt: number, eye: THREE.Vector3): void;
  /** a new model of the gun in the hand (m): the hand at its origin, the barrel along +z, up +y */
  model(): THREE.Object3D;
}

/** a gun of boxes: [colour, centre, size] each */
export function boxModel(parts: [number, [number, number, number], [number, number, number]][]) {
  const g = new THREE.Group();
  for (const [color, [x, y, z], [w, h, d]] of parts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
    m.position.set(x, y, z);
    g.add(m);
  }
  return g;
}
