import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CraftView } from '../../../client/sim-client';
import type { CoreOf } from '../../../sim/craft/cores';
import { FIGHTER } from '../../../sim/craft/plane-flight';
import { box, orient, type CraftFrame, type CraftLook } from '../craft-look';

// A single-seat fighter on one main float and two under its wing tips, ~9 m long, 9.2 m span, nose +z, the main
// float's bottom FLOAT_H under the flight's point. Olive over grey, a long dark cowling with a yellow ring and the two
// MG barrels on top of it, a low wing, a bubble canopy: told apart from the white high-wing floatplane at a glance.
// One merged body with vertex colours, the propeller with a faint disc, the lights.

const OLIVE = 0x4f5a3a, GREY = 0x9aa0a0, GLASS = 0x1c2630, DARK = 0x26282b, YELLOW = 0xd8a92a, WHITE = 0xe8e8e2, METAL = 0x4a4d52;

class FighterLook implements CraftLook<'fighter'> {
  readonly group = new THREE.Group();
  private readonly prop = new THREE.Group();
  private readonly lamps: { mesh: THREE.Mesh; base: THREE.Color; strobe?: boolean }[] = [];
  private spin = 0;
  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor() {
    const floatH = FIGHTER.FLOAT_H, y0 = -floatH + 1.55; // the fuselage's floor over the main float's bottom
    const wy = y0 + 0.15; // the low wing (the flight's WING_Y)
    const parts = [
      // fuselage: the cockpit section, the rear tapering in two boxes, the long cowling and its yellow ring
      box(1.0, 1.05, 2.2, 0, y0 + 0.55, 0.4, OLIVE),
      box(0.8, 0.85, 1.6, 0, y0 + 0.6, -1.5, OLIVE),
      box(0.5, 0.6, 1.6, 0, y0 + 0.7, -3.0, OLIVE),
      box(1.0, 0.95, 1.7, 0, y0 + 0.55, 2.35, DARK),
      box(1.04, 0.99, 0.25, 0, y0 + 0.55, 3.1, YELLOW),
      box(1.02, 0.3, 5.0, 0, y0 + 0.12, 0.3, GREY), // the grey belly
      box(0.82, 0.12, 0.5, 0, y0 + 0.7, -1.3, WHITE), // the band round the rear
      // the canopy's frame (its glass: below, the frame's ends standing out of the glass's) and the headrest behind it
      box(0.66, 0.08, 1.32, 0, y0 + 1.55, 0.25, DARK),
      box(0.4, 0.4, 0.8, 0, y0 + 1.2, -0.75, OLIVE),
      // the two MG barrels over the cowling, the mount's point at their muzzles (sim/seats.ts)
      box(0.08, 0.08, 1.0, 0.18, y0 + 1.15, 3.1, METAL),
      box(0.08, 0.08, 1.0, -0.18, y0 + 1.15, 3.1, METAL),
      // the low wing (two halves, a little dihedral), grey below, yellow leading edges near the tips
      box(4.25, 0.16, 1.7, 2.45, wy, 0.4, OLIVE, 0, 0.06),
      box(4.25, 0.16, 1.7, -2.45, wy, 0.4, OLIVE, 0, -0.06),
      box(4.25, 0.04, 1.7, 2.45, wy - 0.1, 0.4, GREY, 0, 0.06),
      box(4.25, 0.04, 1.7, -2.45, wy - 0.1, 0.4, GREY, 0, -0.06),
      box(1.4, 0.17, 0.25, 3.7, wy + 0.22, 1.2, YELLOW, 0, 0.06),
      box(1.4, 0.17, 0.25, -3.7, wy + 0.22, 1.2, YELLOW, 0, -0.06),
      // tailplane and fin, the fin's tip white
      box(3.0, 0.1, 0.85, 0, y0 + 0.85, -3.4, OLIVE),
      box(0.1, 1.2, 1.1, 0, y0 + 1.5, -3.45, OLIVE, 0.3),
      box(0.12, 0.3, 0.6, 0, y0 + 1.95, -3.7, WHITE, 0.3),
      // the main float on two struts, its nose turned up; a float under each wing tip on a strut
      box(0.6, 0.55, 5.6, 0, -floatH + 0.275, 0.6, GREY),
      box(0.5, 0.4, 0.8, 0, -floatH + 0.42, 3.65, GREY, -0.35),
      box(0.1, 0.95, 0.12, 0, -floatH + 1.0, 1.9, DARK, -0.3),
      box(0.1, 0.95, 0.12, 0, -floatH + 1.0, -0.6, DARK, 0.3),
      box(0.28, 0.3, 1.3, 3.9, wy - 0.85, 0.4, GREY),
      box(0.28, 0.3, 1.3, -3.9, wy - 0.85, 0.4, GREY),
      box(0.06, 0.7, 0.08, 3.9, wy - 0.4, 0.4, DARK),
      box(0.06, 0.7, 0.08, -3.9, wy - 0.4, 0.4, DARK),
    ];
    const body = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }));
    body.castShadow = body.receiveShadow = true;
    // the bubble canopy seen through, onto the pilot (view/seats.ts)
    const glass = new THREE.Mesh(mergeGeometries([box(0.7, 0.5, 1.3, 0, y0 + 1.3, 0.25, GLASS), box(0.66, 0.4, 0.1, 0, y0 + 1.25, 0.95, GLASS, -0.6)]),
      new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.15, transparent: true, opacity: 0.35, depthWrite: false }));
    this.group.add(body, glass);
    // the propeller: three blades and a spinner, and a faint disc so that it reads as spinning at any frame rate
    const blades = new THREE.Mesh(mergeGeometries([
      box(0.14, 1.0, 0.05, 0, 0.5, 0, DARK), box(0.14, 1.0, 0.05, 0, 0.5, 0, DARK).rotateZ(2.094), box(0.14, 1.0, 0.05, 0, 0.5, 0, DARK).rotateZ(-2.094),
      box(0.3, 0.3, 0.45, 0, 0, 0.15, YELLOW)]), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.0, 24), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide }));
    this.prop.add(blades, disc);
    this.prop.position.set(0, y0 + 0.55, 3.3);
    this.group.add(this.prop);
    // lights: red at the left tip (+x: the nose is +z), green at the right, white at the tail, a strobe on the fin
    const lamp = (hex: number, x: number, y: number, z: number, strobe = false) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.16), new THREE.MeshBasicMaterial({ color: hex }));
      m.position.set(x, y, z);
      this.group.add(m);
      this.lamps.push({ mesh: m, base: new THREE.Color(hex), strobe });
    };
    lamp(0xff2a1a, 4.62, wy + 0.28, 0.4);
    lamp(0x22ff55, -4.62, wy + 0.28, 0.4);
    lamp(0xffffff, 0, y0 + 0.7, -3.85);
    lamp(0xffffff, 0, y0 + 2.15, -3.85, true);
    this.group.visible = false;
  }

  // (hidden once crashed, until it is put back)
  draw(c: CraftView<CoreOf<'fighter'>>, { dt, alpha, night, now }: CraftFrame) {
    const f = c.core.flight, d = c.core.drawn(alpha);
    this.group.visible = f.state !== 'crashed';
    orient(this.group, d.p, this.fwd.copy(d.fwd), this.up.copy(d.up));
    // the propeller by the engine (0..1; a wreck's stands), the lamps by the night
    if (!c.wreck) this.spin += (14 + 40 * f.engine) * dt;
    this.prop.rotation.z = this.spin;
    const k = 1 + 3 * night;
    for (const l of this.lamps) {
      const on = !l.strobe || now % 1000 < 80;
      (l.mesh.material as THREE.MeshBasicMaterial).color.copy(l.base).multiplyScalar(on ? k : 0.15);
    }
  }

  hide() { this.group.visible = false; }
}

export const fighterLook = () => new FighterLook();
