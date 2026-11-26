import * as THREE from 'three';
import type { WeaponEvent, WeaponView } from '../weapon-view';

// A tracer is drawn slower than a bullet flies: at 900 m/s it would cross a street in a frame and never be seen.
const TRACER_V = 350, TRACER_L = 3, TRACER_W = 0.05, TRACERS = 48;
const FLASH_S = 0.05, FLASHES = 16;
const SPARKS = 512, SPARKS_PER_HIT = 10, SPARK_S = 0.35, SPARK_V = 5, GRAVITY = 12;

const glow = (color: number) => new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });

// (hit: sparks where it ends, once its head is there)
interface Tracer { mesh: THREE.Mesh; from: THREE.Vector3; dir: THREE.Vector3; len: number; s: number; hit: boolean }
interface Flash { mesh: THREE.Mesh; t: number }

/** the machine gun's look: a flash at the muzzle, a tracer down the shot, sparks where it stopped */
export function mgView(): WeaponView {
  const group = new THREE.Group(), unit = new THREE.BoxGeometry(1, 1, 1), ball = new THREE.IcosahedronGeometry(1, 1);
  const tracerMat = glow(0xffd27a), flashMat = glow(0xffe8a0);
  const tracers: Tracer[] = [], flashes: Flash[] = [];
  for (let i = 0; i < TRACERS; i++) {
    const mesh = new THREE.Mesh(unit, tracerMat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    tracers.push({ mesh, from: new THREE.Vector3(), dir: new THREE.Vector3(), len: 0, s: Infinity, hit: false });
  }
  for (let i = 0; i < FLASHES; i++) {
    const mesh = new THREE.Mesh(ball, flashMat);
    mesh.visible = false;
    group.add(mesh);
    flashes.push({ mesh, t: 0 });
  }
  // the sparks: position, velocity and age per spark, drawn as points
  const pos = new Float32Array(SPARKS * 3), vel = new Float32Array(SPARKS * 3), age = new Float32Array(SPARKS).fill(Infinity);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setDrawRange(0, 0);
  const sparks = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffc060, size: 3, sizeAttenuation: false, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  sparks.frustumCulled = false;
  group.add(sparks);
  let nextSpark = 0, nextTracer = 0, nextFlash = 0;

  const flash = (at: THREE.Vector3) => {
    const f = flashes[nextFlash++ % FLASHES];
    f.t = FLASH_S;
    f.mesh.position.copy(at);
    f.mesh.scale.setScalar(0.12 + Math.random() * 0.08);
    f.mesh.visible = true;
  };
  const tracer = (from: THREE.Vector3, to: THREE.Vector3, hit: boolean) => {
    const T = tracers[nextTracer++ % TRACERS];
    if (T.hit && T.s < T.len) spark(T.from.clone().addScaledVector(T.dir, T.len), T.dir.clone().negate());
    T.from.copy(from);
    T.len = T.dir.subVectors(to, from).length();
    T.hit = hit;
    if (T.len < 1e-3) { T.s = Infinity; if (hit) spark(to, new THREE.Vector3(0, 1, 0)); return; }
    T.dir.divideScalar(T.len);
    T.s = 0;
    T.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), T.dir);
  };
  const spark = (at: THREE.Vector3, back: THREE.Vector3) => {
    for (let k = 0; k < SPARKS_PER_HIT; k++) {
      const i = nextSpark++ % SPARKS, v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize()
        .addScaledVector(back, 0.8).normalize().multiplyScalar(SPARK_V * (0.4 + Math.random()));
      pos.set([at.x, at.y, at.z], 3 * i);
      vel.set([v.x, v.y, v.z], 3 * i);
      age[i] = Math.random() * 0.1;
    }
  };

  return {
    id: 'mg', group,
    event(e: WeaponEvent, own: boolean) {
      if (e.kind !== 'shot') return;
      const from = new THREE.Vector3(e.at.x, e.at.y, e.at.z), to = new THREE.Vector3(e.to.x, e.to.y, e.to.z);
      const dir = to.clone().sub(from).normalize();
      if (!own) flash(from.clone().addScaledVector(dir, 0.6));
      tracer(from, to, !!e.hit);
    },
    fired(muzzle, dir) { flash(muzzle.clone().addScaledVector(dir, 0.1)); },
    update(dt) {
      for (const f of flashes) if (f.mesh.visible && (f.t -= dt) <= 0) f.mesh.visible = false;
      for (const T of tracers) {
        if (T.s >= T.len) { T.mesh.visible = false; continue; }
        T.s += TRACER_V * dt;
        if (T.s >= T.len && T.hit) spark(T.from.clone().addScaledVector(T.dir, T.len), T.dir.clone().negate());
        // (the tracer's head along the shot, its tail TRACER_L behind, both kept within the shot)
        const head = Math.min(T.s, T.len), tail = Math.max(0, head - TRACER_L), L = head - tail;
        T.mesh.visible = L > 1e-3;
        T.mesh.position.copy(T.from).addScaledVector(T.dir, (head + tail) / 2);
        T.mesh.scale.set(TRACER_W, TRACER_W, Math.max(L, 1e-3));
        if (T.s >= T.len) T.mesh.visible = false;
      }
      let n = 0;
      for (let i = 0; i < SPARKS; i++) {
        if (age[i] >= SPARK_S) continue;
        age[i] += dt;
        if (age[i] >= SPARK_S) continue;
        vel[3 * i + 1] -= GRAVITY * dt;
        // (the live sparks packed to the front: the draw range is their count)
        pos[3 * n] = pos[3 * i] + vel[3 * i] * dt; pos[3 * n + 1] = pos[3 * i + 1] + vel[3 * i + 1] * dt; pos[3 * n + 2] = pos[3 * i + 2] + vel[3 * i + 2] * dt;
        if (n !== i) { vel.copyWithin(3 * n, 3 * i, 3 * i + 3); age[n] = age[i]; age[i] = Infinity; }
        n++;
      }
      nextSpark = n;
      geo.setDrawRange(0, n);
      geo.attributes.position.needsUpdate = true;
    },
  };
}
