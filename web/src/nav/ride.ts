import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Pose } from '../sim/contract/pose';
import type { Person } from '../sim/contract/agents';
import { vehicleOf } from '../sim/vehicles';
import type { Picked, StreetLife } from '../view/life';
import type { World } from '../core/world';
import type { Foot } from './foot';
import type { Glide } from './glide';
import type { MoveKeys } from './move-keys';
import type { Ride, WalkOpts } from './nav';

// The ride (nav.ts mode ride): following a pedestrian or a vehicle, and walking as the person followed. The local
// player's commands go to the world sim through its client (sim/sim-client.ts): follow (the sim keeps what is followed
// wherever it goes), enterSeat (the person's walker's seat; refused, the ride goes on following), seatInput (where the
// walk, which is the client's, puts them; the sim bounds it, and a pose it clamped puts the walk back where the sim has
// them), leaveSeat. Nav switches the modes; the car driven is drive.ts's (the driver's
// seat), on this ride's camera.

/** what the ride needs of Nav */
export interface RideHost {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly foot: Foot;
  readonly glide: Glide;
  readonly keys: MoveKeys;
  life(): StreetLife | null;
  world(): World | null;
  /** the ride changed (walking as the person began): Nav tells its listener */
  changed(R: Ride): void;
}

export class Rider {
  ride: Ride | null = null;
  /** the ride's camera; its shake is the driven car's (drive.ts) */
  readonly camera = new RideCamera();
  /** Space while following a person: become them, then jump */
  jumpAsked = false;
  // the person walked as (the local player's seat on them), while the ride lasts
  private walking: Person | null = null;

  constructor(private readonly host: RideHost) {}

  private get sim() { return this.host.life()?.client ?? null; }

  /** follow ag (what was walked let go) */
  start(ag: Picked) {
    this.release();
    this.ride = { ...ag, view: 'behind', dyaw: 0, dpitch: 0, idle: 0, zoom: 1 };
    this.sim?.send({ kind: 'follow', entity: { kind: ag.kind, id: ag.obj.id } });
  }

  /** the ride is over: nothing followed, nothing walked */
  leave() {
    this.ride = null;
    this.camera.reset();
    this.jumpAsked = false;
    this.release();
    this.sim?.send({ kind: 'follow', entity: null });
  }

  // off the person walked: back to the crowd's own walk (the sim no longer keeps them where put), and following them
  // again starts afresh from where they are (walkAs' start) instead of moving them to the foot's position
  release() {
    if (this.walking) this.sim?.send({ kind: 'leaveSeat' });
    this.walking = null;
  }

  /** out of the vehicle (a step to its side) or off the person, onto the street: where Nav walks to */
  exit(): WalkOpts {
    const R = this.ride, H = this.host, pose = R && H.life()?.pose(R.kind, R.obj);
    const f = H.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const p = pose ? new THREE.Vector3(pose.x, pose.y, pose.z) : H.camera.position.clone();
    if (R && pose && R.kind !== 'person') p.addScaledVector(new THREE.Vector3(Math.cos(pose.h), 0, -Math.sin(pose.h)), 2.0);
    return { at: p, facing: f, pitch: 0.05, ms: 500, exact: R?.kind === 'person' };
  }

  /** a frame of the ride before the sim's update: the walk's commands sent (walking as the person followed) */
  control(dt: number) {
    const R = this.ride!, H = this.host, life = H.life();
    // (the seat refused: walked by another, or gone from the crowd; a pose out of reach: the walk back where the sim
    // took it)
    if (life?.client.results('enterSeat', 'walker').some((r) => !r.ok)) this.walking = null;
    if (life?.client.results('seatInput', 'walker').some((r) => !r.ok) && this.walking) {
      const w = life.client.walkedPose(this.walking.id);
      if (w) H.foot.correct(w);
    }
    if (R.kind === 'person' && (H.keys.size || this.jumpAsked || this.walking === R.obj)) this.walkAs(dt);
  }

  /** a frame of the ride after the sim's update and the street's drawing (driving: the car driven): the camera placed
   * on the pose drawn this frame (placed before it, the camera trails the drawn car by a frame's distance, which
   * jumps on an uneven frame: docs/plans/smooth-motion-and-lag.md). What is followed left the map: the nearest one of
   * its kind to follow instead, or 'off' (none: onto the street) */
  place(dt: number, driving: boolean): Picked | 'off' | null {
    const R = this.ride!, H = this.host, life = H.life();
    const pose = life?.pose(R.kind, R.obj);
    if (!pose) return life?.nearest(R.kind, { x: H.camera.position.x, z: H.camera.position.z }, R.obj) ?? 'off';
    const { pos, q, look, fov } = this.camera.frame(R, pose, H.world(), driving, dt);
    H.glide.place(pos, q, fov, true, dt);
    H.controls.target.copy(H.camera.position).addScaledVector(look, 10);
    return null;
  }

