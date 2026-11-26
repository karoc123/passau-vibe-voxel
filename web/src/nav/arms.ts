import type * as THREE from 'three';
import type { SimClient } from '../client/sim-client';
import { weaponIn } from '../sim/weapons';
import { SLOTS } from '../sim/weapons/weapon';
import type { WeaponsView } from '../view/weapons/weapons-view';

/** the player's weapons on foot: the slot in hand and the trigger (held: the weapon fires at its rate) */
export class Arms {
  slot = 1;
  trigger = false;
  /** the drawing of the shots (main.ts), which shows the page's own flash at once */
  view: WeaponsView | null = null;
  // s until the weapon in hand may fire again
  private wait = 0;

  select(slot: number) {
    if (slot >= 1 && slot <= SLOTS) this.slot = slot;
  }

  /** the next slot (step 1) or the one before (-1), round */
  cycle(step: number) {
    this.slot = (((this.slot - 1 + step) % SLOTS) + SLOTS) % SLOTS + 1;
  }

  /** on foot, each frame: a held trigger fires along h and pitch (the host's ray: from the player's eyes as it has
   * them), its flash drawn from camera */
  update(dt: number, sim: SimClient | null, h: number, pitch: number, camera: THREE.Camera) {
    this.wait = Math.max(0, this.wait - dt);
    const w = weaponIn(this.slot);
    if (!this.trigger || !w || !sim || this.wait > 0) return;
    this.wait += 1 / w.rate;
    sim.send({ kind: 'fire', slot: this.slot, h, pitch });
    this.view?.fired(w.id, camera);
  }
}
