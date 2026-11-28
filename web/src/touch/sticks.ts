import { clamp } from '../core/num';
import './touch.css';

export const DEAD_ZONE = 5; // CSS pixels
export type Side = 'left' | 'right';

interface Stick {
  id: number;
  startX: number;
  startY: number;
  radius: number;
  dx: number;
  dy: number;
  t: number; // performance.now() at the touch
}

interface StickEvents {
  onStart?: (side: Side) => void;
  onMove?: (side: Side, stick: Readonly<Stick>) => void;
  onEnd?: (side: Side, stick: Readonly<Stick>) => void;
  onInterrupted?: () => void;
  /** a side whose finger is no stick but the camera's: drawn without rings */
  camera?: Side;
}

export function stickAxis(offset: number, radius: number) {
  return Math.sign(offset) * Math.max(0, Math.abs(offset) - DEAD_ZONE) / (radius - DEAD_ZONE);
}

const ring = (kind: string) => Object.assign(document.createElement('div'), { className: `stick-ring ${kind}` });

// faint rings where the thumbs are (touch.css .stick-ring): the base where the thumb went down, the size of the
// stick's reach, and the knob where it is now
class Rings {
  private readonly base = ring('base');
  private readonly knob = ring('knob');

  show(s: Readonly<Stick>) {
    if (!this.base.isConnected) document.body.append(this.base, this.knob);
    this.base.style.width = this.base.style.height = `${2 * s.radius}px`;
    this.base.style.transform = `translate(${s.startX}px, ${s.startY}px) translate(-50%, -50%)`;
    this.knob.style.transform = `translate(${s.startX + s.dx}px, ${s.startY - s.dy}px) translate(-50%, -50%)`;
  }

  hide() { this.base.remove(); this.knob.remove(); }
}

export class TouchSticks {
  private active = false;
  private readonly sticks: Record<Side, Stick | null> = { left: null, right: null };
  private readonly rings: Record<Side, Rings> = { left: new Rings(), right: new Rings() };

  constructor(private readonly canvas: HTMLElement, private readonly events: StickEvents = {}) {
    canvas.addEventListener('pointerdown', e => {
      if (!this.active || e.pointerType !== 'touch') return;
      const bounds = canvas.getBoundingClientRect();
      const side = e.clientX < bounds.left + bounds.width / 2 ? 'left' : 'right';
      if (this.sticks[side]) return;
      canvas.setPointerCapture(e.pointerId);
      this.sticks[side] = {
        id: e.pointerId, startX: e.clientX, startY: e.clientY,
        radius: clamp(Math.min(bounds.width, bounds.height) * 0.16, 42, 72),
        dx: 0, dy: 0, t: performance.now(),
      };
      if (side !== events.camera) this.rings[side].show(this.sticks[side]!);
      events.onStart?.(side);
    });
    canvas.addEventListener('pointermove', e => {
      const side = this.sideOf(e.pointerId);
      if (!side) return;
      const stick = this.sticks[side]!;
      stick.dx = e.clientX - stick.startX;
      stick.dy = stick.startY - e.clientY;
      if (side !== this.events.camera) this.rings[side].show(stick);
      events.onMove?.(side, stick);
    });
    canvas.addEventListener('pointerup', e => {
      const side = this.sideOf(e.pointerId);
      if (!side) return;
      const stick = this.sticks[side]!;
      this.sticks[side] = null;
      this.rings[side].hide();
      events.onEnd?.(side, stick);
    });
    const interrupt = () => {
      if (!this.sticks.left && !this.sticks.right) return;
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

  /** a stick's deflection for a mode to map: x right, y up, 0 inside the dead zone, 1 at the ring (more beyond it) */
  axes(side: Side): { x: number; y: number } | null {
    const s = this[side];
    return s && { x: stickAxis(s.dx, s.radius), y: stickAxis(s.dy, s.radius) };
  }

  setActive(active: boolean) {
    this.active = active;
    if (!active) this.clear();
  }

  clear() {
    const { left, right } = this.sticks;
    this.sticks.left = this.sticks.right = null;
    this.rings.left.hide();
    this.rings.right.hide();
    for (const stick of [left, right]) {
      if (stick && this.canvas.hasPointerCapture(stick.id)) this.canvas.releasePointerCapture(stick.id);
    }
  }

  private sideOf(id: number): Side | null {
    return this.sticks.left?.id === id ? 'left' : this.sticks.right?.id === id ? 'right' : null;
  }
}

/** the device takes touches (a laptop's touch screen too, unlike a coarse pointer) */
export const touchScreen = () => navigator.maxTouchPoints > 0;
