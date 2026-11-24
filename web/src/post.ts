import * as THREE from 'three';
import { N8AOPostPass } from 'n8ao';
import { BlendFunction, BloomEffect, BrightnessContrastEffect, Effect, EffectAttribute, EffectComposer, EffectPass, HueSaturationEffect, RenderPass,
  SMAAEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import { clamp } from './util';
import { cutFogGlsl, FOG_CUT } from './daylight';
import { SKY_GLSL, type Sky } from './sky';
import { REFL_MAX } from './voxelMaterial';
import { Sharpen, TaaPass } from './taa';

// The miniature look by depth, not by screen band: each pixel blurs by how far its distance is from the focus (what
// the camera looks at), in ratio, so the whole plane of the subject stays sharp -- a tower's clock as much as its base.
// A gather over a disc; a sample counts only if it is itself as blurred as its offset, so sharp edges don't smear out.
// (textureLod in loops, here and in REFL: with texture2D's implicit mip level ANGLE's D3D compiler unrolls the loop and
// takes the early exits away, every pixel paying for all of it.)
const DOF = `uniform float focus; uniform float strength; uniform float maxPx;
float coc(float depth) {
  float d = -getViewZ(depth);
  return strength * maxPx * smoothstep(0.12, 0.9, abs(log(d / focus)));
}
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  float r = coc(depth);
  if (r < 0.5) { outputColor = inputColor; return; }
  vec3 sum = inputColor.rgb; float n = 1.0;
  for (int i = 1; i < 24; i++) {
    float t = float(i) / 24.0, a = float(i) * 2.39996;
    vec2 o = vec2(cos(a), sin(a)) * sqrt(t) * r;
    vec2 q = uv + o * texelSize;
    float w = smoothstep(length(o) - 1.0, length(o), coc(textureLod(depthBuffer, q, 0.0).r));
    sum += textureLod(inputBuffer, q, 0.0).rgb * w; n += w;
  }
  outputColor = vec4(sum / n, inputColor.a);
}`;

class DepthBlur extends Effect {
  constructor() {
    super('DepthBlur', DOF, { attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map([['focus', new THREE.Uniform(500)], ['strength', new THREE.Uniform(0)], ['maxPx', new THREE.Uniform(5)]]) });
  }
  set(focus: number, strength: number, height: number) {
    this.uniforms.get('focus')!.value = focus;
    this.uniforms.get('strength')!.value = strength;
    this.uniforms.get('maxPx')!.value = 5 * height / 1000;
  }
}

// Reflections in the rivers and, in the rain, in the puddles: screen-space, so what is mirrored is what is on the
// screen. The surfaces that mirror mark themselves in the scene's alpha (voxelMaterial.ts): a <=
// REFL_MAX, how much they mirror (1 the open river, less a puddle or a wet street); the stairs' 0.5 and everything
// else's 1 are left alone, and a marked pixel leaves here with alpha 1 again (n8ao reads 0.5 as a staircase). Each
// such pixel is horizontal (an up face), so the mirror is the plane through it: the ray from the eye is mirrored
// there, tilted by ripples that drift as the water does, and marched over the depth buffer in steps that widen from
// the water out (more of them near, where the hits are); a crossing is refined by bisection. Where it leaves the
// screen or the scene unhit, the sky as the sky draws it in that direction (sky.ts: its light and its cumulus, seen
// from the water) -- if the ray is sure to meet nothing off the screen: once it is higher than anything on the map
// (uMapTop) where it leaves, or where the screen shows sky there (around there, across the ray: else the skyline
// where it met the screen's edge drew a hard line down the water). Else nothing: the water keeps the horizon's sheen
// its own shader gives it. (By the pixel where it left alone, from high up the rays that left through the screen's
// sides met the hills drawn there, those through its top the sky: a straight edge across the river from each top
// corner, more of one under the clouds' shadows.) Mixed in by Fresnel -- a mirror at a glance, little of it from
// above. Along the line of sight the ripples tilt it more than across, so a light on the far bank mirrors as a broken
// vertical streak.
const REFL = `#define CUMULUS_CHEAP
${SKY_GLSL}
uniform mat4 uProj; uniform mat4 uView; uniform mat4 uCamWorld; uniform float uTime; uniform float uMapTop;
${cutFogGlsl('uView')}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec3 viewAt(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0 + vec2(uProj[2][0], uProj[2][1])) * -z / vec2(uProj[0][0], uProj[1][1]), z); }
float sceneD(vec2 s) { return -getViewZ(textureLod(depthBuffer, s, 0.0).r); }
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;
  float a = inputColor.a;
  if (a > ${(REFL_MAX + 0.05).toFixed(2)} || a < 0.004) return;
  outputColor.a = 1.0;
  float s = min(a / ${REFL_MAX.toFixed(2)}, 1.0);
  vec3 P = viewAt(uv, getViewZ(depth));
  vec3 V = normalize(P);
  vec3 Wp = (uCamWorld * vec4(P, 1.0)).xyz, eye = uCamWorld[3].xyz;
  // ripples: slopes of a few drifting waves (world-fixed), each faded once a wave is under a few pixels; tilted more
  // along the line of sight (streaks) than across it. Rougher on a wet street than on the river or a puddle.
  float px = -P.z * 2.0 / (uProj[1][1] * resolution.y); // metres per pixel there
  vec2 g = vec2(0.0), q = Wp.xz;
  q += 2.5 * vec2(sin(q.y * 0.071 + uTime * 0.13), sin(q.x * 0.083 - uTime * 0.11)); // crests that wander, not ruled lines
  vec2 d1 = vec2(0.83, 0.56), d2 = vec2(-0.45, 0.89), d3 = vec2(0.2, -0.98), d4 = vec2(-0.93, -0.37);
  g += d1 * cos(dot(q, d1) * 0.47 + uTime * 0.9) * 0.5 * (1.0 - smoothstep(1.5, 4.0, px));
  g += d2 * cos(dot(q, d2) * 1.13 - uTime * 1.4) * 0.4 * (1.0 - smoothstep(0.6, 1.6, px));
  g += d3 * cos(dot(q, d3) * 2.71 + uTime * 2.1) * 0.3 * (1.0 - smoothstep(0.25, 0.7, px));
  g += d4 * cos(dot(q, d4) * 5.9 - uTime * 3.0) * 0.2 * (1.0 - smoothstep(0.1, 0.3, px));
  g *= 0.45 + 0.55 * smoothstep(-0.6, 0.8, sin(q.x * 0.031 + q.y * 0.017 + uTime * 0.05) * sin(q.y * 0.043 - q.x * 0.011)); // calm and choppy patches
  vec2 along = normalize(Wp.xz - eye.xz + 1e-4);
  float ga = dot(g, along), gc = dot(g, vec2(-along.y, along.x));
  float rough = s > 0.99 ? 1.0 : mix(2.5, 0.6, smoothstep(0.1, 0.6, s));
  g = (along * ga * 0.022 + vec2(-along.y, along.x) * gc * 0.01) * rough;
  vec3 N = normalize(mat3(uView) * normalize(vec3(-g.x, 1.0, -g.y)));
  float c = clamp(dot(-V, N), 0.0, 1.0), f = 1.0 - c;
  float w = s * (0.12 + 0.78 * f * f * f * f * f) * (1.0 - cutFog(P)); // (none where the view distance's fog hides it)
  if (w < 0.01) return;
  vec3 R = reflect(V, N);
  // never down into the water, never behind the eye
  vec3 up = mat3(uView) * vec3(0.0, 1.0, 0.0);
  R = normalize(R + up * max(0.0, 0.02 - dot(R, up)));
  float L = cameraFar; // (no further: nothing is drawn beyond the far plane, whatever the map's size)
  if (R.z > 0.0) L = min(L, (-cameraNear * 2.0 - P.z) / R.z);
  vec3 E = P + R * L;
  vec4 c0 = uProj * vec4(P, 1.0), c1 = uProj * vec4(E, 1.0);
  float k0 = 1.0 / c0.w, k1 = 1.0 / c1.w;
  vec2 s0 = c0.xy * k0 * 0.5 + 0.5, s1 = c1.xy * k1 * 0.5 + 0.5, dS = s1 - s0;
  // to the screen's edge
  float tEnd = 1.0;
  if (s1.x > 1.0) tEnd = min(tEnd, (1.0 - s0.x) / dS.x); else if (s1.x < 0.0) tEnd = min(tEnd, -s0.x / dS.x);
  if (s1.y > 1.0) tEnd = min(tEnd, (1.0 - s0.y) / dS.y); else if (s1.y < 0.0) tEnd = min(tEnd, -s0.y / dS.y);
  float z0 = P.z * k0, z1 = E.z * k1;
  // from two pixels out: within one the ray is behind its own pixel's depth
  float t0 = min(2.0 / max(length(dS * resolution), 1e-3), tEnd);
  float j = ign(gl_FragCoord.xy), tPrev = t0, hit = -1.0;
  const int STEPS = 14;
  for (int i = 1; i <= STEPS; i++) {
    float u = (float(i) - j) / float(STEPS), t = t0 + (tEnd - t0) * u * u;
    float rd = -mix(z0, z1, t) / mix(k0, k1, t);
    float sd = sceneD(s0 + dS * t);
    if (rd > sd) {
      float pd = -mix(z0, z1, tPrev) / mix(k0, k1, tPrev);
      if (rd - sd < (rd - pd) * 1.5 + 0.02 * sd + 1.0) { hit = t; break; }
    }
    tPrev = t;
  }
  vec3 refl; float conf;
  if (hit > 0.0) {
    float lo = tPrev, hi = hit;
    for (int i = 0; i < 4; i++) {
      float t = 0.5 * (lo + hi);
      if (-mix(z0, z1, t) / mix(k0, k1, t) > sceneD(s0 + dS * t)) hi = t; else lo = t;
    }
    vec2 sh = s0 + dS * hi;
    // smeared along the ray on the screen (up, mostly) as the ripples would: a light on the far bank, a lit window,
    // mirrors as a streak; more of it at a glance and on a rougher surface
    vec2 sm = normalize(dS * resolution) * texelSize * (1.0 + 7.0 * f * f) * rough;
    refl = (textureLod(inputBuffer, sh, 0.0).rgb * 2.0 + textureLod(inputBuffer, sh + sm, 0.0).rgb + textureLod(inputBuffer, sh - sm, 0.0).rgb
      + textureLod(inputBuffer, sh + 2.5 * sm, 0.0).rgb) / 5.0;
    vec2 e = min(sh, 1.0 - sh);
    conf = smoothstep(0.0, 0.08, min(e.x, e.y));
  } else {
    // the ray left the screen or ran out: where (its view-space point at tEnd, perspective-correct), and the sky
    vec3 X = (uCamWorld * vec4(P + R * (L * tEnd * k1 / mix(k0, k1, tEnd)), 1.0)).xyz;
    vec2 se = clamp(s0 + dS * tEnd, vec2(0.002), vec2(0.998));
    // whether the screen shows sky there: over a span across the ray (~4 % of the height, as the ripples would spread
    // it), not at its one pixel -- where the skyline met the screen's edge, the pixels whose rays left on either side
    // of it took the sky or nothing, a hard edge down the river (and a thin line under each tree or tower on it)
    vec2 pr = dS * resolution, sp = normalize(vec2(-pr.y, pr.x) + 1e-6) * texelSize * (0.04 * resolution.y);
    float sky = 0.0;
    for (int i = 0; i < 8; i++) sky += step(4000.0, sceneD(clamp(se + sp * ((float(i) + j) * 0.25 - 1.0), vec2(0.002), vec2(0.998))));
    conf = max(sky * 0.125, smoothstep(uMapTop, uMapTop * 1.5 + 50.0, X.y));
    if (w * conf < 0.01) return;
    vec3 Rw = normalize(mat3(uCamWorld) * R);
    refl = skyLight(Rw);
    #ifndef NO_REFL_CLOUDS // (without the clouds, to time them)
    vec4 cu = cumulus(Wp, Rw, 0.01);
    refl = mix(refl, cu.rgb, cu.a);
    #endif
  }
  outputColor.rgb = mix(inputColor.rgb, refl * 0.92, w * conf);
}`;

class Reflections extends Effect {
  constructor(private readonly camera: THREE.PerspectiveCamera, sky: Sky) {
    super('Reflections', REFL, { attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([['uProj', new THREE.Uniform(new THREE.Matrix4())], ['uView', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())], ['uTime', new THREE.Uniform(0)], ['uMapTop', new THREE.Uniform(150)], ['fogCut', new THREE.Uniform(FOG_CUT)],
        ...Object.entries(sky.u) as [string, THREE.Uniform][]]) });
  }
  // the map's highest point (metres over the scene's zero)
  set mapTop(h: number) { this.uniforms.get('uMapTop')!.value = h; }
  update() {
    const u = this.uniforms;
    u.get('uProj')!.value.copy(this.camera.projectionMatrix);
    u.get('uView')!.value.copy(this.camera.matrixWorldInverse);
    u.get('uCamWorld')!.value.copy(this.camera.matrixWorld);
    u.get('uTime')!.value = (performance.now() / 1000) % 10000;
  }
}

