import { Vector3 } from 'three';
import type { StreetLife } from '../sim/life';
import type { Car, Person, Pose } from '../sim/types';
import type { CarBuild, CarInput } from '../physics/rapier/car';
import type { DrawnPose, Obstacle, RapierDrive, Walker } from '../physics/rapier/drive-world';

// One drive of a traffic car on Rapier (physics/rapier/drive-world.ts), between the car's world and the street life:
// what the car meets (the traffic and the people near it), what that does to them (a car knocked out of the traffic, a
// person knocked down), the river (a splash, then back on the road a little way back), a crash landing (no control
// for a moment), and the Car drawn where the body is. No DOM: the drive mode (drive.ts) gives it the input and the
// clock and shows its notes; tools/rapier-car.mjs runs it headless (physics/rapier/drive-scenarios.ts).

export const SINK_MS = 2000; // in the river this long, then back on the road
export const CRASH_MS = 1100; // after a crash landing: shaken, no input
const FALLEN_R = 35; // m: people knocked down lie there until the car is this far away (life.ts knockDown)
const SAFE_EVERY_MS = 400, SAFE_KEEP = 16; // where the car was on the road: every so often, the last so many
const BACK_M = 12; // back on the road this far before where it left it
export const NO_INPUT: CarInput = { gas: 0, brake: 0, steer: 0, handbrake: false };

// what the drive needs of the street life
export type DriveLife = Pick<StreetLife, 'roadVehicles' | 'people' | 'riders' | 'takeWheel' | 'knockDown' | 'clearFallen'>;
// a message for the player: shown for `ms`
export interface Note { text: string; ms: number }

export class DriveSession {
  // recent poses on the road (on its wheels, on the ground, no water under it), to come back to from the river
  safe: { pose: Pose; t: number }[] = [];
  sinkUntil = 0;
  crashUntil = 0;
  waiting = false; // the car's ground not built yet: held still
  private input: CarInput = NO_INPUT;

  // `start`: the car as it is drawn now (a car parked on its side or roof is taken as it lies)
  constructor(readonly life: DriveLife, readonly car: Car, readonly rap: RapierDrive, private readonly build: CarBuild, start: DrawnPose, now: number) {
    rap.begin(start, car.v, build);
    // (where it was taken: a traffic car's place on the road, upright)
    this.safe.push({ pose: { x: start.x, y: start.y, z: start.z, h: start.h }, t: now });
  }

  // is the player's input ignored now (sinking, shaken by a crash)?
  held(now: number) { return now < this.sinkUntil || now < this.crashUntil; }

  get kmh() { return this.rap.car?.kmh ?? 0; }

