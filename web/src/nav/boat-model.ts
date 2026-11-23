import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoatDrawn } from '../sim/craft/boat-motion';

// The player's speedboat drawn (nav/boat.ts): boxes merged into one geometry with vertex colours, as the cars and the
// river boats (view/meshes.ts, view/boats.ts); its nav lights brightened at night (as the cars' lamps: the bloom picks them
// up); a trail of foam behind it at speed. Local frame as view/boats.ts: x across (+x the port side, left), y up from the
// waterline, z along, +z the bow.

const WHITE = 0xf3f2ee, HULL = 0x1c2a3a, STRIPE = 0xc23a2b, TEAK = 0x9a6b43, SEAT = 0xe7e1d2, DARK = 0x23262b, GLASS = 0x2a3a46;

function box(w: number, h: number, l: number, x: number, y: number, z: number, hex: number, tilt = 0) {
  const g = new THREE.BoxGeometry(w, h, l);
  if (tilt) g.rotateX(tilt);
  g.translate(x, y + h / 2, z);
  const c = new THREE.Color(hex), a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) a.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

// a stepped (voxel) bow: the hull narrowing over its front metres
function bow(B: number, y0: number, h: number, z0: number, len: number, hex: number, steps = 4) {
  return Array.from({ length: steps }, (_, k) => box(B * (1 - (k + 1) / (steps + 1.5)), h, len / steps, 0, y0, z0 + len / steps * (k + 0.5), hex));
}

function hull() {
  const L = 6.4, B = 2.3, nose = 1.8, zc = -nose / 2, hl = L - nose; // the straight part from the stern to the bow's root
  return mergeGeometries([
    box(B - 0.3, 0.45, hl, 0, -0.45, zc, HULL), ...bow(B - 0.3, -0.45, 0.45, hl / 2 + zc, nose, HULL),
    box(B, 0.55, hl, 0, 0, zc, WHITE), ...bow(B, 0, 0.55, hl / 2 + zc, nose, WHITE),
    box(B + 0.04, 0.12, hl, 0, 0.3, zc, STRIPE), ...bow(B + 0.04, 0.3, 0.12, hl / 2 + zc, nose, STRIPE),
    box(B - 0.2, 0.06, hl - 0.2, 0, 0.55, zc, TEAK), // the deck
    box(B, 0.25, 0.12, 0, 0.55, -L / 2 + 0.06, WHITE), // the transom's rim
    box(0.12, 0.25, hl - 1.6, B / 2 - 0.06, 0.55, zc - 0.6, WHITE), box(0.12, 0.25, hl - 1.6, -B / 2 + 0.06, 0.55, zc - 0.6, WHITE), // gunwales
    ...bow(B - 0.1, 0.55, 0.22, hl / 2 + zc - 0.5, nose + 0.4, WHITE, 3), // the foredeck
    box(0.55, 0.45, 0.55, 0.45, 0.6, -0.2, SEAT), box(0.55, 0.45, 0.55, -0.45, 0.6, -0.2, SEAT), // the seats
    box(0.55, 0.55, 0.12, 0.45, 0.6, -0.5, SEAT), box(0.55, 0.55, 0.12, -0.45, 0.6, -0.5, SEAT),
    box(B - 0.4, 0.4, 0.7, 0, 0.6, -1.9, SEAT), // the bench at the back
    box(0.9, 0.5, 0.35, -0.45, 0.6, 0.55, WHITE), box(0.32, 0.06, 0.06, -0.45, 1.1, 0.45, DARK), // console and wheel
    box(B - 0.35, 0.42, 0.05, 0, 1.08, 0.82, GLASS, -0.55), // the windscreen
    box(0.5, 0.75, 0.45, 0, 0.15, -L / 2 - 0.2, DARK), box(0.42, 0.4, 0.55, 0, 0.75, -L / 2 - 0.2, 0x3c4048), // outboard
    box(0.08, 0.7, 0.08, 0, 0.55, -L / 2 + 0.3, 0xb8bcc2), // the stern light's mast
  ]);
}

const RED = new THREE.Color(1, 0.08, 0.05), GREEN = new THREE.Color(0.05, 1, 0.25), WHITE_L = new THREE.Color(1, 0.96, 0.85);
const FOAM_N = 320, FOAM_LIFE = 2.4, FOAM_EVERY = 0.6; // foam patches kept, s each lives, m of way between two pairs

