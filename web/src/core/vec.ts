// Plain 3-vector and quaternion maths on { x, y, z } and { x, y, z, w } (no three.js, no DOM: tools/core-deps.mjs), for
// the cores that run headless and on a server (the player's vehicles: sim/craft/plane-flight.ts, sim/craft/fpv-flight.ts,
// physics/rapier/car.ts). Each function does the arithmetic of its three.js namesake in the same order, so a core moved
// off three.js steps bit for bit as before. The ones taking `o` write into it and return it; a three.js Vector3 or
// Quaternion passed as `o` or read from works too (structurally the same fields).

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w });

export function set<T extends Vec3>(o: T, x: number, y: number, z: number) { o.x = x; o.y = y; o.z = z; return o; }
export const copy = <T extends Vec3>(o: T, a: Vec3) => set(o, a.x, a.y, a.z);
export const clone = (a: Vec3) => vec3(a.x, a.y, a.z);
// (i: 0 x, 1 y, 2 z)
export const component = (a: Vec3, i: number) => (i === 0 ? a.x : i === 1 ? a.y : a.z);
export function setComponent<T extends Vec3>(o: T, i: number, v: number) { if (i === 0) o.x = v; else if (i === 1) o.y = v; else o.z = v; return o; }

export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const lengthSq = (a: Vec3) => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a: Vec3) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);

export function add<T extends Vec3>(o: T, a: Vec3) { o.x += a.x; o.y += a.y; o.z += a.z; return o; }
export function scale<T extends Vec3>(o: T, s: number) { o.x *= s; o.y *= s; o.z *= s; return o; }
export function addScaled<T extends Vec3>(o: T, a: Vec3, s: number) { o.x += a.x * s; o.y += a.y * s; o.z += a.z * s; return o; }
// (three.js divides by multiplying with the reciprocal: the same here)
export const divide = <T extends Vec3>(o: T, s: number) => scale(o, 1 / s);
export const normalize = <T extends Vec3>(o: T) => divide(o, length(o) || 1);
export function clampLength<T extends Vec3>(o: T, min: number, max: number) {
  const l = length(o);
  return scale(divide(o, l || 1), Math.max(min, Math.min(max, l)));
}
// o = a x b (o may be a or b)
export function cross<T extends Vec3>(o: T, a: Vec3, b: Vec3) {
  const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
  return set(o, ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
}
// o rotated by the unit quaternion q
export function rotate<T extends Vec3>(o: T, q: Quat) {
  const vx = o.x, vy = o.y, vz = o.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return set(o, vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx);
}

export function setQuat<T extends Quat>(o: T, x: number, y: number, z: number, w: number) { o.x = x; o.y = y; o.z = z; o.w = w; return o; }
export const copyQuat = <T extends Quat>(o: T, q: Quat) => setQuat(o, q.x, q.y, q.z, q.w);
// the turn by `angle` about the unit `axis`
export function axisAngle<T extends Quat>(o: T, axis: Vec3, angle: number) {
  const s = Math.sin(angle / 2);
  return setQuat(o, axis.x * s, axis.y * s, axis.z * s, Math.cos(angle / 2));
}
// o = a b (o may be a or b)
export function quatMul<T extends Quat>(o: T, a: Quat, b: Quat) {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w, bx = b.x, by = b.y, bz = b.z, bw = b.w;
  return setQuat(o, ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz);
}
export function quatNormalize<T extends Quat>(o: T) {
  let l = Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z + o.w * o.w);
  if (l === 0) return setQuat(o, 0, 0, 0, 1);
  l = 1 / l;
  return setQuat(o, o.x * l, o.y * l, o.z * l, o.w * l);
}
