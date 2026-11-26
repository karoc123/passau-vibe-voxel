import type * as THREE from 'three';
import type { CraftView, SimClient } from '../../client/sim-client';
import type { CraftId, CraftType } from '../../sim/contract/ids';
import type { CraftLook } from './craft-look';
import { craftLook } from './index';

// The world's crafts the local player does not fly (one left by its pilot, ADR 0008, or another player's), drawn
// between the world's last two ticks (after the sim's update) with the looks their shells use. The craft the local
// player flies is its shell's to draw, in step with its chase camera, so a shell needs to know nothing about crafts it
// is not in. Looks are kept per craft id and reused by type once a craft is gone.

interface Shown { type: CraftType; look: CraftLook }

export class CraftsView {
  private readonly shown = new Map<CraftId, Shown>();
  private readonly free: Shown[] = [];

  constructor(private readonly parent: THREE.Object3D) {}

  /** every frame: the crafts the client sees, but the one the local player pilots */
  update(sim: SimClient | null, dt: number, night: number) {
    const seen = new Set<CraftId>(), frame = { dt, night, now: performance.now(), alpha: sim?.time.alpha ?? 1 };
    for (const c of sim?.crafts() ?? []) {
      if (c.pilot !== null && c.pilot === sim?.player) continue;
      let s = this.shown.get(c.id);
      if (!s) {
        const i = this.free.findIndex((f) => f.type === c.type);
        s = i >= 0 ? this.free.splice(i, 1)[0] : this.make(c.type);
        this.shown.set(c.id, s);
      }
      // (a look is made by the craft's type: its core is that type's)
      s.look.draw(c as CraftView<never>, frame);
      seen.add(c.id);
    }
    for (const [id, s] of this.shown) {
      if (seen.has(id)) continue;
      s.look.hide();
      this.shown.delete(id);
      this.free.push(s);
    }
  }

  private make(type: CraftType): Shown {
    const look = craftLook(type) as CraftLook;
    this.parent.add(look.group);
    return { type, look };
  }
}
