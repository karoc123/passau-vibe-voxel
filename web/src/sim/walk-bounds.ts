// How far a client's walk may move the player's avatar (WorldSim walkPose): the walk is the client's (nav/foot.ts),
// the sim takes its poses only within reach of the last one taken. No three.js, no DOM (tools/core-deps.mjs).
import { frozen } from '../core/frozen';
import type { WalkPose } from './contract/pose';

/** m/s across (speed), up (climb) and down (fall) between two poses, plus slack m on each (an uneven frame, a kerb);
 * board: how far (m, across,
 * from its sides) a vehicle's seat may be taken from on foot, and a player getting out is put down from it (the page
 * offers it from 3 m: a step of slack for the walk the host has not yet taken). foot.ts walks as a person
 * at 2.2 m/s, runs at 7; on foot (an avatar) first person at 6, with Shift 20, click-to-walk up to 22; rises 6 m/s up
 * a step (and out of the water) and jumps at 5.2; falls at 16 m/s² (60 m/s off a 110 m tower); swims at 1.8, bobbing up
 * after a fall into the water at a few m/s. */
export interface WalkBounds { readonly speed: number; readonly climb: number; readonly fall: number; readonly slack: number; readonly board: number }
export const WALK_BOUNDS: WalkBounds = frozen({ speed: 25, climb: 10, fall: 80, slack: 0.5, board: 4 });

/** pose kept within reach of from after t s: moved back towards from across and up or down as far as it went past; the
 * same object when within */
export function boundWalk(from: WalkPose, pose: WalkPose, t: number, B: WalkBounds = WALK_BOUNDS): WalkPose {
  const dx = pose.x - from.x, dz = pose.z - from.z, d = Math.hypot(dx, dz), dy = pose.y - from.y;
  const across = B.speed * t + B.slack, up = B.climb * t + B.slack, down = B.fall * t + B.slack;
  if (d <= across && dy <= up && dy >= -down) return pose;
  const k = d > across ? across / d : 1;
  return { ...pose, x: from.x + dx * k, z: from.z + dz * k, y: from.y + Math.max(-down, Math.min(up, dy)) };
}

/** a vehicle's footprint: its middle (y: where it stands), heading h (0: +z), half its width (r) and length (l) */
export interface Box { x: number; y: number; z: number; h: number; r: number; l: number }

// (along the box's length and across it, beyond its sides; 0 inside)
function outside(b: Box, x: number, z: number) {
  const dx = x - b.x, dz = z - b.z, s = Math.sin(b.h), c = Math.cos(b.h);
  const f = dx * s + dz * c, a = dx * c - dz * s;
  return { f, a, of: Math.max(0, Math.abs(f) - b.l), oa: Math.max(0, Math.abs(a) - b.r), s, c };
}

/** whether a walker at p reaches into box: within reach across of its sides and within reach up or down of where it
 * stands (a craft on a roof is not entered from the street below) */
export function reaches(p: { x: number; y: number; z: number }, b: Box, reach: number) {
  return fromBox(p, b) <= reach && Math.abs(p.y - b.y) <= reach;
}

/** how far (m, across) p is from box's sides; 0 inside */
export function fromBox(p: { x: number; z: number }, b: Box) {
  const o = outside(b, p.x, p.z);
  return Math.hypot(o.of, o.oa);
}

/** pose kept within reach of box (getting out: the page's spot beside it, taken if it is): moved in towards the box
 * as far as it is beyond, its height to within reach of the box's; the same object when within */
export function besideBox(pose: WalkPose, b: Box, reach: number): WalkPose {
  if (reaches(pose, b, reach)) return pose;
  const o = outside(b, pose.x, pose.z), d = Math.hypot(o.of, o.oa);
  const k = d > reach ? reach / d : 1;
  // (the nearest point of the box, then out from it by at most reach)
  const nf = Math.sign(o.f) * Math.min(Math.abs(o.f), b.l), na = Math.sign(o.a) * Math.min(Math.abs(o.a), b.r);
  const f = nf + (o.f - nf) * k, a = na + (o.a - na) * k;
  return { ...pose, x: b.x + f * o.s + a * o.c, z: b.z + f * o.c - a * o.s, y: Math.max(b.y - reach, Math.min(b.y + reach, pose.y)) };
}
