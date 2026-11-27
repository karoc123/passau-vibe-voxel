import * as THREE from 'three';
import type { AvatarState } from '../sim/contract/snapshot';
import type { Pose, RoadPose } from '../sim/contract/pose';
import { STEP } from '../sim/road-net';
import { FIGURE_SCALE as S, FIGURE_TOP } from '../sim/figure';
import { FLOAT } from '../sim/swim';
import { weaponIn } from '../sim/weapons';

// The other players on foot, each a figure of its own (owner: on foot always an avatar of its own, never one of the
// crowd): limbs that swing with its speed and an outfit by player, so two players are told apart and neither is
// taken for the street life. Kept out of the crowd's instanced meshes: the crowd's caps and counts are the crowd's,
// and a player in a busy square is drawn all the same. A few players at most: one small group each, no instancing.

/** where a player's figure is drawn (its feet, heading) and what it carries from frame to frame: its gait's phase,
 * its speed eased (input reaches the host unevenly: a tick without a step would stop the legs), its last frame drawn */
interface Drawn extends RoadPose { ph: number; v: number; frame: number; arm?: number; down?: boolean }

/** an avatar's drawn pose d eased dt s towards where it is between its ticks (a tick its walker's input missed
 * stands still: this keeps it walking on) */
export function easeAvatar(d: Pose, to: Pose, dt: number) {
  const k = 1 - Math.exp(-dt * 10);
  d.x += (to.x - d.x) * k; d.y += (to.y - d.y) * k; d.z += (to.z - d.z) * k;
  d.h += Math.atan2(Math.sin(to.h - d.h), Math.cos(to.h - d.h)) * k;
  return d;
}

// Outfits: brighter shirts than the crowd's, each with its own trousers and hair; a cap on every other player. The
// host names its players p1, p2, ... (sim-server.ts): by that number the first ones present differ in shirt for sure
const SHIRTS = ['#ff4b3e', '#2f9bff', '#ffd23f', '#3fdc6b', '#c45bff', '#ff8a1f', '#19d3c5', '#ff5fa8'];
const TROUSERS = ['#1f2a44', '#3b3b3b', '#5a4632', '#2e4a2e', '#6b6f78'];
const HAIR = ['#2a1d14', '#6b4428', '#c9a25a', '#151515', '#8a3b1e'];
const SKIN = ['#e0b48f', '#c68e62', '#8d5a3b', '#f1c9a5'];
const hashOf = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
/** a player's outfit (colours as #rrggbb; cap: the cap's colour or none) */
interface Look { shirt: string; trousers: string; hair: string; skin: string; cap: string | null }
// An NPC (the host names its avatar npc<id>): a dark vest, olive trousers and a dark cap, apart from every player's
// bright shirt at a glance
const ENEMY: Look = { shirt: '#24271f', trousers: '#4d5236', hair: '#151515', skin: '#c68e62', cap: '#1c1f18' };
function lookOf(player: string): Look {
  if (player.startsWith('npc')) return ENEMY;
  const m = /^p(\d+)$/.exec(player), n = m ? +m[1] : hashOf(player);
  return {
    shirt: SHIRTS[n % SHIRTS.length], trousers: TROUSERS[(n * 3) % TROUSERS.length], hair: HAIR[(n * 7 + 1) % HAIR.length],
    skin: SKIN[(n >>> 1) % SKIN.length], cap: n % 2 ? SHIRTS[(n + 3) % SHIRTS.length] : null,
  };
}

// the gait: a stride (both legs, one cycle) of 2 (STEP_M + STEP_V * v) m, the legs swinging up to WALK_SWING rad at a
// walk (WALK m/s) and RUN_SWING at a run (RUN m/s and on), leaning LEAN rad forward at a run; the speed eased over V_S s
// (the stride as long as the figure's legs: at the walk's speed shorter legs step faster, the feet not sliding)
const STEP_M = 0.55 * S, STEP_V = 0.12 * S, WALK = 2.2, RUN = 6.5, WALK_SWING = 0.5, RUN_SWING = 0.9, LEAN = 0.15, V_S = 0.2;
// a speed past this (m/s) between two ticks is a jump of the walk (put down elsewhere), not a gait
const V_MAX = 12;
// the figure's frame as a grown-up's, drawn at S of it (sim/figure.ts): its feet at 0, +z ahead; the hips, shoulders,
// the arm's length; a name hangs LABEL_UP over the top of its head
const HIP = 0.85, SHOULDER = 1.42, LABEL_UP = 0.35, ARM = 0.6;
// a gun held: the right arm reaching ahead and down to its grip (AIM rad up from hanging), the left under its fore-end
const AIM = 1.2, AIM_LEFT = 1.0;

