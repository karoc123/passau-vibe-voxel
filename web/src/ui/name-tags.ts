import * as THREE from 'three';
import type { MapMark } from '../minimap';
import { el } from '../util';

// The other players' names over them (an avatar, the car driven, the craft flown), as the maps mark them. Only a name
// chosen: an id over a figure says nothing a player can use.

/** farther than this (m) a name is left out: too small to read, and the crowd of them would hide the city */
const NAME_FAR = 150;
// (over the feet or the craft's middle: above a walker's head, a car's roof)
const ABOVE = 2.4;

export class NameTags {
  private readonly box = el('div', '');
  private readonly tags = new Map<string, HTMLDivElement>();
  private readonly v = new THREE.Vector3();

  constructor() { this.box.id = 'name-tags'; }

  /** each frame after the draw: the names of others within NAME_FAR m in front of the camera */
  update(camera: THREE.Camera, others: readonly MapMark[]) {
    const seen = new Set<string>(), w = innerWidth, h = innerHeight, cp = camera.position;
    for (const o of others) {
      if (o.label === o.player || seen.has(o.player)) continue;
      const v = this.v.set(o.x, o.y + ABOVE, o.z);
      if (v.distanceTo(cp) > NAME_FAR) continue;
      v.project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
      seen.add(o.player);
      let t = this.tags.get(o.player);
      if (!t) { t = el('div', 'name-tag', '', this.box); this.tags.set(o.player, t); }
      if (t.textContent !== o.label) t.textContent = o.label;
      t.style.transform = `translate(${((v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v.y) / 2 * h).toFixed(1)}px) translate(-50%, -100%)`;
    }
    for (const [p, t] of this.tags) if (!seen.has(p)) { t.remove(); this.tags.delete(p); }
  }

  /** the names shown now, by player (the tools) */
  shown(): Record<string, string> { return Object.fromEntries([...this.tags].map(([p, t]) => [p, t.textContent ?? ''])); }
}
