import type * as THREE from 'three';
import type { WorldSim } from '../sim/world-sim';
import type { Meta } from '../types';
import type { Pose } from '../sim/types';
import type { Nav } from './nav';
import type { RiverPoints } from '../sim/river';

// A craft the player gets into (docs/plans/code-health.md item 10): the drone (fpv.ts), the car (drive.ts), the boat
// (boat.ts), the floatplane and the jet (plane.ts). Each is one class made from a CraftContext and listed once in
// main.ts (CRAFTS); Nav knows only this interface. A craft gets in through Nav (nav.enterCraft) and Nav lets it know
// when it is left, whatever leaves it (Esc, the map, a search, a walk, another craft): leave(), once.
//
// Two kinds, by `view`:
//   'own':  it owns the camera and the input (the drone, the boat, the plane); Nav leaves keys, pointer and wheel to it
//           and is in its mode 'craft'. Entered from the map or a ride.
//   'ride': Nav's ride camera follows it and Nav's look and zoom gestures stay on (the car). It takes the ride being
//           followed (Nav's mode stays 'ride').
// Which craft is on is body[data-mode] (its id; main.ts), for its CSS.

/** where to get in: x, z, heading h (0: +z, pi/2: +x), and a height for one that starts in the air */
export interface CraftSpot { x: number; y?: number; z: number; h: number }

export interface PlayerCraft {
  /** body[data-mode] while it is on (its CSS) */
  readonly id: string;
  readonly view: 'own' | 'ride';
  /** simulation position and heading while active (the ride itself supplies a drive's pose) */
  readonly mapPose?: Pose | null;
  /** get in: at a spot (tools; later F2, walking up to it) or, without one, where the view is. false: not now */
  enter(at?: CraftSpot): boolean;
  /** it has been left (Nav calls this once, from whatever left it): let go of everything, hide what it showed */
  leave(): void;
  /** every frame, on or not (its panel) */
  update(dt: number): void;
}

/** the light and the rivers' points, for the crafts on the water */
export interface CraftEnv {
  /** 0 by day .. 1 by night (daylight.ts) */
  night: () => number;
  /** the river's points (river.ts); null while not loaded */
  river: () => RiverPoints | null;
}

/** what every craft is made from (main.ts) */
export interface CraftContext {
  nav: Nav;
  camera: THREE.PerspectiveCamera;
  /** the map's focus (OrbitControls' target): a craft keeps it ahead of the camera, as the shadows and fog read it */
  target: THREE.Vector3;
  meta: Meta;
  /** the bar's mode tools, where its panel goes */
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  env: CraftEnv;
  /** the world sim, once the traffic is loaded: the drive's commands go to it, keyed by player id */
  sim: Promise<WorldSim>;
  deployGlider: (source: PlayerCraft, at: CraftSpot) => boolean;
}
