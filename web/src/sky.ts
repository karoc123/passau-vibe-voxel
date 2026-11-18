import * as THREE from 'three';
import { clamp } from './util';
import { CLOUD_GLSL, CLOUD_H, CLOUD_L, CLOUD_N, CLOUD_SKY_TEX, CLOUD_SKY_Z, cloudUniforms } from './clouds';

// how tall the cumulus stand over their base (cumulus())
const CLOUD_T = 350;

const VERT = `varying vec3 vDir;
void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); gl_Position.z = gl_Position.w * 0.99999; }`;

// The sky's light and its cumulus as functions of a direction (and, for the clouds, of where one looks from), shared
// by the sky itself and by the reflections (post.ts): a ray off the water that leaves the screen mirrors this sky.
// Uniforms: Sky.uniforms.
export const SKY_GLSL = `
${CLOUD_GLSL}
uniform sampler2D uCloudSky;
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uWarm; uniform float uGolden; uniform vec3 uGround;
uniform vec3 uSunDir; uniform vec3 uTrueSun; uniform vec3 uSunCol; uniform float uNight; uniform float uDeep;
uniform vec3 uAfterglow; uniform vec3 uCityGlow; uniform vec3 uCloudLit; uniform vec3 uCloudDark; uniform float uCloud;
// the sky without its clouds, moon and stars
vec3 skyLight(vec3 d) {
  float h = d.y;
  vec2 sh = normalize(uSunDir.xz + 1e-5), dh = normalize(d.xz + 1e-5);
  float toward = pow(max(dot(sh, dh), 0.), 2.0);
  vec3 col = mix(mix(uHorizon, uWarm, uGolden * (0.25 + 0.75 * toward)), uTop, pow(clamp(h, 0., 1.), 0.5));
  float tw = pow(max(dot(normalize(uTrueSun.xz + 1e-5), dh), 0.), 3.0);
  col += uAfterglow * tw * exp(-max(h, 0.) * 14.0);
  col += uCityGlow * exp(-max(h, 0.) * 14.0);
  col = mix(col, uGround, smoothstep(0.0, -0.25, h));
  float s = max(dot(d, uSunDir), 0.);
  col += uSunCol * (pow(s, 600.) * 6. * (1. - uCloud) + pow(s, 12.) * 0.35 + pow(s, 3.) * 0.12) * (1. - uNight) * (1. - 0.8 * uCloud);
  return col;
}
// The cumulus (clouds.ts) seen from o along d (d.y > 0; apx: the angle a pixel spans): rgb, and how much of the sky
// they hide. Each heap stands on a flat base CLOUD_H up, as tall as its field is dense over the threshold, up to
// CLOUD_T (the sky's copy of the field, CLOUD_SKY_TEX, holds that share; the plain field shades the ground). The ray
// meets the bases first: one lookup there, filtered anisotropically over the pixel's footprint alone, so towards the
// horizon a base keeps its shape, foreshortened, instead of the plain mips' level bands. Where it misses them it may
// still meet a heap's flank higher up: one more lookup halfway up, from a mip as wide as the ray's way through the
// layer (CLOUD_T over the elevation's tangent) -- the flanks' share of that way, so looking low the heaps stand tall
// and the gaps between them close towards the horizon. A base is grey from below, the darker the taller the heap over it,
// its edge thin and translucent (no bright rim), frayed by a finer copy of the field; a flank is white where the heap
// falls away towards the sun (one more lookup, 200 m sunwards), grey on its far side. Far ones fade into the haze. The
// overcast (uCloud) is a deck over all of it. Four lookups (the old flat sheet took two); Iris Xe, whole frame, the
// old and this one swapped frame block by frame block in one page: +0.05-0.2 ms with the sky in view.
const float CLOUD_T = ${CLOUD_T.toFixed(1)};
vec4 cumulus(vec3 o, vec3 d, float apx) {
  const float IL = ${(1 / CLOUD_L).toExponential(6)};
  float h = max(d.y, 1e-3), z = uCloudA.z, base = max(${CLOUD_H.toFixed(1)} - o.y, 200.0);
  vec2 r = d.xz / h;
  float rl = length(r), dist = base / h;
  vec2 al = rl > 1e-4 ? r / rl : vec2(1.0, 0.0), ac = vec2(-al.y, al.x);
  vec4 wk = clamp(1.0 - abs((z - ${CLOUD_SKY_Z[0].toFixed(4)}) * ${(3 / (CLOUD_SKY_Z[3] - CLOUD_SKY_Z[0])).toFixed(4)} - vec4(0.0, 1.0, 2.0, 3.0)), 0.0, 1.0);
  // the bases: the pixel's footprint, foreshortened along the ray
  vec2 uv = (o.xz + r * base + uCloudA.xy) * IL, gA = al * (apx * dist / h) * IL, gB = ac * (apx * dist) * IL;
  #ifdef CUMULUS_CHEAP
  // (the reflections' sky, post.ts: the bases alone, blurred, as the ripples would)
  float d0 = dot(textureLod(uCloudSky, uv, 1.5 + log2(max(apx * dist / h * ${CLOUD_N / CLOUD_L}, 1.0))), wk), dm = 0.0, ds = 0.0;
  #else
  float d0 = dot(textureGrad(uCloudSky, uv, gA, gB), wk);
  float fr = textureGrad(uCloudTex, uv * 3.7 + 0.37, gA * 3.7, gB * 3.7).r;
  d0 *= mix(1.0, 0.35 + 1.3 * fr, 1.0 - smoothstep(0.05, 0.4, d0)); // frayed at the edges only
  // the flanks: halfway up, along the way through the layer -- a plain mip as wide as that way: they are soft anyway
  vec2 um = uv + r * (0.5 * CLOUD_T * IL);
  float lm = log2(max((CLOUD_T * rl + apx * dist / h) * ${CLOUD_N / CLOUD_L}, 1.0)) - 1.0;
  float dm = dot(textureLod(uCloudSky, um, lm), wk);
  float ds = dot(textureLod(uCloudSky, um + normalize(uTrueSun.xz + 1e-5) * ${(200 / CLOUD_L).toExponential(6)}, lm), wk);
  #endif
  float aB = 1.0 - exp(-7.0 * d0), aF = (1.0 - exp(-0.85 * max(dm - 0.04, 0.0) / h)) * (1.0 - smoothstep(0.3, 0.8, h));
  float deck = smoothstep(0.6, 0.95, uCloud);
  float a = aB + (1.0 - aB) * aF;
  float lit = clamp(0.5 + 3.0 * (dm - ds), 0.0, 1.0);
  vec3 baseC = mix(uCloudLit * 0.95, uCloudDark * 0.7, smoothstep(0.05, 0.6, d0) * (0.5 + 0.5 * smoothstep(0.1, 0.6, h)));
  vec3 flankC = mix(uCloudDark * 0.85, uCloudLit, 0.3 + 0.7 * lit);
  vec3 cl = (baseC * aB + flankC * (a - aB)) / max(a, 1e-4);
  cl = mix(cl, mix(uCloudDark, uCloudLit, 0.75) * (1.0 - 0.22 * smoothstep(0.1, 0.6, d0)), deck);
  float s = max(dot(d, uSunDir), 0.), tw = pow(max(dot(normalize(uTrueSun.xz + 1e-5), normalize(d.xz + 1e-5)), 0.), 3.0);
  cl += uAfterglow * tw * 0.6 + uSunCol * pow(s, 6.0) * 0.4 * (1.0 - 0.6 * smoothstep(0.1, 0.6, d0)) * (1. - uNight) * (1.0 - deck);
  cl = mix(cl, uHorizon, (1.0 - exp(-dist / 45000.0)) * (1.0 - deck) * 0.85); // the haze over the far ones
  return vec4(cl, mix(a * 0.97 * smoothstep(0.0, 0.05, h), 1.0, deck));
}`;

