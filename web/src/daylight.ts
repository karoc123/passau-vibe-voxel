import * as THREE from 'three';
import { Clouds } from './clouds';
import { Sky } from './sky';
import { beam, moonAt, sunAt } from './sun';
import { clamp, lerp, smooth } from './util';
import type { VoxelUniforms } from './voxelMaterial';
import { visibility, WEATHERS, type Weather } from './weather';

// The city's shadow map is drawn only when the city or the light changes; what moves (traffic, people) has its own map
// from a twin of the sun, of no intensity, redrawn every frame. The sun's light is dimmed by both.
const SHADOW = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
if (!THREE.ShaderChunk.lights_fragment_begin.includes(SHADOW)) throw new Error('three: lights_fragment_begin changed');
// (NO_MOVING_SHADOW: the city's far tiles, voxelMaterial.ts, look up the sun's map alone)
THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(SHADOW, `
  #if UNROLLED_LOOP_INDEX == 0 && NUM_DIR_LIGHT_SHADOWS > 1 && defined(NO_MOVING_SHADOW)
  ${SHADOW}
  #elif UNROLLED_LOOP_INDEX == 0 && NUM_DIR_LIGHT_SHADOWS > 1
  ${SHADOW.replace(') : 1.0;', ') * getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] ) : 1.0;')}
  #elif UNROLLED_LOOP_INDEX != 1
  ${SHADOW}
  #endif`);

// The twin (index 1: lights casting shadows come first, the sun was added first) gives no light: its iteration of the
// fragment shader's directional-light loop is left out altogether, not just its shadow lookup
{
  const c = THREE.ShaderChunk.lights_fragment_begin, from = c.indexOf('directionalLight = directionalLights[ i ];');
  const re = c.indexOf('RE_Direct(', from), end = c.indexOf(';', re) + 1;
  if (from < 0 || re < 0 || c.indexOf('directionalLight = directionalLights[ i ];', from + 1) >= 0) throw new Error('three: lights_fragment_begin changed');
  THREE.ShaderChunk.lights_fragment_begin = `${c.slice(0, from)}#if UNROLLED_LOOP_INDEX != 1 || NUM_DIR_LIGHTS != 2\n\t\t${c.slice(from, end)}\n\t\t#endif${c.slice(end)}`;
}

// The view distance (settings.ts dist): a second fog, by the distance from the camera mostly along the ground, full at
// the distance itself, where the city's tiles stop (city.ts). Along the ground: from high up the city below stays in
// view (a vertical metre counts CUT_UP of a horizontal one; never less than the distance along the ground, so where a
// tile is cut the fog is full). Each fogged material's vertex shader takes the greater of the two fogs as its fog
// depth, in the weather fog's terms (the same smoothstep in the fragment shader: no new varying). The uniform is one
// object shared by every material (a plain object: three's uniform cloning keeps it by reference).
// fogCut: x, y the distance fog's start and end (y 0: none), z, w the weather fog's (scene.fog near, far).
export const FOG_CUT = { x: 0, y: 0, z: 2500, w: 7000 };
const CUT_UP = 0.35, CUT_START = 0.45;
// the distance fog's share along its ramp, in the fog vertex shader (farground.ts takes it further)
export const CUT_T = 'clamp( ( fogM - fogCut.x ) / ( fogCut.y - fogCut.x ), 0.0, 1.0 )';
// the distance fog at a view-space position, given the view matrix (lamps.ts: their glow, drawn without fog, fades with
// the city; post.ts: the AO and the reflections on what the fog hides)
export const cutFogGlsl = (view: string) => `
  uniform vec4 fogCut;
  float cutFog(vec3 mv) {
    if (fogCut.y <= 0.0) return 0.0;
    float up = dot(mv, ${view}[1].xyz);
    return smoothstep(fogCut.x, fogCut.y, sqrt(max(dot(mv, mv) - ${(1 - CUT_UP * CUT_UP).toFixed(4)} * up * up, 0.0)));
  }`;
for (const lib of Object.values(THREE.ShaderLib) as { uniforms: Record<string, THREE.IUniform> }[]) if (lib.uniforms.fogColor) lib.uniforms.fogCut = { value: FOG_CUT };
THREE.ShaderChunk.fog_pars_vertex = THREE.ShaderChunk.fog_pars_vertex.replace('varying float vFogDepth;', `varying float vFogDepth;\nuniform vec4 fogCut;`);
if (!THREE.ShaderChunk.fog_vertex.includes('vFogDepth = - mvPosition.z;')) throw new Error('three: fog_vertex changed');
THREE.ShaderChunk.fog_vertex = THREE.ShaderChunk.fog_vertex.replace('vFogDepth = - mvPosition.z;', `vFogDepth = - mvPosition.z;
  if ( fogCut.y > 0.0 ) {
    float fogUp = dot( mvPosition.xyz, viewMatrix[ 1 ].xyz );
    float fogM = sqrt( max( dot( mvPosition.xyz, mvPosition.xyz ) - ${(1 - CUT_UP * CUT_UP).toFixed(4)} * fogUp * fogUp, 0.0 ) );
    vFogDepth = max( vFogDepth, mix( fogCut.z, fogCut.w, ${CUT_T} ) );
  }`);