const box = (w: number, h: number, l: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, l).translate(x, y + h / 2, z);
// shared by every figure (a limb hangs from its pivot: its geometry below 0)
const GEO = {
  leg: box(0.17, HIP, 0.2, 0, -HIP, 0), shoe: box(0.18, 0.1, 0.28, 0, -HIP, 0.04), torso: box(0.44, 0.6, 0.26, 0, HIP, 0),
  arm: box(0.12, ARM, 0.14, 0, -ARM, 0), head: box(0.28, 0.28, 0.28, 0, SHOULDER + 0.04, 0),
  hair: box(0.3, 0.08, 0.3, 0, SHOULDER + 0.32, 0), cap: box(0.31, 0.1, 0.31, 0, SHOULDER + 0.32, 0), peak: box(0.26, 0.03, 0.16, 0, SHOULDER + 0.32, 0.22),
};
const SHOES = new THREE.MeshStandardMaterial({ color: '#202020', roughness: 0.9 });

/** one player's figure: limbs pivoting at the hips and shoulders; label: where a name hangs over it; hand: where its
 * gun is held */
class Figure {
  readonly group = new THREE.Group();
  /** over the head, turning with the figure: a name label added here hangs over the player */
  readonly label = new THREE.Group();
  readonly legs: [THREE.Group, THREE.Group];
  readonly arms: [THREE.Group, THREE.Group];
  readonly body = new THREE.Group();
  /** the right hand's grip, at the end of the right arm, kept level ahead whatever the arm does: a gun added here is
   * held, its barrel along +z */
  readonly hand = new THREE.Group();
  private readonly mats: THREE.Material[];

  constructor(readonly look: Look) {
    const mat = (c: string) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
    const shirt = mat(look.shirt), trousers = mat(look.trousers), skin = mat(look.skin), hair = mat(look.hair), cap = look.cap ? mat(look.cap) : null;
    this.mats = [shirt, trousers, skin, hair, ...(cap ? [cap] : [])];
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => { const o = new THREE.Mesh(g, m); o.castShadow = true; return o; };
    const limb = (x: number, y: number, parts: THREE.Mesh[]) => { const p = new THREE.Group(); p.position.set(x, y, 0); p.add(...parts); this.body.add(p); return p; };
    this.legs = [limb(0.1, HIP, [mesh(GEO.leg, trousers), mesh(GEO.shoe, SHOES)]), limb(-0.1, HIP, [mesh(GEO.leg, trousers), mesh(GEO.shoe, SHOES)])];
    this.arms = [limb(0.29, SHOULDER, [mesh(GEO.arm, shirt)]), limb(-0.29, SHOULDER, [mesh(GEO.arm, shirt)])];
    this.hand.position.y = -ARM;
    // (a gun is the world's size, not the figure's)
    this.hand.scale.setScalar(1 / S);
    this.arms[1].add(this.hand);
    this.body.add(mesh(GEO.torso, shirt), mesh(GEO.head, skin), cap ? mesh(GEO.cap, cap) : mesh(GEO.hair, hair));
    if (cap) this.body.add(mesh(GEO.peak, cap));
    this.body.scale.setScalar(S);
    this.label.position.y = FIGURE_TOP + LABEL_UP;
    this.group.add(this.body, this.label);
  }

  /** at d (eased speed d.v, gait phase d.ph, armed: d.arm a slot with a gun), walking or swimming */
  pose(d: Drawn, swim: boolean, armed: boolean, down = false) {
    const G = this.group, B = this.body, [l, r] = this.legs, [al, ar] = this.arms;
    if (down) { // on its back along its heading, the limbs splayed
      G.position.set(d.x, d.y + 0.15 * S, d.z);
      G.quaternion.setFromEuler(SW.e.set(-Math.PI / 2, d.h, 0, 'YXZ'));
      B.rotation.set(0, 0, 0);
      l.rotation.x = r.rotation.x = 0; l.rotation.z = 0.2; r.rotation.z = -0.2;
      al.rotation.x = ar.rotation.x = -2.6; al.rotation.z = 0;
      this.hand.rotation.x = -ar.rotation.x;
      return;
    }
    l.rotation.z = r.rotation.z = 0;
    if (swim) { // lying forward along its heading, the chest at the water's top, the arms in turn over the head, the legs kicking
      const q = G.quaternion.setFromEuler(SW.e.set(SWIM_TILT, d.h, 0, 'YXZ')), up = SW.v.set(0, 1, 0).applyQuaternion(q);
      G.position.set(d.x, d.y + FLOAT - 0.2 * S, d.z).addScaledVector(up, -HIP * S);
      B.rotation.set(0, 0, 0);
      al.rotation.x = -Math.PI + Math.sin(d.ph) * 1.2; ar.rotation.x = -Math.PI - Math.sin(d.ph) * 1.2;
      l.rotation.x = 0.25 * Math.sin(d.ph * 3); r.rotation.x = -l.rotation.x;
      this.hand.rotation.x = -ar.rotation.x;
      return;
    }
    const run = Math.min(1, Math.max(0, (d.v - WALK) / (RUN - WALK))), swing = swingAt(d.v), s = Math.sin(d.ph);
    G.position.set(d.x, d.y + 0.04 * S * swing * Math.abs(s), d.z);
    G.rotation.set(0, d.h, 0);
    B.rotation.set(LEAN * run, 0, 0);
    l.rotation.x = swing * s; r.rotation.x = -swing * s;
    al.rotation.x = armed ? -AIM_LEFT : -0.8 * swing * s; ar.rotation.x = armed ? -AIM : 0.8 * swing * s;
    al.rotation.z = armed ? -0.35 : 0;
    this.hand.rotation.x = -ar.rotation.x;
  }

