import { frozen } from '../core/frozen';
import type { Vec3 } from '../core/vec';

// The grappling hook: a line shot at the voxel aimed at, which reels its player there. The pull runs where the motion
// does: on foot in the walk (sim/walker.ts, the page's), under the paraglider in its motion (sim/craft/craft-motion.ts,
// the host's, run ahead on the page). No three.js, no DOM (tools/core-deps.mjs).
export const HOOK = frozen({
  range: 80, // m the line reaches
  min: 2, // m: nearer, there is nothing to reel
  speed: 40, // m/s on foot at full pull, from `start` of it over `ramp` s (a jerk from standing read as a teleport)
  start: 0.35, ramp: 0.25,
  arrive: 0.3, // m from the point: there
  stall: 0.3, // s making no way (a wall, a ceiling between): as near as it gets
  drop: 2, // m over the ground at the end: let go and landed on the feet; higher, the body hangs on the line
  hang: 1.2, // m the feet hang under a point on a wall
  ledge: 2, // m a wall's top may be over the point and the body is still pulled up onto it
  // let go in flight, the body keeps its speed up to these (m/s across, up): inside the host's walk bound, so the
  // fling is not clamped
  fling: 20, flingUp: 9,
  glide: 30, // m/s the paraglider is reeled at, its speed following at `pull` /s
  pull: 3,
  swing: 3, // rad/s at most the wing turns to where it is pulled
  near: 4, // m from the point the wing is let go (its shell's)
  slack: 10, // m past the range a point is still taken for one (the page fired at where it had the body)
});

/** what a hook is fired into: the voxels' ray (hitAxis: the axis of the face met) and what the walk asks of them */
export interface HookWorld {
  raycast(o: Vec3, d: Vec3, max: number): number;
  hitAxis: number;
  support(x: number, z: number, top: number): number;
  blocked(x: number, z: number, y0: number, y1: number): boolean;
}

/** where a line fired from `from` along unit dir takes hold: the point on the voxel face met and the face's axis
 * (1: a floor or a ceiling); null: the sky, beyond the range, or at arm's length */
export function hookPoint(w: Pick<HookWorld, 'raycast' | 'hitAxis'>, from: Vec3, dir: Vec3, range: number = HOOK.range) {
  const t = w.raycast(from, dir, range);
  if (!(t >= HOOK.min && t <= range)) return null;
  return { x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z + dir.z * t, axis: w.hitAxis };
}

/** where the feet of a body (head m tall) reeled to hold `at` (hookPoint, fired along dir) end up: on a floor; under a
 * ceiling; on a wall's top where that is within reach over the point and free to stand on, else hanging at the wall */
export function hookFeet(w: Pick<HookWorld, 'support' | 'blocked'>, at: Vec3 & { axis: number }, dir: Vec3, head: number): Vec3 {
  if (at.axis === 1) return { x: at.x, y: dir.y > 0 ? at.y - head - 0.1 : at.y, z: at.z };
  const l = Math.hypot(dir.x, dir.z) || 1, x = at.x + dir.x / l * 0.6, z = at.z + dir.z / l * 0.6, top = w.support(x, z, at.y + HOOK.ledge);
  if (top > at.y && !w.blocked(x, z, top, top + head)) return { x, y: top, z };
  return { x: at.x, y: at.y - HOOK.hang, z: at.z };
}

/** the unit vector from p to hook and how far it is; null: no hook, not a point, or none to be reeled to from p
 * (beyond the range and its slack, or there) */
export function reelTo(p: Vec3, hook: Vec3 | null | undefined) {
  if (!hook || typeof hook !== 'object') return null;
  const x = hook.x - p.x, y = hook.y - p.y, z = hook.z - p.z, l = Math.hypot(x, y, z);
  if (!(l > 0.5 && l <= HOOK.range + HOOK.slack)) return null;
  return { x: x / l, y: y / l, z: z / l, l };
}
