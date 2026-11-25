// A car's body as drawn, from what crosses in a snapshot (contract/agents.ts BodyDraw): shared by the sim's own
// drawing of it (physics/rapier/life-phys.ts LifePhysics.pose) and a client's copy of the traffic
// (client/sim-client.ts TrafficMirror), so both draw the same pose bit for bit. The body's rotation is a quaternion
// at each tick, blended between the two (normalised lerp, the shorter way), its heading, pitch and roll read from
// the blend; never the angles blended. No three.js, no DOM.
import type { BodyDraw, BodyPose } from './contract/agents';
import type { RoadPose } from './contract/pose';
import { FALL_MS } from './contract/snapshot';

const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
// a rotation's up (its y axis)
const upOf = (x: number, y: number, z: number, w: number) => ({ x: 2 * (x * y - w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + w * x) });

/** pose p with what is left (k, 1 .. 0) of a release's difference (BodyDraw's fade) added; body: it has one still (its
 * roll is its own, else the roll is blended out too). A new pose */
export function fadeOut(p: RoadPose, f: { dx: number; dy: number; dz: number; dh: number }, k: number, body: boolean): RoadPose {
  return { x: p.x + f.dx * k, y: p.y + f.dy * k, z: p.z + f.dz * k, h: (p.h ?? 0) + f.dh * k, pitch: p.pitch,
    roll: body ? p.roll : (p.roll ?? 0) * (1 - k) };
}

/** the car's pose (the ground under the body's origin: down its up by ride; its heading, pitch, roll) a of the way
 * from body pose p0 to p1; drive: a driven body's lean, wheelie and fall drawn (BodyDraw drive; step: the tick, s);
 * ox, oz: added to x, z after the blend (the physics world's origin, for its own poses) */
export function bodyPoseAt(p0: BodyPose, p1: BodyPose, a: number, drive: BodyDraw['drive'] = null, step = 0, ox = 0, oz = 0): RoadPose {
  const l = (u: number, v: number) => u + (v - u) * a;
  const d = p0.qx * p1.qx + p0.qy * p1.qy + p0.qz * p1.qz + p0.qw * p1.qw, s = d < 0 ? -1 : 1;
  let qx = l(p0.qx, p1.qx * s), qy = l(p0.qy, p1.qy * s), qz = l(p0.qz, p1.qz * s), qw = l(p0.qw, p1.qw * s);
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  qx /= n; qy /= n; qz /= n; qw /= n;
  const ride = l(p0.ride, p1.ride), up = upOf(qx, qy, qz, qw);
  const x = l(p0.x, p1.x) + ox - up.x * ride, y = l(p0.y, p1.y) - up.y * ride, z = l(p0.z, p1.z) + oz - up.z * ride;
  const m13 = 2 * (qx * qz + qw * qy), m23 = 2 * (qy * qz - qw * qx), m33 = 1 - 2 * (qx * qx + qy * qy);
  const m21 = 2 * (qx * qy + qw * qz), m22 = 1 - 2 * (qx * qx + qz * qz), m31 = 2 * (qx * qz - qw * qy), m11 = 1 - 2 * (qy * qy + qz * qz);
  const level = Math.abs(m23) < 0.9999999;
  const h = level ? Math.atan2(m13, m33) : Math.atan2(-m31, m11);
  const pitch = -Math.asin(-Math.max(-1, Math.min(1, m23)));
  const roll = level ? Math.atan2(m21, m22) : 0;
  if (!drive) return { x, y, z, h, pitch, roll };
  const wheelie = l(p0.wheelie ?? 0, p1.wheelie ?? 0);
  let tilt = roll + l(p0.lean ?? 0, p1.lean ?? 0);
  const f = drive.fall;
  if (f) {
    const now = (f.tick - 1 + a) * step * 1000;
    const k = Math.min(1, Math.max(0, (FALL_MS - (f.until - now)) / 450));
    tilt += (f.side * 1.45 - tilt) * k * k;
  }
  return { x, y: y + Math.sin(wheelie) * -drive.wheelZ, z, h, pitch: pitch + wheelie, roll: tilt };
}

/** car's drawn pose by its body's draw state d (null: none) a of the way between the last two ticks (step: the tick,
 * s): base (its parked pose, else what it is drawn at without a body) itself, or a pose of its own; the body's pose
 * while it moves, the fade back onto its path blended out */
export function drawnBodyPose(d: BodyDraw | null | undefined, a: number, base: RoadPose, step: number): RoadPose {
  if (!d) return base;
  const p = d.p0 && d.p1 ? bodyPoseAt(d.p0, d.p1, a, d.drive, step) : base;
  const f = d.fade;
  return f ? fadeOut(p, f, 1 - smooth01((f.t + (a - 1) * step) / f.dur), d.body) : p;
}
