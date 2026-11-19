import * as THREE from 'three';
import { Effect, Pass } from 'postprocessing';

// Temporal upscaling (TAA), optional (?taa=1, the ⚙ panel; off by default, no preset turns it on). The scene, its AO,
// reflections and depth blur are drawn at a lower resolution (settings.ts TAA_RES unless the resolution is set), each
// frame with the projection shifted by a sub-pixel (Halton 2,3 over 16 frames), and this pass puts the frames together
// at the screen's resolution: each screen pixel keeps a running average (the history, in a half-float target at the
// screen's size; its alpha how many frames' worth it holds) and adds this frame's nearby samples, weighted by how close
// each lands to the pixel's centre -- so over the frames the screen's pixels each see samples of their own, sharper
// than the lower resolution could show in one frame. Before the grade, tone mapping and bloom (post.ts: the last pass
// reads the history instead of the scene), replacing SMAA; that pass also sharpens it a little (Sharpen).
//
// Nothing has motion vectors: the history is found where the camera's motion puts it (each pixel's depth, the nearest
// of its 3 x 3, reprojected by last frame's camera), fetched with a Catmull-Rom filter (a bilinear one blurs a little
// more every frame in motion), and then clipped towards this frame's 3 x 3 neighbourhood (its mean +- its spread, in
// YCoCg of a tone-mapped colour, inside its min/max): what moved by itself -- cars, people, boats, trains, water,
// clouds, the rain -- or came out from behind something, leaves history unlike its neighbourhood, which the clip
// replaces. Against trails in fast motion (FPV), the history keeps fewer frames the further a pixel moved (at 24 screen
// pixels a frame and more, under two: a new frame is a third of the picture or more), the clip is tighter, and the
// further the history was off the neighbourhood the less of it counts. Off the screen last frame, a jump of the camera
// (more than 30 m or 30 degrees between two frames), a resize or a change of resolution: no history.
//
// Only the composer's frame is jittered (post.ts around composer.render): the shadow maps have cameras of their own,
// and picking, the labels and the occlusion culling's key (occlusion.ts) see the camera as it is outside of it. The AO
// (n8ao) and the reflections reconstruct positions from the same, jittered projection as the depth they read.

const N = 16;
const halton = (i: number, b: number) => { let f = 1, r = 0; for (; i > 0; i = Math.floor(i / b)) { f /= b; r += f * (i % b); } return r; };
const JITTER = Array.from({ length: N }, (_, i) => new THREE.Vector2(halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5));