// Night as the eye sees it (before tone mapping, in linear light): in the dark, colour fades and what is left turns
// blue (the Purkinje shift), so red roofs under the moon read as dark slate instead of glowing crimson; what is lit --
// lamps, windows, floodlit stone -- keeps its warmth. A little lift in the shadows keeps the silhouettes readable.
const NIGHT = `uniform float night;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float s = night * (1.0 - smoothstep(0.01, 0.12, L));
  c = mix(c, L * vec3(0.72, 0.9, 1.32), 0.85 * s);
  c += night * vec3(0.0035, 0.0045, 0.008) * (1.0 - smoothstep(0.0, 0.05, L));
  outputColor = vec4(c, inputColor.a);
}`;

class NightGrade extends Effect {
  constructor() { super('NightGrade', NIGHT, { uniforms: new Map([['night', new THREE.Uniform(0)]]) }); }
  get night() { return this.uniforms.get('night')!.value as number; }
  set night(v: number) { this.uniforms.get('night')!.value = v; }
}

// A film grade after tone mapping (after HansF/voxelgent, post.ts): cool shadows, warm highlights and a soft S-curve,
// so the golden hour glows and the shade reads as air rather than grey. Kept light; ?grade=0 turns it off (?grade=0.5
// for half) to compare, as does the graphics panel (settings.ts): at 0 it leaves every pixel as it was.
const FILM = `uniform float strength;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 x = inputColor.rgb;
  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));
  float k = strength * smoothstep(0.0, 0.1, l); // not in the near-black: the night is NightGrade's (no blue lift, no crush)
  x += mix(vec3(-0.010, 0.002, 0.018), vec3(0.026, 0.008, -0.022), smoothstep(0.12, 0.7, l)) * k;
  vec3 c = clamp(x, 0.0, 1.0);
  x = mix(x, c * c * (3.0 - 2.0 * c), 0.16 * k);
  outputColor = vec4(x, inputColor.a);
}`;

