// The host decides shots, from the player's eyes as it has them (a page's word for where it stands is not trusted),
// so the weapons stand on the world's voxels and bodies here, not on a page's.
import type { Vec3 } from '../../core/vec';
import type { EntityRef, WeaponId } from '../contract/ids';
import type { DamageKind } from '../health';

/** the slots a player holds weapons in, numbered from 1 (keys 1, 2) */
export const SLOTS = 2;

/** the eyes over the feet (m): the first-person camera's, so a shot leaves where the player looks from */
export const EYE = 1.7;

/** how far (m) round a player on foot the host keeps the voxels loaded: a ray into a node not loaded meets nothing,
 * so this is at least the longest ray a weapon casts */
export const REACH = 300;

/** the world's voxels as a ray sees them: the distance along unit d from o to the first solid voxel (Infinity: none
 * within max); hold: the voxels within r m of these points (map x, z) kept loaded, those of the call before let go */
export interface VoxelRay {
  raycast(o: Vec3, d: Vec3, max: number): number;
  hold?(around: readonly { x: number; z: number }[], r: number): void;
  /** whether the voxels along the ray up to max m are loaded (the nodes that are not: asked for) */
  ready?(o: Vec3, d: Vec3, max: number): boolean;
}

/** something a shot can hit: an upright box standing on (x, y, z), turned to heading h; r its half width, l its half
 * length (along h), ht its height */
export interface Body { entity: EntityRef; x: number; y: number; z: number; h: number; r: number; l: number; ht: number }

/** a box on the map (x, z): [x0, z0, x1, z1] */
export type MapBox = readonly [number, number, number, number];

/** what a weapon fires into: the voxels and the bodies (the shooter's own left out); near: at least those whose foot
 * is in the box (without one, all) */
export interface ShotWorld { voxels: VoxelRay | null; bodies(near?: MapBox): Iterable<Body> }

// the farthest a body's box reaches from its foot on the map (a bus's half length), with a metre to spare
const BODY_REACH = 7;

/** what a shot did: from at to to, what stopped it (null: nothing within its range) */
export interface Shot { at: Vec3; to: Vec3; hit: EntityRef | 'world' | null }

/** what a weapon lets go to fly (its fire that is not a ray): the host flies it each tick until it bursts */
export interface Projectile {
  /** where it left and its velocity then (m/s): what the others draw its flight from */
  at: Vec3;
  v: Vec3;
  /** its blast's radius (m): the crater it leaves */
  r: number;
  /** its flight from t0 to t1 s after it left, through world: where it burst, or null while it flies on */
  fly(world: ShotWorld, t0: number, t1: number): Vec3 | null;
}

export interface Weapon {
  id: WeaponId;
  /** the slot it is in (1..SLOTS) */
  slot: number;
  /** what the page shows the player */
  name: string;
  /** shots a second at most: the host's limit and a held trigger's pace */
  rate: number;
  /** what it does to what it hits: points of a kind (a blast's at its middle, none at reach m from it) */
  damage: { kind: DamageKind; points: number; reach?: number };
  /** fired from `from` along unit `dir`: a shot at once, or a projectile let go */
  fire(world: ShotWorld, from: Vec3, dir: Vec3): Shot | Projectile;
}

/** the unit direction of heading h (0: +z, pi/2: +x) and pitch (up) */
export function aimDir(h: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: Math.sin(h) * c, y: Math.sin(pitch), z: Math.cos(h) * c };
}

/** a ray from o along unit d through world, up to max m: where it stops and what stopped it */
export function trace(world: ShotWorld, o: Vec3, d: Vec3, max: number): Shot {
  let t = Math.min(max, world.voxels?.raycast(o, d, max) ?? Infinity), hit: Shot['hit'] = t < max ? 'world' : null;
  // (a body is tested only when its foot is near the ray's track on the map: the crowd is thousands)
  const ex = o.x + d.x * t, ez = o.z + d.z * t, m = BODY_REACH;
  // (the crowd's poses read the ground's voxels: only those near the track are asked for, or a shot loads the map)
  for (const b of world.bodies([Math.min(o.x, ex) - m, Math.min(o.z, ez) - m, Math.max(o.x, ex) + m, Math.max(o.z, ez) + m])) {
    const reach = Math.max(b.r, b.l) + 1;
    if (segDist2(o.x, o.z, ex, ez, b.x, b.z) > reach * reach) continue;
    const tb = boxHit(o, d, b);
    if (tb < t) { t = tb; hit = { kind: b.entity.kind, id: b.entity.id }; }
  }
  return { at: { ...o }, to: { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t }, hit };
}

// the squared distance on the map from (px, pz) to the segment (ax, az)-(bx, bz)
function segDist2(ax: number, az: number, bx: number, bz: number, px: number, pz: number) {
  const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
  const k = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L)) : 0;
  return (ax + dx * k - px) ** 2 + (az + dz * k - pz) ** 2;
}

/** the distance along unit d from o into body b (Infinity: it misses; 0: o is inside) */
function boxHit(o: Vec3, d: Vec3, b: Body): number {
  // (in the box's frame: u along its heading, v across, y up from its foot)
  const s = Math.sin(b.h), c = Math.cos(b.h), px = o.x - b.x, pz = o.z - b.z;
  const ou = px * s + pz * c, ov = px * c - pz * s, du = d.x * s + d.z * c, dv = d.x * c - d.z * s;
  let t0 = 0, t1 = Infinity;
  for (const [p, q, lo, hi] of [[ou, du, -b.l, b.l], [ov, dv, -b.r, b.r], [o.y - b.y, d.y, 0, b.ht]]) {
    if (Math.abs(q) < 1e-12) { if (p < lo || p > hi) return Infinity; continue; }
    let a = (lo - p) / q, e = (hi - p) / q;
    if (a > e) [a, e] = [e, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, e);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** a player's triggers: how many shots each weapon has in hand. A weapon's rate refills them, up to one and what SLACK
 * s of its rate give, so commands that reach the host bunched (a page's frames, the network) are not refused while the
 * rate over a while holds */
export class Trigger {
  private readonly held = new Map<WeaponId, { n: number; at: number }>();
  /** whether w may fire at clock now (s); it is then spent */
  pull(w: Weapon, now: number) {
    let s = this.held.get(w.id);
    const most = 1 + SLACK * w.rate;
    if (!s) this.held.set(w.id, s = { n: most, at: now });
    s.n = Math.min(most, s.n + (now - s.at) * w.rate);
    s.at = now;
    if (s.n < 1) return false;
    s.n--;
    return true;
  }
}
// (the MG's 10 a second: two in hand; a slow weapon's command taken up to this early)
const SLACK = 0.1;
