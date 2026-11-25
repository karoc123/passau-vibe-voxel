// The trains' tracks and where their coaches are drawn. Shared (docs/adr/0009-layers-and-owners.md): the sim's trains
// (sim/train-traffic.ts TrainTraffic) and the client's copy (client/sim-client.ts TrafficMirror) draw with this code.
import { at, prepPath, pt, type Path } from './path';
import type { TrainPathData } from './types';
import type { TrainState } from './contract/agents';

export const COACH_LENGTH = 20;
export const COACH_WIDTH = 2.9;
// the gap (m) between two coaches
export const GAP = 1;

export interface CoachPose {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly express: boolean;
}

export type TrackPath = TrainPathData & Path;

/** the tracks a train runs on (a TrainState's p indexes them): those with a service, prepared (copies: data kept) */
export const trainTracks = (data: readonly TrainPathData[]): TrackPath[] =>
  data.filter((d) => d.svc.length && d.p.length >= 2).map((d) => prepPath({ ...d }));

/** the coaches of the trains on their tracks at the latest tick (back: steps back, to draw between the last two) */
export function* coachPoses(tracks: readonly Path[], trains: readonly TrainState[], back = 0): IterableIterator<CoachPose> {
  const a = pt(), b = pt();
  for (const tr of trains) {
    const p = tracks[tr.p];
    for (let k = 0; k < tr.n; k++) {
      const front = tr.s - tr.ds * back - k * (COACH_LENGTH + GAP);
      at(p, front, 0, a); at(p, front - COACH_LENGTH, 0, b);
      yield {
        id: `${tr.id}:${k}`,
        x: (a.x + b.x) / 2,
        y: Math.max(a.z, b.z) + 0.05,
        z: (a.y + b.y) / 2,
        heading: Math.atan2(a.x - b.x, a.y - b.y),
        express: tr.express,
      };
    }
  }
}
