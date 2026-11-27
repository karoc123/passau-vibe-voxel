import * as THREE from 'three';
import type { CraftView } from '../../../client/sim-client';
import type { CoreOf } from '../../../sim/craft/cores';
import { CRAFT_SCALE } from '../../../sim/craft/craft-motion';
import { parts, placeYXZ, type CraftFrame, type CraftLook, type Part } from '../craft-look';

// A light twin (as an H135/H145): 12 m rotor, 10.1 m fuselage with the tail, 3.7 m to the rotor hub, written at a base
// size (10 / 8.4 / 3.1) and drawn CRAFT_SCALE times that, as its collision probes are; the origin over the skids,
// their feet SPAWN_HEIGHT under it.

const PANE = new THREE.MeshStandardMaterial({ color: 0x2a4250, roughness: 0.15, transparent: true, opacity: 0.35, depthWrite: false });

class HelicopterLook implements CraftLook<'helicopter'> {
  readonly group = new THREE.Group();
  private readonly rotor: THREE.Group;
  private readonly tailRotor: THREE.Group;

  constructor() {
    this.group.scale.setScalar(CRAFT_SCALE.helicopter);
    this.group.visible = false;
    ({ rotor: this.rotor, tailRotor: this.tailRotor } = helicopter(this.group, parts()));
  }

  draw(c: CraftView<CoreOf<'helicopter'>>, { dt, alpha }: CraftFrame) {
    const core = c.core;
    placeYXZ(this.group, core.drawn(alpha));
    this.group.visible = true;
    // still on the skids of one left; idling under a pilot on them
    const spin = core.motion.grounded ? (c.pilot === null ? 0 : 9) : 24;
    this.rotor.rotation.y = (this.rotor.rotation.y + spin * dt) % (2 * Math.PI);
    this.tailRotor.rotation.x = (this.tailRotor.rotation.x + 4 * spin * dt) % (2 * Math.PI);
  }

  hide() { this.group.visible = false; }
}

export const helicopterLook = () => new HelicopterLook();

function helicopter(group: THREE.Group, part: Part) {
  const PAINT = 0xc8372d, WHITE = 0xe8e4da, GLASS = 0x2a4250, DARK = 0x2a3238, METAL = 0x5b666d;
  // skids on struts
  for (const x of [-1.1, 1.1]) {
    part(group, METAL, [0.1, 0.1, 2.9], x, -1.05, 0.25);
    part(group, METAL, [0.1, 0.1, 0.35], x, -0.98, 1.78).rotation.x = -0.6;
    for (const z of [-0.5, 1.0]) part(group, METAL, [0.08, 0.62, 0.08], x * 0.85, -0.72, z).rotation.z = x > 0 ? -0.35 : 0.35;
  }
  // the cabin: a belly, the body round the doors' windows, the glass over the front seats, the engine on the roof.
  // The doors' windows and the front glass are seen through, onto who rides along and the pilot (view/seats.ts)
  part(group, WHITE, [1.4, 0.3, 3.0], 0, -0.3, 0.2);
  part(group, PAINT, [1.5, 0.475, 2.6], 0, 0.0625, -0.05);
  part(group, PAINT, [1.5, 0.075, 2.6], 0, 0.8375, -0.05);
  part(group, PAINT, [1.5, 0.5, 1.05], 0, 0.55, -0.825);
  part(group, PAINT, [1.5, 0.5, 0.35], 0, 0.55, 1.075);
  part(group, GLASS, [1.42, 1.0, 1.0], 0, 0.42, 1.55).material = PANE;
  part(group, GLASS, [1.2, 0.5, 0.25], 0, 0.1, 2.1).material = PANE;
  part(group, GLASS, [1.52, 0.5, 1.2], 0, 0.55, 0.3).material = PANE;
  part(group, PAINT, [1.3, 0.2, 1.0], 0, 0.98, 1.45);
  part(group, PAINT, [1.0, 0.5, 1.9], 0, 1.12, -0.6);
  part(group, DARK, [0.2, 0.6, 0.2], 0, 1.65, 0);
  // the tail boom, the fin and the stabiliser
  part(group, PAINT, [0.42, 0.42, 4.6], 0, 0.62, -3.6);
  part(group, PAINT, [0.12, 1.4, 0.75], 0, 1.15, -5.75);
  part(group, PAINT, [0.12, 0.5, 0.5], 0, 0.25, -5.85);
  part(group, WHITE, [1.8, 0.08, 0.45], 0, 0.62, -5.0);
  // the main rotor: two crossed blades, 10 m, the hub 3.1 m over the ground (before the scale)
  const rotor = new THREE.Group();
  rotor.position.y = 2.0;
  group.add(rotor);
  part(rotor, DARK, [0.4, 0.18, 0.4], 0, 0, 0);
  part(rotor, DARK, [10, 0.05, 0.28], 0, 0, 0);
  part(rotor, DARK, [0.28, 0.05, 10], 0, 0, 0);
  // the tail rotor (1.4 m), on the fin's left side
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.16, 1.35, -5.9);
  group.add(tailRotor);
  part(tailRotor, DARK, [0.05, 1.4, 0.16], 0, 0, 0);
  part(tailRotor, DARK, [0.05, 0.16, 1.4], 0, 0, 0);
  return { rotor, tailRotor };
}
