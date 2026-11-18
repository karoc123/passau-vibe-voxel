import * as THREE from 'three';
import { N8AOPostPass } from 'n8ao';
import { BloomEffect, BrightnessContrastEffect, Effect, EffectAttribute, EffectComposer, EffectPass, HueSaturationEffect, RenderPass,
  SMAAEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import { clamp } from './util';
import { SKY_GLSL, type Sky } from './sky';
import { REFL_MAX } from './voxelMaterial';

// The miniature look by depth, not by screen band: each pixel blurs by how far its distance is from the focus (what
// the camera looks at), in ratio, so the whole plane of the subject stays sharp -- a tower's clock as much as its base.
// A gather over a disc; a sample counts only if it is itself as blurred as its offset, so sharp edges don't smear out.
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
    float w = smoothstep(length(o) - 1.0, length(o), coc(readDepth(q)));
    sum += texture2D(inputBuffer, q).rgb * w; n += w;
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
// screen. The surfaces that mirror mark themselves in the scene's alpha (voxelMaterial.ts, flood.ts): a <=
// REFL_MAX, how much they mirror (1 the open river, less a puddle or a wet street); the stairs' 0.5 and everything
// else's 1 are left alone, and a marked pixel leaves here with alpha 1 again (n8ao reads 0.5 as a staircase). Each
// such pixel is horizontal (an up face), so the mirror is the plane through it: the ray from the eye is mirrored
// there, tilted by ripples that drift as the water does, and marched over the depth buffer in steps that widen from
// the water out (more of them near, where the hits are); a crossing is refined by bisection. Where it leaves the
// screen or the scene unhit, the sky as the sky draws it in that direction (sky.ts: its light and its cumulus, seen
// from the water) -- if the ray is sure to meet nothing off the screen: once it is higher than anything on the map
// (uMapTop) where it leaves, or where the screen shows sky there. Else nothing: the water keeps the horizon's sheen
// its own shader gives it. (By the pixel where it left alone, from high up the rays that left through the screen's
// sides met the hills drawn there, those through its top the sky: a straight edge across the river from each top
// corner, more of one under the clouds' shadows.) Mixed in by Fresnel -- a mirror at a glance, little of it from
// above. Along the line of sight the ripples tilt it more than across, so a light on the far bank mirrors as a broken
// vertical streak.
const REFL = `#define CUMULUS_CHEAP
${SKY_GLSL}
uniform mat4 uProj; uniform mat4 uView; uniform mat4 uCamWorld; uniform float uTime; uniform float uMapTop;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec3 viewAt(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0 + vec2(uProj[2][0], uProj[2][1])) * -z / vec2(uProj[0][0], uProj[1][1]), z); }
float sceneD(vec2 s) { return -getViewZ(readDepth(s)); }
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
  float w = s * (0.12 + 0.78 * f * f * f * f * f);
  if (w < 0.01) return;
  vec3 R = reflect(V, N);
  // never down into the water, never behind the eye
  vec3 up = mat3(uView) * vec3(0.0, 1.0, 0.0);
  R = normalize(R + up * max(0.0, 0.02 - dot(R, up)));
  float L = 12000.0;
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
    refl = (texture2D(inputBuffer, sh).rgb * 2.0 + texture2D(inputBuffer, sh + sm).rgb + texture2D(inputBuffer, sh - sm).rgb
      + texture2D(inputBuffer, sh + 2.5 * sm).rgb) / 5.0;
    vec2 e = min(sh, 1.0 - sh);
    conf = smoothstep(0.0, 0.08, min(e.x, e.y));
  } else {
    // the ray left the screen or ran out: where (its view-space point at tEnd, perspective-correct), and the sky
    vec3 X = (uCamWorld * vec4(P + R * (L * tEnd * k1 / mix(k0, k1, tEnd)), 1.0)).xyz;
    vec2 se = clamp(s0 + dS * tEnd, vec2(0.002), vec2(0.998));
    conf = max(step(4000.0, sceneD(se)), smoothstep(uMapTop, uMapTop * 1.5 + 50.0, X.y));
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
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())], ['uTime', new THREE.Uniform(0)], ['uMapTop', new THREE.Uniform(150)],
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
// n8ao also keeps the AO off transparent things (the fountains' jets, the flood's water, rain, the lamps' glow): once
// the scene holds any, it renders the scene twice more each frame for them, with two full-screen clears and depth
// copies (~0.9-1 ms on an Iris Xe) -- even when none of them is shown or in view, as by day nearly always. Skipped
// then, and the composite told so (uTransp: its transparency targets are left as they were, unread).
const TRANSP = 'if (transparencyAware) {';
function maskStairs(n8: N8AOPostPass, transpOn: THREE.IUniform<boolean>) {
  const patch = () => {
    const m = n8.effectCompositerQuad.material, ao = 'float finalAo = pow(texel.r, intensity);';
    if (!m.fragmentShader.includes(ao) || !m.fragmentShader.includes(TRANSP)) throw new Error('n8ao: composite shader changed');
    m.fragmentShader = m.fragmentShader.replace(ao, `float finalAo = mix(1.0, pow(texel.r, intensity), abs(sceneTexel.a - 0.5) < 0.05 ? ${STAIR_AO.toFixed(2)} : 1.0);`)
      .replaceAll(', sceneTexel.a)', ', 1.0)')
      .replace(TRANSP, 'if (transparencyAware && uTransp) {').replace('void main()', 'uniform bool uTransp;\nvoid main()');
    m.uniforms.uTransp = transpOn;
    m.needsUpdate = true;
  };
  const configure = n8.configureEffectCompositer.bind(n8);
  n8.configureEffectCompositer = (...a) => { configure(...a); patch(); };
  patch();
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
  Object.assign(n8.configuration, { aoRadius: 6, distanceFalloff: 1.5, intensity: 2.2, halfRes: true, depthAwareUpsampling: true });
  const transpOn = new THREE.Uniform(true);
  maskStairs(n8, transpOn);
  const render = n8.renderTransparency.bind(n8), frustum = new THREE.Frustum(), m = new THREE.Matrix4();
  n8.renderTransparency = (r) => {
    frustum.setFromProjectionMatrix(m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    transpOn.value = anyTransparentInView(scene, frustum);
    if (transpOn.value) render(r);
  };
  composer.addPass(n8);
  const bloom = new BloomEffect({ intensity: 0.2, luminanceThreshold: 0.92, luminanceSmoothing: 0.15, mipmapBlur: true, radius: 0.55 });
  const tilt = new DepthBlur();
  const tiltPass = new EffectPass(camera, tilt);
  const bloomPass = new EffectPass(camera, bloom);
  composer.addPass(bloomPass);
  composer.addPass(tiltPass);
  const grade = new NightGrade();
  const film = new FilmGrade();
  composer.addPass(new EffectPass(camera,
    grade,
    tone,
    film,
    new HueSaturationEffect({ saturation: 0.12 }),
    new BrightnessContrastEffect({ brightness: 0, contrast: 0.06 }),
    new VignetteEffect({ offset: 0.3, darkness: 0.45 }),
    new SMAAEffect()));
  // focused on what the camera looks at; the blur fades out towards the street, and eases over the whole map
  const setHeight = (h: number, enabled: boolean, focus = 500) => {
    tiltPass.enabled = enabled && h > 60;
    tilt.set(focus, clamp((h - 60) / 250, 0, 1) * (1 - 0.5 * clamp((h - 1200) / 1500, 0, 1)), renderer.domElement.height);
  };
  return { composer, n8, reflPass, reflections, bloom, bloomPass, tone, grade, film, setHeight };
}
