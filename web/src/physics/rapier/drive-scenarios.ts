// The drive mode's glue (nav/drive-session.ts) headless: a traffic car taken over in RapierDrive's world on synthetic
// terrain (scenarios.ts synthMap), with a stand-in for the street life that records what the drive does to it. Run by
// tools/rapier-car.mjs with the car's scenarios (same Outcome).
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { DriveSession, CRASH_MS, SINK_MS, type DriveLife, type Note } from '../../nav/drive-session';
import type { Car, Person } from '../../sim/types';
import type { CarInput } from './car';
import { buildFor, RapierDrive } from './drive-world';
import { synthMap, WATER, type Col, type Outcome } from './scenarios';

const FRAME_MS = 1000 / 60;
const r2 = (x: number) => Math.round(x * 100) / 100;

// a traffic car (or a person) of the stand-in street life at (x, z), ground y, heading +z
const carAt = (x: number, y: number, z: number, len = 4.4) => ({ kind: 'car', rp: new Vector3(x, y, z), rh: 0, pitch: 0, roll: 0, v: 0, brake: 0, len, bus: false }) as unknown as Car;
const personAt = (x: number, y: number, z: number) => ({ kind: 'person', rp: new Vector3(x, y, z), rh: 0 }) as unknown as Person;

// the street life as the drive sees it: what it was told (cars taken out of the traffic, people knocked down)
class StandInLife implements DriveLife {
  readonly taken: Car[] = [];
  readonly knocked: { p: Person; vx: number; vz: number }[] = [];
  constructor(readonly cars: Car[], readonly people: Person[] = [], readonly riders: Person[] = []) {}
  roadVehicles() { return this.cars; }
  takeWheel(car: Car) { this.taken.push(car); return true; }
  knockDown(p: Person, vx: number, vz: number) { if (this.knocked.some((k) => k.p === p)) return false; this.knocked.push({ p, vx, vz }); return true; }
  clearFallen() {}
}

interface Drive { session: DriveSession; life: StandInLife; car: Car; notes: (Note & { t: number })[]; now: number }

// the car (at x, z on the ground there, heading +z at `kmh`) taken over in a world of synthMap(2, col)
function takeOver(col: (x: number, z: number) => Col, x: number, z: number, kmh: number, others: Car[] = [], people: Person[] = []): Drive {
  const map = synthMap(2, col);
  const rap = new RapierDrive(map.meta, { x, z }, { budgetMs: 1e9, load: () => Promise.reject(null) });
  for (const t of map.tiles) rap.terrain.setTile(t.tx, t.tz, t.tile);
  const y = col(Math.floor(x), Math.floor(z)).g;
  const car = carAt(x, y, z);
  car.v = kmh / 3.6;
  const life = new StandInLife([car, ...others], people);
  const now = 1e4;
  const session = new DriveSession(life, car, rap, buildFor(false, car.len), { x, y, z, h: 0, pitch: 0, roll: 0 }, now);
  return { session, life, car, notes: [], now };
}

// `seconds` of frames with input(d) (as the drive mode's update: the session's frame, then the Car drawn), or until
// until(d)
function run(d: Drive, seconds: number, input: (d: Drive) => CarInput, until?: (d: Drive) => boolean) {
  for (let i = 0; i < seconds * 60; i++) {
    d.now += FRAME_MS;
    for (const n of d.session.update(FRAME_MS / 1000, input(d), d.now)) d.notes.push({ ...n, t: d.now });
    d.session.present();
    if (until?.(d)) break;
  }
  return d;
}

const cruise = (kmh: number) => (d: Drive): CarInput => ({ gas: d.session.kmh < kmh ? 1 : 0, brake: 0, steer: 0, handbrake: false });
const said = (d: Drive, text: string) => d.notes.some((n) => n.text.startsWith(text));
const street = (): Col => ({ g: 10, mat: 1 });