const VERT = 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }';
const FRAG = `uniform sampler2D tCur; uniform sampler2D tDepth; uniform sampler2D tHist;
uniform vec2 uLow; uniform vec2 uFull; uniform vec2 uJit;
uniform mat4 uInvVPj; uniform mat4 uCurVP; uniform mat4 uPrevVP;
uniform float uReset; uniform float uWMax; uniform float uWMove;
varying vec2 vUv;
// a colour, tone-mapped (invertibly, by its largest channel), in YCoCg
vec3 toY(vec3 c) {
  c = max(c, 0.0); c /= 1.0 + max(c.r, max(c.g, c.b));
  return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25)));
}
vec3 fromY(vec3 y) {
  vec3 c = vec3(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z);
  return max(c, 0.0) / max(1.0 - max(c.r, max(c.g, c.b)), 1e-3);
}
// the history at uv, Catmull-Rom from 5 bilinear taps (the corners left out); its alpha from the middle one
vec4 history(vec2 uv) {
  vec2 p = uv * uFull, t1 = floor(p - 0.5) + 0.5, f = p - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f), w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, t0 = (t1 - 1.0) / uFull, t3 = (t1 + 2.0) / uFull, t12 = (t1 + w2 / w12) / uFull;
  vec4 m = textureLod(tHist, t12, 0.0);
  vec3 c = textureLod(tHist, vec2(t12.x, t0.y), 0.0).rgb * (w12.x * w0.y) + textureLod(tHist, vec2(t0.x, t12.y), 0.0).rgb * (w0.x * w12.y)
    + m.rgb * (w12.x * w12.y) + textureLod(tHist, vec2(t3.x, t12.y), 0.0).rgb * (w3.x * w12.y) + textureLod(tHist, vec2(t12.x, t3.y), 0.0).rgb * (w12.x * w3.y);
  float w = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return vec4(max(c / w, 0.0), m.a);
}
void main() {
  // this pixel's centre in low-resolution pixels; the sample of low pixel q shows what (unjittered) is at q + 0.5 - uJit
  vec2 pL = vUv * uLow;
  ivec2 c0 = ivec2(floor(pL + uJit)), hi = ivec2(uLow) - 1;
  float r2 = (uFull.x / uLow.x) * (uFull.x / uLow.x);
  vec3 m1 = vec3(0.0), m2 = vec3(0.0), sb = vec3(0.0), sn = vec3(0.0), lo = vec3(1e9), up = vec3(-1e9);
  float wb = 0.0, wn = 0.0, zmin = 2.0; ivec2 qz = c0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 q = clamp(c0 + ivec2(i, j), ivec2(0), hi);
    vec3 y = toY(texelFetch(tCur, q, 0).rgb);
    if (((i + j) & 1) == 0) { float z = texelFetch(tDepth, q, 0).r; if (z < zmin) { zmin = z; qz = q; } } // (the middle and the corners)
    vec2 d = vec2(q) + 0.5 - uJit - pL;
    float dd = dot(d, d), b = exp(-3.5 * dd), n = exp(-2.29 * dd * r2); // (in low pixels; in screen pixels)
    sb += y * b; wb += b; sn += y * n; wn += n;
    m1 += y; m2 += y * y; lo = min(lo, y); up = max(up, y);
  }
  // where the nearest surface around was last frame (positions relative to the camera)
  vec4 P = uInvVPj * vec4((vec2(qz) + 0.5) / uLow * 2.0 - 1.0, zmin * 2.0 - 1.0, 1.0);
  P /= P.w;
  vec4 a = uCurVP * P, b = uPrevVP * P;
  vec2 mv = (b.xy / b.w - a.xy / a.w) * 0.5, hUv = vUv + mv;
  float vPx = length(mv * uFull);
  vec4 h = history(hUv);
  float W = h.a;
  if (uReset > 0.5 || b.w <= 0.0 || hUv.x < 0.0 || hUv.y < 0.0 || hUv.x > 1.0 || hUv.y > 1.0) W = 0.0;
  // the neighbourhood: its mean +- its spread (tighter in motion), inside its min/max; the history clipped towards it
  float mo = smoothstep(1.0, 24.0, vPx);
  vec3 mu = m1 / 9.0, sg = sqrt(max(m2 / 9.0 - mu * mu, 0.0)) * mix(1.5, 0.75, mo);
  vec3 bmin = max(lo, mu - sg), bmax = min(up, mu + sg);
  vec3 hy = toY(h.rgb), cc = 0.5 * (bmax + bmin), e = 0.5 * (bmax - bmin) + 1e-4, v = hy - cc, av = abs(v / e);
  float m = max(av.x, max(av.y, av.z));
  vec3 hc = m > 1.0 ? cc + v / m : hy;
  // fewer frames kept in motion, and the further off the history was, the less of it
  W = min(W, mix(uWMax, uWMove, mo));
  W *= 1.0 / (1.0 + 4.0 * max(m - 1.25, 0.0));
  // this frame: with a little history the broad (smooth) filter, with more the narrow one (sharp), weighted by how
  // near its samples are
  float k = smoothstep(0.5, 4.0, W), wc = mix(1.0, wn, k);
  vec3 cur = mix(sb / wb, sn / max(wn, 1e-4), k);
  vec3 o = (hc * W + cur * wc) / (W + wc);
  gl_FragColor = vec4(fromY(o), min(W + wc, uWMax));
}`;

export class TaaPass extends Pass {
  on = false;
  // the internal resolution's share of the screen's (post.ts sizes the targets before this pass by it)
  scale = 1;
  private readonly hist = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
  private k = 0;
  private frame = 0;
  private reset = true;
  private readonly mat: THREE.ShaderMaterial;
  private readonly P = new THREE.Matrix4();
  private readonly Pi = new THREE.Matrix4();
  private readonly prevVP = new THREE.Matrix4();
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQ = new THREE.Quaternion();
  private readonly T = new THREE.Matrix4();
  private lowW = 1;
  private lowH = 1;

