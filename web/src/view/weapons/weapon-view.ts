import type * as THREE from 'three';
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
  update(dt: number): void;
}
