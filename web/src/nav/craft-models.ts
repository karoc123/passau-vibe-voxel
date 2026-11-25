import * as THREE from 'three';
import { CRAFT_SCALE, type CraftKind } from '../sim/craft/craft-motion';

// The crafts drawn from boxes, at the world's scale (1 unit = 1 m; the walker is 1.78 m, a car 4.6 m, the bus 12 m).
// The hovercraft and the helicopter are written below at a base size and drawn CRAFT_SCALE times that (craft-motion.ts;
// their collision probes, craft-collision.ts, scale with them):
// - hovercraft (x1.3): a passenger hovercraft, 7.8 x 3.4 m, 2.5 m to the fan ducts' top over the skirt's foot (base
//   6.0 x 2.6 x 1.9); the origin HOVER_HEIGHT (0.88 m) over the surface it rides on, nose +z
// - helicopter (x1.2): a light twin (as an H135/H145): 12 m rotor, 10.1 m fuselage with the tail, 3.7 m to the rotor
//   hub (base 10 / 8.4 / 3.1); the origin over the skids, their feet SPAWN_HEIGHT (1.32 m) under it
// - paraglider: a pilot seated in the harness under a 10 m arc of wing, its lines 6-7 m long; the origin at the feet
//   (the motion's point is GLIDER_HEIGHT over them: special-craft.ts draws the model that much lower)
// - drone: a 5-inch FPV quad, 0.25 m motor to motor; the origin its middle, nose -z (as its camera looks); drawn only
//   when someone else flies it, or no one (crafts-view.ts: its pilot sees through its camera)

const box = new THREE.BoxGeometry();

export interface CraftModel { group: THREE.Group; rotor?: THREE.Group; tailRotor?: THREE.Group }

export function makeCraftModel(kind: CraftKind | 'drone'): CraftModel {
  const group = new THREE.Group();
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  const part = (parent: THREE.Object3D, color: number, size: [number, number, number], x: number, y: number, z: number) => {
    let material = materials.get(color);
    if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness: 0.8 }); materials.set(color, material); }
    const mesh = new THREE.Mesh(box, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(...size);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  // a thin bar from a to b (struts, lines)
  const bar = (parent: THREE.Object3D, color: number, a: THREE.Vector3, b: THREE.Vector3, w = 0.025) => {
    const mid = a.clone().lerp(b, 0.5);
    const mesh = part(parent, color, [w, a.distanceTo(b), w], mid.x, mid.y, mid.z);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    mesh.castShadow = false;
    return mesh;
  };

  if (kind === 'hovercraft') { group.scale.setScalar(CRAFT_SCALE.hovercraft); return { group: hovercraft(group, part) }; }
  if (kind === 'helicopter') { group.scale.setScalar(CRAFT_SCALE.helicopter); return helicopter(group, part); }
  if (kind === 'drone') return { group: drone(group, part) };
  return { group: paraglider(group, part, bar) };
}

type Part = (parent: THREE.Object3D, color: number, size: [number, number, number], x: number, y: number, z: number) => THREE.Mesh;
type Bar = (parent: THREE.Object3D, color: number, a: THREE.Vector3, b: THREE.Vector3, w?: number) => THREE.Mesh;

function hovercraft(group: THREE.Group, part: Part) {
  const SKIRT = 0x1f2528, HULL = 0xe8e4da, STRIPE = 0xd4562c, GLASS = 0x2e4a57, DUCT = 0x3b464d;
  // the skirt: a black rubber band round the hull, rounded at the bow
  part(group, SKIRT, [2.6, 0.62, 5.2], 0, -0.37, -0.2);
  part(group, SKIRT, [2.2, 0.56, 0.5], 0, -0.4, 2.6);
  part(group, SKIRT, [1.4, 0.5, 0.3], 0, -0.42, 2.95);
  // the hull's deck, a coloured stripe, the cabin with a wraparound windscreen
  part(group, HULL, [2.4, 0.32, 5.6], 0, 0.06, 0);
  part(group, STRIPE, [2.42, 0.1, 5.62], 0, 0.0, 0);
  part(group, HULL, [1.9, 0.55, 2.6], 0, 0.5, 0.35);
  part(group, GLASS, [1.92, 0.42, 2.0], 0, 0.98, 0.45);
  part(group, GLASS, [1.7, 0.4, 0.12], 0, 0.95, 1.5);
  part(group, HULL, [1.9, 0.1, 2.3], 0, 1.24, 0.35);
  // two fan ducts at the stern (1.4 m), a grille and rudders behind them
  for (const x of [-0.66, 0.66]) {
    part(group, DUCT, [1.3, 1.4, 0.45], x, 0.9, -2.35);
    part(group, 0x151b1e, [1.0, 1.1, 0.47], x, 0.9, -2.35);
    part(group, 0xbfc6c4, [0.95, 0.08, 0.5], x, 0.9, -2.36).rotation.z = Math.PI / 4;
    part(group, 0xbfc6c4, [0.95, 0.08, 0.5], x, 0.9, -2.36).rotation.z = -Math.PI / 4;
    part(group, STRIPE, [0.06, 1.1, 0.45], x, 0.9, -2.85);
  }
  return group;
}

function helicopter(group: THREE.Group, part: Part) {
  const PAINT = 0xc8372d, WHITE = 0xe8e4da, GLASS = 0x2a4250, DARK = 0x2a3238, METAL = 0x5b666d;
  // skids on struts
  for (const x of [-1.1, 1.1]) {
    part(group, METAL, [0.1, 0.1, 2.9], x, -1.05, 0.25);
    part(group, METAL, [0.1, 0.1, 0.35], x, -0.98, 1.78).rotation.x = -0.6;
    for (const z of [-0.5, 1.0]) part(group, METAL, [0.08, 0.62, 0.08], x * 0.85, -0.72, z).rotation.z = x > 0 ? -0.35 : 0.35;
  }
  // the cabin: a belly, the body, the glass over the front seats and the doors' windows, the engine on the roof
  part(group, WHITE, [1.4, 0.3, 3.0], 0, -0.3, 0.2);
  part(group, PAINT, [1.5, 1.05, 2.6], 0, 0.35, -0.05);
  part(group, GLASS, [1.42, 1.0, 1.0], 0, 0.42, 1.55);
  part(group, GLASS, [1.2, 0.5, 0.25], 0, 0.1, 2.1);
  part(group, GLASS, [1.52, 0.5, 1.2], 0, 0.55, 0.3);
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
  return { group, rotor, tailRotor };
}

function paraglider(group: THREE.Group, part: Part, bar: Bar) {
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
  return group;
}

function drone(group: THREE.Group, part: Part) {
  const FRAME = 0x26292b, PROP = 0x9aa3a8, NOSE = 0xd4562c;
  part(group, FRAME, [0.06, 0.035, 0.12], 0, 0, 0);
  part(group, NOSE, [0.03, 0.03, 0.03], 0, 0.02, -0.06);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const arm = part(group, FRAME, [0.012, 0.012, 0.125], x * 0.044, 0, z * 0.044);
    arm.rotation.y = Math.atan2(x, z);
    part(group, z < 0 ? NOSE : PROP, [0.12, 0.004, 0.012], x * 0.088, 0.022, z * 0.088);
  }
  return group;
}
