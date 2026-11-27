import * as THREE from 'three';
import type { CraftView } from '../../client/sim-client';
import { WRECK_COL } from '../../sim/contract/agents';
import type { CraftType } from '../../sim/contract/ids';
import type { CoreOf } from '../../sim/craft/cores';
import { wreckSmoke } from '../wreck-smoke';
import type { CraftFrame, CraftLook } from './craft-look';

// A wreck charred as a car wreck is, its lamps out, and smoking. Every look is wrapped once, so a look itself only
// stops what turns on it. Charring swaps each mesh's material for a charred copy of it (kept by the original, shared
// between frames): the draw calls stay as they were.

const CHAR = new THREE.Color(WRECK_COL);
// (multiplied by a vertex-coloured model's own colours: about CHAR on its light parts, darker on its dark ones)
const SOOT = new THREE.Color(WRECK_COL).multiplyScalar(2.2);
const BLACK = new THREE.Color(0);
// the smoke's size by the craft's (1: a car's)
const SMOKE: Partial<Record<CraftType, number>> = { drone: 0.2, paraglider: 0.5 };

type Lit = THREE.Material & { color?: THREE.Color; emissive?: THREE.Color; vertexColors: boolean };
const charredOf = new WeakMap<THREE.Material, Lit>();

function charred(m: THREE.Material) {
  let c = charredOf.get(m);
  if (!c) charredOf.set(m, c = m.clone() as Lit);
  // (every frame: a look sets its lamps' colours on the material its mesh holds)
  c.color?.copy(m.blending === THREE.AdditiveBlending ? BLACK : c.vertexColors ? SOOT : CHAR);
  c.emissive?.copy(BLACK);
  c.opacity = m.opacity;
  return c;
}

class Wrecked<K extends CraftType> implements CraftLook<K> {
  // the meshes charred, by their own materials
  private readonly swapped = new Map<THREE.Mesh, THREE.Material>();

  constructor(private readonly look: CraftLook<K>, private readonly type: K) {}

  get group() { return this.look.group; }
  get anchor() { return this.look.anchor; }

  draw(c: CraftView<CoreOf<K>>, f: CraftFrame) {
    this.look.draw(c, f);
    const S = this.swapped;
    if (c.wreck) {
      this.look.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material)) return;
        const own = S.get(mesh) ?? mesh.material as THREE.Material;
        S.set(mesh, own);
        mesh.material = charred(own);
      });
      const at = (this.look.anchor ?? this.look.group).position, k = SMOKE[this.type] ?? 1;
      if (this.look.group.visible) wreckSmoke.at(`craft:${c.id}`, at.x, at.y + k, at.z, k);
    } else if (S.size) {
      for (const [mesh, own] of S) mesh.material = own;
      S.clear();
    }
  }

  hide() { this.look.hide(); }
}

/** look drawn charred and smoking while its craft is a wreck */
export const wrecked = <K extends CraftType>(type: K, look: CraftLook<K>): CraftLook<K> => new Wrecked(look, type);