class FilmGrade extends Effect {
  constructor() { super('FilmGrade', FILM, { uniforms: new Map([['strength', new THREE.Uniform(1)]]) }); }
  get strength() { return this.uniforms.get('strength')!.value as number; }
  set strength(v: number) { this.uniforms.get('strength')!.value = clamp(v, 0, 2); }
}

// n8ao reads the depth buffer, where a wall at an angle to the grid is a staircase (mesher.worker.ts): it darkened the
// inner corner of every 1 m step into faint vertical lines from street to eaves. Those walls mark themselves in the
// scene's alpha (voxelMaterial.ts) and keep only a little of it; the alpha is reset to 1 after.
const STAIR_AO = 0.3;
//
// n8ao also keeps the AO off transparent things (the fountains' jets, rain, the lamps' glow): once
// the scene holds any, it renders the scene twice more each frame for them, with two full-screen clears and depth
// copies (~0.9-1 ms on an Iris Xe) -- even when none of them is shown or in view, as by day nearly always. Skipped
// then, and the composite told so (uTransp: its transparency targets are left as they were, unread).
const TRANSP = 'if (transparencyAware) {';
//
// On an Iris Xe (D3D11) every full-size pass costs ~0.3 ms at 1400x900 whatever it does, so n8ao's composite (full
// size: the half-size AO onto the scene) does more than n8ao has it do:
// - the reflections when uRefl (REFL, the very function of their own pass, which runs only with the AO off; on the
//   scene as the composite reads it): ~0.25 ms cheaper than a pass of their own.
// - it draws straight into the composer's buffer: n8ao drew into its own and copied that over (~0.27 ms), and copied
//   its half-size AO once more for its accumulation over still frames (unused here).
// - its depth-aware upsampling of the AO (a 3x3 gather around each pixel, which first works out the pixel's normal
//   from 9 depths: ~0.5 ms) gives way to a bilinear one over the 4 nearest half-size samples, each weighed by how far
//   the pixel lies off that sample's plane (its depth and normal are at hand): a sample across an edge -- another wall,
//   the ground behind a roof -- counts next to nothing. Side by side the same picture, ~0.45 ms cheaper.
const DEPTH = 'float depth = texture2D(sceneDepth, vUv).x;';
const FOG = 'fogFactor = smoothstep( fogNear, fogFar, fogDepth );';
const UP = /#ifdef HALFRES\s*\n\s*vec4 texel = vec4\(0\.0\);[\s\S]*?#else\s*vec4 texel = texture2D\(tDiffuse, vUv\);\s*#endif/;
const UPSAMPLE = `vec4 texel = vec4(1.0);
  if (!isBackgroundDepth(depth)) {
    vec3 P = getWorldPos(depth, vUv); // (in view space)
    vec2 hr = floor(resolution * 0.5), hp = vUv * hr - 0.5, f = fract(hp);
    ivec2 i0 = ivec2(floor(hp)), hmax = ivec2(hr) - 1;
    float ao = 0.0, tw = 0.0, sigma = 0.1 - 0.002 * P.z;
    for (int k = 0; k < 4; k++) {
      ivec2 o = ivec2(k & 1, k >> 1), p = clamp(i0 + o, ivec2(0), hmax);
      vec4 s = texelFetch(tDiffuse, p, 0); // the AO, the normal
      vec3 Ps = getWorldPos(texelFetch(downsampledDepth, p, 0).x, (vec2(p) + 0.5) / hr);
      vec2 b = mix(1.0 - f, f, vec2(o));
      float w = b.x * b.y * exp(-abs(dot(P - Ps, s.gba * 2.0 - 1.0)) / sigma) + 1e-6;
      ao += s.r * w; tw += w;
    }
    texel.r = ao / tw;
  }`;
