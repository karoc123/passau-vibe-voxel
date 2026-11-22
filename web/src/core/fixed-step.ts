// The fixed step of a craft's core, one for all (the plane, the drone, the boat, the car): a frame's time accumulated,
// whole steps of STEP taken out of it, the rest carried to the next frame; `alpha` how far the time drawn is past the
// last step (0..1, to draw between the last two). No three.js, no DOM (tools/core-deps.mjs): a server steps the same.
//   maxDt: a frame counts for at most this long (a stall, a tab in the background), never less than 0
//   maxSteps: at most this many steps a frame (the time beyond them dropped)
export class FixedStep {
  acc = 0;
  constructor(readonly step: number, readonly maxSteps = Infinity, readonly maxDt = Infinity) {}

  /** how far the time drawn is past the last step, in steps (0..1) */
  get alpha() { return this.acc / this.step; }

  /** a frame: as many steps as dt holds, each `step()` in turn; one returning false (it waited: for a tile, a
   *  collider) ends the frame and drops the time left. False if one did. */
  run(dt: number, step: (dt: number) => boolean) {
    this.acc = Math.min(this.acc + Math.min(this.maxDt, Math.max(0, dt)), this.step * this.maxSteps);
    while (this.acc >= this.step) {
      this.acc -= this.step;
      if (!step(this.step)) { this.acc = 0; return false; }
    }
    return true;
  }

  /** a frame whose steps are all taken (the caller needs their number first): how many; at maxSteps the time left is
   *  dropped */
  take(dt: number) {
    this.acc += Math.min(this.maxDt, Math.max(0, dt));
    const n = Math.min(this.maxSteps, Math.floor(this.acc / this.step));
    this.acc = n === this.maxSteps ? 0 : this.acc - n * this.step;
    return n;
  }
}
