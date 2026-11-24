import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash, lerp, wrapAngle } from '../util';
import { CRUISE_L, CRUISE_B, TOUR_L, TOUR_B, MAX_CRUISE } from '../sim/boat-traffic';
import type { BoatView } from '../sim/contract/agents';

const MAX_TOUR = 6;
// cruise lines' accent colours (hull band, funnel, awnings)
const ACCENTS = [0x1d3557, 0xb3202a, 0x0f5c63, 0x7a5a2c, 0x26314a, 0x5b6770];
const TOUR_ACCENTS = [0x1f4f9a, 0x1f4f9a, 0x2a6db3];

function box(w: number, h: number, l: number, x: number, y: number, z: number, hex: number) {
  const g = new THREE.BoxGeometry(w, h, l).translate(x, y + h / 2, z).toNonIndexed();
  const c = new THREE.Color(hex), a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) a.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}
const merge = (gs: THREE.BufferGeometry[]) => mergeGeometries(gs);

const WHITE = 0xf2f1ec, OFF = 0xdcdad3, SKIRT = 0x1b2330, DECK = 0x7f97a3, TURF = 0x4f7d48, GLASS = 0x22303b;

// a stepped (voxel) bow: the hull narrows over its last metres
function bow(B: number, y0: number, h: number, z0: number, len: number, hex: number, steps = 3) {
  const gs: THREE.BufferGeometry[] = [];
  for (let k = 0; k < steps; k++) {
    const w = B * (1 - (k + 1) / (steps + 1)), l = len / steps;
    gs.push(box(w, h, l, 0, y0, z0 + l * (k + 0.5), hex));
  }
  return gs;
}

// local frame: x across (beam), y up from the waterline, z along, +z the bow
function cruiseShip() {
  const L = CRUISE_L, B = CRUISE_B, nose = 7, zc = -nose / 2, hl = L - nose;
  const body = [
    box(B, 1.6, hl, 0, -1.4, zc, SKIRT), box(B, 2.0, hl, 0, 0.2, zc, WHITE), ...bow(B, -1.4, 1.6, L / 2 - nose, nose, SKIRT),
    ...bow(B, 0.2, 2.0, L / 2 - nose, nose, WHITE),
    box(B, 2.6, L - 14, 0, 2.2, -4, WHITE), // main deck
    box(B - 0.6, 2.4, L - 22, 0, 4.8, -7, WHITE), // upper deck
    box(B - 0.6, 0.2, L - 22, 0, 7.2, -7, DECK), // sun deck
    box(5, 0.06, 14, 0, 7.4, -30, TURF), box(4, 0.06, 8, 0, 7.4, 14, TURF), box(3.2, 0.5, 5, 0, 7.4, -48, 0x3d8fb8), // putting green, whirlpool
    // railings round the sun deck, the open bow and the stern
    box(0.12, 0.9, L - 22, (B - 0.6) / 2 - 0.06, 7.4, -7, OFF), box(0.12, 0.9, L - 22, -(B - 0.6) / 2 + 0.06, 7.4, -7, OFF),
    box(B - 0.6, 0.9, 0.12, 0, 7.4, -7 - (L - 22) / 2, OFF),
    box(0.12, 0.9, 6, B / 2 - 0.06, 4.8, L / 2 - 14, OFF), box(0.12, 0.9, 6, -B / 2 + 0.06, 4.8, L / 2 - 14, OFF),
    // loungers
    ...Array.from({ length: 10 }, (_, k) => box(0.7, 0.35, 1.9, (k % 2 ? 1 : -1) * 3.6, 7.4, -58 + (k >> 1) * 3, 0xe9e5da)),
    ...Array.from({ length: 6 }, (_, k) => box(0.7, 0.35, 1.9, (k % 2 ? 1 : -1) * 3.6, 7.4, 22 + (k >> 1) * 3, 0xe9e5da)),
    box(6.4, 2.3, 4.2, 0, 7.4, L / 2 - 22, WHITE), // wheelhouse (it can be lowered for the bridges)
  ];
  const accent = [
    box(B + 0.06, 0.3, hl, 0, 1.75, zc, 0xffffff), ...bow(B + 0.06, 1.75, 0.3, L / 2 - nose, nose, 0xffffff),
    box(6.6, 0.25, 4.4, 0, 9.7, L / 2 - 22, 0xffffff), // wheelhouse roof
    box(8.4, 0.15, 16, 0, 9.6, -12, 0xffffff), // awning over the sun deck bar
    box(0.15, 2.2, 0.15, 3.9, 7.4, -19.5, 0xffffff), box(0.15, 2.2, 0.15, -3.9, 7.4, -19.5, 0xffffff),
    box(0.15, 2.2, 0.15, 3.9, 7.4, -4.5, 0xffffff), box(0.15, 2.2, 0.15, -3.9, 7.4, -4.5, 0xffffff),
  ];
  const win: THREE.BufferGeometry[] = [];
  for (let z = -L / 2 + 4; z < L / 2 - 9; z += 3.8) win.push(box(B + 0.08, 0.45, 1.0, 0, 0.75, z, GLASS)); // portholes
  for (let z = -L / 2 + 6; z < L / 2 - 13; z += 4.2) win.push(box(B + 0.08, 1.7, 3.4, 0, 2.65, z, GLASS)); // French balconies
  for (let z = -L / 2 + 9; z < L / 2 - 20; z += 4.2) win.push(box(B - 0.52, 1.6, 3.4, 0, 5.2, z, GLASS));
  win.push(box(B - 1.4, 1.8, 0.1, 0, 2.6, L / 2 - 11 + 0.02, GLASS), box(B - 2, 1.7, 0.1, 0, 5.1, L / 2 - 18 + 0.02, GLASS)); // panorama lounges
  // a third of the cabins dark at night (the guests ashore or asleep); lounges and wheelhouse always lit
  const cabins = win.length;
  win.push(box(6.5, 0.9, 4.0, 0, 8.7, L / 2 - 22, GLASS), box(6.0, 0.9, 4.3, 0, 8.7, L / 2 - 22, GLASS));
  const off = win.filter((_, i) => i < cabins - 2 && hash(i * 1.37 + 0.2) < 0.33);
  return { body: merge([...body, ...off]), accent: merge(accent), win: merge(win.filter((g) => !off.includes(g))) };
}

