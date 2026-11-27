import { COACH_LENGTH, COACH_WIDTH, Timetable, type CoachPose } from './coaches';
import type { TrainPathData } from './types';

const COACH_HEIGHT = 4;
const COACH_SIZE = Object.freeze({ x: COACH_WIDTH, y: COACH_HEIGHT, z: COACH_LENGTH });

export interface CoachBox extends CoachPose {
  readonly size: typeof COACH_SIZE;
}

/** the host's trains: the timetable at the traffic's clock, worked out only where something asks (a hit, a crash, a
 * walker, a craft) */
export class TrainTraffic {
  private readonly table: Timetable;
  private t = 0;
  private hour = 12;
  // (worked out once a tick: every walker's pose and every craft's step meet them)
  private now: CoachPose[] | null = null;

  constructor(data: TrainPathData[]) { this.table = new Timetable(data); }

  tick(t: number, hour: number) { this.t = t; this.hour = hour; this.now = null; }

  coaches(): readonly CoachPose[] { return this.now ??= [...this.table.coaches(this.t, this.hour)]; }

  *coachBoxes(): IterableIterator<CoachBox> {
    for (const pose of this.coaches()) yield { ...pose, size: COACH_SIZE };
  }
}
