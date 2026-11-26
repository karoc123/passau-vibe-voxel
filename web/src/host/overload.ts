// Over its tick the host gives way in the owner's order: the ambient people, then the cars, then the send rate of
// the others' agents; never the player's own vehicle, never slow motion (the clock and STEP are never touched). Judged
// once a second on the mean of that second's ticks: over OVER of the tick one more step given, under UNDER one taken
// back, the last given first. The dead band between keeps a host near its limit from flapping.
import type { Traffic } from '../sim/traffic';

const OVER = 0.8, UNDER = 0.5, THINNEST = 0.2, THIN = 0.8, FILL = 1.25;

export class Overload {
  /** the snapshots of a session not in a vehicle go every `every`th tick (1: every tick; the third step: 2) */
  every = 1;
  private n = 0;
  private ms = 0;

  /** steps: how many of the three this host takes (the page's own worker only the first: it sends to no one else);
   * per: its ticks a second; budget: a tick's ms */
  constructor(private readonly T: Traffic, private readonly steps: 1 | 3, private readonly per: number, public budget: number) {}

  /** the levels now: the crowd's and the cars' share of the hour's (1: all), the send rate's tick */
  get levels() { return { crowd: this.T.crowd, cars: this.T.carShare, every: this.every }; }

  /** a tick done in ms (the sim's and its snapshots') */
  tick(ms: number) {
    this.ms += ms;
    if (++this.n < this.per) return;
    const mean = this.ms / this.n, T = this.T;
    this.n = 0; this.ms = 0;
    if (mean > OVER * this.budget) {
      if (T.crowd > THINNEST) T.crowd = Math.max(THINNEST, T.crowd * THIN);
      else if (this.steps < 3) return;
      else if (T.carShare > THINNEST) T.carShare = Math.max(THINNEST, T.carShare * THIN);
      else this.every = 2;
    } else if (mean < UNDER * this.budget) {
      if (this.every > 1) this.every = 1;
      else if (T.carShare < 1) T.carShare = Math.min(1, T.carShare * FILL);
      else if (T.crowd < 1) T.crowd = Math.min(1, T.crowd * FILL);
    }
  }
}
