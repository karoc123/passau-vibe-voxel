// Driving state advanced by the world tick, including crashes and the trail used by resets.
import { SafeTrail } from '../../core/safe-trail';
import type { Car, RoadPose } from '../../sim/types';
import type { CarEvent, CarInput } from './car';

export const SINK_MS = 2000, CRASH_MS = 1100, FALL_MS = 1600;
export const NO_INPUT: Readonly<CarInput> = { gas: 0, brake: 0, steer: 0, handbrake: false };
export const PARK: Readonly<CarInput> = { ...NO_INPUT, handbrake: true };
const FALL_IMPACT = 7, BACK_M = 12;

export interface DriveNote { tick: number; text: string; ms: number }
export interface DriverSnapshot {
  tick: number;
  entityId: number;
  pose: RoadPose;
  kmh: number;
  waiting: boolean;
  onWheels: boolean;
  status: 'ok' | 'water';
  sinkMs: number;
  crashMs: number;
  fallMs: number;
}

export class PlayerCar {
  readonly safe = new SafeTrail<RoadPose>(400, 16);
  readonly notes: DriveNote[] = [];
  input: CarInput = NO_INPUT;
  sinkUntil = 0;
  crashUntil = 0;
  fallUntil = 0;
  fallSide = 1;
  waiting = true;

  constructor(readonly car: Car, start: RoadPose, now: number) {
    this.safe.push({ ...start, pitch: 0, roll: 0 }, now);
  }

  held(now: number) { return now < this.sinkUntil || now < this.crashUntil || now < this.fallUntil; }

  recoveryDue(now: number) {
    return (this.sinkUntil > 0 && now >= this.sinkUntil) || (this.fallUntil > 0 && now >= this.fallUntil);
  }

  recoveryPose() {
    const edge = this.safe.newest!;
    const i = this.safe.find((p) => Math.hypot(p.x - edge.x, p.z - edge.z) > BACK_M);
    this.sinkUntil = this.fallUntil = this.crashUntil = 0;
    const pose = this.safe.get(Math.max(0, i)) ?? edge;
    this.safe.cut(Math.max(1, i + 1));
    return pose;
  }

  note(tick: number, text: string, ms: number) {
    if (this.notes.length === 16) this.notes.shift();
    this.notes.push({ tick, text, ms });
  }

  fall(tick: number, now: number, lean: number) {
    this.fallUntil = now + FALL_MS;
    this.fallSide = lean < 0 ? -1 : 1;
    this.note(tick, 'Crash! You came off the bike', FALL_MS);
  }

  contact(tick: number, now: number, event: CarEvent | { kind: 'knock'; speed: number }, bike: boolean, lean: number) {
    const { kind, speed } = event;
    if (bike && !this.fallUntil && ((kind === 'landing' && event.crash) || ((kind === 'impact' || kind === 'knock') && speed >= FALL_IMPACT))) {
      this.fall(tick, now, lean);
    } else if (kind === 'knock') this.note(tick, 'Crash!', 600);
    else if (kind === 'impact' && speed > 2) this.note(tick, 'Contact', 350);
    else if (kind === 'landing') {
      if (event.crash) { this.crashUntil = now + CRASH_MS; this.note(tick, 'Crash!', CRASH_MS); }
      else if (speed > 6) this.note(tick, 'Hard landing', 700);
    }
  }
}
