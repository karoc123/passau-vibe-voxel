import * as THREE from 'three';
import type { World } from './core/world';
import { el } from './util';

const BEAM_H = 600; // m: over every roof and hill, seen from across the city
const COLOR = 0xff4fd8;

/** The page's own waypoint (never sent to the host): set from either map, shown on both, as a beam over the spot in
 * the city and as its distance and direction at the top of the screen (a click there clears it). */
export class Waypoint {
  at: { x: number; z: number } | null = null;
  /** bumped on each change (the maps redraw) */
  version = 0;
  private readonly beam: THREE.Mesh;
  private readonly chip = el('button', '', '<span class="arrow">▲</span><span class="d"></span><span class="x">×</span>');
  private readonly dist = this.chip.querySelector('.d') as HTMLElement;
  private readonly arrow = this.chip.querySelector('.arrow') as HTMLElement;
  private shown = '';
  private turn = NaN;

  constructor(scene: THREE.Scene) {
    // (fog off: the beam is a marker, not a thing in the haze; no depth written: it never hides what is behind it)
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, true).translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.6, depthWrite: false, fog: false, side: THREE.DoubleSide });
    this.beam = new THREE.Mesh(geo, mat);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 10;
    scene.add(this.beam);
    this.chip.id = 'waypoint-chip';
    this.chip.type = 'button';
    this.chip.title = 'Waypoint: click or Backspace to clear';
    this.chip.hidden = true;
    this.chip.addEventListener('click', () => { this.chip.blur(); this.clear(); });
  }

  set(x: number, z: number) { this.at = { x, z }; this.version++; }
  clear() { if (!this.at) return; this.at = null; this.version++; }

  /** a click on a map at (x, z): on the waypoint (within r m) clears it, elsewhere sets it there */
  toggleAt(x: number, z: number, r: number) {
    if (this.at && Math.hypot(this.at.x - x, this.at.z - z) <= r) this.clear();
    else this.set(x, z);
  }

  /** the frame's beam and distance: from the player's pose, seen from the camera */
  update(camera: THREE.Camera, pose: { x: number; z: number; h: number }, world: World | null) {
    const at = this.at;
    this.beam.visible = !!at;
    this.chip.hidden = !at;
    if (!at) return;
    const p = camera.position, b = this.beam;
    // (as wide as a few pixels at any distance, never thinner than a lamp post)
    const w = Math.max(0.8, Math.hypot(at.x - p.x, at.z - p.z) * 0.004);
    b.position.set(at.x, world ? world.groundAt(at.x, at.z) : 0, at.z);
    b.scale.set(w, BEAM_H, w);
    const d = Math.hypot(at.x - pose.x, at.z - pose.z);
    const text = d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`;
    if (text !== this.shown) { this.shown = text; this.dist.textContent = text; }
    // the arrow: the waypoint's bearing against the heading (h grows to the left, the screen's rotation to the right)
    const turn = Math.round((pose.h - Math.atan2(at.x - pose.x, at.z - pose.z)) * 180 / Math.PI);
    if (turn !== this.turn) { this.turn = turn; this.arrow.style.transform = `rotate(${turn}deg)`; }
  }
}