  // One frame of `dt` s at `now` (ms): returns what to tell the player.
  update(dt: number, input: CarInput, now: number): Note[] {
    const { life, car, rap } = this, notes: Note[] = [];
    if (this.sinkUntil && now >= this.sinkUntil) { this.respawn(); return notes; }
    this.input = this.held(now) ? NO_INPUT : input;
    const p = car.rp;
    const obstacles: Obstacle[] = [];
    for (const other of life.roadVehicles()) {
      const q = other.rp;
      if (other === car || !q || (p && (Math.abs(q.x - p.x) > 40 || Math.abs(q.z - p.z) > 40))) continue;
      obstacles.push({ key: other, x: q.x, y: q.y, z: q.z, h: other.rh ?? 0, len: other.len, bus: other.bus });
    }
    // the people near it, walking or cycling (not one being walked by the player)
    const walkers: Walker[] = [];
    for (const list of [life.people, life.riders]) for (const q of list) {
      if (!q.rp || q.ctl || (p && (Math.abs(q.rp.x - p.x) > 15 || Math.abs(q.rp.z - p.z) > 15))) continue;
      walkers.push({ key: q, x: q.rp.x, y: q.rp.y, z: q.rp.z });
    }
    if (p) life.clearFallen(p.x, p.z, FALLEN_R);
    const events = rap.update(dt, this.input, obstacles, walkers);
    this.waiting = events === 'loading';
    if (events === 'loading') return notes;
    for (const e of events) {
      if (e.kind === 'knock') {
        // (out of the traffic: it lies where it is knocked to)
        life.takeWheel(e.key as Car);
        notes.push({ text: 'Crash!', ms: 600 });
      } else if (e.kind === 'person') {
        // (shoved away along the hit and laid down flat: no physics)
        if (life.knockDown(e.key as Person, e.vx, e.vz)) notes.push({ text: 'Ouch!', ms: 600 });
      } else if (e.kind === 'impact' && e.speed > 2) notes.push({ text: 'Contact', ms: 350 });
      else if (e.kind === 'landing') {
        if (e.crash) { this.crashUntil = now + CRASH_MS; notes.push({ text: 'Crash!', ms: CRASH_MS }); }
        else if (e.speed > 6) notes.push({ text: 'Hard landing', ms: 700 });
      }
    }
    if (rap.car?.status === 'water' && !this.sinkUntil) {
      this.sinkUntil = now + SINK_MS;
      notes.push({ text: 'Splash! Back on the road in a moment…', ms: SINK_MS });
    }
    const d = rap.drawn(), last = this.safe.at(-1);
    if (d && (!last || now - last.t > SAFE_EVERY_MS) && this.onRoad(d)) {
      this.safe.push({ pose: { x: d.x, y: d.y, z: d.z, h: d.h }, t: now });
      if (this.safe.length > SAFE_KEEP) this.safe.shift();
    }
    return notes;
  }

  // The car (and the traffic cars it knocked away) drawn where their bodies are
  present() {
    const { car, rap } = this, d = rap.drawn();
    for (const [key, w] of rap.wrecks()) {
      const c = key as Car;
      (c.rp ??= new Vector3()).set(w.x, w.y, w.z);
      Object.assign(c, { rh: w.h, pitch: w.pitch, roll: w.roll, v: 0, brake: 1 });
    }
    if (d) {
      (car.rp ??= new Vector3()).set(d.x, d.y, d.z);
      Object.assign(car, { rh: d.h, pitch: d.pitch, roll: d.roll });
      car.v = this.kmh / 3.6;
    }
    car.brake = this.input.brake > 0 || this.input.handbrake ? 1 : 0;
  }

  // The drive ends: in the river, back on the road first; anywhere else the car stays as it comes to rest (on its
  // roof too, or in the air: where it lands)
  park() {
    const { rap, car } = this;
    if (this.sinkUntil || rap.car?.status === 'water') this.respawn();
    else rap.settle();
    this.present();
    rap.end();
    car.v = 0;
    car.brake = 1;
  }

  // Safe to come back to: on its wheels, upright, out of the water, on the ground (the city's, not a car's roof: the
  // terrain's surface under it within a metre of the wheels' ground) with no water under it
  private onRoad(d: DrawnPose) {
    const rap = this.rap;
    if (!rap.onWheels || rap.car?.status !== 'ok') return false;
    const g = rap.terrain.groundAt(d.x, d.z, d.y + 0.5, true);
    return g !== null && Math.abs(g - d.y) < 1 && rap.terrain.waterAt(d.x, d.z) < 0;
  }

  // back where the car last was on the road, some BACK_M m before where it left it, standing still
  private respawn() {
    const safe = this.safe, edge = safe.at(-1)?.pose;
    const i = edge ? safe.findLastIndex((s) => Math.hypot(s.pose.x - edge.x, s.pose.z - edge.z) > BACK_M) : -1;
    const pose = safe[Math.max(0, i)]?.pose ?? edge;
    this.safe = safe.slice(0, Math.max(1, i + 1));
    this.sinkUntil = 0;
    this.crashUntil = 0;
    if (!pose) return;
    this.rap.begin({ ...pose, pitch: 0, roll: 0 }, 0, this.build);
    (this.car.rp ??= new Vector3()).set(pose.x, pose.y, pose.z);
    Object.assign(this.car, { rh: pose.h, pitch: 0, roll: 0 });
  }
}
