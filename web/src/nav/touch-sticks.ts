import { clamp } from '../util';

export const DEAD_ZONE = 5; // CSS pixels
type Side = 'left' | 'right';

interface Stick {
  id: number;
  startX: number;
  startY: number;
  radius: number;
  dx: number;
  dy: number;
}

interface StickEvents {
  onStart?: (side: Side) => void;
  onMove?: (side: Side, stick: Readonly<Stick>) => void;
  onInterrupted?: () => void;
}

export function stickAxis(offset: number, radius: number) {
  return Math.sign(offset) * Math.max(0, Math.abs(offset) - DEAD_ZONE) / (radius - DEAD_ZONE);
}

export class TouchSticks {
  private active = false;
  private readonly sticks: Record<Side, Stick | null> = { left: null, right: null };

  constructor(private readonly canvas: HTMLCanvasElement, events: StickEvents = {}) {
    canvas.addEventListener('pointerdown', e => {
      if (!this.active || e.pointerType !== 'touch') return;
      const bounds = canvas.getBoundingClientRect();
      const side = e.clientX < bounds.left + bounds.width / 2 ? 'left' : 'right';
      if (this.sticks[side]) return;
      canvas.setPointerCapture(e.pointerId);
      this.sticks[side] = {
        id: e.pointerId, startX: e.clientX, startY: e.clientY,
        radius: clamp(Math.min(bounds.width, bounds.height) * 0.16, 42, 72),
        dx: 0, dy: 0,
      };
      events.onStart?.(side);
    });
    canvas.addEventListener('pointermove', e => {
      const side = this.sideOf(e.pointerId);
      if (!side) return;
      const stick = this.sticks[side]!;
      stick.dx = e.clientX - stick.startX;
      stick.dy = stick.startY - e.clientY;
      events.onMove?.(side, stick);
    });
    canvas.addEventListener('pointerup', e => {
      const side = this.sideOf(e.pointerId);
      if (side) this.sticks[side] = null;
    });
    const interrupt = () => {
      if (!this.left && !this.right) return;
      this.clear();
      events.onInterrupted?.();
    };
    const cancel = (e: PointerEvent) => { if (this.sideOf(e.pointerId)) interrupt(); };
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('lostpointercapture', cancel);
    addEventListener('resize', interrupt);
  }

  get left(): Readonly<Stick> | null { return this.sticks.left; }
  get right(): Readonly<Stick> | null { return this.sticks.right; }

  setActive(active: boolean) {
    this.active = active;
    if (!active) this.clear();
  }

  clear() {
    const { left, right } = this.sticks;
    this.sticks.left = this.sticks.right = null;
    for (const stick of [left, right]) {
      if (stick && this.canvas.hasPointerCapture(stick.id)) this.canvas.releasePointerCapture(stick.id);
    }
  }

  private sideOf(id: number): Side | null {
    return this.left?.id === id ? 'left' : this.right?.id === id ? 'right' : null;
  }
}
