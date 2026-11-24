import * as THREE from 'three';
import type { CraftView, SimClient } from '../sim/sim-client';
import type { CraftId } from '../sim/world-sim';
import { LOCAL_PLAYER } from './player';
import type { CoreOf, CraftType } from '../sim/craft/cores';
import { GLIDER_HEIGHT } from '../sim/craft/craft-motion';
import { PLANE } from '../sim/craft/plane-flight';
import { BoatModel } from './boat-model';
import { makeCraftModel } from './craft-models';
import { PlaneModel } from './plane-model';
import { JetModel } from './jet-model';

// The world's crafts the local player does not fly (SimClient.crafts(): one left by its pilot, ADR 0008, or another
// player's), drawn at their last step with the models their shells use. The craft the local player flies is its
// shell's to draw (in step with its chase camera, its panel); so here is every other one, and a shell needs to know
// nothing about crafts it is not in. Models are kept per craft id and reused by type once a craft is gone.

type Draw = (c: CraftView, dt: number, night: number, now: number) => void;
interface Shown { type: CraftType; group: THREE.Object3D; draw: Draw; hide: () => void }

export class CraftsView {
  private readonly shown = new Map<CraftId, Shown>();
  private readonly free: Shown[] = [];
  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor(private readonly parent: THREE.Object3D) {}

  /** every frame: the crafts the client sees, but the one the local player pilots */
  update(sim: SimClient | null, dt: number, night: number) {
    const seen = new Set<CraftId>(), now = performance.now();
    for (const c of sim?.crafts() ?? []) {
      if (c.pilot === LOCAL_PLAYER) continue;
      let s = this.shown.get(c.id);
      if (!s) {
        const i = this.free.findIndex((f) => f.type === c.type);
        s = i >= 0 ? this.free.splice(i, 1)[0] : this.make(c.type);
        this.shown.set(c.id, s);
      }
      s.draw(c, dt, night, now);
      s.group.visible = true;
      seen.add(c.id);
    }
    for (const [id, s] of this.shown) {
      if (seen.has(id)) continue;
      s.hide();
      this.shown.delete(id);
      this.free.push(s);
    }
  }

  private make(type: CraftType): Shown {
    if (type === 'boat') {
      const m = new BoatModel(this.parent);
      return { type, group: m.group, hide: () => { m.visible = false; }, draw: (c, _dt, night) => {
        const core = c.core as CoreOf<'boat'>;
        m.update(core.drawn(core.clock.alpha), core.motion.speed, night, core.motion.t);
      } };
    }
    if (type === 'floatplane' || type === 'jet') {
      const m = type === 'jet' ? new JetModel() : new PlaneModel(PLANE.FLOAT_H);
      this.parent.add(m.group);
      return { type, group: m.group, hide: () => { m.group.visible = false; }, draw: (c, dt, night, now) => {
        const core = c.core as CoreOf<'floatplane'>, d = core.drawn(core.clock.alpha);
        m.orient(d.p, this.fwd.copy(d.fwd), this.up.copy(d.up));
        m.animate(dt, core.flight.engine, night, now);
      } };
    }
    const { group, rotor, tailRotor } = makeCraftModel(type);
    this.parent.add(group);
    const hide = () => { group.visible = false; };
    if (type === 'drone') {
      return { type, group, hide, draw: (c) => {
        const d = (c.core as CoreOf<'drone'>).drawn(0);
        group.position.set(d.position.x, d.position.y, d.position.z);
        group.quaternion.set(d.attitude.x, d.attitude.y, d.attitude.z, d.attitude.w);
      } };
    }
    const drop = type === 'paraglider' ? GLIDER_HEIGHT : 0;
    return { type, group, hide, draw: (c, dt) => {
      const core = c.core as CoreOf<'helicopter'>, m = core.drawn(core.clock.alpha);
      group.position.set(m.x, m.y - drop, m.z);
      group.rotation.set(-m.pitch, m.h, m.bank, 'YXZ');
      // (the rotors still on the skids of one left; idling under a pilot's, as its shell spins them)
      const spin = core.motion.grounded ? (c.pilot === null ? 0 : 9) : 24;
      if (rotor) rotor.rotation.y = (rotor.rotation.y + spin * dt) % (2 * Math.PI);
      if (tailRotor) tailRotor.rotation.x = (tailRotor.rotation.x + 4 * spin * dt) % (2 * Math.PI);
    } };
  }
}