  // walking as the person followed (foot.ts walkAs), through their eyes; they stay where left while the ride lasts
  // (release(): back to their own walk after)
  private walkAs(dt: number) {
    const R = this.ride!, o = R.obj, H = this.host, sim = this.sim;
    if (o.kind !== 'person' || !sim) return;
    if (this.walking !== o) {
      const p: Pose | null = H.life()!.pose('person', o);
      if (!p) return;
      this.release();
      sim.send({ kind: 'enterSeat', entity: { kind: 'person', id: o.id }, role: 'walker', pose: { ...p, moving: false } });
      this.walking = o;
      Object.assign(R, { label: 'you', view: 'eyes', dyaw: 0, dpitch: 0, zoom: 1 });
      H.glide.start(1100);
      H.changed(R);
      H.foot.startAs(p);
    }
    if (this.jumpAsked) { H.foot.jump(false); this.jumpAsked = false; }
    sim.send({ kind: 'seatInput', role: 'walker', input: H.foot.walkAs(R, dt) });
  }
}

// The ride camera: at the eyes (first person) or behind and above (chase), kept clear of what is between; the car
// driven (drive.ts) through it too, its height followed with a short lag and shaken by a crash. Nav glides the camera
// there (glide.ts).
export class RideCamera {
  /** the driven car's camera: shaken by a crash, dipped by a splash (drive.ts) */
  readonly shake = new THREE.Vector3();
  private y: number | null = null;

  /** the ride is over: the next starts afresh */
  reset() { this.y = null; }

  /** where the camera goes following R at pose (driving: the car driven) */
  frame(R: Ride, pose: Pose, world: World | null, driving: boolean, dt: number) {
    if (driving && R.view === 'behind') {
      // through jumps, drops and landings the chase camera's height follows the car with a short lag
      const y = this.y;
      this.y = y == null || Math.abs(pose.y - y) > 40 ? pose.y : y + (pose.y - y) * (1 - Math.exp(-9 * dt));
      pose.y = this.y;
    } else this.y = null;
    const { pos, look, fov } = rideCamera(R, pose, world, dt);
    if (driving) pos.add(this.shake);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, pos.clone().add(look), new THREE.Vector3(0, 1, 0)));
    return { pos, q, look, fov };
  }
}

// where the camera sits: at the eyes (first person) or behind and above (chase)
const RIG = {
  person: { eye: [1.62, 0.2], back: 4.5, up: 2.2, fov: 65 },
  car: { eye: [1.3, 2.45], fov: 62 }, // dashcam just past the bonnet
};

function rideCamera(R: Ride, pose: Pose, world: World | null, dt: number) {
  const rig = RIG[R.kind], h = pose.h;
  const fw = new THREE.Vector3(Math.sin(h), 0, Math.cos(h)), base = new THREE.Vector3(pose.x, pose.y, pose.z);
  // looking around springs back to straight ahead a few seconds after letting go (vehicles turn under you): at
  // 1.2 /s, as 2 % a frame at 60 fps
  if (R.kind !== 'person' && performance.now() - R.idle > 5000) { const k = Math.exp(-1.2 * dt); R.dyaw *= k; R.dpitch *= k; }
  const yaw = h + R.dyaw, pitch = (R.view === 'eyes' ? -0.04 : -0.22) + R.dpitch;
  const look = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  if (R.view === 'eyes') {
    const bus = R.obj.kind === 'car' && R.obj.bus ? R.obj : null;
    const ahead = bus ? bus.len / 2 + 0.25 : rig.eye[1], up = bus ? 2.3 : rig.eye[0];
    return { pos: base.clone().addScaledVector(fw, ahead).setY(base.y + up), look, fov: THREE.MathUtils.clamp(rig.fov * R.zoom, 25, 80) };
  }
  // (zoomed: further back and higher up alike, the same angle down)
  const chase = R.obj.kind === 'car' ? vehicleOf(R.obj).chase : RIG.person;
  const back = chase.back * R.zoom, high = chase.up * R.zoom;
  const pos = base.clone().addScaledVector(new THREE.Vector3(look.x, 0, look.z).normalize(), -back);
  pos.y = base.y + high;
  return { pos: world ? clearOf(world, base, pos, high, R.kind === 'person' ? 1.5 : 4.5) : pos, look, fov: 55 };
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
  return eye.addScaledVector(d, Math.min(L, Math.max(minDist, t - 0.8)));
}