const REFL_N8 = `uniform bool uRefl;
#define inputBuffer sceneDiffuse
#define texelSize (1.0 / resolution)
#define cameraNear near
#define cameraFar far
#define depthBuffer sceneDepth
float getViewZ(float d) { return near * far / ((far - near) * d - far); }
${REFL.replace('void mainImage(', 'void reflImage(')}
#undef inputBuffer
#undef texelSize
#undef cameraNear
#undef cameraFar
#undef depthBuffer
`;
function patchN8(n8: N8AOPostPass, transpOn: THREE.IUniform<boolean>, reflOn: THREE.IUniform<boolean>, reflUniforms: Map<string, THREE.Uniform>) {
  const patch = () => {
    const m = n8.effectCompositerQuad.material, ao = 'float finalAo = pow(texel.r, intensity);';
    if (![ao, TRANSP, DEPTH, FOG, 'void main()'].every((s) => m.fragmentShader.includes(s)) || !UP.test(m.fragmentShader)) throw new Error('n8ao: composite shader changed');
    m.fragmentShader = m.fragmentShader.replace(ao, `float finalAo = mix(1.0, pow(texel.r, intensity), abs(sceneTexel.a - 0.5) < 0.05 ? ${STAIR_AO.toFixed(2)} : 1.0);`)
      .replaceAll(', sceneTexel.a)', ', 1.0)')
      .replace(TRANSP, 'if (transparencyAware && uTransp) {')
      .replace(DEPTH, `${DEPTH}\n  if (uRefl) { vec4 rc; reflImage(sceneTexel, vUv, depth, rc); sceneTexel = rc; }`)
      .replace(UP, UPSAMPLE)
      // the AO fades with the view distance's fog too (daylight.ts), not only with the weather's
      .replace(FOG, 'fogFactor = max(smoothstep( fogNear, fogFar, fogDepth ), cutFog(getWorldPos(depth, vUv)));')
      .replace('void main()', `uniform bool uTransp;\n${REFL_N8}\nvoid main()`);
    Object.assign(m.uniforms, { uTransp: transpOn, uRefl: reflOn }, Object.fromEntries(reflUniforms));
    // the denoised AO, where the accumulation's copy of it was
    m.uniforms.tDiffuse = { get value() { return n8.writeTargetInternal.texture; }, set value(_: unknown) { /* n8ao's */ } };
    m.needsUpdate = true;
  };
  const configure = n8.configureEffectCompositer.bind(n8);
  n8.configureEffectCompositer = (...a) => { configure(...a); patch(); };
  patch();
  n8.accumulationQuad.render = () => {};
  const render = n8.render.bind(n8), copy = n8.copyQuad.render.bind(n8.copyQuad), skip = () => {};
  n8.copyQuad.render = skip;
  n8.render = (r, input, output, ...a) => {
    const own = n8.outputTargetInternal;
    if (!output) { n8.copyQuad.render = copy; try { render(r, input, output, ...a); } finally { n8.copyQuad.render = skip; } return; }
    n8.outputTargetInternal = output;
    try { render(r, input, output, ...a); } finally { n8.outputTargetInternal = own; }
  };
}