  constructor() {
    super('TaaPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.mat = new THREE.ShaderMaterial({
      name: 'TAA', vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        tCur: { value: null }, tDepth: { value: null }, tHist: { value: null }, uLow: { value: new THREE.Vector2() }, uFull: { value: new THREE.Vector2() },
        uJit: { value: new THREE.Vector2() }, uInvVPj: { value: new THREE.Matrix4() }, uCurVP: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
        uReset: { value: 1 }, uWMax: { value: 12 }, uWMove: { value: 1.6 },
      },
    });
    this.fullscreenMaterial = this.mat;
  }

  // the resolved frame (the history just written): what the last pass reads
  get output() { return this.hist[this.k]; }

  setDepthTexture(t: THREE.Texture) { this.mat.uniforms.tDepth.value = t; }

  setSize(w: number, h: number) {
    for (const t of this.hist) t.setSize(w, h);
    this.mat.uniforms.uFull.value.set(w, h);
    this.reset = true;
  }

  // the size the scene is drawn at (the composer's buffers)
  setLow(w: number, h: number) { this.lowW = w; this.lowH = h; this.reset = true; }

  restart() { this.reset = true; }

  // before the composer's frame: the camera's projection shifted by this frame's sub-pixel, and the matrices to
  // reproject with (relative to the camera, for float precision)
  begin(camera: THREE.PerspectiveCamera) {
    camera.updateMatrixWorld();
    const u = this.mat.uniforms, pos = camera.position, q = camera.quaternion;
    if (pos.distanceTo(this.prevPos) > 30 || q.angleTo(this.prevQ) > 0.52) this.reset = true;
    const j = JITTER[this.frame++ % N];
    u.uJit.value.copy(j);
    u.uLow.value.set(this.lowW, this.lowH);
    this.P.copy(camera.projectionMatrix);
    this.Pi.copy(camera.projectionMatrixInverse);
    this.T.makeTranslation(camera.matrixWorld.elements[12], camera.matrixWorld.elements[13], camera.matrixWorld.elements[14]);
    // view-projection of camera-relative positions: unjittered now, and last frame's
    u.uCurVP.value.multiplyMatrices(this.P, camera.matrixWorldInverse).multiply(this.T);
    u.uPrevVP.value.multiplyMatrices(this.prevVP, this.T);
    this.prevVP.multiplyMatrices(this.P, camera.matrixWorldInverse);
    this.prevPos.copy(pos);
    this.prevQ.copy(q);
    // the content moves by +j low pixels: ndc + 2 j / size, which is -that on elements 8, 9 (they multiply view z = -w)
    const e = camera.projectionMatrix.elements;
    e[8] -= 2 * j.x / this.lowW;
    e[9] -= 2 * j.y / this.lowH;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    u.uInvVPj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.T).invert();
  }

  // after it: the camera as it was
  end(camera: THREE.PerspectiveCamera) {
    camera.projectionMatrix.copy(this.P);
    camera.projectionMatrixInverse.copy(this.Pi);
  }

  render(renderer: THREE.WebGLRenderer, input: THREE.WebGLRenderTarget) {
    const u = this.mat.uniforms;
    u.uReset.value = this.reset ? 1 : 0;
    this.reset = false;
    u.tCur.value = input.texture;
    u.tHist.value = this.hist[this.k].texture;
    this.k ^= 1;
    renderer.setRenderTarget(this.hist[this.k]);
    renderer.render(this.scene, this.camera);
  }
}

// A light sharpening of the resolved frame, in the last pass (post.ts), only with the TAA (else skipped: compiled out):
// contrast-adaptive (after AMD's CAS) over the 4 neighbours, in a tone-mapped space, so an edge already crisp, or a
// bright light, is not over-sharpened.
const SHARPEN = `uniform float amount;
vec3 tm(vec3 c) { return c / (1.0 + c); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = tm(max(inputColor.rgb, 0.0));
  vec3 n = tm(max(textureLod(inputBuffer, uv + vec2(0.0, texelSize.y), 0.0).rgb, 0.0)), s = tm(max(textureLod(inputBuffer, uv - vec2(0.0, texelSize.y), 0.0).rgb, 0.0));
  vec3 e = tm(max(textureLod(inputBuffer, uv + vec2(texelSize.x, 0.0), 0.0).rgb, 0.0)), w = tm(max(textureLod(inputBuffer, uv - vec2(texelSize.x, 0.0), 0.0).rgb, 0.0));
  vec3 mn = min(c, min(min(n, s), min(e, w))), mx = max(c, max(max(n, s), max(e, w)));
  vec3 k = -sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0)) * amount;
  vec3 o = clamp((c + (n + s + e + w) * k) / (1.0 + 4.0 * k), 0.0, 0.999);
  outputColor = vec4(o / (1.0 - o), 1.0);
}`;

export class Sharpen extends Effect {
  // 0.125 (CAS's least) .. 0.2 (its most)
  constructor(amount = 0.15) { super('Sharpen', SHARPEN, { uniforms: new Map([['amount', new THREE.Uniform(amount)]]) }); }
}
