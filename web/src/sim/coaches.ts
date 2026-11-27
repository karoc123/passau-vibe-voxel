// The trains as a timetable: where each coach is is a pure function of the tracks and the world clock, so the host
// and every page work it out alike and nothing of it is sent. Every route sends a train every half hour; it brakes
// for its stations and waits there, and trains on one track never wait for each other (they are spaced by their
// departures only). A train runs in and out RUN m along the straight beyond its track's ends (into a tunnel, off the
// map), so it comes and goes far from the track's open part.
import { hash } from '../core/num';
import { at, prepPath, pt, type Path } from './path';
import type { TrainPathData } from './types';

export const COACH_LENGTH = 20;
export const COACH_WIDTH = 2.9;
// the gap (m) between two coaches
const GAP = 1;

const V = 16, A = 0.7, B = 0.9, DWELL = 25, HEADWAY = 1800, RUN = 1000;
const EXPRESS = /Intercity|DB|ČD|ÖBB|EC|IC/i;

export interface CoachPose {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly express: boolean;
}

export type TrackPath = TrainPathData & Path;

// from time t (s after departure) on, the front is at s + v·u + a·u²/2 (u: time since t) until the next leg's t
interface Leg { t: number; s: number; v: number; a: number }
interface Run { track: number; id: number; n: number; express: boolean; phase: number; legs: Leg[]; dur: number }

/** the tracks a train runs on: those with a service, prepared (copies: data kept) */
const trainTracks = (data: readonly TrainPathData[]): TrackPath[] =>
  data.filter((d) => d.svc.length && d.p.length >= 2).map((d) => prepPath({ ...d }));

const trainLength = (n: number) => n * (COACH_LENGTH + GAP) - GAP;

// one run of a service: from RUN m before the track's start at full speed, stopping with the train centred on each
// station (its front no further than the track's end), to RUN m past the end with its tail
function legsOf(stops: readonly number[], L: number, len: number) {
  const legs: Leg[] = [], end = L + len + RUN;
  let t = 0, s = -RUN, v = V;
  const targets = [...new Set(stops.map((x) => Math.min(x + len / 2, L)))].sort((a, b) => a - b);
  for (const [f, vb] of [...targets.map((f) => [f, 0]), [end, V]]) {
    const d = f - s;
    if (d <= 0.5) continue;
    // the highest speed reached between here and f: up at A from v, down at B to vb
    const peak = Math.min(V, Math.sqrt(Math.max(v * v, vb * vb, (d + v * v / (2 * A) + vb * vb / (2 * B)) / (1 / (2 * A) + 1 / (2 * B)))));
    if (peak > v) { legs.push({ t, s, v, a: A }); t += (peak - v) / A; s += (peak * peak - v * v) / (2 * A); v = peak; }
    const brake = (v * v - vb * vb) / (2 * B), cruise = f - s - brake;
    if (cruise > 0) { legs.push({ t, s, v, a: 0 }); t += cruise / v; s += cruise; }
    if (v > vb) { const a = -(v * v - vb * vb) / (2 * (f - s)); legs.push({ t, s, v, a }); t += (vb - v) / a; }
    s = f; v = vb;
    if (vb === 0) { legs.push({ t, s, v: 0, a: 0 }); t += DWELL; }
  }
  return { legs, dur: t };
}

const frontAt = (legs: readonly Leg[], u: number) => {
  let i = legs.length - 1;
  while (i > 0 && legs[i].t > u) i--;
  const l = legs[i], w = u - l.t;
  return l.s + l.v * w + l.a * w * w / 2;
};

/** the trains of the tracks' timetable */
export class Timetable {
  readonly tracks: TrackPath[];
  private readonly runs: Run[] = [];

  constructor(data: readonly TrainPathData[]) {
    this.tracks = trainTracks(data);
    let id = 0;
    this.tracks.forEach((p, track) => {
      const lag = hash(track * 31 + 7);
      p.svc.forEach((svc, k) => {
        const express = EXPRESS.test(svc.op) || EXPRESS.test(svc.ref), n = express ? 8 : 4;
        const phase = (k / p.svc.length + lag) % 1;
        this.runs.push({ track, id: id++, n, express, phase, ...legsOf(svc.stops, p.L, trainLength(n)) });
      });
    });
  }

  /** the coaches at world time t (s) when the hour is hour: no train leaves between a quarter past midnight and half
   * past four */
  *coaches(t: number, hour: number): IterableIterator<CoachPose> {
    const a = pt(), b = pt(), R = this.runs.length;
    for (const r of this.runs) {
      const p = this.tracks[r.track];
      for (let m = Math.ceil((t - r.dur) / HEADWAY - r.phase); m <= Math.floor(t / HEADWAY - r.phase); m++) {
        const u = t - (m + r.phase) * HEADWAY;
        if (u < 0 || u >= r.dur) continue;
        const left = (((hour - u / 3600) % 24) + 24) % 24;
        if (left > 0.25 && left < 4.5) continue;
        const s = frontAt(r.legs, u);
        for (let k = 0; k < r.n; k++) {
          const front = s - k * (COACH_LENGTH + GAP);
          at(p, front, 0, a); at(p, front - COACH_LENGTH, 0, b);
          yield {
            id: `${m * R + r.id}:${k}`,
            x: (a.x + b.x) / 2,
            y: Math.max(a.z, b.z) + 0.05,
            z: (a.y + b.y) / 2,
            heading: Math.atan2(a.x - b.x, a.y - b.y),
            express: r.express,
          };
        }
      }
    }
  }
}
