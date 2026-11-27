import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Pose } from '../sim/contract/pose';
import { vehicleOf } from '../sim/vehicles';
import { EYE } from '../sim/figure';
import type { SimClient } from '../client/sim-client';
import type { Rideable } from '../sim/types';
import type { Picked, StreetLife } from '../view/life';
import type { World } from '../core/world';
import type { Glide } from './glide';
import type { Ride, WalkOpts } from './nav';

// The ride (nav.ts mode ride): following a pedestrian or a vehicle. The local player's command goes to the world sim
// through its client (client/sim-client.ts): follow (the sim keeps what is followed wherever it goes). Walking off a
// person followed is the player's own avatar where they stood (Nav), never the person: on foot a player is never one
// of the crowd (owner). Nav switches the modes; the car driven is drive.ts's (the driver's seat), on this ride's camera.

/** what the ride needs of Nav */
export interface RideHost {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly glide: Glide;
  life(): StreetLife | null;
  /** the world sim's client (the local player's commands, reads) */
  sim(): SimClient | null;
  world(): World | null;
}

export class Rider {
  ride: Ride | null = null;
  /** the ride's camera; its shake is the driven car's (drive.ts) */
  readonly camera = new RideCamera();

  constructor(private readonly host: RideHost) {}

  private get sim() { return this.host.sim(); }

  /** follow ag */
  start(ag: Picked) {
    this.ride = { ...ag, view: 'behind', dyaw: 0, dpitch: 0, idle: 0, zoom: 1 };
    this.sim?.send({ kind: 'follow', entity: { kind: ag.ref.kind, id: ag.ref.id } });
  }

  /** the ride is over: nothing followed */
  leave() {
    this.ride = null;
    this.camera.reset();
    this.sim?.send({ kind: 'follow', entity: null });
  }

  /** out of the vehicle (a step to its side) or off the person, onto the street: where Nav walks to */
  exit(): WalkOpts {
    const R = this.ride, H = this.host, pose = R && H.life()?.pose(R.ref);
    const f = H.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const p = pose ? new THREE.Vector3(pose.x, pose.y, pose.z) : H.camera.position.clone();
    if (R && pose && R.ref.kind !== 'person') p.addScaledVector(new THREE.Vector3(Math.cos(pose.h), 0, -Math.sin(pose.h)), 2.0);
    return { at: p, facing: f, pitch: 0.05, ms: 500, exact: R?.ref.kind === 'person' };
  }

  /** a frame of the ride after the sim's update and the street's drawing (driving: the car driven): the camera placed
   * on the pose drawn this frame (placed before it, the camera trails the drawn car by a frame's distance, which
   * jumps on an uneven frame: docs/plans/smooth-motion-and-lag.md). What is followed left the map: the nearest one of
   * its kind to follow instead, or 'off' (none: onto the street) */
  place(dt: number, driving: boolean): Picked | 'off' | null {
    const R = this.ride!, H = this.host, life = H.life();
    const pose = life?.pose(R.ref);
    if (!pose) return life?.nearest(R.ref.kind, { x: H.camera.position.x, z: H.camera.position.z }, R.ref) ?? 'off';
    const { pos, q, look, fov } = this.camera.frame(R, life!.agent(R.ref)!, pose, H.world(), driving, dt);
    H.glide.place(pos, q, fov, true, dt);
    H.controls.target.copy(H.camera.position).addScaledVector(look, 10);
    return null;
  }
}

// The ride camera: at the eyes (first person) or behind and above (chase), kept clear of what is between; the car
// driven (drive.ts) through it too, its height followed with a short lag and shaken by a crash. Nav glides the camera
// there (glide.ts).
class RideCamera {
  /** the driven car's camera: shaken by a crash, dipped by a splash (drive.ts) */
  readonly shake = new THREE.Vector3();
  private y: number | null = null;

  /** the ride is over: the next starts afresh */
  reset() { this.y = null; }

