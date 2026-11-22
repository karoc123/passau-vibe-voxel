import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { box, orient } from './plane-model';

// The jet drawn from boxes in code (as the floatplane, plane-model.ts): a small two-seat aerobatic trainer in red and
// white, ~9 m long, 7.6 m span, nose +z, its belly at y = -1.3 (the flight's point is the fuselage's cube's centre).
// One merged body with vertex colours; the exhaust a glow (basic materials, additive: no new shader) that grows into
// an afterburner's flame over the last 15 % of the throttle; the lights as the floatplane's, and a landing light.

const WHITE = 0xf2f2ee, RED = 0xc4202a, GLASS = 0x1a2430, DARK = 0x2a2c30, METAL = 0x5a5e66;
const AB_FROM = 0.85; // the throttle where the afterburner's flame starts (drawn only: the thrust is the lever's)

export class JetModel {
  readonly group = new THREE.Group();
  private readonly flame = new THREE.Group();
  private readonly outer: THREE.Mesh;
  private readonly core: THREE.Mesh;
  private readonly glow: THREE.Mesh;
  private readonly lamps: { mesh: THREE.Mesh; base: THREE.Color; strobe?: boolean; night?: boolean }[] = [];

  constructor() {
    const parts = [
      // fuselage: nose cone in two steps, cockpit section, centre, rear, tail cone
      box(0.36, 0.36, 0.9, 0, -0.05, 4.25, RED),
      box(0.62, 0.62, 1.0, 0, -0.02, 3.4, RED),
      box(0.88, 0.9, 2.2, 0, 0, 1.85, WHITE),
      box(1.05, 1.0, 2.6, 0, 0, -0.5, WHITE),
      box(0.86, 0.86, 1.6, 0, 0.02, -2.6, WHITE),
      box(0.64, 0.66, 0.8, 0, 0.04, -3.75, RED),
      box(0.5, 0.12, 6.0, 0, -0.47, 0.2, RED), // the belly stripe
      // canopy: glass on a dark frame, two seats in tandem
      box(0.66, 0.5, 2.3, 0, 0.62, 1.7, GLASS),
      box(0.7, 0.08, 2.4, 0, 0.42, 1.7, DARK),
      box(0.62, 0.42, 0.12, 0, 0.6, 2.88, GLASS, -0.7),
      // intakes either side of the cockpit
      box(0.3, 0.55, 1.5, 0.62, -0.05, 0.7, WHITE),
      box(0.3, 0.55, 1.5, -0.62, -0.05, 0.7, WHITE),
      box(0.26, 0.45, 0.06, 0.62, -0.05, 1.46, DARK),
      box(0.26, 0.45, 0.06, -0.62, -0.05, 1.46, DARK),
      // the low wing: two swept halves with a little dihedral, red tip tanks
      box(3.0, 0.12, 1.7, 1.9, -0.36, -0.4, WHITE, 0, 0.05),
      box(3.0, 0.12, 1.7, -1.9, -0.36, -0.4, WHITE, 0, -0.05),
      box(0.3, 0.3, 1.9, 3.38, -0.22, -1.3, RED),
      box(0.3, 0.3, 1.9, -3.38, -0.22, -1.3, RED),
      // tailplane and fin (swept), the fin red
      box(2.9, 0.08, 0.9, 0, 0.1, -3.55, WHITE),
      box(0.1, 1.45, 1.3, 0, 1.05, -3.45, RED, 0.45),
      // the nozzle
      box(0.56, 0.56, 0.3, 0, 0.04, -4.25, METAL),
    ];
    // the wings' sweep: the halves' boxes turned about y (built straight, merged turned)
    const sweep = (g: THREE.BufferGeometry, a: number, x: number) => g.translate(-x, 0, 0).rotateY(a).translate(x, 0, 0);
    sweep(parts[14], 0.32, 0.5); sweep(parts[15], -0.32, -0.5);
    const body = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.2 }));
    body.castShadow = body.receiveShadow = true;
    this.group.add(body);
    // the exhaust: a faint glow in the nozzle, and the flame (an outer and a core cone, their tips back along -z, scaled
    // by length)
    const add = (color: number, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
    const cone = (r: number) => new THREE.ConeGeometry(r, 1, 12, 1, true).translate(0, 0.5, 0).rotateX(-Math.PI / 2);
    this.glow = new THREE.Mesh(new THREE.CircleGeometry(0.22, 16).rotateY(Math.PI), add(0xff7a2a, 0.9));
    this.glow.position.set(0, 0.04, -4.41);
    this.outer = new THREE.Mesh(cone(0.26), add(0xff6a20, 0.55));
    this.core = new THREE.Mesh(cone(0.15), add(0x9fc8ff, 0.8));
    this.flame.add(this.outer, this.core);
    this.flame.position.set(0, 0.04, -4.4);
    this.group.add(this.glow, this.flame);
    // lights: red at the left tip (+x), green at the right, white at the tail, a strobe on the fin, a landing light
    // under the nose (by night only)
    const lamp = (hex: number, x: number, y: number, z: number, o: { strobe?: boolean; night?: boolean } = {}) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.24), new THREE.MeshBasicMaterial({ color: hex }));
      m.position.set(x, y, z);
      this.group.add(m);
      this.lamps.push({ mesh: m, base: new THREE.Color(hex), ...o });
    };
    lamp(0xff2a1a, 3.56, -0.22, -1.1);
    lamp(0x22ff55, -3.56, -0.22, -1.1);
    lamp(0xffffff, 0, 0.1, -4.05);
    lamp(0xffffff, 0, 1.75, -3.9, { strobe: true });
    lamp(0xfff4dd, 0, -0.42, 3.2, { night: true });
    this.group.visible = false;
  }

  orient(p: THREE.Vector3, fwd: THREE.Vector3, up: THREE.Vector3) { orient(this.group, p, fwd, up); }

  /** the exhaust by the engine (0..1; the afterburner over AB_FROM), the lamps by the night (0 day .. 1 night) */
  animate(_dt: number, engine: number, night: number, now: number) {
    const ab = Math.max(0, (engine - AB_FROM) / (1 - AB_FROM)), flicker = 0.9 + 0.1 * Math.sin(now * 0.07) * Math.sin(now * 0.031);
    // the nozzle glows a little with the engine, more by night; the flame is a short heat shimmer, long with reheat
    (this.glow.material as THREE.MeshBasicMaterial).opacity = Math.min(1, engine * (0.15 + 0.7 * night) + 0.6 * ab);
    const len = (0.4 * engine + 3.2 * ab) * flicker;
    this.flame.visible = len > 0.05;
    this.flame.scale.set(0.8 + 0.4 * ab, 0.8 + 0.4 * ab, Math.max(0.01, len));
    (this.outer.material as THREE.MeshBasicMaterial).opacity = (0.15 + 0.5 * ab + 0.2 * night) * flicker;
    (this.core.material as THREE.MeshBasicMaterial).opacity = (0.1 + 0.75 * ab) * flicker;
    const k = 1 + 3 * night;
    for (const l of this.lamps) {
      const on = (!l.strobe || now % 1000 < 80) && (!l.night || night > 0.3);
      (l.mesh.material as THREE.MeshBasicMaterial).color.copy(l.base).multiplyScalar(on ? k : 0.15);
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    });
  }
}