  /** seated at s: feet as if standing there, turned as q; the legs reaching forward legs rad from hanging, the hands on
   * the knees */
  sit(s: Seated) {
    const G = this.group, [l, r] = this.legs, [al, ar] = this.arms;
    G.position.copy(s.at);
    G.quaternion.copy(s.q);
    this.body.rotation.set(0, 0, 0);
    l.rotation.x = r.rotation.x = -s.legs;
    al.rotation.x = ar.rotation.x = -0.6;
    al.rotation.z = 0;
    this.hand.rotation.x = -ar.rotation.x;
  }

  dispose() { for (const m of this.mats) m.dispose(); }
}

/** a player drawn sitting in a vehicle (view/seats.ts): their feet's point as if standing (the hips HIP over it), the
 * vehicle's turn, the legs' reach forward (rad) */
export interface Seated { player: string; at: THREE.Vector3; q: THREE.Quaternion; legs: number }
/** the hips' height over a figure's feet */
export const HIPS = HIP * S;
const SWIM_TILT = 1.3, SW = { e: new THREE.Euler(), v: new THREE.Vector3() };

/** how far (rad) the legs swing either way at v m/s: none standing, WALK_SWING at a walk, RUN_SWING at a run */
function swingAt(v: number) {
  return v <= WALK ? WALK_SWING * Math.min(1, v / WALK) : WALK_SWING + (RUN_SWING - WALK_SWING) * Math.min(1, (v - WALK) / (RUN - WALK));
}

/** the other players on foot, a figure each by player at their avatar's pose, and those riding along, sitting in their
 * seats */
export class Avatars {
  readonly group = new THREE.Group();
  private readonly figures = new Map<string, Figure>();
  private readonly drawnBy = new Map<number, Drawn & { player: string }>();
  private frame = 0;

  /** the frame's drawing of avatars (all but me's and those of seated, the players in a vehicle), a (0..1) of the way
   * from their tick before to their tick; at: where an avatar is between its ticks (TrafficMirror avatarPose). The
   * avatars are drawn on the render clock, a tick or two behind who sits in which vehicle (the newest snapshot's): a
   * player got in is the vehicle only from its first frame, never a figure beside it too. sitting: the players in their
   * seats this frame (me among them when seen from outside: StreetLife decides) */
  update(avatars: readonly AvatarState[], me: string | null, seated: ReadonlySet<string>, a: number, dt: number, at: (av: AvatarState, a: number, out: Pose) => Pose,
    sitting: readonly Seated[] = []) {
    this.frame++;
    const to = { x: 0, y: 0, z: 0, h: 0 }, here = new Set<string>();
    for (const s of sitting) {
      if (here.has(s.player)) continue;
      this.figureOf(s.player).sit(s);
      here.add(s.player);
    }
    for (const av of avatars) {
      if (av.player === me || seated.has(av.player)) continue;
      at(av, a, to);
      let d = this.drawnBy.get(av.id);
      if (!d || d.player !== av.player || Math.hypot(d.x - to.x, d.z - to.z) > 6) {
        d = { ...to, pitch: 0, roll: 0, ph: 0, v: 0, frame: this.frame, player: av.player };
        this.drawnBy.set(av.id, d);
      }
      d.frame = this.frame;
      d.arm = av.pose.arm;
      d.down = av.pose.down;
      easeAvatar(d, to, dt);
      const p = av.pose, q = av.prev, step = Math.hypot(p.x - q.x, p.z - q.z) / STEP;
      d.v += ((p.moving && step < V_MAX ? step : 0) - d.v) * (1 - Math.exp(-dt / V_S));
      d.ph += dt * (av.pose.swim ? (p.moving ? 5 : 2) : 2 * Math.PI * d.v / (2 * (STEP_M + STEP_V * d.v)));
      this.figureOf(av.player).pose(d, !!p.swim, d.arm !== undefined && !!weaponIn(d.arm), !!p.down);
      here.add(av.player);
    }
    for (const [id, d] of this.drawnBy) if (d.frame !== this.frame) this.drawnBy.delete(id);
    for (const [player, f] of this.figures) if (!here.has(player)) { this.group.remove(f.group); f.dispose(); this.figures.delete(player); }
  }

  private figureOf(player: string) {
    let f = this.figures.get(player);
    if (!f) { f = new Figure(lookOf(player)); this.figures.set(player, f); this.group.add(f.group); }
    return f;
  }

  /** player's figure drawn this frame (its label: where a name hangs over it; its hand: where a gun is held), or
   * undefined */
  figure(player: string): Figure | undefined { return this.figures.get(player); }

  /** where the other players on foot are drawn this frame (by player; arm: the slot in their hand; hand: their figure's
   * grip) */
  drawn(): { player: string; pose: Readonly<Drawn>; arm?: number; hand?: THREE.Object3D }[] {
    return [...this.drawnBy.values()].map((d) => ({ player: d.player, pose: d, arm: d.arm, hand: this.figures.get(d.player)?.hand }));
  }
}
