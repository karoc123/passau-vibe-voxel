import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CraftView } from '../../../client/sim-client';
import type { CoreOf } from '../../../sim/craft/cores';
import { box, parts, placeYXZ, Spin, type CraftFrame, type CraftLook } from '../craft-look';

// A passenger hovercraft (Griffon 2000 class, about 20 seats), small enough for the Danube, the Inn and the wider
// streets: 12.8 x 5.8 m on its skirt, the cabin 6.6 m long with a window to every row, 4.1 m to the fan ducts' top over
// the skirt's foot. Two ducted fans at the stern with rudder vanes behind them. Written in metres, nose +z, left +x;
// the origin HOVER_HEIGHT (1 m) over the surface it rides on, as its probes and its solid shape are.

const SKIRT = 0x272b2e, SEAM = 0x16191b, HULL = 0xebe8e1, LIVERY = 0x1f4e8c, STRIPE = 0xc8372d, GLASS = 0x22384a;
const ROOF = 0xc6cacc, DECK = 0x6b7175, DUCT = 0x3d464c, METAL = 0x9aa2a6, DARK = 0x15191b, ORANGE = 0xe8742a;
// the ducts: their middles (x, y, z), the opening's half-width, how deep they are
const FANS = [1.4, -1.4], FAN_Y = 1.85, FAN_Z = -5.1, DUCT_R = 1.0, DUCT_D = 0.9;
const RED = new THREE.Color(1, 0.08, 0.05), GREEN = new THREE.Color(0.05, 1, 0.25), WHITE_L = new THREE.Color(1, 0.96, 0.85);