// The bloom's bright pass at half size: postprocessing masks the whole image by brightness at full size (~0.3 ms) and
// then takes it down to half with 13 bilinear taps 1 and 2 pixels apart; here each pixel is masked as it is read, 2x2
// of them averaged into a half-size image, and that taken through the same 13 taps (those 1 pixel apart now land
// between its pixels: a little wider). As much bloom overall; pixel by pixel off by 2% of it on average in a lit
// street at night, 15% over the faint bloom of the overview by night (where it barely shows); ~0.3 ms cheaper.
// (Masking all 36 pixels the 13 taps cover, in one pass, would be exact, but costs more than the passes it replaces.)
interface MipBlur {
  downsamplingMipmaps: THREE.WebGLRenderTarget[]; upsamplingMipmaps: THREE.WebGLRenderTarget[]; scene: THREE.Scene; camera: THREE.Camera;
  fullscreenMaterial: THREE.Material;
  downsamplingMaterial: THREE.ShaderMaterial & { setSize(w: number, h: number): void; inputBuffer: THREE.Texture };
  upsamplingMaterial: THREE.ShaderMaterial & { setSize(w: number, h: number): void; inputBuffer: THREE.Texture; supportBuffer: THREE.Texture };
}
function brightDown(bloom: BloomEffect, on: () => boolean) {
  const lum = bloom.luminanceMaterial, mip = bloom.mipmapBlurPass as unknown as MipBlur;
  const bright = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
  const mat = new THREE.ShaderMaterial({
    name: 'BrightDown', depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    uniforms: { inputBuffer: { value: null }, threshold: { value: 1 }, smoothing: { value: 0 } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }',
    fragmentShader: `uniform sampler2D inputBuffer; uniform float threshold; uniform float smoothing;
vec4 tap(ivec2 p) { vec4 t = texelFetch(inputBuffer, min(p, textureSize(inputBuffer, 0) - 1), 0); return smoothstep(threshold, threshold + smoothing, luminance(t.rgb)) * t; }
void main() {
  ivec2 p = 2 * ivec2(gl_FragCoord.xy);
  gl_FragColor = 0.25 * (tap(p) + tap(p + ivec2(1, 0)) + tap(p + ivec2(0, 1)) + tap(p + ivec2(1, 1)));
}`,
  });
  bloom.update = (renderer: THREE.WebGLRenderer, input: THREE.WebGLRenderTarget) => {
    if (!on()) return;
    const { downsamplingMipmaps: down, upsamplingMipmaps: up, downsamplingMaterial: dm, upsamplingMaterial: um } = mip;
    mat.uniforms.inputBuffer.value = input.texture;
    mat.uniforms.threshold.value = lum.threshold;
    mat.uniforms.smoothing.value = lum.smoothing;
    const step = (m: THREE.Material, target: THREE.WebGLRenderTarget) => { mip.fullscreenMaterial = m; renderer.setRenderTarget(target); renderer.render(mip.scene, mip.camera); };
    if (bright.width !== down[0].width || bright.height !== down[0].height) bright.setSize(down[0].width, down[0].height);
    step(mat, bright);
    dm.setSize(input.width, input.height); dm.inputBuffer = bright.texture; step(dm, down[0]);
    let prev = down[0];
    for (let i = 1; i < down.length; i++) { dm.setSize(prev.width, prev.height); dm.inputBuffer = prev.texture; step(dm, down[i]); prev = down[i]; }
    for (let i = up.length - 1; i >= 0; i--) {
      um.setSize(prev.width, prev.height); um.inputBuffer = prev.texture; um.supportBuffer = down[i].texture;
      step(um, up[i]); prev = up[i];
    }
  };
}

