import type { Rect } from './ui/help';
import { $, el } from './util';

// frames per second, triangles drawn, and the round trip to a host on the network: a line in the menu's Debug (line),
// and on a desktop at the top right if switched on there (kept: SHOWN_KEY; a touch screen's corners are taken)
const SHOWN_KEY = 'passau.perf';
export class Perf {
  rects: Rect[] = [];
  private readonly box = el('div', '', '<div class="fps"></div>');
  private readonly fpsBox = $('.fps', this.box);
  private n = 0;
  private t0 = 0;
  /** the frames a second last shown (0: none yet) */
  fps = 0;
  /** the round trip to the host, ms (null: none measured yet); null itself: no host, the page's own worker;
   * undefined: not known yet (the start menu) */
  ping: (() => number | null) | null | undefined;

  constructor(private readonly line: HTMLElement, toggle: HTMLInputElement) {
    this.box.id = 'perf';
    let on = false;
    try { on = localStorage.getItem(SHOWN_KEY) === '1'; } catch { /* storage blocked: not shown */ }
    const show = () => { toggle.checked = on; this.box.hidden = !on; };
    show();
    toggle.addEventListener('change', () => {
      on = toggle.checked;
      show();
      try { localStorage.setItem(SHOWN_KEY, on ? '1' : '0'); } catch { /* not remembered */ }
    });
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
      this.fps = Math.round((this.n * 1000) / (now - this.t0));
      const ping = this.ping?.();
      this.fpsBox.innerHTML = `${this.fps} fps<span class="mark">${(triangles / 1e6).toFixed(1)} M triangles</span>`
        + (this.ping === undefined ? '' : `<span class="mark ping">${this.ping === null ? 'alone, no ping' : ping == null ? '– ms ping' : `${Math.round(ping)} ms ping`}</span>`);
      this.line.innerHTML = this.fpsBox.innerHTML;
    }
    this.n = 0;
    this.t0 = now;
  }
}
