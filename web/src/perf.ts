import type { Rect } from './hud';
import { $, el } from './util';

// top right: frames per second and triangles drawn (the resolution and the detail are in the ⚙ panel, settings.ts)
export class Perf {
  rects: Rect[] = [];
  private readonly box = el('div', '', '<div class="fps"></div>');
  private readonly fps = $('.fps', this.box);
  private n = 0;
  private t0 = 0;

  constructor() {
    this.box.id = 'perf';
    const measure = () => { const r = this.box.getBoundingClientRect(); this.rects = [{ x0: r.left - 6, x1: r.right + 6, y0: r.top - 6, y1: r.bottom + 6 }]; };
    new ResizeObserver(measure).observe(this.box);
    addEventListener('resize', measure);
  }

  // triangles: everything drawn in the last frame, shadow maps included
  frame(now: number, hidden: boolean, triangles: number) {
    if (hidden) { this.n = 0; this.t0 = now; return; }
    this.n++;
    if (now - this.t0 < 500) return;
    if (this.t0) {
      this.fps.innerHTML = `${Math.round((this.n * 1000) / (now - this.t0))} fps<span class="mark">${(triangles / 1e6).toFixed(1)} M triangles</span>`;
    }
    this.n = 0;
    this.t0 = now;
  }
}
