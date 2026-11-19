import { clamp } from '../util';
import { HOVER_THROTTLE, type FlightInput } from './fpv-flight';

const DEAD_ZONE = 5; // CSS pixels
const MAX_ROTATION_INPUT = 0.42; // Match the keyboard's gentler rates.

interface Stick {
  id: number;
  startX: number;
  startY: number;
  radius: number;
  startThrottle: number;
  x: number;
  y: number;
}

export class FpvTouch {
  private active = false;
  private left: Stick | null = null;
  private right: Stick | null = null;
  private throttle = HOVER_THROTTLE;

  constructor(private readonly canvas: HTMLCanvasElement, onInterrupted: () => void) {
    canvas.addEventListener('pointerdown', e => {
      if (!this.active || e.pointerType !== 'touch') return;
      const bounds = canvas.getBoundingClientRect();
      const side = e.clientX < bounds.left + bounds.width / 2 ? 'left' : 'right';
      if (this[side]) return;
      canvas.setPointerCapture(e.pointerId);
      this[side] = {
        id: e.pointerId, startX: e.clientX, startY: e.clientY,
        radius: clamp(Math.min(bounds.width, bounds.height) * 0.16, 42, 72),
        startThrottle: this.throttle,
        x: 0, y: 0,
      };
    });
    canvas.addEventListener('pointermove', e => {
      const stick = this.left?.id === e.pointerId ? this.left : this.right?.id === e.pointerId ? this.right : null;
      if (!stick) return;
      const dx = e.clientX - stick.startX;
      const dy = stick.startY - e.clientY;
      if (stick === this.left) {
        stick.x = clamp(this.axis(dx, stick.radius), -1, 1);
        this.throttle = clamp(stick.startThrottle + 0.65 * this.axis(dy, stick.radius), 0, 1);
        return;
      }
      const distance = Math.hypot(dx, dy);
      const scale = distance > DEAD_ZONE ? Math.min(this.axis(distance, stick.radius), 1) / distance : 0;
      stick.x = dx * scale;
      stick.y = dy * scale;
    });
    const release = (e: PointerEvent) => {
      if (this.left?.id === e.pointerId) this.left = null;
      if (this.right?.id === e.pointerId) this.right = null;
    };
    canvas.addEventListener('pointerup', release);
    const interrupt = (e: PointerEvent) => {
      if (this.left?.id === e.pointerId || this.right?.id === e.pointerId) onInterrupted();
    };
    canvas.addEventListener('pointercancel', interrupt);
    canvas.addEventListener('lostpointercapture', interrupt);
    addEventListener('resize', () => {
      if (this.left || this.right) onInterrupted();
    });
  }

  setActive(active: boolean) {
    this.active = active;
    if (!active) this.clearSticks();
  }

  get throttlePercent() { return Math.round(this.throttle * 100); }

  reset() {
    this.setActive(false);
    this.throttle = HOVER_THROTTLE;
  }

  read(): FlightInput {
    return {
      throttle: this.throttle,
      yaw: (this.left?.x ?? 0) * MAX_ROTATION_INPUT,
      roll: (this.right?.x ?? 0) * MAX_ROTATION_INPUT,
      pitch: (this.right?.y ?? 0) * MAX_ROTATION_INPUT,
    };
  }

  private axis(offset: number, radius: number) {
    return Math.sign(offset) * Math.max(0, Math.abs(offset) - DEAD_ZONE) / (radius - DEAD_ZONE);
  }

  private clearSticks() {
    const left = this.left, right = this.right;
    this.left = this.right = null;
    for (const stick of [left, right]) {
      if (stick && this.canvas.hasPointerCapture(stick.id)) this.canvas.releasePointerCapture(stick.id);
    }
  }
}