function body() {
  const g: THREE.BufferGeometry[] = [];
  // the skirt: a rubber bag from the surface to the hull, stepped round the bow, its fingers' seams down the sides
  g.push(box(5.8, 1.1, 10.6, 0, -0.45, -0.7, SKIRT), box(5.2, 1.0, 1.0, 0, -0.5, 5.1, SKIRT), box(4.0, 0.9, 0.8, 0, -0.55, 6.0, SKIRT),
    box(5.2, 1.0, 0.4, 0, -0.5, -6.2, SKIRT), box(5.9, 0.12, 10.7, 0, 0.04, -0.7, SEAM));
  for (let z = -5.6; z < 4.6; z += 0.8) for (const x of [-2.91, 2.91]) g.push(box(0.03, 0.95, 0.07, x, -0.5, z, SEAM));
  // the buoyancy hull with a red rubbing strake, the decks' non-slip grey
  g.push(box(5.2, 0.4, 11.6, 0, 0.3, -0.4, HULL), box(4.0, 0.4, 0.7, 0, 0.3, 5.75, HULL), box(5.3, 0.14, 11.7, 0, 0.17, -0.4, STRIPE),
    box(4.6, 0.02, 1.8, 0, 0.51, 4.9, DECK), box(5.0, 0.02, 3.6, 0, 0.51, -4.4, DECK));
  for (const x of [-2.35, 2.35]) g.push(box(0.5, 0.02, 6.6, x, 0.51, 0.7, DECK));
  // the cabin: a blue band under a row of windows, a door aft each side, the roof; the wheelhouse forward on it
  g.push(box(4.2, 0.8, 6.6, 0, 0.9, 0.7, HULL), box(4.22, 0.18, 6.62, 0, 1.2, 0.7, LIVERY),
    box(4.2, 0.55, 6.6, 0, 2.325, 0.7, HULL), box(4.22, 0.08, 6.62, 0, 2.1, 0.7, LIVERY), box(4.0, 0.12, 6.4, 0, 2.66, 0.7, ROOF));
  for (const z of [-2.53, -1.0, -0.15, 0.7, 1.55, 2.4, 3.25, 3.93]) g.push(box(4.24, 0.75, 0.14, 0, 1.675, z, HULL));
  for (const x of [-2.03, -1.0, 0, 1.0, 2.03]) g.push(box(0.14, 0.75, 0.04, x, 1.675, 4.01, HULL));
  for (const x of [-2.12, 2.12]) {
    g.push(box(0.04, 1.8, 0.9, x, 1.45, -1.95, LIVERY), box(0.05, 0.45, 0.5, x * 1.005, 1.85, -1.95, GLASS),
      box(0.05, 0.08, 0.2, x * 1.005, 1.35, -1.62, METAL), box(0.06, 0.5, 0.5, x * 1.01, 0.95, 3.3, ORANGE));
  }
  // (the wheelhouse's glass band a pane of its own, onto its pilot; a ceiling under the cabin's roof hides the pilot's
  // legs, which reach down into it, from who rides along)
  g.push(box(2.2, 0.245, 1.4, 0, 2.7225, 3.1, HULL), box(2.2, 0.105, 1.4, 0, 3.2475, 3.1, HULL), box(2.3, 0.08, 1.5, 0, 3.34, 3.1, ROOF),
    box(0.1, 0.36, 1.44, 0, 3.02, 3.1, HULL), box(0.08, 0.7, 0.08, 0, 3.7, 2.8, METAL), box(4.16, 0.02, 6.56, 0, 2.03, 0.7, ROOF));
  // the foredeck: rails on posts, a bow door, bollards
  for (const x of [-2.2, 2.2]) {
    g.push(box(0.04, 0.04, 1.4, x, 1.35, 4.9, METAL), box(0.18, 0.25, 0.18, x * 0.75, 0.63, 4.5, DARK));
    for (const z of [4.3, 5.0, 5.6]) g.push(box(0.05, 0.85, 0.05, x, 0.93, z, METAL));
  }
  g.push(box(4.4, 0.04, 0.04, 0, 1.35, 5.6, METAL), box(2.0, 0.03, 0.8, 0, 0.53, 5.9, DARK));
  for (const x of [-1.1, 0, 1.1]) g.push(box(0.05, 0.85, 0.05, x, 0.93, 5.6, METAL));
  // aft: the engine house with its louvres, exhausts and the lift fan's grille on top
  g.push(box(3.6, 0.9, 1.6, 0, 0.95, -3.4, HULL), box(3.62, 0.3, 1.0, 0, 1.0, -3.4, DARK), box(1.4, 0.04, 1.2, 0, 1.42, -3.4, DARK));
  for (const x of [-1.2, 1.2]) g.push(box(0.2, 0.5, 0.2, x, 1.65, -3.2, METAL));
  // the ducts: eight slabs round each opening on a pylon, a red ring at the back, a guard grille in front of the fan
  const chord = 2 * (DUCT_R + 0.22) * Math.tan(Math.PI / 8) + 0.02;
  for (const cx of FANS) {
    g.push(box(0.5, 0.35, 0.8, cx, 0.65, FAN_Z, DUCT));
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, s = Math.sin(a), c = Math.cos(a);
      g.push(box(chord, 0.22, DUCT_D, cx + s * (DUCT_R + 0.11), FAN_Y + c * (DUCT_R + 0.11), FAN_Z, DUCT, 0, -a),
        box(chord + 0.06, 0.26, 0.16, cx + s * (DUCT_R + 0.12), FAN_Y + c * (DUCT_R + 0.12), FAN_Z - DUCT_D / 2 + 0.06, STRIPE, 0, -a));
    }
    const front = FAN_Z + DUCT_D / 2 - 0.03;
    g.push(box(2 * DUCT_R, 0.05, 0.05, cx, FAN_Y, front, METAL), box(0.05, 2 * DUCT_R, 0.05, cx, FAN_Y, front, METAL));
    for (const dx of [-0.5, 0.5]) g.push(box(0.05, 1.7, 0.05, cx + dx, FAN_Y, front, METAL));
  }
  return mergeGeometries(g);
}

class HovercraftLook implements CraftLook<'hovercraft'> {
  readonly group = new THREE.Group();
  private readonly fans: THREE.Group[] = [];
  private readonly rudders: THREE.Group[] = [];
  private readonly radar = new THREE.Group();
  private readonly blur: THREE.MeshBasicMaterial;
  private readonly lights: { mat: THREE.MeshBasicMaterial; base: THREE.Color }[] = [];
  private readonly fan = new Spin();
  private readonly scan = new Spin();

