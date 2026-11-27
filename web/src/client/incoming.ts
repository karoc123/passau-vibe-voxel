import type { Vec3 } from '../core/vec';
import type { SimEvent } from '../sim/contract/events';
import type { EntityRef, PlayerId } from '../sim/contract/ids';
import { weaponById } from '../sim/weapons';

/** the page's player as fire is read against them: their body (what a shot at them stops in: their avatar on foot,
 * the vehicle they sit in, at whatever seat; null: none) and where it is */
export interface Target { player: PlayerId; body: EntityRef | null; at: Vec3 }

/** fire that concerns the player: from where it came (a shot's muzzle, a blast's middle), by whom, and whether it
 * met them (false: it passed close) */
export interface Incoming { by: PlayerId; from: Vec3; hit: boolean }

// A shot passing within NEAR m is a near miss, but only FAR m and more down its way: a friend firing from beside the
// player is not shooting at them.
const NEAR = 6, FAR = 12;

/** what event e means to the player as incoming fire, or null: none. The one place that says so, whoever fired (an
 * NPC on foot, a lookout, an enemy plane, another player) */
export function incoming(e: SimEvent, me: Target): Incoming | null {
  if (e.kind === 'blast') {
    const reach = weaponById(e.weapon)?.damage.reach ?? e.r;
    return Math.hypot(e.at.x - me.at.x, e.at.y - me.at.y, e.at.z - me.at.z) < reach ? { by: e.player, from: e.at, hit: true } : null;
  }
  if (e.kind !== 'shot' || e.player === me.player) return null;
  const h = e.hit, b = me.body;
  if (h && h !== 'world' && b && h.kind === b.kind && h.id === b.id) return { by: e.player, from: e.at, hit: true };
  const dx = e.to.x - e.at.x, dy = e.to.y - e.at.y, dz = e.to.z - e.at.z, len = Math.hypot(dx, dy, dz);
  if (len < FAR) return null;
  const px = me.at.x - e.at.x, py = me.at.y - e.at.y, pz = me.at.z - e.at.z;
  const s = Math.min(len, (px * dx + py * dy + pz * dz) / len);
  if (s < FAR) return null;
  const k = s / len;
  return Math.hypot(px - dx * k, py - dy * k, pz - dz * k) < NEAR ? { by: e.player, from: e.at, hit: false } : null;
}

/** where on the screen's rim `from` lies for a view at eye looking along heading h: rad clockwise from straight
 * ahead (the top), so a quarter turn is the right edge */
export function bearing(from: { x: number; z: number }, eye: { x: number; z: number }, h: number) {
  const dx = from.x - eye.x, dz = from.z - eye.z, s = Math.sin(h), c = Math.cos(h);
  // (the view's right on the map is (-cos h, sin h): x grows to the left of one looking along +z)
  return Math.atan2(-dx * c + dz * s, dx * s + dz * c);
}
