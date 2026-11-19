// Rapier spike (approach B), opt-in: ?physics=rapier, then P. Loaded on demand (main.ts); nothing of it is in the boot
// bundle. P: spawn the car at the focus / get in and out; WASD drive, Space handbrake; B: throw a box from the camera;
// V: drop a pile of boxes ahead; R: a ragdoll standing ahead (hit it); T: throw a ragdoll from the camera; Esc: get out.
// Stats in the corner and on window.__rapier.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Meta } from '../../types';
import { RapierCar, type CarInput } from './car';
import { Ragdoll } from './ragdoll';
import { CHUNK, RapierTerrain } from './terrain';

const STEP = 1 / 60;
const MAX_STEPS = 4;
const MAX_BOXES = 80;
const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space']);

interface Ctx { scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; meta: Meta }
interface Tracked { body: RAPIER.RigidBody; obj: THREE.Object3D; prevP: THREE.Vector3; prevQ: THREE.Quaternion; curP: THREE.Vector3; curQ: THREE.Quaternion }

let wasmMemory: WebAssembly.Memory | null = null;

export async function startRapier(ctx: Ctx) {
  const t0 = performance.now();
  // (catch the module's memory to report its size: Rapier doesn't expose it)
  const inst = WebAssembly.instantiate;
  (WebAssembly as { instantiate: unknown }).instantiate = async (...a: Parameters<typeof WebAssembly.instantiate>) => {
    const r = await (inst as (...b: unknown[]) => Promise<WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance>)(...a);
    const i = 'instance' in r ? r.instance : r;
    for (const v of Object.values(i.exports)) if (v instanceof WebAssembly.Memory) wasmMemory = v;
    return r;
  };
  try { await RAPIER.init(); } finally { (WebAssembly as { instantiate: unknown }).instantiate = inst; }
  const initMs = performance.now() - t0;
  return new RapierDemo(ctx, initMs);
}

