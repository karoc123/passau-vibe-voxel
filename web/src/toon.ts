import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';
import './daylight'; // (its patches of lights_fragment_begin first: it replaces the shadow line by its exact text)

// EXPERIMENT: a cel-shaded ("toon") look, ?look=toon; without it nothing here does anything. Removing it: this file and
// the two lines in post.ts that name it.
// - the sun's (and every lamp's) light in bands: three's direct diffuse term for every lit material (the voxels, cars,
//   people, crafts: all MeshStandard/MeshLambert) takes N.L in 3 steps, and the sun's shadow a hard edge instead of PCF's
//   soft one -- patched into three's shader chunks once, before anything compiles, as daylight.ts does
// - ink lines (Outline below): a post pass over the depth buffer
export const TOON = typeof location !== 'undefined' && new URLSearchParams(location.search).get('look') === 'toon';

// N.L in bands: 0 / 0.45 / 0.8 / 1, each step a little soft so it doesn't alias
const BAND = '#define TOON_BAND(x) (0.45 * smoothstep(0.02, 0.06, x) + 0.35 * smoothstep(0.42, 0.48, x) + 0.2 * smoothstep(0.78, 0.84, x))';
// a shadow lookup (its intensity i: lit is 1, full shadow 1 - i) cut at its middle
const STEP = '#define TOON_SHADOW(m, s, i, b, r, c) mix(1.0 - (i), 1.0, smoothstep(0.35, 0.65, (getShadow(m, s, i, b, r, c) - 1.0 + (i)) / max((i), 1e-3)))';
const DOT_NL = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';

if (TOON) {
  const C = THREE.ShaderChunk;
  for (const k of ['lights_physical_pars_fragment', 'lights_lambert_pars_fragment'] as const) {
    if (!C[k].includes(DOT_NL)) throw new Error(`three: ${k} changed`);
    C[k] = `${BAND}\n${C[k].replace(DOT_NL, DOT_NL.replace('= saturate(', '= TOON_BAND( saturate(').replace(');', ') );'))}`;
  }
  if (!C.lights_fragment_begin.includes('getShadow( directionalShadowMap[')) throw new Error('three: lights_fragment_begin changed');
  C.lights_fragment_begin = `${STEP}\n${C.lights_fragment_begin.replaceAll('getShadow( directionalShadowMap[', 'TOON_SHADOW( directionalShadowMap[')}`;
}

// Ink lines from the depth buffer alone (there is no normal buffer). 1/z is affine across the screen on any plane, so
// its discrete Laplacian is zero on a flat face at whatever angle (no lines across a grazing street) and large where
// the pixel is nearer than its neighbours on both sides' average: a silhouette's near side (the line on the object,
// not on what is behind it) and, much weaker, a convex corner (a building's edge, a ridge). Relative to 1/z, so the
// same at every distance; faded out into the distance, where everything is an edge.
const OUTLINE = `uniform float sil; uniform float crease; uniform float px;
float invZ(vec2 q) { return -1.0 / getViewZ(textureLod(depthBuffer, q, 0.0).r); }
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;
  float z = -getViewZ(depth);
  if (z > cameraFar * 0.98) return;
  float w = 1.0 / z;
  vec2 dx = vec2(texelSize.x * px, 0.0), dy = vec2(0.0, texelSize.y * px);
  float l = invZ(uv - dx), r = invZ(uv + dx), d = invZ(uv - dy), u = invZ(uv + dy);
  float e = max(2.0 * w - l - r, 2.0 * w - d - u) / w;
  float k = max(smoothstep(sil, sil * 3.0, e), 0.6 * smoothstep(crease, crease * 3.0, e));
  k *= 1.0 - smoothstep(1500.0, 4000.0, z);
  outputColor.rgb = mix(inputColor.rgb, inputColor.rgb * 0.08, k);
}`;

export class Outline extends Effect {
  constructor() {
    super('ToonOutline', OUTLINE, { attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map([['sil', new THREE.Uniform(0.03)], ['crease', new THREE.Uniform(0.004)], ['px', new THREE.Uniform(1)]]) });
  }
  // the line's reach in pixels at this height of the scene (two at ~900 px)
  setHeight(h: number) { this.uniforms.get('px')!.value = Math.max(1, Math.round(h / 450)); }
}
