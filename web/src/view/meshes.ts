import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { MAX_BIKES, MAX_CARS, MAX_PEOPLE } from '../sim/contract/agents';
import { PALETTE, VEHICLE_IDS, VEHICLES, type Part } from '../sim/vehicles';
import type { VehicleId } from '../sim/contract/ids';
export { MAX_BIKES, MAX_PEOPLE };

function box(w: number, h: number, l: number, x: number, y: number, z: number, hex?: number) {
  const g = new THREE.BoxGeometry(w, h, l).translate(x, y + h / 2, z);
  if (hex === undefined) return g;
  const c = new THREE.Color(hex), a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) a.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
const merge = (...gs: THREE.BufferGeometry[]) => mergeGeometries(gs);
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.25, ...o });

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, { shadow = false, color = false } = {}) {
  const m = new THREE.InstancedMesh(geo, mat, n);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  m.frustumCulled = false;
  if (color) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  return m;
}

// a vehicle type's meshes (sim/vehicles.ts, its model's parts by colour): its paint (white, coloured per instance),
// its fixed colours (glass, tyres, trim: vertex colours), its head lamps (headMat: brighter at night) and tail lamps
// (coloured per instance: brighter when braking)
export interface VehicleMeshes { body: THREE.InstancedMesh; dark: THREE.InstancedMesh; head: THREE.InstancedMesh; tail: THREE.InstancedMesh }
/** a vehicle type's meshes with its cabin seen into: its side windows a pane of their own */
export interface OpenMeshes extends VehicleMeshes { pane: THREE.InstancedMesh }

const partBox = ([w, h, l, x, y, z, c]: Part, colour: boolean) => box(w, h, l, x, y, z, colour ? new THREE.Color(PALETTE[c as keyof typeof PALETTE]).getHex() : undefined);

function vehicleMeshes(model: readonly Part[], n: number, mats: { body: THREE.Material; dark: THREE.Material; head: THREE.Material; tail: THREE.Material }): VehicleMeshes {
  const parts = (want: (c: string) => boolean, colour: boolean) => {
    const gs = model.filter((p) => want(p[6])).map((p) => partBox(p, colour));
    return gs.length ? merge(...gs) : new THREE.BufferGeometry();
  };
  const fixed = (c: string) => c !== 'paint' && c !== 'head' && c !== 'tail';
  return {
    body: instanced(parts((c) => c === 'paint', false), mats.body, n, { shadow: true, color: true }),
    dark: instanced(parts(fixed, true), mats.dark, n, { shadow: true }),
    head: instanced(parts((c) => c === 'head', false), mats.head, n),
    tail: instanced(parts((c) => c === 'tail', false), mats.tail, n, { color: true }),
  };
}

// A car a seated player is drawn in (view/seats.ts) has its cabin opened, so that who sits in it shows; few are near
// at once. All the others keep the solid cabin: an empty one seen into would change the look of every car of the
// traffic.
export const OPEN_CARS = 16;
const spans = (a: Part, b: Part) => a[4] < b[4] + b[1] && b[4] < a[4] + a[1] && Math.abs(a[5] - b[5]) < (a[2] + b[2]) / 2;
// a side window: glass at least as wide as a part of the body it wraps (a windscreen or a visor is narrower and stays)
const wraps = (g: Part, q: Part) => g[6] === 'glass' && q[6] !== 'glass' && q[0] <= g[0] && spans(q, g);
// an end wall this thin beside a side window is the windscreen or the rear window: glass too, so who sits in the car
// shows from ahead and from behind
const END = 0.3;
// q without the slab across it at g's height and length: what is below and above it, and before and after it (an
// end wall thinner than END goes to the glass)
function carve(q: Part, g: Part, panes: Part[]): Part[] {
  const [w, h, l, x, y, z, c] = q, top = y + h, g0 = g[5] - g[2] / 2, g1 = g[5] + g[2] / 2, q0 = z - l / 2, q1 = z + l / 2;
  const lo = Math.max(y, g[4]), hi = Math.min(top, g[4] + g[1]), out: Part[] = [];
  if (lo > y) out.push([w, lo - y, l, x, y, z, c]);
  if (top > hi) out.push([w, top - hi, l, x, hi, z, c]);
  if (g0 > q0) (g0 - q0 < END ? panes : out).push([w, hi - lo, g0 - q0, x, lo, (q0 + g0) / 2, c]);
  if (q1 > g1) (q1 - g1 < END ? panes : out).push([w, hi - lo, q1 - g1, x, lo, (g1 + q1) / 2, c]);
  return out;
}
const inside = (a: Part, b: Part) => Math.abs(a[3] - b[3]) < (a[0] + b[0]) / 2 && spans(a, b);
/** a model's parts with its side windows cut out of the body behind them, and the glass: those windows, the end
 * walls beside them, and any glass with no body behind it any more (a windscreen before an opened end, a bus's band) */
function opened(model: readonly Part[]): { parts: Part[]; panes: Part[] } {
  const sides = model.filter((g) => model.some((q) => wraps(g, q))), panes = [...sides];
  let parts = model.filter((p) => !sides.includes(p));
  for (const g of sides) parts = parts.flatMap((q) => (wraps(g, q) ? carve(q, g, panes) : [q]));
  const free = parts.filter((g) => g[6] === 'glass' && !parts.some((q) => q[6] !== 'glass' && inside(g, q)));
  return { parts: parts.filter((p) => !free.includes(p)), panes: [...panes, ...free] };
}