// the city's shadow map is drawn in PARTS x PARTS parts, one a frame. Iris Xe, a time-of-day sweep from Oberhaus, GPU
// ms/frame p50/p95: still 28.5/30; whole map each frame 56/59; 2 x 2 37/43; 3 x 3 34/37; 4 x 4 32/36 (but 16 frames a map)
const PARTS = 3;
// What changes among the city's casters (a tile in or out, a distance level for another) is drawn again into the map in
// use, over the cells (CELLS x CELLS of it) under the change: at most PATCH x PATCH cells a frame
const CELLS = 16, PATCH = 4;
// The sun is followed once the tip of the longest shadow (the map's top over the ground) has moved by more than
// SUN_TEXELS of the map's texels, or a sixth of the shadows' blur (the overcast's soft shadows: up to 22 texels)
const SUN_TEXELS = 0.5;
// the map's square is fitted again once the view rests (REST_MS without wanting another square)
const REST_MS = 400;
// What moves (traffic, people, boats) is simulated within 900 m of a centre that trails the focus by up to 120 m
// (sim/life.ts): its map covers no more than that, at no more than 2048² (at the overview finer than the city's).
const TWIN_R = 1050, TWIN_MAX = 2048;
// the fastest of them (m/s: a car at 50 km/h, a train), and its map drawn at least every TWIN_EVERY-th frame
const MOVER_V = 20, TWIN_EVERY = 4;
// something visible under o casts a shadow (an instanced mesh with instances)
function casts(o: THREE.Object3D): boolean {
  if (!o.visible) return false;
  const m = o as THREE.InstancedMesh;
  if (m.isMesh && m.castShadow && (!m.isInstancedMesh || m.count > 0)) return true;
  return o.children.some(casts);
}

// a shadow map as three makes it for PCF, but with one 8-bit channel of colour, not four: the colour is never read,
// and at 4096² RGBA it was 64 MB of the map's 128
function shadowTarget(size: number) {
  const t = new THREE.WebGLRenderTarget(size, size, { format: THREE.RedFormat });
  const d = t.depthTexture = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
  d.format = THREE.DepthFormat;
  d.compareFunction = THREE.LessEqualCompare;
  d.minFilter = d.magFilter = THREE.LinearFilter;
  return t;
}