function tourBoat() {
  const L = TOUR_L, B = TOUR_B, nose = 4, zc = -nose / 2, hl = L - nose;
  const body = [
    box(B, 1.0, hl, 0, 0.4, zc, WHITE), ...bow(B, 0.4, 1.0, L / 2 - nose, nose, WHITE),
    box(B - 0.6, 2.3, L - 12, 0, 1.4, -3, WHITE), // saloon
    box(B - 0.6, 0.15, L - 12, 0, 3.7, -3, 0xb9bcbc), // open top deck
    box(0.1, 0.9, L - 12, (B - 0.6) / 2 - 0.05, 3.85, -3, OFF), box(0.1, 0.9, L - 12, -(B - 0.6) / 2 + 0.05, 3.85, -3, OFF),
    box(B - 0.6, 0.9, 0.1, 0, 3.85, -3 - (L - 12) / 2, OFF),
    box(3.4, 1.7, 3.0, 0, 3.85, L / 2 - 10.5, WHITE), // wheelhouse
    box(0.1, 0.8, 7, B / 2 - 0.05, 1.4, L / 2 - 6, OFF), box(0.1, 0.8, 7, -B / 2 + 0.05, 1.4, L / 2 - 6, OFF), // bow rails
  ];
  // benches on the top deck: passengers in summer clothes as specks of colour
  const people = [0xc8553d, 0x3d6fa8, 0xe8e3d6, 0xd9a441, 0x7a9a5b, 0x2f2f33, 0xb03a48];
  for (let k = 0; k < 7; k++) {
    body.push(box(B - 2.4, 0.45, 0.6, 0, 3.85, -18 + k * 2.6, 0x6d5a45));
    for (let j = 0; j < 3; j++) if (hash(k * 7 + j) < 0.6) body.push(box(0.45, 0.8, 0.4, -2 + j * 2, 4.3, -18 + k * 2.6 - 0.2, people[(k * 3 + j) % people.length]));
  }
  const accent = [
    box(B + 0.02, 1.4, hl, 0, -1.0, zc, 0xffffff), ...bow(B + 0.02, -1.0, 1.4, L / 2 - nose, nose, 0xffffff),
    box(B + 0.06, 0.25, hl, 0, 1.15, zc, 0xffffff), box(3.6, 0.2, 3.2, 0, 5.55, L / 2 - 10.5, 0xffffff),
  ];
  const win: THREE.BufferGeometry[] = [];
  for (let z = -L / 2 + 7; z < L / 2 - 9; z += 2.5) win.push(box(B - 0.52, 1.3, 2.0, 0, 2.0, z, GLASS));
  win.push(box(3.5, 0.7, 2.6, 0, 4.7, L / 2 - 10.5, GLASS));
  return { body: merge(body), accent: merge(accent), win: merge(win) };
}

