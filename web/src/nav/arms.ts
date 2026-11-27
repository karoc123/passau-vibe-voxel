import type * as THREE from 'three';
import type { SimClient } from '../client/sim-client';
import type { Vec3 } from '../core/vec';
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
  // a tap asked for one shot: kept until the weapon may fire, so a tap during the wait still fires
  private once = false;

  select(slot: number) {
    if (slot >= 1 && slot <= SLOTS) this.slot = slot;
  }

  /** the next slot (step 1) or the one before (-1), round */
  cycle(step: number) {
    this.slot = (((this.slot - 1 + step) % SLOTS) + SLOTS) % SLOTS + 1;
  }

  /** one shot, as soon as the weapon may fire */
  pull() { this.once = true; }

  /** each frame on foot or at a mount: a held trigger (the mouse's, or held: the touch's) fires along h and pitch (the
   * host's ray: from the player's eyes as it has them), its flash drawn from camera. At a mount (gun): its weapon's
   * slot, and the world point under the crosshair, asked for only when a shot goes */
  update(dt: number, sim: SimClient | null, h: number, pitch: number, camera: THREE.Camera, held = false, gun?: { slot: number; to: () => Vec3 }) {
    this.wait = Math.max(0, this.wait - dt);
    const slot = gun?.slot ?? this.slot, w = weaponIn(slot);
    if (!w || !sim) { this.once = false; return; }
    if (!(this.trigger || held || this.once) || this.wait > 0) return;
    this.once = false;
    this.wait += 1 / w.rate;
    sim.send(gun ? { kind: 'fire', slot, h, pitch, to: gun.to() } : { kind: 'fire', slot, h, pitch });
    this.view?.fired(w.id, camera);
  }
}