  /** where the camera goes following R (agent: what it is now) at pose (driving: the car driven) */
  frame(R: Ride, agent: Readonly<Rideable>, pose: Pose, world: World | null, driving: boolean, dt: number) {
    if (driving && R.view === 'behind') {
      // through jumps, drops and landings the chase camera's height follows the car with a short lag
      const y = this.y;
      this.y = y == null || Math.abs(pose.y - y) > 40 ? pose.y : y + (pose.y - y) * (1 - Math.exp(-9 * dt));
      pose.y = this.y;
    } else this.y = null;
    const { pos, look, fov } = rideCamera(R, agent, pose, world, dt);
    if (driving) pos.add(this.shake);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, pos.clone().add(look), new THREE.Vector3(0, 1, 0)));
    return { pos, q, look, fov };
  }
}

// where the camera sits: at the eyes (first person) or behind and above (chase)
const RIG = {
  person: { eye: [EYE, 0.2], back: 4.5, up: 2.2, fov: 65 }, // (a passer-by's eyes: the figure's)
  car: { eye: [1.3, 2.45], fov: 62 }, // dashcam just past the bonnet
};

function rideCamera(R: Ride, agent: Readonly<Rideable>, pose: Pose, world: World | null, dt: number) {
  const rig = RIG[R.ref.kind], h = pose.h;
  const fw = new THREE.Vector3(Math.sin(h), 0, Math.cos(h)), base = new THREE.Vector3(pose.x, pose.y, pose.z);
  // looking around springs back to straight ahead a few seconds after letting go (vehicles turn under you): at
  // 1.2 /s, as 2 % a frame at 60 fps
  if (R.ref.kind !== 'person' && performance.now() - R.idle > 5000) { const k = Math.exp(-1.2 * dt); R.dyaw *= k; R.dpitch *= k; }
  const yaw = h + R.dyaw, pitch = (R.view === 'eyes' ? -0.04 : -0.22) + R.dpitch;
  const look = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  if (R.view === 'eyes') {
    const bus = agent.kind === 'car' && agent.bus ? agent : null;
    const ahead = bus ? bus.len / 2 + 0.25 : rig.eye[1], up = bus ? 2.3 : rig.eye[0];
    return { pos: base.clone().addScaledVector(fw, ahead).setY(base.y + up), look, fov: THREE.MathUtils.clamp(rig.fov * R.zoom, 25, 80) };
  }
  // (zoomed: further back and higher up alike, the same angle down)
  const chase = agent.kind === 'car' ? vehicleOf(agent).chase : RIG.person;
  const back = chase.back * R.zoom, high = chase.up * R.zoom;
  const pos = base.clone().addScaledVector(new THREE.Vector3(look.x, 0, look.z).normalize(), -back);
  pos.y = base.y + high;
  return { pos: world ? clearOf(world, base, pos, high, R.ref.kind === 'person' ? 1.5 : 4.5) : pos, look, fov: 55 };
}

// keep the chase camera clear: under a deck or a tree drop lower first, only then pull in towards the agent
function clearOf(world: World, base: THREE.Vector3, pos: THREE.Vector3, up: number, minDist: number) {
  const eye = base.clone().setY(base.y + 1.5);
  const clear = (p: THREE.Vector3) => { const d = p.clone().sub(eye), L = d.length(); return world.raycast(eye, d.divideScalar(L), L) >= L - 0.3; };
  if (clear(pos)) return pos;
  for (const f of [0.6, 0.35]) {
    const p = pos.clone().setY(base.y + Math.max(2.2, up * f));
    if (clear(p)) return p;
  }
  const d = pos.clone().sub(eye), L = d.length(), t = world.raycast(eye, d.divideScalar(L), L);
  if (t - 0.8 >= minDist) return eye.addScaledVector(d, Math.min(L, t - 0.8));
  // backed up to a wall: kept minDist out the camera stood in it or behind it, and the view went on through the wall;
  // so in front of it (0.8 m: the near plane's corners ~0.7 m out), raised over the car as far as is clear
  const p = eye.addScaledVector(d, Math.max(0, t - 0.8));
  p.y += Math.max(0, Math.min(base.y + up - p.y, world.raycast(p, UP, up + 1) - 0.8));
  return p;
}
const UP = new THREE.Vector3(0, 1, 0);