  constructor() {
    const hull = new THREE.Mesh(body(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 }));
    hull.castShadow = hull.receiveShadow = true;
    // (the cabin's window band and the wheelhouse's seen through, onto who rides along and the pilot: view/seats.ts)
    const glass = new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.15, transparent: true, opacity: 0.35, depthWrite: false });
    // (its ends a little inside the window frames' faces: on them, the frames flickered through it)
    const pane = new THREE.Mesh(mergeGeometries([new THREE.BoxGeometry(4.2, 0.75, 6.58).translate(0, 1.675, 0.7),
      new THREE.BoxGeometry(2.22, 0.35, 1.42).translate(0, 3.02, 3.1)]), glass);
    this.group.add(hull, pane);
    const part = parts();
    // the fans: a hub and five pitched blades each, and a faint disc so that they read as turning at any frame rate
    this.blur = new THREE.MeshBasicMaterial({ color: 0x202426, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    for (const cx of FANS) {
      const fan = new THREE.Group();
      fan.position.set(cx, FAN_Y, FAN_Z - 0.1);
      part(fan, METAL, [0.34, 0.34, 0.5], 0, 0, 0);
      for (let k = 0; k < 5; k++) {
        const arm = new THREE.Group();
        arm.rotation.z = k * 2 * Math.PI / 5;
        part(arm, DARK, [0.26, 0.8, 0.05], 0, 0.55, 0).rotation.y = 0.45;
        fan.add(arm);
      }
      fan.add(new THREE.Mesh(new THREE.CircleGeometry(0.96, 24), this.blur));
      this.fans.push(fan);
      this.group.add(fan);
      // two rudder vanes behind each duct, hinged at their leading edge
      for (const dx of [-0.45, 0.45]) {
        const vane = new THREE.Group();
        vane.position.set(cx + dx, FAN_Y, FAN_Z - DUCT_D / 2 - 0.08);
        part(vane, HULL, [0.06, 1.8, 0.6], 0, 0, -0.3);
        // (the stripe standing out of the vane's top and edges, not on them)
        part(vane, STRIPE, [0.07, 0.32, 0.62], 0, 0.76, -0.3);
        this.rudders.push(vane);
        this.group.add(vane);
      }
    }
    this.radar.position.set(0, 4.08, 2.8);
    part(this.radar, DARK, [1.0, 0.07, 0.16], 0, 0, 0);
    this.group.add(this.radar);
    // nav lights: red to port (+x), green to starboard, white on the mast
    const light = (base: THREE.Color, x: number, y: number, z: number) => {
      const mat = new THREE.MeshBasicMaterial({ color: base.clone() });
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.18), mat);
      m.position.set(x, y, z);
      this.lights.push({ mat, base });
      this.group.add(m);
    };
    light(RED, 2.16, 2.45, 3.7);
    light(GREEN, -2.16, 2.45, 3.7);
    light(WHITE_L, 0, 3.98, 2.8);
    this.group.visible = false;
  }

  draw(c: CraftView<CoreOf<'hovercraft'>>, { dt, alpha, night }: CraftFrame) {
    const m = c.core.motion;
    placeYXZ(this.group, c.core.drawn(alpha));
    this.group.visible = true;
    // the engine runs while someone is in it (not in a wreck): the fans idle and wind up with the throttle, and run down once left
    const on = c.pilot !== null && !c.wreck, a = this.fan.step(on ? 9 + 55 * m.throttle : 0, 1.2, dt);
    this.fans[0].rotation.z = a;
    this.fans[1].rotation.z = -a;
    this.blur.opacity = Math.min(0.3, this.fan.rate / 120);
    // the vanes swing the jet to the side the craft turns to
    const rudder = 0.45 * Math.max(-1, Math.min(1, m.yaw / m.cfg.hovercraft.yaw));
    for (const v of this.rudders) v.rotation.y = rudder;
    this.radar.rotation.y = this.scan.step(on ? 3 : 0, 2, dt);
    for (const { mat, base } of this.lights) mat.color.copy(base).multiplyScalar(on ? 0.35 + 2.4 * night : 0.15);
  }

  hide() { this.group.visible = false; }
}

export const hovercraftLook = () => new HovercraftLook();