export const DRIVE_SCENARIOS: Record<string, () => Outcome> = {
  // a traffic car standing in the lane, run into at 40 km/h: knocked out of the traffic (takeWheel) and away (its Car
  // drawn where its body lies)
  drive_knock() {
    const other = carAt(64, 10, 60);
    const d = takeOver(street, 64, 30, 40, [other]);
    run(d, 4, cruise(40));
    const moved = Math.hypot(other.rp!.x - 64, other.rp!.z - 60);
    const detail = { taken: d.life.taken.includes(other), crashNote: said(d, 'Crash!'), movedM: r2(moved), carZ: r2(d.car.rp!.z) };
    d.session.park();
    return { name: 'drive_knock', pass: detail.taken && detail.crashNote && moved > 1, detail };
  },
  // a person in the lane, run into at 30 km/h: knocked down (knockDown, along the car's velocity)
  drive_person() {
    const p = personAt(64, 10, 50);
    const d = takeOver(street, 64, 30, 30, [], [p]);
    run(d, 3, cruise(30));
    const k = d.life.knocked.find((x) => x.p === p);
    const detail = { knocked: !!k, ouch: said(d, 'Ouch!'), vz: r2(k?.vz ?? 0) };
    d.session.park();
    return { name: 'drive_person', pass: !!k && detail.ouch && k.vz > 2, detail };
  },
  // off the bank into the river at 40 km/h (the river's water the ground's top voxel, 3 m under the bank): a splash,
  // no control while it sinks, then back on the bank some 12 m before its edge (where it was last on the road, not
  // where it was taken), standing, on its wheels
  drive_river_respawn() {
    const d = takeOver((_x, z) => (z >= 60 ? { g: 4, mat: WATER } : { g: 7 }), 64, 20, 40);
    run(d, 8, cruise(40), (x) => x.session.sinkUntil > 0);
    const splashAt = d.now, splash = said(d, 'Splash!'), held = d.session.held(d.now + 10);
    run(d, (SINK_MS + 200) / 1000, cruise(40));
    // (back: placed once its ground is built, then settled for a second, no input)
    run(d, 1, () => ({ gas: 0, brake: 0, steer: 0, handbrake: true }));
    const rap = d.session.rap, p = d.car.rp!;
    const detail = { splash, held, backAfterS: r2((d.now - splashAt) / 1000), status: rap.car?.status ?? 'none', onWheels: rap.onWheels, zBack: r2(p.z), yBack: r2(p.y), kmh: r2(d.session.kmh) };
    d.session.park();
    return { name: 'drive_river_respawn', pass: splash && held && detail.status === 'ok' && detail.onWheels && p.z < 50 && p.z > 35 && Math.abs(p.y - 7) < 0.5, detail };
  },
  // parked in the river: back on the bank first
  drive_park_in_river() {
    const d = takeOver((_x, z) => (z >= 60 ? { g: 4, mat: WATER } : { g: 7 }), 64, 20, 40);
    run(d, 8, cruise(40), (x) => x.session.sinkUntil > 0);
    d.session.park();
    const p = d.car.rp!;
    const detail = { zParked: r2(p.z), yParked: r2(p.y), carGone: !d.session.rap.car };
    return { name: 'drive_park_in_river', pass: p.z < 50 && Math.abs(p.y - 7) < 0.5 && detail.carGone, detail };
  },
  // off a 10 m cliff at 60 km/h: a crash landing; the player's input ignored for CRASH_MS, then back
  drive_crash_landing() {
    const d = takeOver((_x, z) => ({ g: z < 50 ? 20 : 10 }), 64, 25, 60);
    run(d, 5, cruise(60), (x) => x.session.crashUntil > 0);
    const crashed = d.session.crashUntil > 0, at = d.now, heldNow = d.session.held(at), note = said(d, 'Crash!');
    const heldAfter = d.session.held(at + CRASH_MS + 1);
    const detail = { crashed, note, heldNow, heldAfter };
    d.session.park();
    return { name: 'drive_crash_landing', pass: crashed && note && heldNow && !heldAfter, detail };
  },
};

export async function runDriveScenarios(ids?: string[]) {
  await RAPIER.init();
  const out: Outcome[] = [];
  for (const [id, f] of Object.entries(DRIVE_SCENARIOS)) if (!ids || ids.includes(id)) out.push(f());
  return out;
}
