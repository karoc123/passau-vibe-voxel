import * as THREE from 'three';
import type { CraftView } from '../../client/sim-client';
import type { CraftType } from '../../sim/contract/ids';
import type { CoreOf } from '../../sim/craft/cores';

// A craft type's look is a package of its own (view/crafts/<type>/, listed once in index.ts): its model and what
// moves on it. The same draw runs for the craft the local player flies (its shell), another player's and one left in
// the world (crafts-view.ts), so a rotor or a fan that turns is the package's business alone.

/** what a frame gives every look: s since the last, between the world's last two ticks (alpha), 0 day .. 1 night, ms */
export interface CraftFrame { dt: number; alpha: number; night: number; now: number }

export interface CraftLook<K extends CraftType = CraftType> {
  /** what the look adds to the scene (hidden until drawn) */
  readonly group: THREE.Object3D;
  /** placed where the craft is drawn this frame and animated from its state (its pilot, its core), shown */
  draw(c: CraftView<CoreOf<K>>, f: CraftFrame): void;
  /** out of sight (left by its shell, or gone): what trails behind it let go of */
  hide(): void;
}

/** a box of colour hex, w x h x l round x, y, z (turned rx about x, then rz about z), vertex-coloured to be merged */
export function box(w: number, h: number, l: number, x: number, y: number, z: number, hex: number, rx = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, l);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  const c = new THREE.Color(hex), a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) a.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

const basis = new THREE.Matrix4(), left = new THREE.Vector3();
/** a model (nose +z, up +y, left +x) at p, its nose along fwd and its up along up (unit, across each other) */
export function orient(g: THREE.Object3D, p: THREE.Vector3Like, fwd: THREE.Vector3, up: THREE.Vector3) {
  g.position.copy(p);
  g.quaternion.setFromRotationMatrix(basis.makeBasis(left.crossVectors(up, fwd), up, fwd));
}

/** separate box meshes of one material per colour, for a model whose parts move apart (rotors, vanes) */
export function parts() {
  const unit = new THREE.BoxGeometry(), materials = new Map<number, THREE.MeshStandardMaterial>();
  return (parent: THREE.Object3D, color: number, size: [number, number, number], x: number, y: number, z: number) => {
    let material = materials.get(color);
    if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness: 0.8 }); materials.set(color, material); }
    const mesh = new THREE.Mesh(unit, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(...size);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
}
export type Part = ReturnType<typeof parts>;

/** a spinning part's angle: its rate follows target (rad/s) at response /s, so it spins up and runs down */
export class Spin {
  angle = 0;
  rate = 0;
  step(target: number, response: number, dt: number) {
    this.rate += (target - this.rate) * (1 - Math.exp(-response * dt));
    this.angle = (this.angle + this.rate * dt) % (2 * Math.PI);
    return this.angle;
  }
}

/** a pose as the special crafts draw it: heading, pitch (+ nose up), bank (+ the right side down) */
export function placeYXZ(g: THREE.Object3D, m: { x: number; y: number; z: number; h: number; pitch: number; bank: number }, drop = 0) {
  g.position.set(m.x, m.y - drop, m.z);
  g.rotation.set(-m.pitch, m.h, m.bank, 'YXZ');
}