// instanced meshes for every car (of each type), person, bike and signal head; the simulation writes their matrices
export class LifeMeshes {
  readonly group = new THREE.Group();
  // the vehicles' meshes by type; the car's also as body, dark, head and tail
  readonly vehicles = {} as Record<VehicleId, VehicleMeshes>;
  // the same with the cabin seen into (OPEN_CARS each)
  readonly open = {} as Record<VehicleId, OpenMeshes>;
  readonly body: THREE.InstancedMesh;
  readonly dark: THREE.InstancedMesh;
  readonly head: THREE.InstancedMesh;
  readonly tail: THREE.InstancedMesh;
  readonly legs: THREE.InstancedMesh;
  readonly torso: THREE.InstancedMesh;
  readonly pole: THREE.InstancedMesh;
  readonly bike: THREE.InstancedMesh;
  readonly lamp: THREE.InstancedMesh;
  readonly headMat = new THREE.MeshBasicMaterial({ color: 0xfff3dd });

  constructor(scene: THREE.Scene, heads: [number, number, number, number, ...number[]][]) {
    const mats = { body: std({ color: 0xffffff }), dark: std({ vertexColors: true, roughness: 0.15, metalness: 0.5 }), head: this.headMat, tail: new THREE.MeshBasicMaterial({ color: 0xffffff }) };
    for (const id of VEHICLE_IDS) this.vehicles[id] = vehicleMeshes(VEHICLES[id].model, MAX_CARS, mats);
    const pane = std({ color: PALETTE.glass, roughness: 0.15, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
    for (const id of VEHICLE_IDS) {
      const { parts, panes } = opened(VEHICLES[id].model);
      const glass = panes.length ? merge(...panes.map((p) => partBox(p, false))) : new THREE.BufferGeometry();
      this.open[id] = { ...vehicleMeshes(parts, OPEN_CARS, mats), pane: instanced(glass, pane, OPEN_CARS) };
    }
    ({ body: this.body, dark: this.dark, head: this.head, tail: this.tail } = this.vehicles.car);
    const P = MAX_PEOPLE + MAX_BIKES;
    this.legs = instanced(merge(box(0.18, 0.85, 0.22, -0.1, 0, 0, 0x2b3240), box(0.18, 0.85, 0.22, 0.1, 0, 0, 0x2b3240),
      box(0.3, 0.3, 0.3, 0, 1.45, 0, 0xe0b48f), box(0.32, 0.1, 0.32, 0, 1.72, 0, 0x3a2a20)), std({ vertexColors: true, roughness: 0.9, metalness: 0 }), P);
    this.torso = instanced(box(0.46, 0.62, 0.3, 0, 0.85, 0), std({ color: 0xffffff, roughness: 0.9, metalness: 0 }), P, { color: true });
    this.legs.castShadow = this.torso.castShadow = true;
    const wheelB = (z: number) => box(0.07, 0.68, 0.68, 0, 0, z, 0x1a1a1a);
    this.bike = instanced(merge(wheelB(-0.55), wheelB(0.55), box(0.06, 0.07, 1.05, 0, 0.62, 0, 0x8c8f93), box(0.06, 0.5, 0.06, 0, 0.3, -0.18, 0x8c8f93),
      box(0.5, 0.05, 0.05, 0, 1.0, 0.5, 0x2b2b2b)), std({ vertexColors: true, roughness: 0.5, metalness: 0.4 }), MAX_BIKES, { shadow: true });
    const H = Math.max(1, heads.length);
    this.pole = instanced(merge(box(0.18, 3.3, 0.18, 0, 0, 0, 0x3a3e42), box(0.42, 1.25, 0.36, 0, 3.0, 0, 0x202225)), std({ vertexColors: true, roughness: 0.6 }), H);
    this.pole.castShadow = true;
    this.lamp = instanced(new THREE.BoxGeometry(0.3, 0.3, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff }), H, { color: true });
    this.pole.count = 0; // (the signals near the focus: poles())
    for (const id of VEHICLE_IDS) {
      const V = this.vehicles[id], O = this.open[id];
      this.group.add(V.body, V.dark, V.head, V.tail, O.body, O.dark, O.head, O.tail, O.pane);
    }
    this.group.add(this.legs, this.torso, this.bike, this.pole, this.lamp);
    scene.add(this.group);
  }

  // the signals' poles: those of heads[which] (life.ts: near the focus)
  poles(heads: [number, number, number, number, ...number[]][], which: number[]) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    which.forEach((h, i) => { const [x, y, z, rot] = heads[h]; this.pole.setMatrixAt(i, m.compose(p.set(x, z, y), q.setFromAxisAngle(up, rot + Math.PI), one)); });
    setCount(which.length, this.pole);
  }
}

// the instances drawn; only those are uploaded (not the whole MAX_* buffer), and nothing when there are none
export function setCount(n: number, ...meshes: THREE.InstancedMesh[]) {
  for (const m of meshes) {
    m.count = n;
    if (n === 0) continue; // (a range of 0 would upload the whole array: WebGL's bufferSubData takes length 0 as "to the end")
    upload(m.instanceMatrix, n);
    if (m.instanceColor) upload(m.instanceColor, n);
  }
}

function upload(a: THREE.BufferAttribute, n: number) {
  a.clearUpdateRanges(); // (still pending if the mesh was not drawn since: this one covers all that is drawn)
  a.addUpdateRange(0, n * a.itemSize);
  a.needsUpdate = true;
}
