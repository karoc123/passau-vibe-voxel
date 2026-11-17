import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash, wrapAngle } from '../util';
import { at, prepPath, pt, type Path } from './path';

// Boats on the rivers (scripts/boats.py -> data/boats.json):
// - river-cruise ships moored along the old town's Danube quay (the OSM berths: Zollände, A14, Liegestelle 3..8), bow
//   upstream; how many lie there follows the season (Apr-Oct nearly every berth, often a second ship rafted alongside;
//   a few in March, November and December's Christmas-market cruises; in Jan-Feb a laid-up one, dark). Some of the
//   day's ships come in in the early morning and some leave in the evening, one at a time, at ~13 km/h along the
//   fairway: from downstream straight up to the berth, from upstream past the old town to turn in the Dreiflüsseeck's
//   basin and come in bow upstream; bound downstream, they turn in the wide reach above the old town.
// - the excursion boats of the Dreiflüsse-Stadtrundfahrt (the OSM ferry route) from the pier below the Rathaus: up
//   the Danube, back past the old town, round the Dreiflüsseeck, up the Inn and back, departures on the half hour in
//   summer, hourly in spring and autumn, none in high water. A fleet of three: as many as the timetable needs take turns,
//   the rest lie rafted alongside the pier; a boat back from a trip ties up behind the ones waiting, and when the one at
//   the pier casts off the next slides in.
// Everything is a function of the clock (the hour slider), and floats on the river level (the slider: flood.ts);
// windows light up at night.

export interface Berth { x: number; y: number; dx: number; dy: number; nx: number; ny: number }
type XY = [number, number];
// the cruise ships' lanes (boats.py): up (westbound) and down (eastbound), and the two turns between them, each
// [index on the lane it leaves, index on the lane it joins, points]
export interface Fairway { up: XY[]; down: XY[]; turnE: [number, number, XY[]]; turnW: [number, number, XY[]] }
export interface BoatData { berths: Berth[]; tour: XY[]; fairway?: Fairway }

const CRUISE_L = 135, CRUISE_B = 11.4, TOUR_L = 38, TOUR_B = 8;
const MAX_CRUISE = 24, MAX_TOUR = 6;
const V = 2.8, ACC = 0.06; // m/s along the loop (10 km/h: the round trip takes ~42 min, as the real one about 45), m/s²
const BOARD = 12 * 60; // a boat is lit and boarding this long before it casts off
const AFTER = 8 * 60; // and lit this long after it comes in
const FLEET = 3, SLOT = TOUR_B + 1; // excursion boats, and their spacing rafted at the pier
const SLIDE: XY = [45, 170]; // s after a boat casts off: the next one moves into its place
const TURN = 10 * 60; // the least time at the pier between two trips
const VC = 3.6, ACC_C = 0.015; // cruise ships under way: 13 km/h, m/s²
const MORNING = 6 * 3600, LATEST_IN = 9.25 * 3600, EVENING = 18 * 3600, LATEST_OUT = 23.75 * 3600; // s after midnight
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

// a cruise ship coming in or leaving: along `path` from t0 for dur seconds; `crab` metres at the berth end are the
// sideways slip to or from the quay, the hull kept parallel to it (hx, hy)
interface Move { path: Path; t0: number; dur: number; arrive: boolean; crab: number; hx: number; hy: number }
// k: the berth's slot (2 per berth), r: 0 at the quay, 1 alongside `inner`
interface Ship { x: number; y: number; dx: number; dy: number; len: number; acc: number; lit: boolean; r: number; k: number; inner?: Ship; arr?: Move; dep?: Move }

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const xyz = (p: XY[]) => p.map(([x, y]) => [x, y, 0] as [number, number, number]);

// a quadratic Bézier from a through c to b, without its first point
function bezier(a: XY, c: XY, b: XY, n = 12): XY[] {
  return Array.from({ length: n }, (_, k) => {
    const t = (k + 1) / n, u = 1 - t;
    return [u * u * a[0] + 2 * t * u * c[0] + t * t * b[0], u * u * a[1] + 2 * t * u * c[1] + t * t * b[1]] as XY;
  });
}
const arcLen = (p: XY[]) => p.reduce((l, q, k) => (k ? l + Math.hypot(q[0] - p[k - 1][0], q[1] - p[k - 1][1]) : 0), 0);

