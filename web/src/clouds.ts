import * as THREE from 'three';
import { hash, smooth } from './util';

// Cumulus drifting with the wind, and their shadows on the city. One field of clouds, on a level sheet CLOUD_H above
// the scene's zero, read by the sky (looking up through the sheet) and by the tiles (looking from each point towards
// the sun through it), so a shadow on the ground lies where its cloud is in the sky.
//
// The field is a tileable texture baked once (CLOUD_N² over CLOUD_L metres): heaps of round puffs, 100-350 m across,
// gathered in drifts, over a little noise that frays and joins them; its values then evened out to a uniform spread, so
// a threshold t leaves a 1 - t share of the sky covered (the puffs' cores first). A tile pays one bilinear lookup.
export const CLOUD_H = 1200;
export const CLOUD_L = 5000;
export const CLOUD_N = 256;

// how much of the sky the cumulus cover, by the weather's cloud (0 clear .. ~0.6 cloudy; past it the overcast deck,
// sky.ts, closes over them)
export const coverage = (cloud: number) => 0.14 + 0.5 * smooth(0, 0.6, cloud);
// how much a cloud's shadow takes from the sun: none under the overcast (the sun is a glow through it) or by night
export const shadowStrength = (cloud: number, night: number) => 0.82 * (1 - smooth(0.65, 0.95, cloud)) * (1 - night);

function bake() {
  const N = CLOUD_N, v = new Float32Array(N * N);
  // value noise, each octave wrapping on its own period, so the whole tiles
  const oct = (x: number, y: number, P: number, seed: number) => {
    const fx = x * P / N, fy = y * P / N, ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const g = (i: number, j: number) => hash(((i % P) + P) % P * 157.3 + (((j % P) + P) % P) * 61.7 + seed * 19.1);
    const a = g(ix, iy), b = g(ix + 1, iy), c = g(ix, iy + 1), d = g(ix + 1, iy + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const m = CLOUD_L / N, fbm = (x: number, y: number) => {
    let s = 0, amp = 0.5;
    for (let o = 0, P = 8; o < 4; o++, P *= 2, amp *= 0.5) s += amp * oct(x, y, P, o);
    return s;
  };
  // each texel's place nudged by noise (~80 m), so the puffs come out lumpy, not round
  const wx = new Float32Array(N * N), wy = new Float32Array(N * N), p = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { wx[y * N + x] = (fbm(x, y + 91) - 0.47) * 9; wy[y * N + x] = (fbm(x + 57, y) - 0.47) * 9; }
  // the puffs, of all sizes and heights, a few more where the drifts (a coarse octave) are; each wraps across the edges.
  // Thin cover leaves the tallest standing alone, more joins them into heaps
  for (let k = 0, placed = 0; placed < 300 && k < 5000; k++) {
    const cx = Math.floor(hash(k * 1.7 + 0.3) * N), cy = Math.floor(hash(k * 2.9 + 7.1) * N);
    if (hash(k * 5.3 + 1.9) > oct(cx, cy, 4, 9) * 0.8 + 0.35) continue;
    placed++;
    const r = (110 + 330 * hash(k * 3.1 + 4.4) ** 2) / m, R = Math.ceil(2.2 * r + 5), w = 0.45 + 0.55 * hash(k * 7.7);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const i = (((cy + dy) % N) + N) % N * N + (((cx + dx) % N) + N) % N, ex = dx + wx[i], ey = dy + wy[i];
      const e = (ex * ex + ey * ey) / (r * r);
      if (e < 4.8) p[i] += w * Math.exp(-e);
    }
  }
  for (let i = 0; i < N * N; i++) v[i] = p[i] + 0.2 * fbm(i % N + 33, Math.floor(i / N));
  // even the values out by rank: the share of texels below t is t
  const order = Array.from({ length: N * N }, (_, i) => i).sort((a, b) => v[a] - v[b]);
  const data = new Uint8Array(N * N);
  order.forEach((i, r) => { data[i] = Math.floor(r * 256 / (N * N)); });
  const t = new THREE.DataTexture(data, N, N, THREE.RedFormat);
  Object.assign(t, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, unpackAlignment: 1, needsUpdate: true });
  return t;
}