// a transparent thing shown (it and all above it visible; an instanced one with any instances) and in the frustum (or
// not culled by it)
function anyTransparentInView(scene: THREE.Object3D, frustum: THREE.Frustum): boolean {
  for (const o of scene.children) {
    if (!o.visible || ((o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count === 0)) continue;
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (mat && (Array.isArray(mat) ? mat.some((x) => x.transparent) : mat.transparent)) {
      const g = (o as THREE.Mesh).geometry;
      if (!o.frustumCulled || !g || frustum.intersectsObject(o)) return true;
    }
    if (o.children.length && anyTransparentInView(o, frustum)) return true;
  }
  return false;
}

export function makePost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, sky: Sky) {
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL });
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  composer.addPass(new RenderPass(scene, camera));
  const reflections = new Reflections(camera, sky);
  const reflPass = new EffectPass(camera, reflections);
  composer.addPass(reflPass);
  const n8 = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
  // 8 samples (n8ao's default 16): after its denoising side by side the same, ~0.25 ms cheaper
  Object.assign(n8.configuration, { aoRadius: 6, distanceFalloff: 1.5, intensity: 2.2, halfRes: true, depthAwareUpsampling: true, aoSamples: 8 });
  const transpOn = new THREE.Uniform(true), reflOn = new THREE.Uniform(true);
  patchN8(n8, transpOn, reflOn, reflections.uniforms);
  const render = n8.renderTransparency.bind(n8), frustum = new THREE.Frustum(), m = new THREE.Matrix4();
  n8.renderTransparency = (r) => {
    frustum.setFromProjectionMatrix(m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    transpOn.value = anyTransparentInView(scene, frustum);
    if (transpOn.value) render(r);
  };
  const n8render = n8.render.bind(n8);
  n8.render = (...a) => { reflections.update(); n8render(...a); }; // (its view matrix: the AO's fog too)
  composer.addPass(n8);
  // the bloom in the last pass (not one of its own, ~0.4 ms): it reads that pass's input, after the depth blur
  const bloom = new BloomEffect({ intensity: 0.2, luminanceThreshold: 0.92, luminanceSmoothing: 0.15, mipmapBlur: true, radius: 0.55 });
  let bloomOn = true;
  brightDown(bloom, () => bloomOn);
  const tilt = new DepthBlur();
  const tiltPass = new EffectPass(camera, tilt);
  composer.addPass(tiltPass);
  // the temporal upscaling (taa.ts), when on: the passes before it at the lower resolution, it and the last at the screen's
  const taa = new TaaPass();
  taa.enabled = false;
  composer.addPass(taa);
  const grade = new NightGrade();
  const film = new FilmGrade();
  // SMAA's edge searches sample in loops: with implicit mip levels (there are no mips) the D3D compiler unrolls them
  // and drops their early exits, so every pixel ran every step (as in DOF and REFL, which take textureLod for it):
  // ~0.25-0.4 ms
  const smaa = new SMAAEffect(), wm = smaa.weightsMaterial;
  wm.fragmentShader = `#undef texture2D\n#define texture2D(t, c) textureLod(t, c, 0.0)\n${wm.fragmentShader}`;
  // and its edges are written as none where there are none instead of left out, so their target needs no clearing
  // first (~0.13 ms for the clear, ~0.05 for the writes)
  const em = smaa.edgeDetectionMaterial;
  if (!em.fragmentShader.includes('discard;')) throw new Error('SMAA: edge shader changed');
  em.fragmentShader = em.fragmentShader.replaceAll('discard;', 'gl_FragColor = vec4(0.0); return;');
  (smaa as unknown as { clearPass: { render(): void } }).clearPass.render = () => {};
  const sharpen = new Sharpen();
  sharpen.blendMode.blendFunction = BlendFunction.SKIP;
  const smaaBlend = smaa.blendMode.blendFunction, smaaUpdate = smaa.update.bind(smaa);
  smaa.update = (...a) => { if (!taa.on) smaaUpdate(...a); };
  const last = new EffectPass(camera,
    sharpen,
    bloom,
    grade,
    tone,
    film,
    new HueSaturationEffect({ saturation: 0.12 }),
    new BrightnessContrastEffect({ brightness: 0, contrast: 0.06 }),
    new VignetteEffect({ offset: 0.3, darkness: 0.45 }),
    smaa);
  composer.addPass(last);
  // with the TAA the last pass reads its resolved frame (at the screen's size) instead of the composer's buffer
  const lastRender = last.render.bind(last);
  last.render = (r, input, ...a) => lastRender(r, taa.on ? taa.output : input, ...a);
  // the passes before the TAA at the lower size, the TAA's history and the last pass at the screen's
  const low = new THREE.Vector2(1, 1);
  const setSize = composer.setSize.bind(composer);
  const fit = () => {
    const full = renderer.getDrawingBufferSize(new THREE.Vector2());
    low.set(Math.max(1, Math.round(full.x * taa.scale)), Math.max(1, Math.round(full.y * taa.scale)));
    if (!taa.on) low.copy(full);
    const c = composer as unknown as { inputBuffer: THREE.WebGLRenderTarget; outputBuffer: THREE.WebGLRenderTarget; depthRenderTarget: THREE.WebGLRenderTarget | null };
    c.inputBuffer.setSize(low.x, low.y);
    c.outputBuffer.setSize(low.x, low.y);
    c.depthRenderTarget?.setSize(low.x, low.y);
    for (const p of composer.passes) {
      if (p === taa || p === last) p.setSize(full.x, full.y);
      else p.setSize(low.x, low.y);
    }
    taa.setLow(low.x, low.y);
  };
  composer.setSize = (...a) => { setSize(...a); fit(); };
  // the camera jittered for the composer's frame only
  const compose = composer.render.bind(composer);
  composer.render = (dt?: number) => {
    if (!taa.on) return compose(dt);
    taa.begin(camera);
    try { compose(dt); } finally { taa.end(camera); }
  };
  const setTaa = (on: boolean, scale: number) => {
    if (on === taa.on && scale === taa.scale) return;
    taa.on = taa.enabled = on;
    taa.scale = on ? scale : 1;
    if (smaa.blendMode.blendFunction !== (on ? BlendFunction.SKIP : smaaBlend)) smaa.blendMode.blendFunction = on ? BlendFunction.SKIP : smaaBlend;
    sharpen.blendMode.blendFunction = on ? BlendFunction.SRC : BlendFunction.SKIP;
    composer.setSize(innerWidth, innerHeight);
  };
  // focused on what the camera looks at; the blur fades out towards the street, and eases over the whole map
  const setHeight = (h: number, enabled: boolean, focus = 500) => {
    tiltPass.enabled = enabled && h > 60;
    tilt.set(focus, clamp((h - 60) / 250, 0, 1) * (1 - 0.5 * clamp((h - 1200) / 1500, 0, 1)), low.y);
  };
  // the AO, the reflections (in the AO's composite, else their own pass) and the bloom on or off
  const on = { ao: true, refl: true };
  const enable = (c: { ao?: boolean; refl?: boolean; bloom?: boolean }) => {
    Object.assign(on, { ao: c.ao ?? on.ao, refl: c.refl ?? on.refl });
    n8.enabled = on.ao;
    reflOn.value = on.ao && on.refl;
    reflPass.enabled = !on.ao && on.refl;
    if (c.bloom !== undefined && c.bloom !== bloomOn) {
      bloomOn = c.bloom;
      bloom.blendMode.blendFunction = bloomOn ? BlendFunction.SCREEN : BlendFunction.SKIP;
    }
  };
  enable({});
  fit();
  return { composer, n8, reflections, bloom, tone, grade, film, setHeight, enable, taa, setTaa,
    // the height the scene is drawn at (pixels)
    get height() { return low.y; } };
}
