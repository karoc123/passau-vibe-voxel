// Small number helpers shared by the viewer and the headless world sim (no three.js, no DOM: tools/core-deps.mjs).

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const ease = (t: number) => t * t * (3 - 2 * t);
export const smooth = (a: number, b: number, x: number) => ease(clamp((x - a) / (b - a), 0, 1));
export const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// A seeded random number generator (mulberry32): the same seed, the same sequence, in [0, 1). What the world sim draws
// from instead of Math.random, so two runs from one seed are the same.
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = ReturnType<typeof rng>;
