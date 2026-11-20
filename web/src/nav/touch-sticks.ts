import { clamp } from '../util';

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
  /** with it, two fingers close together pinch (see PINCH_NEAR): d0 / d of the fingers' distance since the last call */
  onPinch?: (ratio: number) => void;
}

// a second finger landing this close to a first that has hardly moved (a fraction of the screen's shorter side) makes
// a pinch with it, not a second stick: the two thumbs of the sticks are far apart (on a phone, portrait ~200 px,
// landscape ~600 px), a pinch's fingers close; and a stick in use has moved
const PINCH_NEAR = 0.35, PINCH_STILL = 20;
// the first finger of a pinch is a stick until the second lands: for its first moments (still, the only one) it is
// not read yet (the getters, onMove), so a pinch never steers, walks or turns on the way in
const PINCH_WINDOW = 120; // ms

export function stickAxis(offset: number, radius: number) {
  return Math.sign(offset) * Math.max(0, Math.abs(offset) - DEAD_ZONE) / (radius - DEAD_ZONE);
}

const ring = (kind: string) => Object.assign(document.createElement('div'), { className: `stick-ring ${kind}` });

// faint rings where the thumbs are (style.css .stick-ring): the base where the thumb went down, the size of the
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
  private pinch: { pts: Map<number, { x: number; y: number }>; d: number } | null = null;

  constructor(private readonly canvas: HTMLElement, private readonly events: StickEvents = {}) {
    canvas.addEventListener('pointerdown', e => {
      if (!this.active || e.pointerType !== 'touch') return;
      const bounds = canvas.getBoundingClientRect();
      const side = e.clientX < bounds.left + bounds.width / 2 ? 'left' : 'right';
      if (this.pinch) return;
      const held = [this.sticks.left, this.sticks.right].filter((s) => s !== null);
      if (events.onPinch && held.length === 1) {
        const s = held[0], x = s.startX + s.dx, y = s.startY - s.dy;
        const d = Math.hypot(e.clientX - x, e.clientY - y);
        if (Math.hypot(s.dx, s.dy) < PINCH_STILL && d < PINCH_NEAR * Math.min(bounds.width, bounds.height)) {
          canvas.setPointerCapture(e.pointerId);
          const sd = this.sideOf(s.id)!;
          this.sticks[sd] = null; // (no onEnd: not a tap)
          this.rings[sd].hide();
          this.pinch = { pts: new Map([[s.id, { x, y }], [e.pointerId, { x: e.clientX, y: e.clientY }]]), d: Math.max(20, d) };
          return;
        }
      }
      if (this.sticks[side]) return;
      canvas.setPointerCapture(e.pointerId);
      this.sticks[side] = {
        id: e.pointerId, startX: e.clientX, startY: e.clientY,
        radius: clamp(Math.min(bounds.width, bounds.height) * 0.16, 42, 72),
        dx: 0, dy: 0, t: performance.now(),
      };
      this.rings[side].show(this.sticks[side]!);
      events.onStart?.(side);
    });
    canvas.addEventListener('pointermove', e => {
      const p = this.pinch?.pts.get(e.pointerId);
      if (p && this.pinch) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...this.pinch.pts.values()], d = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
        events.onPinch?.(this.pinch.d / d);
        this.pinch.d = d;
        return;
      }
      const side = this.sideOf(e.pointerId);
      if (!side) return;
      const stick = this.sticks[side]!;
      stick.dx = e.clientX - stick.startX;
      stick.dy = stick.startY - e.clientY;
      this.rings[side].show(stick);
      if (!this.undecided(stick)) events.onMove?.(side, stick);
    });
    canvas.addEventListener('pointerup', e => {
      if (this.pinch?.pts.has(e.pointerId)) { this.endPinch(); return; } // (the other finger then does nothing until lifted)
      const side = this.sideOf(e.pointerId);
      if (!side) return;
      const stick = this.sticks[side]!;
      this.sticks[side] = null;
      this.rings[side].hide();
      events.onEnd?.(side, stick);
    });
    const interrupt = () => {
      if (!this.sticks.left && !this.sticks.right) { this.endPinch(); return; }
      this.clear();
      events.onInterrupted?.();
    };
    const cancel = (e: PointerEvent) => {
      if (this.pinch?.pts.has(e.pointerId)) this.endPinch();
      else if (this.sideOf(e.pointerId)) interrupt();
    };
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('lostpointercapture', cancel);
    addEventListener('resize', interrupt);
  }

  get left(): Readonly<Stick> | null { return this.decided(this.sticks.left); }
  get right(): Readonly<Stick> | null { return this.decided(this.sticks.right); }

  private decided(s: Stick | null) { return s && !this.undecided(s) ? s : null; }

  // a lone stick just put down that has hardly moved: maybe the first finger of a pinch (see PINCH_WINDOW)
  private undecided(s: Readonly<Stick>) {
    return !!this.events.onPinch && !(this.sticks.left && this.sticks.right) &&
      performance.now() - s.t < PINCH_WINDOW && Math.hypot(s.dx, s.dy) < PINCH_STILL;
  }

  setActive(active: boolean) {
    this.active = active;
    if (!active) this.clear();
  }

  private endPinch() {
    for (const id of this.pinch?.pts.keys() ?? []) if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    this.pinch = null;
  }

  clear() {
    this.endPinch();
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
