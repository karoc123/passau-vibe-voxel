import * as THREE from 'three';
import type { CraftView } from '../../../client/sim-client';
import type { CoreOf } from '../../../sim/craft/cores';
import { mountOf, SEATS } from '../../../sim/seats';
import { parts, placeYXZ, type CraftFrame, type CraftLook, type Part } from '../craft-look';

// A medium twin in olive (UH-60/NH90 class), written in metres, so that it reads as bigger than the light one beside
// it. Its doors stand open; each door's MG sits a little ahead of and under the gunner's eyes (sim/seats.ts), so that
// it does not stand in the gunner's view.

const PANE = new THREE.MeshStandardMaterial({ color: 0x2a3a30, roughness: 0.15, transparent: true, opacity: 0.35, depthWrite: false });

class GunshipLook implements CraftLook<'gunship'> {
  readonly group = new THREE.Group();
  private readonly rotor: THREE.Group;
  private readonly tailRotor: THREE.Group;

  constructor() {
    this.group.visible = false;
    ({ rotor: this.rotor, tailRotor: this.tailRotor } = gunship(this.group, parts()));
  }

  draw(c: CraftView<CoreOf<'gunship'>>, { dt, alpha }: CraftFrame) {
    const core = c.core;
    placeYXZ(this.group, core.drawn(alpha));
    this.group.visible = true;
    // still on the skids of one left and on a wreck; idling under a pilot on them
    const spin = c.wreck ? 0 : core.motion.grounded ? (c.pilot === null ? 0 : 7) : 20;
    this.rotor.rotation.y = (this.rotor.rotation.y + spin * dt) % (2 * Math.PI);
    this.tailRotor.rotation.x = (this.tailRotor.rotation.x + 4 * spin * dt) % (2 * Math.PI);
  }

  hide() { this.group.visible = false; }
}

export const gunshipLook = () => new GunshipLook();

function gunship(group: THREE.Group, part: Part) {
  const OLIVE = 0x4b5535, DARK_OLIVE = 0x353d27, DARK = 0x23282a, METAL = 0x4a5257, GUN = 0x1c1f20;
  // skids on struts, their feet SPAWN_HEIGHT under the origin
  for (const x of [-1.2, 1.2]) {
    part(group, METAL, [0.12, 0.12, 4.2], x, -1.24, 0.3);
    part(group, METAL, [0.12, 0.12, 0.45], x, -1.15, 2.55).rotation.x = -0.6;
    for (const z of [-1.2, 1.5]) part(group, METAL, [0.1, 0.55, 0.1], x * 0.93, -0.95, z).rotation.z = x > 0 ? -0.3 : 0.3;
  }
  // the floor, the roof over the open doors, the walls behind and ahead of them; the cockpit's glass (the pilot seen
  // through it) and the nose
  part(group, DARK_OLIVE, [2.3, 0.35, 5.2], 0, -0.8, 0.4);
  part(group, OLIVE, [2.3, 0.25, 5.2], 0, 1.1, 0.4);
  part(group, OLIVE, [2.3, 1.6, 0.6], 0, 0.175, -1.9);
  part(group, OLIVE, [2.3, 1.6, 1.2], 0, 0.175, 1.2);
  part(group, DARK, [2.1, 1.3, 1.2], 0, 0.3, 2.4).material = PANE;
  part(group, OLIVE, [1.9, 0.7, 0.7], 0, -0.3, 3.3);
  part(group, DARK, [1.8, 0.55, 0.35], 0, 0.35, 3.15).material = PANE;
  // the gunners' seats inside the doors, the bench at the back
  for (const x of [-0.95, 0.95]) part(group, DARK, [0.5, 0.5, 0.5], x, -0.37, -0.46);
  part(group, DARK, [1.8, 0.45, 0.5], 0, -0.4, -1.35);
  // the engines and the rotor's mast over the cabin
  part(group, OLIVE, [1.5, 0.6, 3.0], 0, 1.52, -0.4);
  part(group, DARK, [0.25, 0.6, 0.25], 0, 2.1, 0);
  // the tail boom, the fin and the stabiliser
  part(group, OLIVE, [0.6, 0.6, 6.0], 0, 0.8, -5.2);
  part(group, OLIVE, [0.15, 1.8, 1.0], 0, 1.5, -8.4);
  part(group, OLIVE, [2.6, 0.08, 0.6], 0, 0.9, -7.6);
  // a door gun each side on an arm, pointing out
  for (const side of [1, -1] as const) {
    const m = mountOf(SEATS.craft.gunship, { role: 'passenger', index: side > 0 ? 0 : 1 })!.at;
    part(group, METAL, [0.08, 0.5, 0.08], m.x, m.y - 0.45, m.z + 0.35);
    part(group, GUN, [1.0, 0.1, 0.1], m.x + side * 0.4, m.y - 0.2, m.z + 0.35);
    part(group, GUN, [0.2, 0.15, 0.25], m.x - side * 0.05, m.y - 0.2, m.z + 0.35);
  }
  // the main rotor: four blades, 15 m
  const rotor = new THREE.Group();
  rotor.position.y = 2.4;
  group.add(rotor);
  part(rotor, DARK, [0.5, 0.2, 0.5], 0, 0, 0);
  for (const a of [0, Math.PI / 4]) {
    part(rotor, DARK, [15, 0.06, 0.4], 0, 0, 0).rotation.y = a;
    part(rotor, DARK, [0.4, 0.06, 15], 0, 0, 0).rotation.y = a;
  }
  // the tail rotor (2.6 m), on the fin's left side
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.18, 1.9, -8.6);
  group.add(tailRotor);
  part(tailRotor, DARK, [0.05, 2.6, 0.2], 0, 0, 0);
  part(tailRotor, DARK, [0.05, 0.2, 2.6], 0, 0, 0);
  return { rotor, tailRotor };
}
