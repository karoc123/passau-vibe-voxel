// Rapier spike: a simple ragdoll (11 capsules and spherical/revolute joints). It stands posed (kinematic, as an
// animated NPC would) until something hits it; then all of it turns dynamic and takes the hitter's momentum.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { G_CAR_ONLY, G_RAGDOLL } from './terrain';

// (drawn as cylinders: CapsuleGeometry would pull more of three into the boot bundle, which three lives in)
// part: centre (standing, relative to the feet), capsule half height and radius, axis 'y' or 'x'
const PARTS = {
  pelvis: { at: [0, 1.0, 0], hh: 0.08, r: 0.14, axis: 'x' },
  chest: { at: [0, 1.32, 0], hh: 0.12, r: 0.16, axis: 'y' },
  head: { at: [0, 1.66, 0], hh: 0.04, r: 0.11, axis: 'y' },
  armUL: { at: [0.3, 1.35, 0], hh: 0.11, r: 0.055, axis: 'y' },
  armUR: { at: [-0.3, 1.35, 0], hh: 0.11, r: 0.055, axis: 'y' },
  armLL: { at: [0.3, 1.05, 0], hh: 0.1, r: 0.05, axis: 'y' },
  armLR: { at: [-0.3, 1.05, 0], hh: 0.1, r: 0.05, axis: 'y' },
  legUL: { at: [0.11, 0.72, 0], hh: 0.15, r: 0.075, axis: 'y' },
  legUR: { at: [-0.11, 0.72, 0], hh: 0.15, r: 0.075, axis: 'y' },
  legLL: { at: [0.11, 0.28, 0], hh: 0.16, r: 0.06, axis: 'y' },
  legLR: { at: [-0.11, 0.28, 0], hh: 0.16, r: 0.06, axis: 'y' },
} as const;
type Part = keyof typeof PARTS;
// joints: [parent, child, world-space anchor (standing), kind]
const JOINTS: [Part, Part, [number, number, number], 'ball' | 'hinge'][] = [
  ['pelvis', 'chest', [0, 1.14, 0], 'ball'],
  ['chest', 'head', [0, 1.52, 0], 'ball'],
  ['chest', 'armUL', [0.3, 1.5, 0], 'ball'],
  ['chest', 'armUR', [-0.3, 1.5, 0], 'ball'],
  ['armUL', 'armLL', [0.3, 1.2, 0], 'hinge'],
  ['armUR', 'armLR', [-0.3, 1.2, 0], 'hinge'],
  ['pelvis', 'legUL', [0.11, 0.92, 0], 'ball'],
  ['pelvis', 'legUR', [-0.11, 0.92, 0], 'ball'],
  ['legUL', 'legLL', [0.11, 0.48, 0], 'hinge'],
  ['legUR', 'legLR', [-0.11, 0.48, 0], 'hinge'],
];
// ragdoll parts don't collide with each other, nor with what only the car meets
const GROUPS = (G_RAGDOLL << 16) | (0xffff & ~G_RAGDOLL & ~G_CAR_ONLY);

export class Ragdoll {
  readonly bodies: RAPIER.RigidBody[] = [];
  readonly meshes: THREE.Mesh[] = [];
  readonly colliders = new Set<number>();
  limp = false;

  private readonly mats: THREE.Material[];

  // cloth: its clothes' colour (default blue)
  constructor(R: typeof RAPIER, private readonly world: RAPIER.World, feet: { x: number; y: number; z: number }, heading: number, group: THREE.Object3D, limp = false, cloth?: THREE.Color) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    const rot = (v: readonly number[]) => new THREE.Vector3(v[0], v[1], v[2]).applyQuaternion(q);
    const byName = new Map<Part, RAPIER.RigidBody>();
    const skin = new THREE.MeshStandardMaterial({ color: 0xe0b090, roughness: 0.7 });
    const clothes = new THREE.MeshStandardMaterial({ color: cloth ?? 0x3060c0, roughness: 0.8 });
    this.mats = [skin, clothes];
    for (const [name, p] of Object.entries(PARTS) as [Part, (typeof PARTS)[Part]][]) {
      const c = rot(p.at);
      const partQ = q.clone();
      if (p.axis === 'x') partQ.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
      const desc = (limp ? R.RigidBodyDesc.dynamic() : R.RigidBodyDesc.kinematicPositionBased())
        .setTranslation(feet.x + c.x, feet.y + c.y, feet.z + c.z).setRotation(partQ).setAngularDamping(0.8).setLinearDamping(0.05);
      const b = this.world.createRigidBody(desc);
      const col = this.world.createCollider(R.ColliderDesc.capsule(p.hh, p.r).setDensity(1000).setFriction(0.7)
        .setCollisionGroups(GROUPS).setActiveEvents(R.ActiveEvents.COLLISION_EVENTS), b);
      this.colliders.add(col.handle);
      this.bodies.push(b);
      byName.set(name, b);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, p.hh * 2 + p.r * 1.6, 8), name === 'head' || name.startsWith('armL') ? skin : clothes);
      m.castShadow = true;
      group.add(m);
      this.meshes.push(m);
    }
    for (const [a, b, at, kind] of JOINTS) {
      const A = byName.get(a)!, B = byName.get(b)!;
      const w = rot(at).add(new THREE.Vector3(feet.x, feet.y, feet.z));
      const la = local(A, w), lb = local(B, w);
      const data = kind === 'ball' ? R.JointData.spherical(la, lb) : R.JointData.revolute(la, lb, localAxis(A, rot([1, 0, 0])));
      this.world.createImpulseJoint(data, A, B, true);
    }
    this.limp = limp;
  }

  // turn dynamic, carrying `v` (the hitter's velocity) and a bit upward
  goLimp(R: typeof RAPIER, v: { x: number; y: number; z: number }) {
    if (this.limp) return;
    this.limp = true;
    for (const b of this.bodies) {
      b.setBodyType(R.RigidBodyType.Dynamic, true);
      b.setLinvel({ x: v.x * 0.9, y: v.y * 0.9 + Math.hypot(v.x, v.z) * 0.25, z: v.z * 0.9 }, true);
    }
  }

  dispose() {
    for (const b of this.bodies) this.world.removeRigidBody(b);
    for (const m of this.meshes) { m.removeFromParent(); m.geometry.dispose(); }
    for (const m of this.mats) m.dispose();
  }
}

function local(b: RAPIER.RigidBody, w: THREE.Vector3) {
  const t = b.translation(), r = b.rotation();
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
  const v = w.clone().sub(new THREE.Vector3(t.x, t.y, t.z)).applyQuaternion(q);
  return { x: v.x, y: v.y, z: v.z };
}

function localAxis(b: RAPIER.RigidBody, a: THREE.Vector3) {
  const r = b.rotation();
  const v = a.clone().applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w).invert());
  return { x: v.x, y: v.y, z: v.z };
}
