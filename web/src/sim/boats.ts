import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash } from '../util';
import { at, prepPath, pt, type Path } from './path';

// Boats on the rivers (scripts/boats.py -> data/boats.json):
// - river-cruise ships moored along the old town's Danube quay (the OSM berths: Zollände, A14, Liegestelle 3..8), bow
//   upstream; how many lie there follows the season (Apr-Oct nearly every berth, often a second ship rafted alongside;
//   a few in March, November and December's Christmas-market cruises; in Jan-Feb a laid-up one, dark)
// - the excursion boats of the Dreiflüsse-Stadtrundfahrt (the OSM ferry route) from the pier below the Rathaus: up
//   the Danube, back past the old town, round the Dreiflüsseeck, up the Inn and back, departures on the half hour in
//   summer, hourly in spring and autumn, none in high water
// All float on the river level (the slider: flood.ts); windows light up at night.

export interface Berth { x: number; y: number; dx: number; dy: number; nx: number; ny: number }
export interface BoatData { berths: Berth[]; tour: [number, number][] }

const CRUISE_L = 135, CRUISE_B = 11.4, TOUR_L = 38, TOUR_B = 8;
const MAX_CRUISE = 24, MAX_TOUR = 6;
const V = 2.8, ACC = 0.06; // m/s along the loop (10 km/h: the round trip takes ~42 min, as the real one about 45), m/s²
const BOARD = 12 * 60; // a boat lies at the pier this long before it casts off
const NO_TOURS_ABOVE = 3.5; // m above the survey day: the excursion boats stay in (Hochwassermarke)
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
const NONE = new THREE.Matrix4().makeScale(0, 0, 0);
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

interface Kind { body: THREE.InstancedMesh; accent: THREE.InstancedMesh; win: THREE.InstancedMesh; dark: THREE.InstancedMesh; n: number }