export class BoatModel {
  readonly group = new THREE.Group();
  private readonly hull: THREE.Mesh;
  private readonly lights: { mat: THREE.MeshBasicMaterial; base: THREE.Color }[] = [];
  private readonly foam: THREE.InstancedMesh;
  private readonly foamAt: { x: number; y: number; z: number; h: number; t: number; side: number; w: number }[] = [];
  private foamFrom: { x: number; z: number; h: number; t: number } | null = null; // where the last pair was laid
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly c = new THREE.Color();

  constructor(parent: THREE.Object3D) {
    this.hull = new THREE.Mesh(hull(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.1 }));
    this.hull.castShadow = this.hull.receiveShadow = true;
    const light = (base: THREE.Color, x: number, y: number, z: number) => {
      const mat = new THREE.MeshBasicMaterial({ color: base.clone() });
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.16), mat);
      m.position.set(x, y, z);
      this.lights.push({ mat, base });
      this.hull.add(m);
    };
    light(RED, 1.02, 0.86, 1.3); // port (left)
    light(GREEN, -1.02, 0.86, 1.3); // starboard
    light(WHITE_L, 0, 1.3, -2.9); // stern, on its mast
    this.foam = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), FOAM_N);
    this.foam.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(FOAM_N * 3), 3);
    this.foam.frustumCulled = false;
    this.foam.count = 0;
    this.foam.renderOrder = 2;
    this.group.add(this.hull, this.foam);
    this.group.visible = false;
    parent.add(this.group);
  }

  set visible(v: boolean) {
    this.group.visible = v;
    if (!v) { this.foamAt.length = 0; this.foam.count = 0; }
  }

  // drawn at `d`, going `speed` m/s; night 0..1 (daylight.night); t the clock (s)
  update(d: BoatDrawn, speed: number, night: number, t: number) {
    this.hull.position.set(d.x, d.y, d.z);
    // (YXZ: the heading, then the pitch, nose up about the beam, then the roll about the length)
    this.hull.quaternion.setFromEuler(this.e.set(-d.pitch, d.h, d.roll));
    for (const { mat, base } of this.lights) mat.color.copy(base).multiplyScalar(0.35 + 2.4 * night);
    // the foam: a pair of patches off the stern's corners every FOAM_EVERY m at speed (laid along the way since the
    // last frame, so a slow frame leaves no gap), spreading and fading
    const v = Math.abs(speed), F = this.foamFrom;
    if (v <= 2.5) this.foamFrom = null;
    else if (!F || Math.hypot(d.x - F.x, d.z - F.z) > 40) this.foamFrom = { x: d.x, z: d.z, h: d.h, t };
    else {
      const L = Math.hypot(d.x - F.x, d.z - F.z), k = Math.floor(L / FOAM_EVERY), w = Math.min(1, v / 14);
      let dh = d.h - F.h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      for (let i = 1; i <= k; i++) {
        const f = i * FOAM_EVERY / L, x = F.x + (d.x - F.x) * f, z = F.z + (d.z - F.z) * f, h = F.h + dh * f, tt = F.t + (t - F.t) * f;
        const sh = Math.sin(h), ch = Math.cos(h);
        for (const side of [1, -1]) {
          const a = side * 0.85, b = -3.3;
          this.foamAt.push({ x: x + a * ch + b * sh, y: d.y + 0.04, z: z - a * sh + b * ch, h, t: tt, side, w });
        }
      }
      if (k) {
        const f = k * FOAM_EVERY / L;
        this.foamFrom = { x: F.x + (d.x - F.x) * f, z: F.z + (d.z - F.z) * f, h: F.h + dh * f, t: F.t + (t - F.t) * f };
      }
      while (this.foamAt.length > FOAM_N) this.foamAt.shift();
    }
    let n = 0;
    const one = new THREE.Vector3(), pos = new THREE.Vector3();
    for (const f of this.foamAt) {
      const age = (t - f.t) / FOAM_LIFE;
      if (age >= 1) continue;
      // drifting out sideways as the wake's V opens
      const out = f.side * age * 2.2 * f.w, ch = Math.cos(f.h), sh = Math.sin(f.h);
      pos.set(f.x + out * ch, f.y, f.z - out * sh);
      one.set(0.45 + 1.8 * age, 1, 1.8 + 0.6 * age);
      this.m.compose(pos, this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, f.h), one);
      this.foam.setMatrixAt(n, this.m);
      const k = (1 - age) * (1 - age) * 0.13 * f.w * (1 - 0.75 * night);
      this.foam.setColorAt(n, this.c.setRGB(k, k, k));
      n++;
    }
    this.foam.count = n;
    if (n) { this.foam.instanceMatrix.needsUpdate = true; this.foam.instanceColor!.needsUpdate = true; }
  }
}
