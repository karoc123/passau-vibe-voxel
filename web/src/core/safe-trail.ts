// Where a craft last was safe, for the player's T (unstick, back on the road, the last safe point) and a respawn after a
// crash: one for all (the car, the boat, the plane; docs/plans/code-health.md item 12). A pose is recorded at most
// every `every` (in the craft's own clock: the car's ms, the boat's and the plane's seconds of steps), the newest
// `keep` kept. Which poses are safe and which one to go back to is the craft's. No three.js, no DOM
// (tools/core-deps.mjs): a server keeps the same.
export class SafeTrail<P> {
  private poses: { pose: P; t: number }[] = [];
  private next = 0;

  constructor(readonly every: number, readonly keep: number) {}

  get length() { return this.poses.length; }
  get newest(): P | undefined { return this.poses.at(-1)?.pose; }
  get(i: number): P | undefined { return this.poses[i]?.pose; }

  /** time to record (the craft then checks the pose is safe) */
  due(t: number) { return t >= this.next; }

  /** the next record not before t + every (a pose found not safe, or a respawn) */
  wait(t: number) { this.next = t + this.every; }

  /** a safe pose at t; the oldest dropped past `keep` */
  push(pose: P, t: number) {
    this.poses.push({ pose, t });
    if (this.poses.length > this.keep) this.poses.shift();
    this.wait(t);
  }

  /** the newest pose for which ok holds: its index, -1 if none */
  find(ok: (pose: P, t: number) => boolean) {
    let i = this.poses.length - 1;
    while (i >= 0 && !ok(this.poses[i].pose, this.poses[i].t)) i--;
    return i;
  }

  /** keep the oldest n (going back: what came after is gone); the next record `every` after the newest kept */
  cut(n: number) {
    this.poses.length = Math.min(this.poses.length, Math.max(0, n));
    const last = this.poses.at(-1);
    if (last) this.wait(last.t);
  }

  /** empty, or only `first` (the start); when the next is recorded stays as it was */
  clear(first?: P, t = 0) { this.poses = first ? [{ pose: first, t }] : []; }

  /** empty, the next pose recorded from t = 0 on */
  reset() { this.poses = []; this.next = 0; }
}
