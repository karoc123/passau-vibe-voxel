import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CraftView } from '../../../client/sim-client';
import type { CoreOf } from '../../../sim/craft/cores';
import { PLANE } from '../../../sim/craft/plane-flight';
import { box, orient, type CraftFrame, type CraftLook } from '../craft-look';

// A high-wing two-seater on floats, 7 m long, 9 m span, nose +z, the floats' bottoms FLOAT_H under the flight's point
// (the fuselage's cube's centre). One merged body with vertex colours, the propeller with a faint disc, the lights.

const WHITE = 0xf2f2ee, BLUE = 0x1f4f9a, GLASS = 0x1c2630, DARK = 0x2a2c30, FLOAT = 0xd8d8d2, RED = 0xb02a22;

class FloatplaneLook implements CraftLook<'floatplane'> {
  readonly group = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly prop = new THREE.Group();
  private readonly lamps: { mesh: THREE.Mesh; base: THREE.Color; strobe?: boolean }[] = [];
  private spin = 0;

  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor() {
    const floatH = PLANE.FLOAT_H, y0 = -floatH + 1.55; // the fuselage's floor over the floats' bottoms
    const parts = [
      // fuselage: cabin (under its glass, and the wall behind the seats), rear in two tapering boxes, cowling
      box(1.15, 0.755, 2.4, 0, y0 + 0.3725, 0.9, WHITE),
      box(1.15, 0.495, 0.55, 0, y0 + 0.9975, -0.025, WHITE),
      box(1.0, 1.0, 1.6, 0, y0 + 0.68, -1.1, WHITE),
      box(0.7, 0.7, 1.7, 0, y0 + 0.8, -2.7, WHITE),
      box(1.05, 0.95, 0.9, 0, y0 + 0.6, 2.5, WHITE),
      box(1.17, 0.18, 4.6, 0, y0 + 0.55, 0.2, BLUE), // the stripe
      // the high wing (two halves, a little dihedral) on the cabin's roof, struts down to the fuselage
      box(4.4, 0.16, 1.45, 2.3, y0 + 1.36, 0.9, WHITE, 0, 0.035),
      box(4.4, 0.16, 1.45, -2.3, y0 + 1.36, 0.9, WHITE, 0, -0.035),
      box(0.25, 0.17, 1.47, 4.3, y0 + 1.43, 0.9, RED, 0, 0.035),
      box(0.25, 0.17, 1.47, -4.3, y0 + 1.43, 0.9, RED, 0, -0.035),
      box(0.07, 1.25, 0.1, 1.3, y0 + 0.75, 0.9, DARK, 0, 0.75),
      box(0.07, 1.25, 0.1, -1.3, y0 + 0.75, 0.9, DARK, 0, -0.75),
      // tailplane and fin
      box(3.0, 0.1, 0.8, 0, y0 + 0.95, -3.3, WHITE),
      box(0.1, 1.2, 1.0, 0, y0 + 1.55, -3.35, WHITE, 0.25),
      box(0.12, 0.35, 0.6, 0, y0 + 2.0, -3.55, BLUE, 0.25),
      // floats: two pontoons on struts
      box(0.45, 0.42, 5.4, 1.15, -floatH + 0.21, 0.4, FLOAT),
      box(0.45, 0.42, 5.4, -1.15, -floatH + 0.21, 0.4, FLOAT),
      box(0.38, 0.3, 0.7, 1.15, -floatH + 0.32, 3.3, FLOAT, -0.35),
      box(0.38, 0.3, 0.7, -1.15, -floatH + 0.32, 3.3, FLOAT, -0.35),
      box(0.08, 1.1, 0.08, 0.85, y0 - 0.45, 1.5, DARK, 0, 0.45),
      box(0.08, 1.1, 0.08, -0.85, y0 - 0.45, 1.5, DARK, 0, -0.45),
      box(0.08, 1.1, 0.08, 0.85, y0 - 0.45, -0.6, DARK, 0, 0.45),
      box(0.08, 1.1, 0.08, -0.85, y0 - 0.45, -0.6, DARK, 0, -0.45),
    ];
    this.body = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 }));
    this.body.castShadow = this.body.receiveShadow = true;
    // the windscreen and the side windows seen through, onto the pilot (view/seats.ts)
    const glass = new THREE.Mesh(mergeGeometries([box(1.0, 0.55, 0.12, 0, y0 + 1.15, 1.95, GLASS, -0.5), box(1.18, 0.5, 1.85, 0, y0 + 1.0, 1.175, GLASS)]),
      new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.15, transparent: true, opacity: 0.35, depthWrite: false }));
    this.group.add(this.body, glass);
    // the propeller: two blades and a spinner, and a faint disc so that it reads as spinning at any frame rate
    const blades = new THREE.Mesh(mergeGeometries([box(0.14, 1.85, 0.05, 0, 0, 0, DARK), box(0.24, 0.24, 0.35, 0, 0, 0.12, WHITE)]),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.95, 24), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide }));
    this.prop.add(blades, disc);
    this.prop.position.set(0, y0 + 0.6, 3.0);
    this.group.add(this.prop);
    // lights: red at the left tip (+x: the nose is +z), green at the right, white at the tail, a strobe on the fin
    const lamp = (hex: number, x: number, y: number, z: number, strobe = false) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.16), new THREE.MeshBasicMaterial({ color: hex }));
      m.position.set(x, y, z);
      this.group.add(m);
      this.lamps.push({ mesh: m, base: new THREE.Color(hex), strobe });
    };
    lamp(0xff2a1a, 4.48, y0 + 1.5, 0.9);
    lamp(0x22ff55, -4.48, y0 + 1.5, 0.9);
    lamp(0xffffff, 0, y0 + 0.85, -3.62);
    lamp(0xffffff, 0, y0 + 2.2, -3.62, true);
    this.group.visible = false;
  }

  // (hidden once crashed, until it is put back)
  draw(c: CraftView<CoreOf<'floatplane'>>, { dt, alpha, night, now }: CraftFrame) {
    const f = c.core.flight, d = c.core.drawn(alpha);
    this.group.visible = f.state !== 'crashed';
    orient(this.group, d.p, this.fwd.copy(d.fwd), this.up.copy(d.up));
    // the propeller by the engine (0..1), the lamps by the night
    this.spin += (14 + 40 * f.engine) * dt;
    this.prop.rotation.z = this.spin;
    const k = 1 + 3 * night;
    for (const l of this.lamps) {
      const on = !l.strobe || now % 1000 < 80;
      (l.mesh.material as THREE.MeshBasicMaterial).color.copy(l.base).multiplyScalar(on ? k : 0.15);
    }
  }

  hide() { this.group.visible = false; }
}

export const floatplaneLook = () => new FloatplaneLook();