// n: boats placed this frame; lit, dark: of those, how many with their windows lit or dark (each in its own mesh)
interface Kind { body: THREE.InstancedMesh; accent: THREE.InstancedMesh; win: THREE.InstancedMesh; dark: THREE.InstancedMesh; n: number; lit: number; dark_: number }

export class Boats {
  readonly group = new THREE.Group();
  private readonly cruise: Kind;
  private readonly boat: Kind;
  private readonly winMat = new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.12, metalness: 0.5, emissive: new THREE.Color(1.0, 0.8, 0.52), emissiveIntensity: 0 });
  private readonly darkMat = new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.12, metalness: 0.5 });
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly c = new THREE.Color();
  private readonly box = new THREE.Box3();

  constructor() {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
    const kind = (g: { body: THREE.BufferGeometry; accent: THREE.BufferGeometry; win: THREE.BufferGeometry }, n: number): Kind => {
      const inst = (geo: THREE.BufferGeometry, m: THREE.Material, colour: boolean, shadow: boolean) => {
        const mesh = new THREE.InstancedMesh(geo, m, n);
        mesh.castShadow = mesh.receiveShadow = shadow;
        // culled by the bounds of where the boats are now (update): off screen -- in the town's lanes, up on the
        // hills -- their ~3000 triangles a ship aren't drawn, nor shadowed
        mesh.boundingSphere = new THREE.Sphere();
        if (colour) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
        mesh.count = 0;
        this.group.add(mesh);
        return mesh;
      };
      return { body: inst(g.body, mat, false, true), accent: inst(g.accent, mat, true, true), win: inst(g.win, this.winMat, false, false), dark: inst(g.win, this.darkMat, false, false), n: 0, lit: 0, dark_: 0 };
    };
    this.cruise = kind(cruiseShip(), MAX_CRUISE);
    this.boat = kind(tourBoat(), MAX_TOUR);
  }

  private put(k: Kind, x: number, y: number, z: number, heading: number, len: number, lit: boolean, accent: number) {
    this.q.setFromAxisAngle(this.up, heading);
    this.scl.set(1, 1, len);
    this.m.compose(this.pos.set(x, y, z), this.q, this.scl);
    const i = k.n++;
    k.body.setMatrixAt(i, this.m);
    k.accent.setMatrixAt(i, this.m);
    k.accent.setColorAt(i, this.c.setHex(accent));
    // the windows lit or dark: one mesh each, drawn only for the boats they belong to (a folded-away copy in the other
    // still cost its vertices)
    if (lit) k.win.setMatrixAt(k.lit++, this.m);
    else k.dark.setMatrixAt(k.dark_++, this.m);
  }

  // the sphere round the boats placed: each one's centre, out by half a cruise ship (three's own InstancedMesh bounds
  // would go over every vertex of every instance)
  private bound(mesh: THREE.InstancedMesh) {
    const s = mesh.boundingSphere!, box = this.box.makeEmpty(), p = this.pos;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, this.m);
      box.expandByPoint(p.setFromMatrixPosition(this.m));
    }
    box.getBoundingSphere(s);
    s.radius += CRUISE_L * 0.55;
  }

  render(boats: BoatView, back: number, night: number) {
    for (const k of [this.cruise, this.boat]) k.n = k.lit = k.dark_ = 0;
    for (const pose of boats.poses) {
      const { id, kind, underway, len, lit } = pose;
      const prev = boats.previous.find((p) => p.kind === kind && p.id === id) ?? pose;
      const x = lerp(pose.x, prev.x, back), z = lerp(pose.z, prev.z, back), y = lerp(pose.y, prev.y, back);
      const heading = pose.heading + wrapAngle(prev.heading - pose.heading) * back;
      if (kind === 'boat') {
        const bob = underway ? 0.06 * Math.sin(boats.elapsed * 1.7 + id) : 0;
        this.put(this.boat, x, y + bob, z, heading, len / TOUR_L, lit, TOUR_ACCENTS[id % TOUR_ACCENTS.length]);
      } else {
        const berth = id >> 1, slot = id % 2;
        const accent = ACCENTS[(hash(boats.day * 11 + berth * 5 + slot * 3) * ACCENTS.length) | 0];
        this.put(this.cruise, x, y, z, heading, len / CRUISE_L, lit, accent);
      }
    }

    for (const k of [this.cruise, this.boat])
      for (const mesh of [k.body, k.accent, k.win, k.dark]) {
        mesh.count = mesh === k.win ? k.lit : mesh === k.dark ? k.dark_ : k.n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        if (mesh.count) this.bound(mesh);
      }
    this.winMat.emissiveIntensity = night * 1.3;
  }
}
