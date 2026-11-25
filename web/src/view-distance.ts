import type * as THREE from 'three';
import type { installCity } from './city';
import type { Daylight } from './daylight';
import { DIST_MAX, DIST_MIN, type Settings } from './settings';

type City = Awaited<ReturnType<typeof installCity>>;

// The view distance now: the setting, but no less than VIEW_PER_HEIGHT times the camera's height over the ground (in
// 100 m steps), so that from high up (the whole map's view, 2.5 km over it) the city below is not all haze. A street,
// Oberhaus, the overview (~560 m up) keep the setting.
const VIEW_PER_HEIGHT = 1.2, WHOLE_START = 0.75;
// 'Whole map' (dist 0) is DIST_MAX (5 km), so that on a large map it no longer loads all of it; its fog starts late.
// Within what the budget affords (city.ts affordable): the coarsest level's nodes in range at most half the budget (as
// detail 0 is twice the whole map's), the rest for the splits nearest and in view. Only a phone's ceiling ever makes it
// bite (on a desktop the budget is at least twice the whole map at 8 m); the camera's height still widens it (the
// overview: the whole map at 8 m). It shrinks at once and grows again only by AFFORD_STEP, not to and fro as the
// camera moves; never under DIST_MIN.
const AFFORD_STEP = 300;
// The far plane: out to the map's furthest corner from the camera (the far ground stands to the map's edge, faintly
// through the view distance's fog: farground.ts), within FAR_PER_CUT times the view distance where there is one, and
// within the weather fog's far end (daylight.setFogFrom: past it all is the fog's colour; in clear weather it lies
// beyond Passau's map from anywhere in it, so on a larger map the far plane, with 'whole map', no longer grows with
// the map), and never inside the sky's sphere (sky.ts, 6000 m). In FAR_STEP steps, so that it seldom changes (the depth's scale with
// it: the TAA's history, the occlusion's horizons).
const SKY_R = 6000, FAR_PER_CUT = 4, FAR_STEP = 500;

export interface ViewDistanceDeps {
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  map: THREE.Box3;
  daylight: Daylight;
  gfx: Settings;
  city: () => City | null;
  budget: () => number;
}

// the view distance handed to the city and the daylight's fog, and the camera's far plane
export class ViewDistance {
  private cutNow = -1;
  private affordNow = Infinity;
  constructor(private readonly d: ViewDistanceDeps) {}

  // (the view distance handed to the city on the next frame)
  reset() { this.cutNow = -1; }

  update(above: number) {
    const { gfx, city, budget, daylight } = this.d;
    const a = Math.max(DIST_MIN, city()?.affordable(budget() / 2) ?? Infinity);
    if (a < this.affordNow || a >= this.affordNow + AFFORD_STEP) this.affordNow = a;
    const want = gfx.now.dist || DIST_MAX, d = Math.min(want, this.affordNow), c = Math.max(d, Math.ceil((above * VIEW_PER_HEIGHT) / 100) * 100);
    if (c === this.cutNow) return;
    this.cutNow = c;
    daylight.setCut(c, gfx.now.dist || d < want ? undefined : WHOLE_START);
    city()?.setDist(c);
  }

  fitFar() {
    const { map, camera, scene } = this.d, cutNow = this.cutNow;
    if (map.isEmpty()) return;
    const p = camera.position;
    const reach = Math.hypot(Math.max(p.x - map.min.x, map.max.x - p.x), Math.max(p.y - map.min.y, map.max.y - p.y), Math.max(p.z - map.min.z, map.max.z - p.z));
    const fogFar = (scene.fog as THREE.Fog | null)?.far ?? Infinity;
    const want = Math.max(SKY_R + FAR_STEP, Math.min(reach, cutNow > 0 ? cutNow * FAR_PER_CUT : Infinity, fogFar));
    const far = Math.ceil(want / FAR_STEP) * FAR_STEP;
    if (far === camera.far) return;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}