export class Boats {
  readonly group = new THREE.Group();
  private readonly tour: Path;
  private readonly cruise: Kind;
  private readonly boat: Kind;
  private readonly winMat = new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.12, metalness: 0.5, emissive: new THREE.Color(1.0, 0.8, 0.52), emissiveIntensity: 0 });
  private readonly darkMat = new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.12, metalness: 0.5 });
  private readonly T: number; // a round trip, s
  private readonly raft: XY; // from the pier out into the river
  private t = 0;
  private lastHour = -1;
  private day = -1;
  private ships: Ship[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly c = new THREE.Color();
  private readonly box = new THREE.Box3();
  private readonly a = pt();
  private readonly b = pt();

  constructor(private readonly data: BoatData, private readonly waterTop = 4) {
    this.tour = prepPath({ p: xyz(data.tour) });
    const ramp = V / ACC; // s to reach cruising speed
    this.T = (this.tour.L - V * ramp) / V + 2 * ramp;
    this.raft = [-this.tour.startD[1], this.tour.startD[0]]; // the boat at the pier lies bow west, the river to starboard
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

  // ---- cruise ships

  // the way in to (or out from) a berth at (x, y), heading (hx, hy): from the east straight up the up lane, or from the
  // west down the down lane and round in the Eck's basin; out to the west up the up lane, or round in the reach above
  // the town and away down the down lane
  private route(f: Fairway, x: number, y: number, hx: number, hy: number, arrive: boolean, east: boolean, t0: number): Move {
    const near = (lane: XY[]) => lane.reduce((bi, p, i) => (Math.hypot(p[0] - x, p[1] - y) < Math.hypot(lane[bi][0] - x, lane[bi][1] - y) ? i : bi), 0);
    const ia = near(f.up), berth: XY = [x, y];
    let p: XY[];
    if (arrive) {
      const from = Math.max(ia - 4, 1); // ~30 m short of abeam (the up lane runs westwards)
      const slip = bezier(f.up[from], f.up[ia], berth);
      const lane = east ? f.up.slice(0, from + 1) : [...f.down.slice(0, f.turnE[0] + 1), ...f.turnE[2], ...f.up.slice(f.turnE[1], from + 1)];
      p = [...lane, ...slip];
      return this.move(p, arcLen([f.up[from], ...slip]), true, hx, hy, t0);
    }
    const to = Math.min(ia + 4, f.up.length - 2);
    const slip = [berth, ...bezier(berth, f.up[ia], f.up[to])];
    p = [...slip, ...(east ? [...f.up.slice(to + 1, f.turnW[0] + 1), ...f.turnW[2], ...f.down.slice(f.turnW[1])] : f.up.slice(to + 1))];
    return this.move(p, arcLen(slip), false, hx, hy, t0);
  }

  private move(p: XY[], crab: number, arrive: boolean, hx: number, hy: number, t0: number): Move {
    const path = prepPath({ p: xyz(p) }), ramp = VC / ACC_C, dRamp = 0.5 * VC * ramp;
    return { path, t0, dur: Math.max(0, path.L - dRamp) / VC + ramp, arrive, crab, hx, hy };
  }

  // arc length along a move t s after it begins: an arrival comes in at speed and slows to the berth, a departure
  // gathers way from it
  private static sMove(mv: Move, t: number) {
    const ramp = VC / ACC_C, L = mv.path.L;
    if (mv.arrive) {
      const u = mv.dur - t;
      return u < ramp ? L - 0.5 * ACC_C * u * u : VC * t;
    }
    return t < ramp ? 0.5 * ACC_C * t * t : 0.5 * VC * ramp + VC * (t - ramp);
  }

  // the day's cruise ships: which berths are taken (the same all day), and who comes in or leaves when
  private cruiseDay(d: number) {
    const f = this.data.fairway, ships: Ship[] = [];
    const share = Boats.berthShare(d), laidUp = d < 60;
    this.data.berths.forEach((b, i) => {
      const h = hash(d * 37 + i * 101 + 0.5);
      if (h >= share) return;
      const raft = !laidUp && h < share * 0.45; // a second ship tied alongside
      let inner: Ship | undefined;
      for (let r = 0; r < (raft ? 2 : 1) && ships.length < MAX_CRUISE; r++) {
        const len = (r ? 110 + 25 * hash(d + i * 13 + 7) : 125 + 10 * hash(d * 3 + i)) / CRUISE_L;
        const off = r * (CRUISE_B + 1.2), shift = (1 - len) * CRUISE_L * 0.5; // a shorter ship lies at the berth's upstream end
        const acc = ACCENTS[(hash(d * 11 + i * 5 + r * 3) * ACCENTS.length) | 0];
        const s: Ship = { x: b.x + b.nx * off + b.dx * shift, y: b.y + b.ny * off + b.dy * shift, dx: b.dx, dy: b.dy, len, acc, lit: !laidUp, r, k: i * 2 + r, inner };
        ships.push(s);
        inner = s;
      }
    });
    if (!f || laidUp) return ships;
    // who moves today: an outer ship comes in after the inner one, and leaves before it
    const comes = new Set<Ship>(), goes = new Set<Ship>();
    for (const s of ships) {
      if (hash(d * 13 + s.k * 7 + 0.21) < 0.4 || (s.inner && comes.has(s.inner))) comes.add(s);
      if (hash(d * 17 + s.k * 5 + 0.67) < 0.4 || (s.inner && goes.has(s.inner))) goes.add(s);
    }
    // one at a time: arrivals from 6:00 (inner ships first), done before the first excursion boat; departures from
    // 18:00 (outer ships first), after the last one is back
    let t = MORNING + 1200 * hash(d * 0.7 + 0.3);
    for (const s of [...comes].sort((a, b) => a.r - b.r || hash(d + a.k) - hash(d + b.k))) {
      const mv = this.route(f, s.x, s.y, s.dx, s.dy, true, hash(d * 5 + s.k + 0.9) < 0.5, t);
      const outer = ships.find((o) => o.inner === s);
      if (mv.t0 + mv.dur > LATEST_IN || (outer && !comes.has(outer))) continue; // no time left: it was here overnight
      s.arr = mv;
      t = mv.t0 + mv.dur + 180;
    }
    for (const s of ships) if (s.inner && s.inner.arr && !s.arr) s.inner.arr = undefined; // an outer ship can't have been here first
    t = EVENING + 1200 * hash(d * 0.9 + 0.1);
    for (const s of [...goes].sort((a, b) => b.r - a.r || hash(d + a.k + 3) - hash(d + b.k + 3))) {
      const outer = ships.find((o) => o.inner === s);
      if (outer && !outer.dep) continue; // the ship alongside stays the night, so does this one
      const mv = this.route(f, s.x, s.y, s.dx, s.dy, false, hash(d * 3 + s.k + 0.4) < 0.5, t);
      if (mv.t0 + mv.dur > LATEST_OUT) continue;
      s.dep = mv;
      t = mv.t0 + mv.dur + 180;
    }
    return ships;
  }

  // where a ship under way is: on its path, heading along it, but kept parallel to the quay over the slip in or out
  private placeMoving(s: Ship, mv: Move, clock: number, z: number) {
    const sv = Boats.sMove(mv, clock - mv.t0), P = mv.path, A = this.a, B = this.b;
    at(P, sv + 30, 0, A); at(P, sv - 30, 0, B);
    let ang = Math.atan2(A.x - B.x, A.y - B.y);
    const w = mv.arrive ? smooth(P.L - mv.crab - 50, P.L - mv.crab + 5, sv) : 1 - smooth(mv.crab - 5, mv.crab + 50, sv);
    ang += wrapAngle(Math.atan2(mv.hx, mv.hy) - ang) * w;
    at(P, sv, 0, A);
    this.put(this.cruise, A.x, A.y, z, Math.sin(ang), Math.cos(ang), s.len, s.lit, s.acc);
  }

  // ---- excursion boats

  // the trip a boat of the rotation (b < n) is on at the clock, its next departure, and when it last came in
  private static trips(deps: number[], n: number, b: number, clock: number, T: number) {
    let on = -1, next = Infinity, back = -Infinity;
    for (let k = b; k < deps.length; k += n) {
      const dep = deps[k];
      if (clock >= dep && clock < dep + T) on = dep;
      else if (dep > clock) { next = Math.min(next, dep); }
      else back = Math.max(back, dep + T);
    }
    return { on, next, back };
  }

  // the boat's place in the raft at the pier (0 alongside, 1, 2 outwards), easing in as the one ahead casts off
  private slot(deps: number[], n: number, b: number, clock: number) {
    if (b >= n) return b; // the spare boats lie outermost, out of the way
    const key = (o: number) => {
      const tr = Boats.trips(deps, n, o, clock, this.T);
      return tr.on >= 0 ? null : tr.next < Infinity ? tr.next : 1e6 + tr.back; // waiting for the next trip, or done for the day
    };
    const mine = key(b)!;
    let s = 0;
    for (let o = 0; o < n; o++) {
      if (o === b) continue;
      const k = key(o);
      if (k !== null && k < mine) s++;
    }
    // a boat that cast off a moment ago still holds its place, the others slide in
    for (const dep of deps) {
      const dt = clock - dep;
      if (dt < 0 || dt >= SLIDE[1]) continue;
      if (Boats.trips(deps, n, b, dep, this.T).on < 0 && deps.indexOf(dep) % n !== b) s += 1 - smooth(SLIDE[0], SLIDE[1], dt);
    }
    return s;
  }

  private put(k: Kind, x: number, y: number, z: number, dx: number, dy: number, len: number, lit: boolean, accent: number) {
    this.q.setFromAxisAngle(this.up, Math.atan2(dx, dy));
    this.scl.set(1, 1, len);
    this.m.compose(this.pos.set(x, z, y), this.q, this.scl);
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

  update(dt: number, hour: number, day: number, night: number, level: number) {
    if (Math.abs(hour - this.lastHour) > 1e-6) { this.t = 0; this.lastHour = hour; } // the clock was set: start from it
    this.t += dt;
    const clock = hour * 3600 + this.t, z = this.waterTop + Math.max(0, level);
    const d = Math.round(day);
    if (d !== this.day) { this.day = d; this.ships = this.cruiseDay(d); }
    for (const k of [this.cruise, this.boat]) k.n = k.lit = k.dark_ = 0;

    // cruise ships: moored, or coming in or leaving
    for (const s of this.ships) {
      if (s.arr && clock < s.arr.t0) continue; // not here yet
      if (s.dep && clock > s.dep.t0 + s.dep.dur) continue; // gone
      const mv = s.arr && clock < s.arr.t0 + s.arr.dur ? s.arr : s.dep && clock > s.dep.t0 ? s.dep : null;
      if (mv) this.placeMoving(s, mv, clock, z);
      else this.put(this.cruise, s.x, s.y, z, s.dx, s.dy, s.len, s.lit, s.acc);
    }

    // excursion boats
    if (level < NO_TOURS_ABOVE) {
      const deps = Boats.departures(d), at0 = this.a, at1 = this.b, P = this.tour, half = TOUR_L / 2, [rx, ry] = this.raft;
      const every = deps.length > 1 ? deps[1] - deps[0] : 3600;
      const n = Math.min(FLEET, deps.length, Math.ceil((this.T + TURN) / every)); // the boats the timetable needs
      for (let b = 0; b < FLEET; b++) {
        const tr = b < n ? Boats.trips(deps, n, b, clock, this.T) : { on: -1, next: Infinity, back: -Infinity };
        let s = 0, lat = 0, bob = 0;
        if (tr.on >= 0) {
          const t = clock - tr.on;
          s = this.sAt(t);
          // coming in to its place in the raft
          lat = this.slot(deps, n, b, tr.on + this.T) * SLOT * smooth(P.L - 170, P.L - 25, s);
          bob = 0.06 * Math.sin(this.t * 1.7 + b); // rock gently under way
        } else {
          s = 0;
          lat = this.slot(deps, n, b, clock) * SLOT;
        }
        at(P, s + half * 0.8, 0, at0); at(P, s - half * 0.8, 0, at1);
        const dx = at0.x - at1.x, dy = at0.y - at1.y, l = Math.hypot(dx, dy) || 1;
        at(P, s, 0, at0);
        const lit = tr.on >= 0 || tr.next - clock < BOARD || clock - tr.back < AFTER;
        this.put(this.boat, at0.x + rx * lat, at0.y + ry * lat, z + bob, dx / l, dy / l, 1, lit, TOUR_ACCENTS[b % TOUR_ACCENTS.length]);
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
