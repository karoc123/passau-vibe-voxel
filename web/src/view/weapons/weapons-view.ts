import * as THREE from 'three';
import type { SimClient } from '../../client/sim-client';
import type { WeaponId } from '../../sim/contract/ids';
import { WEAPON_VIEWS } from './index';
import type { WeaponEvent, WeaponView } from './weapon-view';

// There is no gun model: the page's own shots leave from a muzzle low and right of the eyes, so its flash and tracers
// neither blind nor hide the crosshair.
const RIGHT = 0.22, DOWN = 0.2, AHEAD = 0.6;

/** the weapons' events drawn by their packages' views, and the page's own trigger at once */
export class WeaponsView {
  private readonly views = new Map<WeaponId, WeaponView>();
  private seen: number;
  // where the page's player last fired from (null: not yet, in this view)
  private muzzle: THREE.Vector3 | null = null;

  constructor(scene: THREE.Scene, private readonly client: SimClient) {
    for (const make of WEAPON_VIEWS) { const v = make(); this.views.set(v.id, v); scene.add(v.group); }
    this.seen = client.tick;
  }

  /** the page's player fired weapon, looking as camera does */
  fired(weapon: WeaponId, camera: THREE.Camera) {
    const v = this.views.get(weapon);
    if (!v) return;
    const dir = camera.getWorldDirection(new THREE.Vector3()), right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir);
    this.muzzle = camera.position.clone().addScaledVector(right, RIGHT).addScaledVector(up, -DOWN).addScaledVector(dir, AHEAD);
    v.fired(this.muzzle.clone(), dir);
  }

  update(dt: number) {
    const C = this.client;
    for (const e of C.eventsSince(this.seen)) {
      if (!('weapon' in e)) continue;
      const own = e.player === C.player;
      // (the host's shot leaves from the eyes; the page's own is drawn from its muzzle, where its flash was)
      this.views.get(e.weapon)?.event(own && this.muzzle && e.kind === 'shot' ? { ...e, at: this.muzzle.clone() } as WeaponEvent : e, own);
    }
    this.seen = C.tick;
    for (const v of this.views.values()) v.update(dt);
  }
}