export class RapierDemo {
  readonly world: RAPIER.World;
  readonly terrain: RapierTerrain;
  readonly group = new THREE.Group();
  readonly origin: { x: number; z: number };
  car: RapierCar | null = null;
  driving = false;
  scriptInput: CarInput | null = null;
  readonly ragdolls: Ragdoll[] = [];
  private readonly tracked: Tracked[] = [];
  private readonly boxes: Tracked[] = [];
  private readonly keys = new Set<string>();
  private readonly events: RAPIER.EventQueue;
  private acc = 0;
  private frozen = false;
  private pendingCar = false;
  private readonly hud = document.createElement('div');
  private readonly boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly boxMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.6 });
  private readonly camGoal = new THREE.Vector3();
  readonly stats = { loadMs: 0, initMs: 0, steps: 0, stepMsAvg: 0, stepMsMax: 0, stepMsLast: 0, frameMs: 0, frozenFrames: 0, wasmBytes: 0, bodies: 0, colliders: 0, kmh: 0, wheels: 0, air: 0, maxAir: 0 };

  constructor(private readonly ctx: Ctx, initMs: number) {
    this.stats.initMs = initMs;
    const R = RAPIER;
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    const f = ctx.controls.target;
    this.origin = { x: Math.floor(f.x / CHUNK) * CHUNK, z: Math.floor(f.z / CHUNK) * CHUNK };
    this.terrain = new RapierTerrain(R, this.world, ctx.meta, this.origin);
    this.events = new R.EventQueue(true);
    ctx.scene.add(this.group);
    this.hud.style.cssText = 'position:fixed;left:8px;top:8px;padding:6px 8px;background:rgba(0,0,0,.6);color:#fff;font:11px/1.35 monospace;z-index:1000;white-space:pre;pointer-events:none';
    document.body.append(this.hud);
    addEventListener('keydown', this.onKey, { capture: true });
    addEventListener('keyup', (e) => this.keys.delete(e.code), { capture: true });
    addEventListener('blur', () => this.keys.clear());
    (window as unknown as { __rapier: RapierDemo }).__rapier = this;
  }

  // world <-> physics coordinates
  toPhys(v: THREE.Vector3) { return { x: v.x - this.origin.x, y: v.y, z: v.z - this.origin.z }; }
  toWorld(v: { x: number; y: number; z: number }, out = new THREE.Vector3()) { return out.set(v.x + this.origin.x, v.y, v.z + this.origin.z); }

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as Element).closest?.('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.driving && (KEYS.has(e.code) || e.code === 'Escape')) {
      if (e.code === 'Escape') this.driving = false;
      else this.keys.add(e.code);
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (e.repeat) return;
    if (e.code === 'KeyP') this.toggleCar();
    else if (e.code === 'KeyB') this.throwBox();
    else if (e.code === 'KeyV') this.pile();
    else if (e.code === 'KeyR') this.ragdollAhead();
    else if (e.code === 'KeyT') this.throwRagdoll();
    else return;
    e.preventDefault(); e.stopPropagation();
  };

  toggleCar() {
    if (this.car) { this.driving = !this.driving; return; }
    this.pendingCar = true;
  }

  // the focus: the car, else the camera's focus
  private focus() {
    if (this.car) return this.toWorld(this.car.body.translation());
    return this.ctx.controls.target.clone();
  }

  private spawnCar() {
    const f = this.ctx.controls.target, p = this.toPhys(f);
    const hit = this.world.castRay(new RAPIER.Ray({ x: p.x, y: 400, z: p.z }, { x: 0, y: -1, z: 0 }), 500, true);
    if (!hit) return false;
    const cam = this.ctx.camera.position;
    const heading = Math.atan2(f.x - cam.x, f.z - cam.z);
    this.car = new RapierCar(RAPIER, this.world, { x: p.x, y: 400 - hit.timeOfImpact + 1.4, z: p.z }, heading);
    this.group.add(this.car.mesh);
    this.track(this.car.body, this.car.mesh);
    this.driving = true;
    return true;
  }

  throwBox(size = 0.5 + Math.random() * 0.6) {
    const cam = this.ctx.camera, dir = cam.getWorldDirection(new THREE.Vector3());
    const at = cam.position.clone().addScaledVector(dir, 4);
    return this.addBox(at, dir.multiplyScalar(22), size);
  }

  pile() {
    const f = this.focus(), dir = this.forward();
    const at = f.addScaledVector(dir, 10);
    const p = this.toPhys(at);
    const hit = this.world.castRay(new RAPIER.Ray({ x: p.x, y: 400, z: p.z }, { x: 0, y: -1, z: 0 }), 500, true);
    const g = hit ? 400 - hit.timeOfImpact : at.y;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 3 - (y > 1 ? 1 : 0); x++) {
      const side = new THREE.Vector3(dir.z, 0, -dir.x);
      const w = this.toWorld({ x: p.x, y: g + 0.45 + y * 0.92, z: p.z }).addScaledVector(side, (x - 1) * 0.95 + (y % 2) * 0.45);
      this.addBox(w, new THREE.Vector3(), 0.9);
    }
  }

  private forward() {
    if (this.car) {
      const r = this.car.body.rotation();
      return new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).setY(0).normalize();
    }
    return this.ctx.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
  }

  private addBox(at: THREE.Vector3, v: THREE.Vector3, size: number) {
    const p = this.toPhys(at);
    const b = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setLinvel(v.x, v.y, v.z).setCcdEnabled(true));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(size / 2, size / 2, size / 2).setDensity(80).setFriction(0.7).setRestitution(0.2), b);
    const m = new THREE.Mesh(this.boxGeo, this.boxMat);
    m.scale.setScalar(size);
    m.castShadow = m.receiveShadow = true;
    this.group.add(m);
    const t = this.track(b, m);
    this.boxes.push(t);
    if (this.boxes.length > MAX_BOXES) this.untrack(this.boxes.shift()!);
    return b;
  }

  ragdollAhead() {
    const f = this.focus(), dir = this.forward(), at = f.addScaledVector(dir, this.car ? 25 : 6);
    const p = this.toPhys(at);
    const hit = this.world.castRay(new RAPIER.Ray({ x: p.x, y: 400, z: p.z }, { x: 0, y: -1, z: 0 }), 500, true);
    if (!hit) return null;
    return this.addRagdoll({ x: p.x, y: 400 - hit.timeOfImpact, z: p.z }, Math.atan2(-dir.x, -dir.z), false);
  }

  throwRagdoll() {
    const cam = this.ctx.camera, dir = cam.getWorldDirection(new THREE.Vector3());
    const p = this.toPhys(cam.position.clone().addScaledVector(dir, 5).add(new THREE.Vector3(0, -1, 0)));
    const r = this.addRagdoll(p, Math.random() * 6, true);
    for (const b of r.bodies) b.setLinvel({ x: dir.x * 16, y: dir.y * 16 + 3, z: dir.z * 16 }, true);
    return r;
  }

  private addRagdoll(feet: { x: number; y: number; z: number }, heading: number, limp: boolean) {
    const r = new Ragdoll(RAPIER, this.world, feet, heading, this.group, limp);
    r.bodies.forEach((b, i) => this.track(b, r.meshes[i]));
    this.ragdolls.push(r);
    if (this.ragdolls.length > 6) {
      const old = this.ragdolls.shift()!;
      for (const b of old.bodies) { const t = this.tracked.find((x) => x.body === b); if (t) this.untrack(t, false); }
      old.dispose();
    }
    return r;
  }

  private track(body: RAPIER.RigidBody, obj: THREE.Object3D) {
    const t = body.translation(), r = body.rotation();
    const p = this.toWorld(t), q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const tr: Tracked = { body, obj, prevP: p.clone(), prevQ: q.clone(), curP: p.clone(), curQ: q.clone() };
    this.tracked.push(tr);
    obj.position.copy(p); obj.quaternion.copy(q);
    return tr;
  }

  private untrack(t: Tracked, remove = true) {
    this.tracked.splice(this.tracked.indexOf(t), 1);
    if (remove) { this.world.removeRigidBody(t.body); t.obj.removeFromParent(); }
  }

  private input(): CarInput {
    if (this.scriptInput) return this.scriptInput;
    const k = (...c: string[]) => (c.some((x) => this.keys.has(x)) ? 1 : 0);
    return { gas: k('KeyW', 'ArrowUp'), brake: k('KeyS', 'ArrowDown'), steer: k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'), handbrake: this.keys.has('Space') };
  }

  update(dt: number) {
    const f0 = performance.now();
    // the terrain around every body (asleep too: it may be woken), and around the focus for a car still to be placed
    const pts: { x: number; z: number }[] = [];
    for (const t of this.tracked) pts.push(this.toWorld(t.body.translation()));
    if (this.pendingCar) pts.push(this.ctx.controls.target.clone());
    const ready = this.terrain.update(pts);
    if (this.pendingCar && ready[ready.length - 1] && this.spawnCar()) this.pendingCar = false;
    // a body whose ground isn't built yet: the world is held still (all of it, the spike's simplification)
    this.frozen = ready.slice(0, this.pendingCar ? -1 : undefined).some((r) => !r);
    if (this.frozen) { this.stats.frozenFrames++; this.acc = 0; }
    else {
      this.acc += Math.min(dt, 0.25);
      let n = 0;
      while (this.acc >= STEP && n < MAX_STEPS) {
        this.acc -= STEP;
        n++;
        for (const t of this.tracked) { t.prevP.copy(t.curP); t.prevQ.copy(t.curQ); }
        const s0 = performance.now();
        const carV = this.car?.body.linvel();
        if (this.car) this.car.step(this.driving ? this.input() : { gas: 0, brake: 0, steer: 0, handbrake: true }, STEP);
        this.world.step(this.events);
        this.handleEvents(carV);
        const ms = performance.now() - s0;
        this.stats.steps++;
        this.stats.stepMsLast = ms;
        this.stats.stepMsAvg += (ms - this.stats.stepMsAvg) * 0.05;
        this.stats.stepMsMax = Math.max(this.stats.stepMsMax, ms);
        for (const t of this.tracked) {
          const p = t.body.translation(), r = t.body.rotation();
          this.toWorld(p, t.curP);
          t.curQ.set(r.x, r.y, r.z, r.w);
        }
        this.cull();
        // time in the air, in simulated time
        if (this.car) {
          if (this.car.wheelsInContact() === 0) { this.stats.air += STEP; this.stats.maxAir = Math.max(this.stats.maxAir, this.stats.air); }
          else this.stats.air = 0;
        }
      }
      if (n === MAX_STEPS) this.acc = 0;
    }
    // drawn between the last two steps
    const a = this.frozen ? 1 : this.acc / STEP;
    for (const t of this.tracked) {
      t.obj.position.lerpVectors(t.prevP, t.curP, a);
      t.obj.quaternion.slerpQuaternions(t.prevQ, t.curQ, a);
    }
    if (this.car) {
      this.car.syncWheels();
      this.stats.kmh = this.car.kmh;
      this.stats.wheels = this.car.wheelsInContact();
    }
    if (this.car && this.driving) this.follow(dt);
    this.ctx.controls.enabled = !(this.car && this.driving);
    this.stats.frameMs = performance.now() - f0;
    this.stats.bodies = this.world.bodies.len();
    this.stats.colliders = this.world.colliders.len();
    this.stats.wasmBytes = wasmMemory?.buffer.byteLength ?? 0;
    this.drawHud();
  }

  // a ragdoll touched by anything turns limp with the hitter's momentum; the car keeps most of its speed (a posed
  // ragdoll is kinematic: infinitely heavy for the one step it is hit in)
  private handleEvents(carV: RAPIER.Vector | undefined) {
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      for (const r of this.ragdolls) {
        if (r.limp) continue;
        const mine = r.colliders.has(h1) ? h1 : r.colliders.has(h2) ? h2 : -1;
        if (mine < 0) continue;
        const other = this.world.getCollider(mine === h1 ? h2 : h1);
        const ob = other?.parent();
        const v = ob ? ob.linvel() : { x: 0, y: 0, z: 0 };
        r.goLimp(RAPIER, v);
        if (this.car && ob === this.car.body && carV) this.car.body.setLinvel({ x: carV.x * 0.9, y: carV.y, z: carV.z * 0.9 }, true);
      }
    });
  }

  // bodies that fell off the map (or through it) go
  private cull() {
    for (const t of [...this.boxes]) if (t.body.translation().y < -50) { this.boxes.splice(this.boxes.indexOf(t), 1); this.untrack(t); }
    if (this.car && this.car.body.translation().y < -50) {
      const p = this.car.body.translation();
      console.warn('rapier: car fell off the map at', p.x + this.origin.x, p.z + this.origin.z);
      this.car.body.setTranslation({ x: p.x, y: 200, z: p.z }, true);
      this.car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  private follow(dt: number) {
    const car = this.car!, cam = this.ctx.camera, ctl = this.ctx.controls;
    const p = car.mesh.position, fwd = this.forward();
    const v = car.body.linvel();
    const back = 15 + Math.hypot(v.x, v.z) * 0.2;
    this.camGoal.copy(p).addScaledVector(fwd, -back).add(new THREE.Vector3(0, 5, 0));
    // not behind a wall: pulled in along the line from the car (a ray through the colliders, the car's own left out)
    const from = this.toPhys(p.clone().add(new THREE.Vector3(0, 1.5, 0))), d = this.camGoal.clone().sub(p).sub(new THREE.Vector3(0, 1.5, 0));
    const len = d.length();
    d.divideScalar(len);
    const hit = this.world.castRay(new RAPIER.Ray(from, d), len, true, undefined, undefined, undefined, car.body);
    if (hit) this.camGoal.copy(p).add(new THREE.Vector3(0, 1.5, 0)).addScaledVector(d, Math.max(3, hit.timeOfImpact - 0.6));
    const k = 1 - Math.exp(-6 * dt);
    cam.position.lerp(this.camGoal, k);
    if (cam.position.y < p.y + 1.5) cam.position.y = p.y + 1.5;
    ctl.target.copy(p).add(new THREE.Vector3(0, 1.2, 0)).addScaledVector(fwd, 4);
    cam.lookAt(ctl.target);
  }

  private drawHud() {
    const s = this.stats, t = this.terrain.stats;
    this.hud.textContent = `rapier ${RAPIER.version()}  load ${s.loadMs.toFixed(0)} ms (init ${s.initMs.toFixed(0)})  wasm ${(s.wasmBytes / 1048576).toFixed(1)} MB\n`
      + `step ${s.stepMsLast.toFixed(2)} ms (avg ${s.stepMsAvg.toFixed(2)}, max ${s.stepMsMax.toFixed(1)})  update ${s.frameMs.toFixed(2)} ms\n`
      + `chunks ${t.chunks}  voxels ${t.voxels}  ramp tris ${t.tris}  builds ${t.builds} (avg ${(t.buildMsTotal / Math.max(1, t.builds)).toFixed(2)}, max ${t.buildMsMax.toFixed(1)} ms)  tiles loading ${t.tilesLoading}${this.frozen ? '  FROZEN (loading)' : ''}\n`
      + `bodies ${s.bodies}  colliders ${s.colliders}  boxes ${this.boxes.length}  ragdolls ${this.ragdolls.length}\n`
      + (this.car ? `car ${s.kmh.toFixed(0)} km/h  wheels ${s.wheels}/4${s.air > 0.05 ? `  AIR ${s.air.toFixed(2)} s` : ''}  ${this.driving ? 'driving' : 'parked (P)'}\n` : this.pendingCar ? 'placing car…\n' : '')
      + 'P car  WASD/Space  B box  V pile  R ragdoll  T throw ragdoll  Esc out';
  }
}