const FRAG = `
${SKY_GLSL}
uniform vec3 uMoonDir; uniform float uMoon; uniform float uMoonLit;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y, apx = length(fwidth(d)) * 0.7;
  vec3 col = skyLight(d);
  // The moon (sun.ts moonAt): a disc ~2.5 x its true size, lit from where the sun is (so its phase is the true one), its
  // seas a little darker, the dark part faintly earthlit; a halo around it, more of it the fuller it is. Before the
  // clouds, which pass over it.
  if (uMoon > 0.0) {
    float cd = dot(d, uMoonDir);
    vec3 e1 = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0)), e2 = cross(e1, uMoonDir);
    vec2 p = vec2(dot(d, e1), dot(d, e2)) / 0.0105;
    float r2 = dot(p, p);
    if (cd > 0.0 && r2 < 1.2) {
      vec3 N = e1 * p.x + e2 * p.y - uMoonDir * sqrt(max(1.0 - r2, 0.0));
      float lit = smoothstep(-0.04, 0.12, dot(N, uTrueSun));
      float seas = 0.78 + 0.22 * smoothstep(0.35, 0.65, noise(p * 2.2 + 4.3));
      vec3 mc = vec3(1.0, 0.96, 0.88) * (lit * seas * 1.7 + 0.025);
      col = mix(col, mc, (1.0 - smoothstep(1.0 - 2.0 * fwidth(r2), 1.0, r2)) * uMoon);
    }
    float a = max(1.0 - cd, 0.0);
    col += vec3(0.55, 0.65, 0.85) * (exp(-a * 9000.0) * 0.25 + exp(-a * 600.0) * 0.05) * uMoon * uMoonLit;
  }
  if (h > 0.0) {
    vec4 cu = cumulus(cameraPosition, d, apx);
    col = mix(col, cu.rgb, cu.a);
    if (uDeep > 0.01) col += vec3(step(0.9965, hash(floor(d * 380.)))) * uDeep * 0.2 * smoothstep(0.08, 0.4, h) * (1. - cu.a);
  }
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;

const C = (h: number) => new THREE.Color(h);
const mixC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, clamp(t, 0, 1));

export interface SkyState {
  elDeg: number;
  sunDir: THREE.Vector3;
  trueSun: THREE.Vector3;
  golden: number;
  night: number;
  deep: number;
  cloud: number;
  moonDir: THREE.Vector3;
  moon: number; // how much of the moon is seen (0 by day, below the horizon or behind the overcast)
  moonLit: number;
}

export class Sky {
  readonly horizon = C(0xdfe8ee);
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  readonly u = {
    uTop: { value: C(0x6fa3d8) }, uHorizon: { value: C(0xdfe8ee) }, uGround: { value: C(0x8a8478) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uTrueSun: { value: new THREE.Vector3(0, 1, 0) },
    uWarm: { value: C(0xffc89a) }, uGolden: { value: 0 }, uSunCol: { value: C(0xfff2d8) }, uNight: { value: 0 },
    uDeep: { value: 0 }, uAfterglow: { value: C(0x000000) }, uCityGlow: { value: C(0x000000) },
    uCloudLit: { value: C(0xffffff) }, uCloudDark: { value: C(0xdde3ea) }, uCloud: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoon: { value: 0 }, uMoonLit: { value: 0 },
    ...cloudUniforms, uCloudSky: { value: CLOUD_SKY_TEX },
  };
  private env: THREE.Scene | null = null;

  constructor() {
    this.material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.u, side: THREE.BackSide, depthWrite: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(6000, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  // night: 0 by day .. 1 after sunset; deep: 0 at blue hour .. 1 in full night
  set({ elDeg, sunDir, trueSun, golden, night, deep, cloud, moonDir, moon, moonLit }: SkyState) {
    const u = this.u;
    u.uMoonDir.value.copy(moonDir);
    u.uMoon.value = moon;
    u.uMoonLit.value = moonLit;
    const nightTop = mixC(C(0x0a2f6a), C(0x081226), deep), nightHor = mixC(C(0x5a6f98), C(0x2c3450), deep);
    u.uTop.value.copy(mixC(mixC(C(0x4f8fd8), C(0x6f8fd0), golden * 0.5), nightTop, night));
    u.uHorizon.value.copy(mixC(C(0xdde8f1), nightHor, night));
    u.uWarm.value.copy(mixC(C(0xffc596), mixC(C(0x7a5a50), C(0x3a3440), deep), night));
    u.uGolden.value = golden;
    u.uGround.value.copy(mixC(C(0xc9cdd0), C(0x10121c), night));
    u.uSunDir.value.copy(sunDir);
    u.uTrueSun.value.copy(trueSun);
    u.uSunCol.value.copy(mixC(C(0xfff2d8), C(0xffa060), golden));
    u.uNight.value = night;
    u.uDeep.value = deep;
    const afterglow = Math.max(0, 1 - Math.abs(elDeg + 3) / 11) * (elDeg < 2 ? 1 : 0);
    u.uAfterglow.value.copy(C(0xff9a4a)).multiplyScalar(0.55 * afterglow);
    u.uCityGlow.value.copy(C(0x8a6a48)).multiplyScalar(0.3 * night * deep);
    u.uCloudLit.value.copy(mixC(C(0xffffff), mixC(C(0x55607a), C(0x2c3040), deep), night));
    u.uCloudDark.value.copy(mixC(C(0xd8dfe8), mixC(C(0x22324f), C(0x111522), deep), night));
    const deckLit = mixC(C(0xc4c9cf), C(0x5a4e46), night), deckDark = mixC(C(0x8e959e), C(0x3a322d), night);
    // (broken cloud, ~0.6 (clouds.ts), keeps blue between its cumulus, greyer than on a clear day; the overcast closes it)
    const oc = cloud * cloud;
    u.uCloudLit.value.lerp(deckLit, oc);
    u.uCloudDark.value.lerp(deckDark, cloud);
    u.uHorizon.value.lerp(mixC(C(0xb8bdc2), C(0x4a423c), night), cloud);
    u.uTop.value.lerp(deckDark, oc);
    u.uWarm.value.lerp(u.uHorizon.value, cloud);
    u.uGolden.value = golden * (1 - cloud);
    u.uCityGlow.value.multiplyScalar(1 - 0.6 * cloud);
    u.uAfterglow.value.multiplyScalar(1 - cloud);
    u.uDeep.value = deep * (1 - cloud);
    u.uCloud.value = cloud;
    this.horizon.copy(u.uHorizon.value).lerp(u.uWarm.value, golden * 0.4 * (1 - cloud));
  }

  // a small copy of the sky to bake reflections from
  envScene() {
    if (!this.env) {
      this.env = new THREE.Scene();
      this.env.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.material));
    }
    return this.env;
  }
}
