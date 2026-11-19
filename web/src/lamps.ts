import * as THREE from 'three';
import { lampColour } from './lamplight';
import { cutFogGlsl, FOG_CUT } from './daylight';

// The heads of the street lamps placed along the streets (lamplight.ts: their pools are in the lamp
// map, and they have no post): a soft point of light 4.5 m over the street, in the lamp's colour, bright enough at night
// for the bloom to give it a halo. A point sprite ~0.75 m across, never under ~2.5 pixels (its light spread over them
// instead, so a far street is a string of faint dots, not of sparks). Drawn after the city, tested against its depth
// and writing none; added to the colour only, so the scene's alpha (the reflections' and the AO's marks) is untouched.
// (beyond the view distance, daylight.ts, the lamps fade with the city: they are drawn without fog)
const VERT = `${cutFogGlsl('viewMatrix')}
attribute vec3 color;
uniform float uScale; uniform float uOn;
varying vec3 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = 0.75 * uScale / max(-mv.z, 1.0), s = max(px, 2.5);
  gl_PointSize = min(s, 64.0);
  vCol = color * uOn * 5.0 * (px / s) * mix(1.0, px / s, 0.5) * (1.0 - cutFog(mv.xyz));
}`;
const FRAG = `
varying vec3 vCol;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  gl_FragColor = vec4(vCol * (exp(-d * 9.0) + 0.06 * (1.0 - d)), 1.0);
}`;

// In CELL m squares, a Points object each (three culls each by the view's frustum); only the squares within reach of
// the camera (the view distance where one is set, else the far plane) are in the group at all, so a frame's work grows
// with what is near, not with the map's lamps. (The heads add up, ONE + ONE: the order they are drawn in is no matter.)
const CELL = 1024;

export class LampHeads {
  readonly group = new THREE.Group();
  private readonly mat: THREE.ShaderMaterial;
  // by cell (cy * 65536 + cx)
  private readonly cells = new Map<number, THREE.Points>();
  private windowKey = '';

  constructor(scene: THREE.Scene, lamps: [number, number, number][]) {
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { uScale: { value: 500 }, uOn: { value: 0 }, fogCut: { value: FOG_CUT } },
      depthWrite: false, transparent: true, fog: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
    const scale = (renderer: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera) => {
      const cam = camera as THREE.PerspectiveCamera, h = renderer.getRenderTarget()?.height ?? renderer.domElement.height;
      this.mat.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2));
    };
    const by = new Map<number, [number, number, number][]>();
    for (const l of lamps) {
      const k = Math.floor(l[1] / CELL) * 65536 + Math.floor(l[0] / CELL);
      (by.get(k) ?? by.set(k, []).get(k)!).push(l);
    }
    const c = new THREE.Color();
    for (const [k, list] of by) {
      const pos = new Float32Array(list.length * 3), col = new Float32Array(list.length * 3);
      list.forEach(([x, y, z], i) => {
        pos.set([x, z + 4.5, y], 3 * i);
        const [r, g, b] = lampColour(x, y);
        c.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
        col.set([c.r, c.g, c.b], 3 * i);
      });
      const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)).setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.computeBoundingSphere();
      const pts = new THREE.Points(geo, this.mat);
      pts.matrixAutoUpdate = false;
      pts.onBeforeRender = scale;
      this.cells.set(k, pts);
    }
    this.group.visible = false;
    this.group.name = 'lampheads';
    scene.add(this.group);
  }

  // the cells in the square around the camera that its reach spans, in the group (looked at again only when that
  // square changes)
  update(camera: THREE.PerspectiveCamera) {
    if (!this.group.visible) return;
    const reach = FOG_CUT.y > 0 ? Math.min(FOG_CUT.y, camera.far) : camera.far, p = camera.position;
    const x0 = Math.floor((p.x - reach) / CELL), x1 = Math.floor((p.x + reach) / CELL), y0 = Math.floor((p.z - reach) / CELL), y1 = Math.floor((p.z + reach) / CELL);
    const key = `${x0},${x1},${y0},${y1}`;
    if (key === this.windowKey) return;
    this.windowKey = key;
    this.group.clear();
    // (the cells held or the square's, whichever are fewer)
    if (this.cells.size < (x1 - x0 + 1) * (y1 - y0 + 1)) {
      for (const [k, pts] of this.cells) {
        const cx = k % 65536, cy = Math.floor(k / 65536);
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) this.group.add(pts);
      }
    } else {
      for (let cy = Math.max(0, y0); cy <= y1; cy++) for (let cx = Math.max(0, x0); cx <= x1; cx++) {
        const pts = this.cells.get(cy * 65536 + cx);
        if (pts) this.group.add(pts);
      }
    }
  }

  set night(n: number) {
    this.mat.uniforms.uOn.value = n;
    this.group.visible = n > 0.02;
  }
}
