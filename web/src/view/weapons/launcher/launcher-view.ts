import * as THREE from 'three';
import { flight, FUSE } from '../../../sim/weapons/launcher/launcher';
import type { Vec3 } from '../../../core/vec';
import type { PlayerId } from '../../../sim/contract/ids';
import type { WeaponEvent, WeaponView } from '../weapon-view';
import { boxModel } from '../weapon-view';

const GRENADES = 16, BLASTS = 8, BLAST_S = 0.6, PUFF_S = 0.15;

interface Grenade { mesh: THREE.Mesh; player: PlayerId | null; at: Vec3; v: Vec3; t: number }
interface Blast { fire: THREE.Mesh; smoke: THREE.Mesh; r: number; t: number }

/** the grenade launcher's look: a puff at the muzzle, the grenade along the host's arc, a fireball and smoke where it
 * bursts (the crater is the world's edit) */
export function launcherView(): WeaponView {
  const group = new THREE.Group(), ball = new THREE.IcosahedronGeometry(1, 2);
  const shell = new THREE.MeshLambertMaterial({ color: 0x3a4030 });
  const fireMat = new THREE.MeshBasicMaterial({ color: 0xffb050, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const smokeMat = new THREE.MeshLambertMaterial({ color: 0x55504a, transparent: true, depthWrite: false });
  const puffMat = new THREE.MeshBasicMaterial({ color: 0xd8d0c0, transparent: true, depthWrite: false, opacity: 0.6 });
  const grenades: Grenade[] = [], blasts: Blast[] = [];
  for (let i = 0; i < GRENADES; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.2), shell);
    mesh.visible = false;
    group.add(mesh);
    grenades.push({ mesh, player: null, at: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, t: Infinity });
  }
  for (let i = 0; i < BLASTS; i++) {
    const fire = new THREE.Mesh(ball, fireMat.clone()), smoke = new THREE.Mesh(ball, smokeMat.clone());
    fire.visible = smoke.visible = false;
    group.add(fire, smoke);
    blasts.push({ fire, smoke, r: 0, t: Infinity });
  }
  const puff = new THREE.Mesh(ball, puffMat);
  puff.visible = false;
  group.add(puff);
  let puffT = Infinity, nextG = 0, nextB = 0;
  const p = new THREE.Vector3(), q = { x: 0, y: 0, z: 0 };

  return {
    id: 'launcher', group,
    event(e: WeaponEvent) {
      if (e.kind === 'launch') {
        const g = grenades[nextG++ % GRENADES];
        Object.assign(g, { player: e.player, at: { ...e.at }, v: { ...e.v }, t: 0 });
        g.mesh.visible = true;
      } else if (e.kind === 'blast') {
        // (the player's oldest grenade in the air is the one that burst)
        let g: Grenade | null = null;
        for (const c of grenades) if (c.player === e.player && c.t < Infinity && (!g || c.t > g.t)) g = c;
        if (g) { g.t = Infinity; g.mesh.visible = false; }
        const b = blasts[nextB++ % BLASTS];
        b.r = e.r; b.t = 0;
        b.fire.position.set(e.at.x, e.at.y, e.at.z);
        b.smoke.position.set(e.at.x, e.at.y, e.at.z);
        b.fire.visible = b.smoke.visible = true;
      }
    },
    fired(muzzle, dir) {
      puff.position.copy(muzzle).addScaledVector(dir, 0.15);
      puff.scale.setScalar(0.1);
      puff.visible = true;
      puffT = 0;
    },
    update(dt) {
      if (puff.visible) {
        puffT += dt;
        puff.scale.setScalar(0.1 + puffT * 2);
        (puff.material as THREE.MeshBasicMaterial).opacity = 0.6 * Math.max(0, 1 - puffT / PUFF_S);
        if (puffT >= PUFF_S) puff.visible = false;
      }
      for (const g of grenades) {
        if (g.t === Infinity) continue;
        g.t += dt;
        // (a blast never seen, the grenade far off: gone after its fuse)
        if (g.t > FUSE + 1) { g.t = Infinity; g.mesh.visible = false; continue; }
        flight(g.at, g.v, g.t, q);
        g.mesh.position.set(q.x, q.y, q.z);
        flight(g.at, g.v, g.t + 0.05, q);
        g.mesh.lookAt(p.set(q.x, q.y, q.z));
      }
      for (const b of blasts) {
        if (b.t === Infinity) continue;
        b.t += dt;
        const k = b.t / BLAST_S;
        if (k >= 1) { b.t = Infinity; b.fire.visible = b.smoke.visible = false; continue; }
        b.fire.scale.setScalar(b.r * (0.4 + 0.8 * Math.sqrt(k)));
        (b.fire.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - 1.6 * k);
        b.smoke.scale.setScalar(b.r * (0.6 + 0.9 * k));
        b.smoke.position.y += dt * 1.5;
        (b.smoke.material as THREE.MeshLambertMaterial).opacity = 0.7 * (1 - k);
      }
    },
    // a fat short tube on a drum and a grip, olive
    model: () => boxModel([
      [0x4a5236, [0, 0, 0.1], [0.11, 0.11, 0.5]],
      [0x2b2e26, [0, 0, 0.36], [0.13, 0.13, 0.04]],
      [0x3a3f2c, [0, -0.02, -0.08], [0.15, 0.15, 0.16]],
      [0x2b2e26, [0, -0.12, -0.1], [0.04, 0.12, 0.05]],
      [0x2b2e26, [0, -0.04, -0.26], [0.05, 0.08, 0.2]],
    ]),
  };
}