export class Daylight {
  hour = 0;
  exposure = 1.15;
  day = 237;
  weather: Weather = WEATHERS.clear;
  night = 0;
  readonly sky = new Sky();
  readonly clouds = new Clouds();
  uniforms: VoxelUniforms | null = null;
  bloom: { intensity: number; luminanceMaterial: { threshold: number; smoothing: number } } | null = null;
  grade: { night: number } | null = null;
  redraws = 0;
  ao: { intensity: number; aoRadius: number } | null = null;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly twin = new THREE.DirectionalLight(0xffffff, 0);
  private readonly gate = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  private still: THREE.Object3D | null = null;
  private moving: () => THREE.Object3D | null = () => null;
  private shown: [boolean, boolean] | null = null;
  private readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b5a48, 0.6);
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly lightDir = new THREE.Vector3(0, 1, 0);
  private env: THREE.WebGLRenderTarget | null = null;
  private envKey = '';
  // the city's next shadow map, drawn a part a frame (see drawPart); not in the scene, three draws it when asked
  private readonly next = new THREE.DirectionalLight(0xffffff, 0);
  private readonly partView = new THREE.Vector4(0, 0, 1, 1);
  private job: { part: number; frame: Pick<THREE.OrthographicCamera, 'left' | 'right' | 'top' | 'bottom' | 'near' | 'far'>; pos: THREE.Vector3; target: THREE.Vector3; c: THREE.Vector3; R: number; top: number } | null = null;
  private whole = true;
  private dirty = false;
  // the square and the light of the map in use, or of the one being drawn
  private readonly aimC = new THREE.Vector3();
  private aimR = 0;
  private readonly aimL = new THREE.Vector3();
  // the focus's drift a frame (smoothed): a new square is aimed ahead of it
  private readonly drift = new THREE.Vector3();
  private readonly lastF = new THREE.Vector3(NaN, 0, 0);
  private idealKey = '';
  private idealAt = 0;
  // patches: the sun's map's cells to draw again (see patch), drawn by a light of its own into the sun's map
  private readonly fix = new THREE.DirectionalLight(0xffffff, 0);
  private readonly fixView = new THREE.Vector4(0, 0, 1, 1);
  private readonly cells = new Uint8Array(CELLS * CELLS);
  private cellsDirty = false;
  // changes while the next map is drawn: patched into it once it is the sun's (its parts drawn before them lack them)
  private later: THREE.Box3[] = [];
  // the sun's map's light and square, counted (each whole map, each swap): the casters' rects are kept for one
  private mapGen = 0;
  private rectGen = -1;
  private rects = new WeakMap<THREE.BufferGeometry, number[]>();
  patches = 0;
  private readonly frontC = new THREE.Vector3();
  private frontR = 0;
  private frontTop = 0;
  parts = 0;
  private partDue = false;
  private focus = new THREE.Vector3();
  private twinLive = true;
  private twinAge = 0;
  private twinT = 0;
  private readonly twinFrom = new THREE.Vector3();
  private northTheta = 0;
  // the view distance (settings.ts dist; 0: the whole map)
  private cut = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, shadowSize = 8192) {
    const sun = this.sun, size = Math.min(shadowSize, renderer.capabilities.maxTextureSize);
    sun.castShadow = true;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0004;
    sun.shadow.radius = 3;
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
    const twin = this.twin;
    twin.castShadow = true;
    twin.shadow.mapSize.set(Math.min(size, TWIN_MAX), Math.min(size, TWIN_MAX));
    const next = this.next;
    next.castShadow = true;
    next.shadow.mapSize.set(size, size);
    next.shadow.autoUpdate = false;
    next.shadow.getViewport = () => this.partView;
    const fix = this.fix;
    fix.castShadow = true;
    fix.shadow.autoUpdate = false;
    fix.shadow.getViewport = () => this.fixView;
    scene.add(sun, sun.target, twin, twin.target, this.hemi, this.sky.mesh);
    this.watchShadows(scene);
    // a part of the next map is drawn in the frame's own shadow pass, before the sun's and the twin's maps: three's
    // render state (which the depth pass needs) only exists inside a render
    // Three's depth pass draws what the *view's* camera layers show, not the shadow camera's: a tile the occlusion
    // culling (city.ts) moved to its own layer would cast no shadow. The view's camera sees all layers for it.
    const sm = renderer.shadowMap, render = sm.render.bind(sm);
    sm.render = (lights, s, camera) => {
      const mask = camera.layers.mask;
      camera.layers.enableAll();
      try {
        if (this.partDue && this.job && s === scene) { this.partDue = false; this.drawPart(render, camera); }
        else if (this.cellsDirty && !this.job && s === scene && this.sun.shadow.map && !this.sun.shadow.needsUpdate) this.drawPatch(render, camera);
        render(lights, s, camera);
      } finally { camera.layers.mask = mask; }
    };
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  // the first object the shadow pass meets: it shows each map only its own casters, and the main pass shows them all again
  private watchShadows(scene: THREE.Scene) {
    const g = this.gate;
    g.castShadow = true;
    g.frustumCulled = false;
    scene.add(g);
    scene.children.unshift(scene.children.pop()!);
    g.onBeforeShadow = (_r, _o, _c, shadowCamera) => {
      const still = this.still, moving = this.moving();
      if (!still) return;
      this.shown ??= [still.visible, moving?.visible ?? false];
      const city = shadowCamera === this.sun.shadow.camera || shadowCamera === this.next.shadow.camera || shadowCamera === this.fix.shadow.camera;
      if (shadowCamera === this.sun.shadow.camera) { this.redraws++; this.mapGen++; this.cells.fill(0); this.cellsDirty = false; }
      still.visible = city && this.shown[0];
      if (moving) moving.visible = !city && this.shown[1];
    };
    g.onBeforeRender = () => this.showAll();
  }

  private showAll() {
    if (!this.shown || !this.still) return;
    this.still.visible = this.shown[0];
    const moving = this.moving();
    if (moving) moving.visible = this.shown[1];
    this.shown = null;
  }

  casters(still: THREE.Object3D, moving: () => THREE.Object3D | null) {
    this.still = still;
    this.moving = moving;
  }

  // the city changed (what its tiles show: the buildings shown, the season, the clay's blocks): drawn again a part a
  // frame; whole: at once, in this frame
  redrawShadow(whole = false) { if (whole) this.whole = true; else this.dirty = true; }

  // Casters changed within these boxes (world space: tiles in or out, one distance level for another): what the
  // sun's map shows of them is drawn again, cell by cell (drawPatch), in this frame and the next, not the whole map.
  // A caster writes only the texels under its own box in the light's view, so its cells are all that change.
  changed(boxes: THREE.Box3[]) {
    if (!boxes.length) return;
    if (this.job) this.later.push(...boxes.map((b) => b.clone()));
    this.mark(boxes);
  }

  private mark(boxes: THREE.Box3[]) {
    const a = this.sun.shadow;
    if (!a.map || !this.sun.castShadow) return;
    a.updateMatrices(this.sun);
    const m = a.matrix, p = new THREE.Vector3();
    for (const b of boxes) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      // (a metre over the box's top: the shader lifts sloped roofs by up to that; a texel's slack all round)
      for (let k = 0; k < 8; k++) {
        p.set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y + 1 : b.min.y, k & 4 ? b.max.z : b.min.z).applyMatrix4(m);
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      const e = 1 / a.mapSize.x, at = (v: number) => clamp(Math.floor(v * CELLS), 0, CELLS - 1);
      if (x1 + e < 0 || x0 - e > 1 || y1 + e < 0 || y0 - e > 1) continue;
      for (let j = at(y0 - e); j <= at(y1 + e); j++) for (let i = at(x0 - e); i <= at(x1 + e); i++) this.cells[j * CELLS + i] = 1;
      this.cellsDirty = true;
    }
  }

  // each shown tile's rect in the sun's map (uv) and its triangles: [u0, u1, v0, v1, triangles] a tile, kept while the
  // map's light and square stay (rectGen)
  private casterRects() {
    const a = this.sun.shadow, out: number[] = [], p = new THREE.Vector3();
    if (this.rectGen !== this.mapGen) { this.rectGen = this.mapGen; this.rects = new WeakMap(); }
    a.updateMatrices(this.sun);
    for (const o of this.still?.children ?? []) {
      const m = o as THREE.Mesh, g = m.geometry, b = g?.boundingBox;
      if (!m.visible || !m.castShadow || !b) continue;
      let r = this.rects.get(g);
      if (!r) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let k = 0; k < 8; k++) {
          p.set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y + 1 : b.min.y, k & 4 ? b.max.z : b.min.z).applyMatrix4(a.matrix);
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
        const f = g.userData.faces as Uint32Array | undefined;
        r = [x0, x1, y0, y1, f ? f[f.length - 1] * 2 : (g.index?.count ?? 0) / 3];
        this.rects.set(g, r);
      }
      out.push(...r);
    }
    return out;
  }

  // The dirty cells, at most PATCH x PATCH of them a frame (the first dirty one and those dirty in the block from it),
  // drawn into the sun's own map: its light, narrowed to them, into its viewport, scissored (three clears the map
  // first: only there). In the frame's own shadow pass, before the main pass: a change never shows half drawn.
  private drawPatch(render: THREE.WebGLShadowMap['render'], viewer: THREE.Camera) {
    const c = this.cells, first = c.indexOf(1);
    if (first < 0) { this.cellsDirty = false; return; }
    const j0 = Math.floor(first / CELLS), i0 = first % CELLS;
    // the block of at most k x k cells from the first dirty one, and the casters' triangles under it
    const block = (k: number) => {
      let i1 = i0, j1 = j0, ia = i0;
      for (let j = j0; j < Math.min(CELLS, j0 + k); j++) for (let i = Math.max(0, i0 - k + 1); i < Math.min(CELLS, i0 + k); i++) {
        if (!c[j * CELLS + i] || Math.max(i1, i) - Math.min(ia, i) >= k) continue;
        ia = Math.min(ia, i); i1 = Math.max(i1, i); j1 = Math.max(j1, j);
      }
      return [ia, i1, j1] as const;
    };
    // A patch costs no more than a part of a whole redraw (the triangles under the map over PARTS²): a smaller block
    // where the casters under the larger one are more (a distance level's node, up to 512 m, is drawn whole in any
    // cell it touches)
    const rects = this.casterRects(), under = (u0: number, u1: number, v0: number, v1: number) => {
      let n = 0;
      for (let k = 0; k < rects.length; k += 5) if (rects[k] < u1 && rects[k + 1] > u0 && rects[k + 2] < v1 && rects[k + 3] > v0) n += rects[k + 4];
      return n;
    };
    const budget = under(0, 1, 0, 1) / (PARTS * PARTS);
    let ia = i0, i1 = i0, j1 = j0;
    for (const k of [PATCH, 2, 1]) {
      [ia, i1, j1] = block(k);
      if (k === 1 || under(ia / CELLS, (i1 + 1) / CELLS, j0 / CELLS, (j1 + 1) / CELLS) <= budget) break;
    }
    for (let j = j0; j <= j1; j++) for (let i = ia; i <= i1; i++) c[j * CELLS + i] = 0;
    this.cellsDirty = c.indexOf(1) >= 0;
    const sun = this.sun, a = sun.shadow, fix = this.fix, s = fix.shadow, cam = s.camera, f = a.camera, S = a.mapSize.x;
    const at = (k: number) => Math.floor(k * S / CELLS) / S, x0 = at(ia), x1 = at(i1 + 1), y0 = at(j0), y1 = at(j1 + 1);
    fix.position.copy(sun.position); fix.target.position.copy(sun.target.position);
    fix.updateMatrixWorld(); fix.target.updateMatrixWorld();
    if (s.mapSize.x !== S) s.mapSize.set(S, S);
    s.map = a.map;
    const w = f.right - f.left, h = f.top - f.bottom;
    Object.assign(cam, { left: f.left + x0 * w, right: f.left + x1 * w, bottom: f.bottom + y0 * h, top: f.bottom + y1 * h, near: f.near, far: f.far });
    cam.updateProjectionMatrix();
    this.fixView.set(x0, y0, x1 - x0, y1 - y0);
    const map = a.map!;
    map.scissor.set(Math.round(x0 * S), Math.round(y0 * S), Math.round((x1 - x0) * S), Math.round((y1 - y0) * S));
    map.scissorTest = true;
    s.needsUpdate = true;
    try { render([fix], this.scene, viewer); } finally { map.scissorTest = false; s.map = null; }
    this.showAll();
    this.patches++;
  }

  // the graphics panel (settings.ts): the size of both shadow maps, or none (0). Without shadow-casting lights every
  // material is compiled again without the shadow lookups (three's light state changes), so off saves their cost too.
  setShadowSize(n: number, max: number) {
    const on = n > 0, size = Math.min(n, max);
    for (const l of [this.sun, this.twin, this.next]) {
      const m = l === this.twin ? Math.min(size, TWIN_MAX) : size;
      l.castShadow = on;
      if (on && l.shadow.mapSize.x !== m) { l.shadow.mapSize.set(m, m); l.shadow.map?.dispose(); l.shadow.map = null; }
    }
    this.twinLive = true;
    this.job = null;
    this.whole = true;
  }

  // a restored WebGL context comes back with empty render targets: the sky's light and the city's shadow drawn again
  restore() {
    this.envKey = '';
    this.apply(this.hour);
    this.job = null;
    this.redrawShadow(true);
  }

  // the grid is turned (scripts/aoi.py): compass bearings turn by theta in the scene
  set theta(t: number) { this.northTheta = t; this.apply(this.hour); }

  private skyDir(az: number, el: number) {
    const a = az + this.northTheta;
    return new THREE.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), -Math.cos(a) * Math.cos(el));
  }

  apply(hour: number) {
    this.hour = hour;
    const { el, az } = sunAt(this.day, hour), elDeg = el * 180 / Math.PI, w = this.weather, cloud = w.cloud;
    const night = this.night = 1 - smooth(-7, 1, elDeg), day = 1 - night;
    const deep = smooth(-9, -17, elDeg), golden = (1 - smooth(8, 34, elDeg)) * (1 - cloud);
    // by night the light is the moon's where it is up (no lower than 15°: its shadows stay short), fainter at a crescent;
    // without it, a dim skylight from high in the SE
    const moon = moonAt(this.day, hour), moonDeg = moon.el * 180 / Math.PI, moonUp = smooth(-1, 6, moonDeg), moonK = moonUp * moon.lit;
    const nightDir = new THREE.Vector3(0.45, 0.75, 0.5).normalize().lerp(this.skyDir(moon.az, Math.max(moon.el, 15 * Math.PI / 180)), moonUp).normalize();
    const dir = elDeg > -2 ? this.skyDir(az, Math.max(el, 2.5 * Math.PI / 180)) : nightDir;
    // (broken cloud, ~0.6, keeps the sun's direction and its crisp shadows, the clouds' own drift over them; the overcast,
    // towards 1, softens them into a glow from above)
    const oc = smooth(0.55, 1, cloud);
    const sun = this.sun, hemi = this.hemi, light = elDeg > -2 ? dir.clone().lerp(new THREE.Vector3(0, 1, 0), 0.8 * oc).normalize() : dir;
    const T = beam(elDeg), lumT = T[0] * 0.2126 + T[1] * 0.7152 + T[2] * 0.0722, sinEl = Math.max(0, Math.sin(el));
    const sky = Math.max(0.22 * sinEl * (1 - lumT), 0.025 * smooth(-7, 2, elDeg)), sunH = lumT * sinEl;
    const adapt = clamp((0.62 / (sunH + sky)) ** 0.72, 1, 8);
    sun.color.setRGB(T[0] / T[0], T[1] / T[0], T[2] / T[0]).lerp(new THREE.Color(0xa8b4cc).lerp(new THREE.Color(0x9cb0d8), moonK), night).lerp(new THREE.Color(0xd8dde6), cloud * day);
    sun.intensity = lerp(5.9 * lumT * adapt, 0.85 * (0.75 + 0.4 * moonK), night) * (elDeg > -2 ? smooth(-2, 1, elDeg) * day + night : night) * lerp(1, 0.4 * sinEl, Math.max(oc, 0.35 * cloud));
    sun.shadow.radius = lerp(3, 22, oc);
    sun.shadow.normalBias = clamp(0.3 / Math.max(light.y, 0.05), 0.5, 3);
    const skyRel = sky / 0.075 * adapt;
    hemi.color.setRGB(0.63, 0.77, 1).lerp(new THREE.Color(1, 0.82, 0.66), golden * 0.45).lerp(new THREE.Color(0x46557a).lerp(new THREE.Color(0x3c4a6c), deep), night);
    hemi.groundColor.copy(sun.color).multiplyScalar(0.4).lerp(new THREE.Color(0x4a3c2c), night);
    hemi.intensity = lerp(0.14 * skyRel, lerp(1.15, 1.0, deep), night);
    if (cloud > 0) {
      hemi.color.lerp(new THREE.Color(0xd4d8de).lerp(new THREE.Color(0x66666c), night), cloud);
      hemi.groundColor.lerp(new THREE.Color(0x6e6a66).lerp(new THREE.Color(0x2a2420), night), cloud);
      hemi.intensity = lerp(hemi.intensity, lerp(1.6 * smooth(-4, 6, elDeg) * (0.3 + 0.7 * sinEl) ** 0.4, 3.0 * (1 + 0.35 * w.cover), night), cloud);
    }
    this.sky.set({ elDeg, sunDir: dir, trueSun: this.skyDir(az, el), golden, night, deep, cloud,
      moonDir: this.skyDir(moon.az, moon.el), moon: night * smooth(-0.6, 1, moonDeg) * (1 - cloud), moonLit: moon.lit });
    this.lightDir.copy(light);
    this.clouds.setDay(this.day, this.northTheta);
    this.clouds.setLight(cloud, night, this.skyDir(az, el));
    if (this.uniforms) {
      this.uniforms.uNight.value = night;
      this.uniforms.uHorizon.value.copy(this.sky.horizon).convertSRGBToLinear();
      this.uniforms.uWet.value = w.rain;
      this.uniforms.uSnow.value = w.cover;
      this.uniforms.uDay.value = this.day;
    }
    // by night a lower threshold: the lit windows, the lamps' heads and the moon glow a little, not only the brightest
    if (this.bloom) {
      this.bloom.intensity = lerp(0.15, 0.9, night);
      Object.assign(this.bloom.luminanceMaterial, { threshold: lerp(0.92, 0.8, night), smoothing: lerp(0.15, 0.25, night) });
    }
    if (this.grade) this.grade.night = night;
    if (this.ao) Object.assign(this.ao, { intensity: lerp(2.2, 3.4, cloud * day), aoRadius: lerp(6, 9, cloud * day) });
    this.scene.fog = new THREE.Fog(this.sky.horizon.clone(), 2500, 7000);
    const key = `${(elDeg / 0.6).toFixed(0)},${cloud.toFixed(1)}`;
    if (key !== this.envKey) {
      this.env?.dispose();
      this.env = this.pmrem.fromScene(this.sky.envScene(), 0, 1, 10000);
      this.scene.environment = this.env.texture;
      this.envKey = key;
    }
    this.scene.environmentIntensity = lerp(lerp(0.38 * Math.min(skyRel, 2), 0.9 * smooth(-4, 6, elDeg), cloud), lerp(0.6, 0.5, deep), night);
    const e = lerp(this.exposure, 1, night);
    sun.intensity *= e; hemi.intensity *= e; this.scene.environmentIntensity *= e;
  }

  // The view distance: the fog is full there (from CUT_START of it on), and the city's shadow map covers no more
  setCut(d: number) {
    if (d === this.cut) return;
    this.cut = d;
    FOG_CUT.x = d * CUT_START; FOG_CUT.y = d;
  }

  // height: the camera above the ground. Low views look along the city, so the haze closes in and softens the far
  // hills and the map's edge into the sky; the old town across the river stays clear (from Oberhaus the Dom is ~500 m
  // off, the far side of the old town ~900 m). From the overview up, the whole map stays as clear as before.
  // (after HansF/voxelgent, daylight.ts). Nothing is culled past fog.far: in clear weather it lies beyond the map from
  // anywhere in it; only low views in snow would gain (~1/3 of the triangles), and a camera.far there would cut the sky.
  setFogFrom(dist: number, height = 1000) {
    const fog = this.scene.fog as THREE.Fog | null;
    if (!fog) return;
    // Snow and rain bring it in by the visibility squared from above, but low only by the visibility itself, and not
    // nearer than ~250 m in snow, ~400 m in rain: at k² the street ended in white ~90 m off. Clear weather is k = 1.
    const w = this.weather, k = visibility(w), low = 1 - smooth(60, 450, height), least = low * (400 * w.rain + 250 * w.snow);
    fog.near = Math.max(lerp(2500, 700, low) * k ** (2 - low), least, dist * (0.6 + 0.45 * k));
    fog.far = fog.near + lerp(4500, 2200, low) * k;
    FOG_CUT.z = fog.near; FOG_CUT.w = fog.far;
  }

  fitShadow(focus: THREE.Vector3, camera: THREE.Camera, viewDist: number, map: THREE.Box3) {
    if (map.isEmpty()) return;
    const sun = this.sun, f = focus;
    const dist = viewDist + Math.max(0, camera.position.y - (map.min.y + 80));
    // Refit in steps (a tenth in size), not every frame the view moves: each refit redraws the city (within the view
    // distance: what lies beyond is neither drawn nor seen through the fog). The square (half-size Rq) has a margin of
    // 0.75 g all round (g = Rq / 16): a new one is aimed once the focus has left it, ahead of the focus's drift (half
    // a g that way), so a flight crosses ~1.25 g a map, not one; once the view needs a larger one (aimed a step larger
    // while it grows, so a zoom out redraws every other step); and a smaller one only once the view rests (REST_MS):
    // a zoom in redraws once, at its end. Or once the light has turned (tipShift) or the city changed.
    const top = Math.min(Math.max(map.max.x, map.max.z) * 0.75, this.cut || Infinity), R = clamp(dist * 1.15, Math.min(300, top), top);
    const ideal = Math.min(top, 1.1 ** Math.ceil(Math.log(R) / Math.log(1.1))), now = performance.now();
    if (Number.isFinite(this.lastF.x)) this.drift.lerp(new THREE.Vector3(f.x - this.lastF.x, 0, f.z - this.lastF.z), 0.25);
    this.lastF.set(f.x, 0, f.z);
    const ik = `${Math.round(f.x / (ideal / 16))},${Math.round(f.z / (ideal / 16))},${ideal.toFixed(1)}`;
    if (ik !== this.idealKey) { this.idealKey = ik; this.idealAt = now; }
    const rest = now - this.idealAt > REST_MS, hasMap = !!sun.shadow.map && this.aimR > 0;
    const grow = ideal > this.aimR * 1.0001, shrink = rest && ideal < this.aimR * 0.9999;
    const Rq = !hasMap || this.whole ? ideal : grow ? Math.min(top, ideal * (rest ? 1 : 1.1)) : shrink ? ideal : this.aimR;
    const g = Rq / 16, Rf = Rq + 0.75 * g, texel = (2 * Rf) / sun.shadow.mapSize.x;
    const moved = Math.max(Math.abs(f.x - this.aimC.x), Math.abs(f.z - this.aimC.z)) > 0.75 * (this.aimR / 16);
    const turned = this.tipShift(map.max.y - map.min.y, (2 * (this.aimR + 0.75 * this.aimR / 16)) / sun.shadow.mapSize.x) > Math.max(SUN_TEXELS, sun.shadow.radius / 6);
    const d = this.drift, dl = Math.max(Math.abs(d.x), Math.abs(d.z)), lead = dl > 0.002 * g ? (0.5 * g) / dl : 0, q = g / 8;
    const c = new THREE.Vector3(Math.round((f.x + d.x * lead) / q) * q, 0, Math.round((f.z + d.z * lead) / q) * q);
    if (!sun.castShadow) this.job = null;
    else {
      // drawn whole, at once: the first map, after a lost context or a new size, and a jump (the view gone more than
      // half the square's size from where the last map was aimed, or grown to twice it), where the old map would leave
      // the view unshadowed for the frames the next one takes
      const jump = Math.max(Math.abs(c.x - this.aimC.x), Math.abs(c.z - this.aimC.z)) > this.aimR / 2 || Rq > 2 * this.aimR;
      if (this.whole || !hasMap || jump) {
        this.whole = this.dirty = false; this.job = null; this.aim(c, Rq);
        this.fitLight(sun, c, Rf, texel, map);
        sun.shadow.map ??= shadowTarget(sun.shadow.mapSize.x);
        sun.shadow.needsUpdate = true;
        this.frontC.copy(c); this.frontR = Rf; this.frontTop = map.max.y;
        this.cells.fill(0); this.cellsDirty = false; this.later = [];
      } else if (!this.job && (grow || shrink || moved || turned || this.dirty)) {
        // the view moved, the light turned or the city changed: the next map is aimed and begun, the sun keeps the
        // last one until it is done. A newer aim waits for it: each map takes as many frames as it has parts.
        this.dirty = false; this.aim(c, Rq);
        const next = this.next, cam = next.shadow.camera;
        this.fitLight(next, c, Rf, texel, map);
        next.shadow.map ??= shadowTarget(next.shadow.mapSize.x);
        this.job = { part: 0, frame: { left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom, near: cam.near, far: cam.far },
          pos: next.position.clone(), target: next.target.position.clone(), c: c.clone(), R: Rf, top: map.max.y };
      }
      this.partDue = !!this.job;
    }
    this.focus = focus;
    this.fitTwin(focus);
  }

  private aim(c: THREE.Vector3, R: number) {
    this.aimC.copy(c); this.aimR = R; this.aimL.copy(this.lightDir);
  }

  // How far the tip of a shadow cast from h above the ground has moved since the light the map was aimed with, in the
  // map's texels (across the light: what the map sees of it)
  private tipShift(h: number, texel: number) {
    const L = this.lightDir, A = this.aimL;
    if (A.lengthSq() === 0) return Infinity;
    const d = new THREE.Vector3(L.x / L.y - A.x / A.y, 0, L.z / L.y - A.z / A.y).multiplyScalar(h);
    return d.addScaledVector(L, -L.dot(d)).length() / texel;
  }

  // The next city shadow map is drawn in PARTS x PARTS parts, one a frame: each part is the light's view of its piece
  // of the square, into its piece of the map (a viewport of whole texels, so the parts meet without a seam). A whole 4096²
  // map in one frame cost 8-16 ms on an Iris Xe: a hitch at each step of a time-of-day sweep or a flight. When the
  // last part is in, the two maps trade places, and the sun takes the new map's direction and square with it, so
  // light and shadow always agree. (Parts drawn into a map not in use: no half-drawn map is ever seen.)
  private drawPart(render: THREE.WebGLShadowMap['render'], viewer: THREE.Camera) {
    const job = this.job!, n = PARTS, i = job.part % n, j = Math.floor(job.part / n), f = job.frame, s = this.next.shadow, cam = s.camera;
    // the part's edges on whole texels of the map: k / n of the way across, rounded down
    const S = s.mapSize.x, at = (k: number) => Math.floor(k * S / n) / S, x0 = at(i), x1 = at(i + 1), y0 = at(j), y1 = at(j + 1);
    const w = f.right - f.left, h = f.top - f.bottom;
    Object.assign(cam, { left: f.left + x0 * w, right: f.left + x1 * w, bottom: f.bottom + y0 * h, top: f.bottom + y1 * h, near: f.near, far: f.far });
    cam.updateProjectionMatrix();
    this.partView.set(x0, y0, x1 - x0, y1 - y0);
    s.needsUpdate = true;
    const r = this.renderer, clear = r.clear;
    if (job.part > 0) r.clear = () => {}; // three clears the whole map before it draws: only before the first part
    try { render([this.next], this.scene, viewer); } finally { r.clear = clear; }
    this.showAll();
    this.parts++;
    if (++job.part < n * n) return;
    const sun = this.sun, a = sun.shadow;
    [a.map, s.map] = [s.map, a.map];
    sun.position.copy(job.pos); sun.target.position.copy(job.target);
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    Object.assign(a.camera, f);
    a.camera.updateProjectionMatrix();
    a.updateMatrices(sun);
    this.frontC.copy(job.c); this.frontR = job.R; this.frontTop = job.top;
    this.job = null;
    this.redraws++;
    this.mapGen++;
    // what changed while it was drawn is drawn again into it, as into any map in use
    this.cells.fill(0); this.cellsDirty = false;
    this.mark(this.later);
    this.later = [];
    this.fitTwin(this.focus); // the moving things' map, drawn next in this pass, turns with the sun
  }

  private fitLight(light: THREE.DirectionalLight, f: THREE.Vector3, R: number, texel: number, map: THREE.Box3) {
    const c = new THREE.Vector3(f.x, 0, f.z);
    light.target.position.copy(c);
    light.position.copy(c).addScaledVector(this.lightDir, 2500);
    light.updateMatrixWorld(); light.target.updateMatrixWorld();
    this.frame(light, f, R, texel, map.max.y);
  }

  // the light's camera: the square of half-size R around f, ground to the top, in light space, edges on whole texels
  private frame(light: THREE.DirectionalLight, f: THREE.Vector3, R: number, texel: number, top: number) {
    const inv = new THREE.Matrix4().lookAt(light.position, light.target.position, new THREE.Vector3(0, 1, 0)).invert(), pts = [];
    for (const x of [f.x - R, f.x + R]) for (const z of [f.z - R, f.z + R]) for (const y of [0, top]) pts.push(new THREE.Vector3(x, y, z).sub(light.position).applyMatrix4(inv));
    const b = new THREE.Box3().setFromPoints(pts), snap = (v: number) => Math.floor(v / texel) * texel, cam = light.shadow.camera;
    const left = snap(b.min.x), right = left + Math.ceil((b.max.x - b.min.x) / texel) * texel;
    const bottom = snap(b.min.y), up = bottom + Math.ceil((b.max.y - b.min.y) / texel) * texel;
    const near = Math.max(1, -b.max.z - 700), far = -b.min.z + 10; // towers outside the square still cast into it
    if (cam.left === left && cam.right === right && cam.bottom === bottom && cam.top === up && cam.near === near && cam.far === far) return;
    Object.assign(cam, { left, right, bottom, top: up, near, far });
    cam.updateProjectionMatrix();
  }

  // the moving things' map: the sun's direction, a square of up to TWIN_R around the focus (the city's map's own when
  // that is smaller)
  private fitTwin(focus: THREE.Vector3) {
    const sun = this.sun, twin = this.twin, a = sun.shadow, b = twin.shadow;
    twin.position.copy(sun.position); twin.target.position.copy(sun.target.position);
    twin.updateMatrixWorld(); twin.target.updateMatrixWorld();
    const R = Math.min(this.frontR, TWIN_R), f = R < this.frontR ? focus : this.frontC;
    if (R > 0) this.frame(twin, f, R, 2 * R / b.mapSize.x, this.frontTop);
    if (twin.castShadow) b.map ??= shadowTarget(b.mapSize.x);
    // the same blur on the ground as the city's shadow (radius in texels of each map)
    const blur = R > 0 ? (this.frontR / a.mapSize.x) / (R / b.mapSize.x) : 1;
    Object.assign(b, { bias: a.bias, normalBias: a.normalBias, radius: a.radius * blur, intensity: a.intensity });
    // The moving things' map is drawn while they are in the scene, shown and something of them casts, and once more
    // (empty) after. Not every frame where its shadows are soft enough not to show it: what moves (at most MOVER_V)
    // moves less between two of its draws than SUN_TEXELS of its texels or a sixth of its blur (the overcast's soft
    // shadows: every TWIN_EVERY-th frame); at once when the sun's map turned (the light with it).
    const moving = this.moving(), live = !!moving && moving.visible && moving.parent !== null && casts(moving);
    b.autoUpdate = false;
    const now = performance.now(), dt = clamp((now - this.twinT) / 1000, 0.004, 0.1), texel = 2 * R / b.mapSize.x;
    this.twinT = now;
    const every = clamp(Math.floor(Math.max(SUN_TEXELS, b.radius / 6) * texel / (MOVER_V * dt)), 1, TWIN_EVERY);
    const turned = !this.twinFrom.equals(twin.position);
    if ((live && (++this.twinAge >= every || turned)) || this.twinLive && !live) { b.needsUpdate = true; this.twinAge = 0; this.twinFrom.copy(twin.position); }
    this.twinLive = live;
  }
}
