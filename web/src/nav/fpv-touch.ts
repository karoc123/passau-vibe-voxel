import { clamp } from '../util';
import { HOVER_THROTTLE } from '../sim/craft/fpv-flight';
import type { FlightInput } from '../sim/contract/inputs';
import { DEAD_ZONE, stickAxis, TouchSticks } from './touch-sticks';

const MAX_ROTATION_INPUT = 0.42; // Match the keyboard's gentler rates.

export class FpvTouch {
  private readonly sticks: TouchSticks;
  private throttle = HOVER_THROTTLE;
  private startThrottle = HOVER_THROTTLE;

  // onPinch: two fingers close together (touch-sticks.ts), d0 / d of their distance since the last call
  constructor(canvas: HTMLCanvasElement, onInterrupted: () => void, onPinch: (ratio: number) => void) {
    this.sticks = new TouchSticks(canvas, {
      onStart: side => { if (side === 'left') this.startThrottle = this.throttle; },
      onMove: (side, { dy, radius }) => {
        if (side === 'left') this.throttle = clamp(this.startThrottle + 0.65 * stickAxis(dy, radius), 0, 1);
      },
      onInterrupted,
      onPinch,
    });
  }

  setActive(active: boolean) {
    this.sticks.setActive(active);
  }

  get throttlePercent() { return Math.round(this.throttle * 100); }

  reset() {
    this.setActive(false);
    this.throttle = HOVER_THROTTLE;
  }

  read(): FlightInput {
    const { left, right } = this.sticks;
    const distance = right ? Math.hypot(right.dx, right.dy) : 0;
    const scale = right && distance > DEAD_ZONE ? Math.min(stickAxis(distance, right.radius), 1) / distance : 0;
    return {
      throttle: this.throttle,
      yaw: left ? clamp(stickAxis(left.dx, left.radius), -1, 1) * MAX_ROTATION_INPUT : 0,
      roll: (right?.dx ?? 0) * scale * MAX_ROTATION_INPUT,
      pitch: (right?.dy ?? 0) * scale * MAX_ROTATION_INPUT,
    };
  }
}
