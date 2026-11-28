import { clamp } from '../core/num';
import { DRONE } from '../sim/craft/fpv-flight';
import type { FlightInput } from '../sim/contract/inputs';
import { DEAD_ZONE, stickAxis, TouchSticks } from './sticks';

const MAX_ROTATION_INPUT = 0.42; // Match the keyboard's gentler rates.

export class FpvTouch {
  private readonly sticks: TouchSticks;
  private throttle = DRONE.hover;
  private startThrottle = DRONE.hover;

  constructor(canvas: HTMLCanvasElement, onInterrupted: () => void) {
    this.sticks = new TouchSticks(canvas, {
      onStart: side => { if (side === 'left') this.startThrottle = this.throttle; },
      onMove: (side, { dy, radius }) => {
        if (side === 'left') this.throttle = clamp(this.startThrottle + 0.65 * stickAxis(dy, radius), 0, 1);
      },
      onInterrupted,
    });
  }

  setActive(active: boolean) {
    this.sticks.setActive(active);
  }

  get throttlePercent() { return Math.round(this.throttle * 100); }

  reset() {
    this.setActive(false);
    this.throttle = DRONE.hover;
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
