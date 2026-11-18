import * as THREE from 'three';
import { Sky } from './sky';
import { beam, sunAt } from './sun';
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

// the city's shadow map is drawn in PARTS x PARTS parts, one a frame. Iris Xe, a time-of-day sweep from Oberhaus, GPU
// ms/frame p50/p95: still 28.5/30; whole map each frame 56/59; 2 x 2 37/43; 3 x 3 34/37; 4 x 4 32/36 (but 16 frames a map)
const PARTS = 3;
// What moves (traffic, people, boats) is simulated within 900 m of a centre that trails the focus by up to 120 m
// (sim/life.ts): its map covers no more than that, at no more than 2048² (at the overview finer than the city's).
const TWIN_R = 1050, TWIN_MAX = 2048;

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
  uniforms: VoxelUniforms | null = null;
  bloom: { intensity: number } | null = null;
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
  private shadowKey = '';
  // the city's next shadow map, drawn a part a frame (see drawPart); not in the scene, three draws it when asked
  private readonly next = new THREE.DirectionalLight(0xffffff, 0);
  private readonly partView = new THREE.Vector4(0, 0, 1, 1);
  private job: { part: number; frame: Pick<THREE.OrthographicCamera, 'left' | 'right' | 'top' | 'bottom' | 'near' | 'far'>; pos: THREE.Vector3; target: THREE.Vector3; c: THREE.Vector3; R: number; top: number } | null = null;
  private whole = true;
  private dirty = false;
  private readonly aimC = new THREE.Vector3();
  private aimR = 0;
  private readonly frontC = new THREE.Vector3();
  private frontR = 0;
  private frontTop = 0;
  parts = 0;
  private partDue = false;
  private focus = new THREE.Vector3();
  private twinLive = true;
  private northTheta = 0;

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
      const city = shadowCamera === this.sun.shadow.camera || shadowCamera === this.next.shadow.camera;
      if (shadowCamera === this.sun.shadow.camera) this.redraws++;
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

  // the city changed (tiles in or out, a level, the season): drawn again a part a frame; whole: at once, in this frame
  redrawShadow(whole = false) { if (whole) this.whole = true; else this.dirty = true; }

  // the graphics panel (settings.ts): the size of both shadow maps, or none (0). Without shadow-casting lights every
  // material is compiled again without the shadow lookups (three's light state changes), so off saves their cost too.
  setShadowSize(n: number, max: number) {
    const on = n > 0, size = Math.min(n, max);
    for (const l of [this.sun, this.twin, this.next]) {
      const m = l === this.twin ? Math.min(size, TWIN_MAX) : size;
      l.castShadow = on;
      if (on && l.shadow.mapSize.x !== m) { l.shadow.mapSize.set(m, m); l.shadow.map?.dispose(); l.shadow.map = null; }
    }
    this.shadowKey = '';
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
    const dir = elDeg > -2 ? this.skyDir(az, Math.max(el, 2.5 * Math.PI / 180)) : new THREE.Vector3(0.45, 0.75, 0.5).normalize(); // the moon, high in the SE
    const sun = this.sun, hemi = this.hemi, light = elDeg > -2 ? dir.clone().lerp(new THREE.Vector3(0, 1, 0), 0.8 * cloud).normalize() : dir;
    const T = beam(elDeg), lumT = T[0] * 0.2126 + T[1] * 0.7152 + T[2] * 0.0722, sinEl = Math.max(0, Math.sin(el));
    const sky = Math.max(0.22 * sinEl * (1 - lumT), 0.025 * smooth(-7, 2, elDeg)), sunH = lumT * sinEl;
    const adapt = clamp((0.62 / (sunH + sky)) ** 0.72, 1, 8);
    sun.color.setRGB(T[0] / T[0], T[1] / T[0], T[2] / T[0]).lerp(new THREE.Color(0xa8b4cc), night).lerp(new THREE.Color(0xd8dde6), cloud * day);
    sun.intensity = lerp(5.9 * lumT * adapt, 0.85, night) * (elDeg > -2 ? smooth(-2, 1, elDeg) * day + night : night) * lerp(1, 0.4 * sinEl, cloud);
    sun.shadow.radius = lerp(3, 22, cloud);
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
    this.sky.set({ elDeg, sunDir: dir, trueSun: this.skyDir(az, el), golden, night, deep, cloud });
    this.lightDir.copy(light);
    this.shadowKey = '';
    if (this.uniforms) {
      this.uniforms.uNight.value = night;
      this.uniforms.uHorizon.value.copy(this.sky.horizon).convertSRGBToLinear();
      this.uniforms.uWet.value = w.rain;
      this.uniforms.uSnow.value = w.cover;
      this.uniforms.uDay.value = this.day;
    }
    if (this.bloom) this.bloom.intensity = lerp(0.15, 0.9, night);
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
  }

  fitShadow(focus: THREE.Vector3, camera: THREE.Camera, viewDist: number, map: THREE.Box3) {
    if (map.isEmpty()) return;
    const sun = this.sun, f = focus;
    const dist = viewDist + Math.max(0, camera.position.y - (map.min.y + 80));
    // refit in steps (a tenth in size, a sixteenth across), not every frame the view moves: each refit redraws the city
    const top = Math.max(map.max.x, map.max.z) * 0.75, R = clamp(dist * 1.15, 300, top);
    const Rq = Math.min(top, 1.1 ** Math.ceil(Math.log(R) / Math.log(1.1))), g = Rq / 16;
    const c = new THREE.Vector3(Math.round(f.x / g) * g, 0, Math.round(f.z / g) * g), Rf = Rq + 0.75 * g, texel = (2 * Rf) / sun.shadow.mapSize.x;
    const L = this.lightDir, key = `${c.x},${c.z},${Rq.toFixed(1)},${L.x.toFixed(4)},${L.y.toFixed(4)},${L.z.toFixed(4)}`;
    if (!sun.castShadow) this.job = null;
    else {
      // drawn whole, at once: the first map, after a lost context or a new size, and a jump (the view gone more than
      // half the square's size from where the last map was aimed, or grown to twice it), where the old map would leave
      // the view unshadowed for the frames the next one takes
      const jump = Math.max(Math.abs(c.x - this.aimC.x), Math.abs(c.z - this.aimC.z)) > this.aimR / 2 || Rq > 2 * this.aimR;
      if (this.whole || !sun.shadow.map || jump) {
        this.whole = this.dirty = false; this.job = null; this.shadowKey = key; this.aimC.copy(c); this.aimR = Rq;
        this.fitLight(sun, c, Rf, texel, map);
        sun.shadow.map ??= shadowTarget(sun.shadow.mapSize.x);
        sun.shadow.needsUpdate = true;
        this.frontC.copy(c); this.frontR = Rf; this.frontTop = map.max.y;
      } else if (!this.job && (key !== this.shadowKey || this.dirty)) {
        // the view moved, the light turned or the city changed: the next map is aimed and begun, the sun keeps the
        // last one until it is done. A newer aim waits for it: each map takes as many frames as it has parts.
        this.dirty = false; this.shadowKey = key; this.aimC.copy(c); this.aimR = Rq;
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
    // the moving things' map is drawn every frame while they are in the scene and shown, and once more (empty) after
    const moving = this.moving(), live = !!moving && moving.visible && moving.parent !== null;
    b.autoUpdate = false;
    if (live || this.twinLive) b.needsUpdate = true;
    this.twinLive = live;
  }
}
