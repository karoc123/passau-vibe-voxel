// How far a client's walk may move the person it walks as (WorldSim walkPose): the walk is the client's (nav/foot.ts),
// the sim takes its poses only within reach of the last one taken. No three.js, no DOM (tools/core-deps.mjs).
import { frozen } from '../core/frozen';
import type { WalkPose } from './types';

/** m/s across (speed), up (climb) and down (fall) between two poses, plus slack m on each (an uneven frame, a kerb);
 * take: how far (m, across) from where the sim has a person a walkAs may start. foot.ts walks at 2.2 m/s, runs at 7,
 * rises 6 m/s up a step and jumps at 5.2; falls at 16 m/s² (60 m/s off a 110 m tower). */
export interface WalkBounds { readonly speed: number; readonly climb: number; readonly fall: number; readonly slack: number; readonly take: number }
export const WALK_BOUNDS: WalkBounds = frozen({ speed: 12, climb: 10, fall: 80, slack: 0.5, take: 5 });

/** pose kept within reach of from after t s: moved back towards from across and up or down as far as it went past; the
 * same object when within */
export function boundWalk(from: WalkPose, pose: WalkPose, t: number, B: WalkBounds = WALK_BOUNDS): WalkPose {
  const dx = pose.x - from.x, dz = pose.z - from.z, d = Math.hypot(dx, dz), dy = pose.y - from.y;
  const across = B.speed * t + B.slack, up = B.climb * t + B.slack, down = B.fall * t + B.slack;
  if (d <= across && dy <= up && dy >= -down) return pose;
  const k = d > across ? across / d : 1;
  return { ...pose, x: from.x + dx * k, z: from.z + dz * k, y: from.y + Math.max(-down, Math.min(up, dy)) };
}
