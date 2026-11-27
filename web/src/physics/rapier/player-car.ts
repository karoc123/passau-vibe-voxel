// Driving state advanced by the world tick, including crashes and the trail used by resets.
import { SafeTrail } from '../../core/safe-trail';
import type { Car } from '../../sim/types';
import { NO_INPUT, type CarInput } from '../../sim/contract/inputs';
import type { RoadPose } from '../../sim/contract/pose';
import { CRASH_MS, FALL_MS } from '../../sim/contract/snapshot';
import type { DriveNote, FallCause } from '../../sim/contract/events';
import type { CarEvent } from './car';

// a hit throws the rider off a bike when it costs FALL_HEAD (m/s) along the bike's heading in one step (head on into a
// wall from ~30 km/h; a glancing scrape or a nudge on a car's corner costs little along it: tools/vehicles.mjs
// bike_wall, bike_scrape), or when something moving (a car, a coach) shoves it by FALL_SHOVE (m/s) in any direction (a
// train into a standing bike: ~12, tools/rapier-car.mjs drive_moving_coach_bike). FALL_NOTE_MS: how long the note
// says why.
const FALL_HEAD = 8, FALL_SHOVE = 8, FALL_NOTE_MS = 4000, BACK_M = 12;
const BY = { impact: 'wall', coach: 'train', knock: 'car' } as const;

/** a hit on the player's car by something moving: a train's coach, a car of the traffic (knock); speed: the closing
 * speed (m/s), head: m/s lost along the heading, shove: m/s its horizontal velocity changed by */
export interface Hit { kind: 'coach' | 'knock'; speed: number; head: number; shove: number }

// (what it publishes, DriverSnapshot, DriveNote, and its timers: sim/contract/)

export class PlayerCar {
  readonly safe = new SafeTrail<RoadPose>(400, 16);
  readonly notes: DriveNote[] = [];
  input: CarInput = NO_INPUT;
  sinkUntil = 0;
  crashUntil = 0;
  fallUntil = 0;
  fallSide = 1;
  waiting = true;
  /** the hardest contact (m/s) since it was last taken (LifePhysics.driverHit): the host's damage reads it */
  hardest = 0;

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

  fall(tick: number, now: number, lean: number, cause: FallCause) {
    this.fallUntil = now + FALL_MS;
    this.fallSide = lean < 0 ? -1 : 1;
    const why = cause.kind === 'side' ? 'on its side' : `${cause.kind === 'landing' ? 'crash landing' : cause.kind} ${Math.round(cause.speed)} m/s`;
    if (this.notes.length === 16) this.notes.shift();
    this.notes.push({ tick, text: `Crash! You came off the bike: ${why}`, ms: FALL_NOTE_MS, fall: cause });
  }

  contact(tick: number, now: number, event: CarEvent | Hit, bike: boolean, lean: number) {
    const { kind, speed } = event;
    if (kind !== 'step') this.hardest = Math.max(this.hardest, speed);
    if (bike && this.fallUntil) return; // (the fall's note stays)
    if (bike && kind === 'landing' && event.crash) this.fall(tick, now, lean, { kind: 'landing', speed });
    else if (bike && kind !== 'landing' && kind !== 'step' && ((event.head ?? 0) >= FALL_HEAD || ('shove' in event && event.shove >= FALL_SHOVE)))
      this.fall(tick, now, lean, { kind: BY[kind], speed: Math.max(event.head ?? 0, 'shove' in event ? event.shove : 0) });
    else if (kind === 'knock') this.note(tick, 'Crash!', 600);
    else if ((kind === 'impact' || kind === 'coach') && speed > 2) this.note(tick, 'Contact', 350);
    else if (kind === 'landing') {
      if (event.crash) { this.crashUntil = now + CRASH_MS; this.note(tick, 'Crash!', CRASH_MS); }
      else if (speed > 6) this.note(tick, 'Hard landing', 700);
    }
  }
}
