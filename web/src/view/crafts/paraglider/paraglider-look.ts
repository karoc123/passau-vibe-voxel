import * as THREE from 'three';
import type { CraftView } from '../../../client/sim-client';
import type { CoreOf } from '../../../sim/craft/cores';
import { GLIDER_HEIGHT } from '../../../sim/craft/craft-motion';
import { parts, placeYXZ, type CraftFrame, type CraftLook, type Part } from '../craft-look';

// A pilot seated in the harness under a 10 m arc of wing, its lines 6-7 m long. The model's origin is at the feet, the
// motion's point GLIDER_HEIGHT over them (the pilot's middle): drawn that much lower.

class ParagliderLook implements CraftLook<'paraglider'> {
  readonly group = new THREE.Group();

  constructor() {
    this.group.visible = false;
    paraglider(this.group, parts());
  }

  draw(c: CraftView<CoreOf<'paraglider'>>, { alpha }: CraftFrame) {
    placeYXZ(this.group, c.core.drawn(alpha), GLIDER_HEIGHT);
    this.group.visible = true;
  }

  hide() { this.group.visible = false; }
}

export const paragliderLook = () => new ParagliderLook();

// a thin bar from a to b (struts, lines)
function bars(part: Part) {
  return (parent: THREE.Object3D, color: number, a: THREE.Vector3, b: THREE.Vector3, w = 0.025) => {
    const mid = a.clone().lerp(b, 0.5);
    const mesh = part(parent, color, [w, a.distanceTo(b), w], mid.x, mid.y, mid.z);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    mesh.castShadow = false;
    return mesh;
  };
}

function paraglider(group: THREE.Group, part: Part) {
  const bar = bars(part);
  const SUIT = 0x2c4a63, HARNESS = 0x2b2f33, SKIN = 0xd9a27c, HELMET = 0xf0f0ea;
  // the pilot, seated in the harness: legs hanging forward, hands up on the brakes (as tall as the walker)
  part(group, HARNESS, [0.5, 0.32, 0.7], 0, 0.72, -0.05);
  part(group, HARNESS, [0.46, 0.55, 0.22], 0, 1.0, -0.38);
  part(group, SUIT, [0.42, 0.55, 0.28], 0, 1.14, -0.12).rotation.x = -0.2;
  part(group, SKIN, [0.24, 0.26, 0.24], 0, 1.55, -0.08);
  part(group, HELMET, [0.28, 0.17, 0.3], 0, 1.68, -0.08);
  for (const sign of [-1, 1]) {
    part(group, SUIT, [0.17, 0.5, 0.19], sign * 0.12, 0.66, 0.38).rotation.x = 1.25;
    part(group, SUIT, [0.16, 0.48, 0.17], sign * 0.12, 0.32, 0.66).rotation.x = 0.1;
    part(group, HARNESS, [0.17, 0.1, 0.27], sign * 0.12, 0.06, 0.72);
    part(group, SUIT, [0.12, 0.55, 0.13], sign * 0.3, 1.5, -0.08).rotation.z = -sign * 0.25;
  }
  // the wing: nine cells on an arc round the pilot (radius 6 m, 10 m from tip to tip, 7.6 m over the feet in the
  // middle), the chord 2.6 m tapering to 1.5 at the tips; its lines fan out to the risers at the shoulders
  const R = 6, CY = 1.6, cells = 9;
  for (let i = 0; i < cells; i++) {
    const a = (i - (cells - 1) / 2) * 0.24, chord = 2.6 - 1.1 * Math.abs(a) / 0.96;
    const x = R * Math.sin(a), y = CY + R * Math.cos(a);
    const cell = part(group, i % 2 ? 0xe0a030 : 0xf3cf6a, [1.4, 0.28, chord], x, y, 0.15);
    cell.rotation.z = -a;
    if (i % 2 === 0) {
      const riser = new THREE.Vector3(Math.sign(x) * 0.25, 1.45, -0.05);
      const under = (dz: number) => new THREE.Vector3(x - 0.15 * Math.sin(a), y - 0.15 * Math.cos(a), 0.15 + dz * chord);
      bar(group, 0x4d5e63, riser, under(0.35));
      bar(group, 0x4d5e63, riser, under(-0.35));
    }
  }
}
