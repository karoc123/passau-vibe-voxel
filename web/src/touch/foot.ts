import { clamp } from '../core/num';
import { TouchSticks } from './sticks';

// The right thumb on foot shares the view between looking and the trigger, so it is told apart by motion and time: a
// finger that moves past SLOP looks, one that lifts still within HOLD is a tap (one shot, as a mouse click is), one held
// still past HOLD holds the trigger (the MG at its rate) until it lifts, and may then drag to sweep. HOLD is past a tap's
// usual ~100-150 ms and short enough that holding to fire does not feel late; SLOP is above a resting thumb's jitter.
// (a mounted gun's thumb goes by the same two: nav/passenger.ts)
export const SLOP = 10, HOLD = 250; // CSS px, ms
// the left thumb's tap (a short touch that hardly moved: follow who is there, as with one finger elsewhere)
const TAP_SLOP = 8, TAP_MS = 600;

export interface FootIntents {
  /** a touch went down (a fly to somewhere stops) */
  start(): void;
  /** the right thumb dragged by (dx, dy) CSS px since the last call: right and up positive */
  look(dx: number, dy: number): void;
  /** the left thumb tapped at (x, y) */
  tap(x: number, y: number): void;
  /** the right thumb tapped: one shot */
  fire(): void;
}

/** on foot on a touch screen: the left thumb a stick that walks, the right thumb looks and fires */
export class FootTouch {
  private readonly sticks: TouchSticks;
  private lookFrom = { dx: 0, dy: 0 };
  private dragged = false;
  private holding = false;

  constructor(canvas: HTMLElement, on: FootIntents) {
    this.sticks = new TouchSticks(canvas, {
      onStart: (side) => {
        if (side === 'right') { this.lookFrom = { dx: 0, dy: 0 }; this.dragged = this.holding = false; }
        on.start();
      },
      onMove: (side, s) => {
        if (side !== 'right' || (!this.dragged && Math.hypot(s.dx, s.dy) < SLOP)) return;
        // (from the touch's start: the slop is looked too, so a drag turns as far as before)
        this.dragged = true;
        on.look(s.dx - this.lookFrom.dx, s.dy - this.lookFrom.dy);
        this.lookFrom = { dx: s.dx, dy: s.dy };
      },
      onEnd: (side, s) => {
        const d = Math.hypot(s.dx, s.dy), ms = performance.now() - s.t;
        if (side === 'left') { if (d < TAP_SLOP && ms < TAP_MS) on.tap(s.startX + s.dx, s.startY - s.dy); }
        else if (!this.dragged && !this.holding && d < SLOP && ms < HOLD) on.fire();
        if (side === 'right') this.holding = false;
      },
    });
  }

  setActive(active: boolean) {
    this.sticks.setActive(active);
    if (!active) this.holding = false;
  }

  /** the left stick: [forward, right] in -1..1, or null */
  get move(): [number, number] | null {
    const a = this.sticks.axes('left');
    if (!a) return null;
    const f = clamp(a.y, -1, 1), r = clamp(a.x, -1, 1);
    return f || r ? [f, r] : null;
  }

  /** each frame: the trigger held (the right thumb held still past HOLD, then until it lifts) */
  trigger() {
    const s = this.sticks.right;
    if (!s) this.holding = false;
    else if (!this.dragged && performance.now() - s.t >= HOLD) this.holding = true;
    return this.holding;
  }
}