export class Boats {
  readonly group = new THREE.Group();
  private readonly tour: Path;
  private readonly cruise: Kind;
  private readonly boat: Kind;
  private readonly winMat = new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.12, metalness: 0.5, emissive: new THREE.Color(1.0, 0.8, 0.52), emissiveIntensity: 0 });
  private readonly darkMat = new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.12, metalness: 0.5 });
  private readonly T: number; // a round trip, s
  private t = 0;
  private lastHour = -1;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly c = new THREE.Color();
  private readonly a = pt();
  private readonly b = pt();

  constructor(private readonly data: BoatData, private readonly waterTop = 4) {
    this.tour = prepPath({ p: data.tour.map(([x, y]) => [x, y, 0] as [number, number, number]) });
    const ramp = V / ACC; // s to reach cruising speed
    this.T = (this.tour.L - V * ramp) / V + 2 * ramp;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
    const kind = (g: { body: THREE.BufferGeometry; accent: THREE.BufferGeometry; win: THREE.BufferGeometry }, n: number): Kind => {
      const inst = (geo: THREE.BufferGeometry, m: THREE.Material, colour: boolean, shadow: boolean) => {
        const mesh = new THREE.InstancedMesh(geo, m, n);
        mesh.castShadow = mesh.receiveShadow = shadow;
        mesh.frustumCulled = false;
        if (colour) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
        mesh.count = 0;
        this.group.add(mesh);
        return mesh;
      };
      return { body: inst(g.body, mat, false, true), accent: inst(g.accent, mat, true, true), win: inst(g.win, this.winMat, false, false), dark: inst(g.win, this.darkMat, false, false), n: 0 };
    };
    this.cruise = kind(cruiseShip(), MAX_CRUISE);
    this.boat = kind(tourBoat(), MAX_TOUR);
  }

  // the share of the berths taken on this day of the year
  private static berthShare(day: number) {
    if (day < 60) return 0.12; // Jan-Feb: a ship or two laid up for the winter
    if (day < 91) return 0.35; // March: the first cruises
    if (day < 305) return 0.9; // April-October
    if (day < 335) return 0.4; // November
    return 0.45; // December: Christmas-market cruises
  }

  // departures of the Dreiflüsse-Stadtrundfahrt on this day, in seconds after midnight
  private static departures(day: number) {
    if (day < 75 || day > 310) return [];
    const summer = day >= 121 && day <= 280, out: number[] = [];
    for (let h = summer ? 9.5 : 10; h <= (summer ? 17 : 16) + 1e-6; h += summer ? 0.5 : 1) out.push(h * 3600);
    return out;
  }

  // arc length along the loop t seconds after casting off (accelerate, cruise, slow to the pier)
  private sAt(t: number) {
    const ramp = V / ACC, L = this.tour.L;
    if (t <= 0) return 0;
    if (t >= this.T) return L;
    if (t < ramp) return 0.5 * ACC * t * t;
    const u = this.T - t;
    if (u < ramp) return L - 0.5 * ACC * u * u;
    return 0.5 * ACC * ramp * ramp + V * (t - ramp);
  }

  private put(k: Kind, x: number, y: number, z: number, dx: number, dy: number, len: number, lit: boolean, accent: number) {
    this.q.setFromAxisAngle(this.up, Math.atan2(dx, dy));
    this.scl.set(1, 1, len);
    this.m.compose(this.pos.set(x, z, y), this.q, this.scl);
    const i = k.n++;
    k.body.setMatrixAt(i, this.m);
    k.accent.setMatrixAt(i, this.m);
    k.accent.setColorAt(i, this.c.setHex(accent));
    // a lit and an unlit copy of the windows: the one not wanted is folded away
    k.win.setMatrixAt(i, lit ? this.m : NONE);
    k.dark.setMatrixAt(i, lit ? NONE : this.m);
  }

  update(dt: number, hour: number, day: number, night: number, level: number) {
    if (Math.abs(hour - this.lastHour) > 1e-6) { this.t = 0; this.lastHour = hour; } // the clock was set: start from it
    this.t += dt;
    const clock = hour * 3600 + this.t, z = this.waterTop + Math.max(0, level);
    const d = Math.round(day);
    this.cruise.n = this.boat.n = 0;

    // moored cruise ships: the same ones all day
    const share = Boats.berthShare(d), laidUp = d < 60;
    this.data.berths.forEach((b, i) => {
      const h = hash(d * 37 + i * 101 + 0.5);
      if (h >= share) return;
      const raft = !laidUp && h < share * 0.45; // a second ship tied alongside
      for (let r = 0; r < (raft ? 2 : 1) && this.cruise.n < MAX_CRUISE; r++) {
        const len = (r ? 110 + 25 * hash(d + i * 13 + 7) : 125 + 10 * hash(d * 3 + i)) / CRUISE_L;
        const off = r * (CRUISE_B + 1.2), shift = (1 - len) * CRUISE_L * 0.5; // a shorter ship lies at the berth's upstream end
        const acc = ACCENTS[(hash(d * 11 + i * 5 + r * 3) * ACCENTS.length) | 0];
        this.put(this.cruise, b.x + b.nx * off + b.dx * shift, b.y + b.ny * off - b.dy * shift, z, b.dx, b.dy, len, !laidUp, acc);
      }
    });

    // excursion boats
    if (level < NO_TOURS_ABOVE) {
      const deps = Boats.departures(d), at0 = this.a, at1 = this.b;
      deps.forEach((dep, k) => {
        const next = deps[k + 1] ?? Infinity, t = clock - dep;
        const linger = Math.min(600, Math.max(30, next - BOARD - (dep + this.T)));
        if (t < -BOARD || t > this.T + linger || this.boat.n >= MAX_TOUR) return;
        const s = this.sAt(t), half = TOUR_L / 2;
        at(this.tour, s + half * 0.8, 0, at0); at(this.tour, s - half * 0.8, 0, at1);
        const dx = at0.x - at1.x, dy = at0.y - at1.y, l = Math.hypot(dx, dy) || 1;
        at(this.tour, s, 0, at0);
        // rock gently under way
        const bob = t > 0 && t < this.T ? 0.06 * Math.sin(this.t * 1.7 + k) : 0;
        this.put(this.boat, at0.x, at0.y, z + bob, dx / l, dy / l, 1, true, TOUR_ACCENTS[k % TOUR_ACCENTS.length]);
      });
    }

    for (const k of [this.cruise, this.boat])
      for (const mesh of [k.body, k.accent, k.win, k.dark]) {
        mesh.count = k.n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    this.winMat.emissiveIntensity = night * 1.3;
  }
}
