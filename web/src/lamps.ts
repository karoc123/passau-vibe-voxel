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

export class LampHeads {
  readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, lamps: [number, number, number][]) {
    const pos = new Float32Array(lamps.length * 3), col = new Float32Array(lamps.length * 3), c = new THREE.Color();
    lamps.forEach(([x, y, z], i) => {
      pos.set([x, z + 4.5, y], 3 * i);
      const [r, g, b] = lampColour(x, y);
      c.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
      col.set([c.r, c.g, c.b], 3 * i);
    });
    const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)).setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { uScale: { value: 500 }, uOn: { value: 0 }, fogCut: { value: FOG_CUT } },
      depthWrite: false, transparent: true, fog: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
    this.points = new THREE.Points(geo, this.mat);
    this.points.visible = false;
    this.points.onBeforeRender = (renderer, _s, camera) => {
      const cam = camera as THREE.PerspectiveCamera, h = renderer.getRenderTarget()?.height ?? renderer.domElement.height;
      this.mat.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) / 2));
    };
    scene.add(this.points);
  }

  set night(n: number) {
    this.mat.uniforms.uOn.value = n;
    this.points.visible = n > 0.02;
  }
}