// shared by the sky (sky.ts) and the tiles (voxelMaterial.ts makeUniforms): uCloudA = the wind's drift (x, z, metres),
// the threshold, the shadow's strength; uCloudSun = the sun's direction over its height (x, z), for the shadow
const field = bake();
export const cloudUniforms = {
  uCloudTex: { value: field as THREE.Texture },
  uCloudA: { value: new THREE.Vector4(0, 0, 0.86, 0) },
  uCloudSun: { value: new THREE.Vector2(0, 0) },
};

// the field at a point (metres, on the sheet): 0..1, the cloud's density there; the sheet's point a ray from p
// towards the sun meets (cloudShade)
export const CLOUD_GLSL = `
  uniform sampler2D uCloudTex; uniform vec4 uCloudA; uniform vec2 uCloudSun;
  float cloudAt(vec2 q) { return texture2D(uCloudTex, (q + uCloudA.xy) * ${(1 / CLOUD_L).toExponential(6)}).r; }
  // what of the sun gets through the clouds to p: a single lookup, the edge soft over ~100 m
  float cloudShade(vec3 p) {
    if (uCloudA.w <= 0.0) return 1.0;
    float n = cloudAt(p.xz + uCloudSun * (${CLOUD_H.toFixed(1)} - p.y));
    return 1.0 - uCloudA.w * smoothstep(uCloudA.z - 0.07, uCloudA.z + 0.1, n);
  }`;

// The sky's own copy of the field (sky.ts cumulus): how tall the heaps stand, as a share of their full height, for the
// thresholds of the four channels (CLOUD_SKY_Z, 1 - coverage from broken cloud to clear, evenly: the weather's own lies
// between two of them, and the sky interpolates). 0 at a heap's edge, 1 at the densest core. Filtered anisotropically:
// the sky averages it along a ray's way through the heaps in one lookup. (The tiles keep the plain field: their lookup
// is the shadow's, and pays nothing for this.)
export const CLOUD_SKY_Z = [0, 1, 2, 3].map((k) => 1 - coverage(0.6) + k / 3 * (coverage(0.6) - coverage(0)));
export const CLOUD_SKY_TEX = (() => {
  const f = field.image.data as Uint8Array, d = new Uint8Array(f.length * 4);
  for (let i = 0; i < f.length; i++) for (let k = 0; k < 4; k++) {
    const z = CLOUD_SKY_Z[k];
    d[i * 4 + k] = Math.round(255 * Math.min(Math.max((f[i] / 255 - z) / (1 - z), 0), 1));
  }
  const t = new THREE.DataTexture(d, CLOUD_N, CLOUD_N, THREE.RGBAFormat);
  Object.assign(t, { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, anisotropy: 4, needsUpdate: true });
  return t as THREE.Texture;
})();

// The wind at the clouds' height: Passau's prevailing westerlies, from between WSW and NW, a day's own; 8-14 m/s
export class Clouds {
  private readonly wind = new THREE.Vector2(10, 0);
  private readonly start = new THREE.Vector2();

  setDay(day: number, northTheta: number) {
    const from = (245 + 70 * hash(day * 3.17)) * Math.PI / 180, speed = 8 + 6 * hash(day * 7.91 + 2.3);
    // blowing towards from + 180°; compass bearings in the scene as daylight.ts skyDir
    const a = from + Math.PI + northTheta;
    this.wind.set(Math.sin(a) * speed, -Math.cos(a) * speed);
    this.start.set(hash(day * 1.31) * CLOUD_L, hash(day * 2.71 + 5) * CLOUD_L);
  }

  // sunDir: towards the sun (the true one, not the light's softened direction)
  setLight(cloud: number, night: number, sunDir: THREE.Vector3) {
    const a = cloudUniforms.uCloudA.value;
    a.z = 1 - coverage(cloud);
    a.w = shadowStrength(cloud, night) * smooth(0.02, 0.08, sunDir.y);
    const y = Math.max(sunDir.y, 0.08);
    cloudUniforms.uCloudSun.value.set(sunDir.x / y, sunDir.z / y);
  }

  tick(t: number) {
    const a = cloudUniforms.uCloudA.value;
    // (drift wrapped to the field's period, so the float stays small)
    a.x = (this.start.x - this.wind.x * t) % CLOUD_L;
    a.y = (this.start.y - this.wind.y * t) % CLOUD_L;
  }
}
