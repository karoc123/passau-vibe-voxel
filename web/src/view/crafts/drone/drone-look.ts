import * as THREE from 'three';
import type { CraftView } from '../../../client/sim-client';
import type { CoreOf } from '../../../sim/craft/cores';
import { parts, type CraftFrame, type CraftLook, type Part } from '../craft-look';

// A 5-inch FPV quad, 0.25 m motor to motor; the origin its middle, nose -z (as its camera looks). Its own pilot sees
// through its camera, so only others see this.

class DroneLook implements CraftLook<'drone'> {
  readonly group = new THREE.Group();

  constructor() {
    this.group.visible = false;
    drone(this.group, parts());
  }

  draw(c: CraftView<CoreOf<'drone'>>, { alpha }: CraftFrame) {
    const d = c.core.drawn(alpha);
    this.group.position.set(d.position.x, d.position.y, d.position.z);
    this.group.quaternion.set(d.attitude.x, d.attitude.y, d.attitude.z, d.attitude.w);
    this.group.visible = true;
  }

  hide() { this.group.visible = false; }
}

export const droneLook = () => new DroneLook();

function drone(group: THREE.Group, part: Part) {
  const FRAME = 0x26292b, PROP = 0x9aa3a8, NOSE = 0xd4562c;
  part(group, FRAME, [0.06, 0.035, 0.12], 0, 0, 0);
  part(group, NOSE, [0.03, 0.03, 0.03], 0, 0.02, -0.06);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const arm = part(group, FRAME, [0.012, 0.012, 0.125], x * 0.044, 0, z * 0.044);
    arm.rotation.y = Math.atan2(x, z);
    part(group, z < 0 ? NOSE : PROP, [0.12, 0.004, 0.012], x * 0.088, 0.022, z * 0.088);
  }
}
