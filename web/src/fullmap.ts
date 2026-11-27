import { type DrawnMark, drawOther, drawPin, drawPlayer, drawScale, INK, type MapData, type MapMarks, OUTSIDE } from './minimap';
import { el } from './util';

const CELL = 4; // metres per pixel of the city's picture
const MAX_ZOOM = 3; // CSS px per metre
const TAP = 8; // px: a pointer moved less than this is a tap (a waypoint), more a drag
const SCALES = [50, 100, 200, 500, 1000, 2000];

/** The whole city full screen, north up: the picture painted once (again only when the data changes), the view drawn
 * from it when it is moved or zoomed, the markers alone redrawn as they move. A drag moves it, the wheel or a pinch
 * zooms, a tap sets the waypoint (on the waypoint: clears it). */
export class FullMap {
  /** the others as last drawn (the tools) */
  drawnOthers: DrawnMark[] = [];
  private readonly root = el('div', '');
  private readonly base = el('canvas', '', '', this.root);
  private readonly marks = el('canvas', 'marks', '', this.root);
  private readonly city = document.createElement('canvas');
  private cityVersion = -1;
  private cx = 0;
  private cz = 0;
  private s = 1; // CSS px per metre
  private w = 0;
  private h = 0;
  private viewDirty = true;
  private lastT = -Infinity;
  private lastMarks = -1;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private tap: { id: number; x: number; y: number; moved: boolean } | null = null;

  constructor(private readonly data: MapData, private readonly at: MapMarks) {
    this.root.id = 'fullmap';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Map of the whole city');
    this.marks.setAttribute('role', 'img');
    this.marks.setAttribute('aria-label', 'Your position, the waypoint and the other players; tap for a waypoint');
    const close = el('button', 'close', '×', this.root);
    close.type = 'button';
    close.title = 'Close the map (, or Esc)';
    close.addEventListener('click', () => this.close());
    el('div', 'hint', 'Tap or click: waypoint (again: clear) · drag: move · wheel or pinch: zoom · , or Esc: close', this.root);
    const m = this.marks;
    m.addEventListener('pointerdown', (e) => this.down(e));
    m.addEventListener('pointermove', (e) => this.move(e));
    m.addEventListener('pointerup', (e) => this.up(e, true));
    m.addEventListener('pointercancel', (e) => this.up(e, false));
    m.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    m.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('resize', () => { if (this.isOpen) this.fit(false); });
    // (first, before the modes': Esc closes the map, not the walk)
    addEventListener('keydown', (e) => {
      if (this.isOpen && e.code === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); this.close(); }
    }, { capture: true });
  }

  get isOpen() { return !this.root.hidden; }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  open() {
    if (this.isOpen || document.body.classList.contains('noui')) return;
    if (document.pointerLockElement) document.exitPointerLock();
    this.root.hidden = false;
    const p = this.at.pose();
    this.cx = p.x; this.cz = p.z;
    this.fit(true);
  }

  close() {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.pointers.clear();
    this.tap = null;
  }

  /** the frame: the view drawn again if it moved, the markers 10 times a second (at once when the waypoint changed) */
  update(now: number) {
    if (!this.isOpen) return;
    if (this.cityVersion !== this.data.version) { this.cityVersion = this.data.version; this.data.paint(this.city, CELL); this.viewDirty = true; }
    const moved = this.viewDirty;
    if (moved) { this.viewDirty = false; this.drawBase(); }
    if (moved || this.lastMarks !== this.at.waypoint.version || now - this.lastT >= 100) {
      this.lastT = now;
      this.lastMarks = this.at.waypoint.version;
      this.drawMarks();
    }
  }

  /** world point (x, z) on the screen, in CSS px (the tools) */
  toScreen(x: number, z: number) { return { sx: this.w / 2 + (x - this.cx) * this.s, sy: this.h / 2 + (z - this.cz) * this.s }; }

  private toWorld(sx: number, sy: number) { return { x: this.cx + (sx - this.w / 2) / this.s, z: this.cz + (sy - this.h / 2) / this.s }; }

  // the canvases at the window's size; first: the zoom of about 1.5 km across round the player
  private fit(first: boolean) {
    this.w = this.root.clientWidth; this.h = this.root.clientHeight;
    const dpr = Math.min(2, devicePixelRatio);
    for (const c of [this.base, this.marks]) { c.width = Math.round(this.w * dpr); c.height = Math.round(this.h * dpr); }
    if (first) this.s = Math.min(this.w, this.h) / 1500;
    this.clampView();
    this.viewDirty = true;
    this.lastMarks = -1;
  }

  private get minZoom() { return 0.8 * Math.min(this.w / this.data.W, this.h / this.data.D); }

  private clampView() {
    this.s = Math.min(MAX_ZOOM, Math.max(this.minZoom, this.s));
    this.cx = Math.min(this.data.W, Math.max(0, this.cx));
    this.cz = Math.min(this.data.D, Math.max(0, this.cz));
    this.viewDirty = true;
  }

  private zoomAt(sx: number, sy: number, k: number) {
    const p = this.toWorld(sx, sy);
    this.s *= k;
    this.s = Math.min(MAX_ZOOM, Math.max(this.minZoom, this.s));
    this.cx = p.x - (sx - this.w / 2) / this.s;
    this.cz = p.z - (sy - this.h / 2) / this.s;
    this.clampView();
  }

  private down(e: PointerEvent) {
    this.marks.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    this.tap = this.pointers.size === 1 ? { id: e.pointerId, x: e.offsetX, y: e.offsetY, moved: false } : null;
  }

  private move(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const [a, b] = [...this.pointers.values()];
    if (this.pointers.size >= 2 && b) {
      // a pinch: the zoom by the fingers' spread, the move by their middle
      const other = p === a ? b : a, d0 = Math.hypot(p.x - other.x, p.y - other.y), d1 = Math.hypot(e.offsetX - other.x, e.offsetY - other.y);
      const mx = (p.x + other.x) / 2, my = (p.y + other.y) / 2, nx = (e.offsetX + other.x) / 2, ny = (e.offsetY + other.y) / 2;
      this.cx -= (nx - mx) / this.s; this.cz -= (ny - my) / this.s;
      if (d0 > 0 && d1 > 0) this.zoomAt(nx, ny, d1 / d0);
    } else {
      const t = this.tap;
      if (t && Math.hypot(e.offsetX - t.x, e.offsetY - t.y) > TAP) t.moved = true;
      if (!t || t.moved) { this.cx -= (e.offsetX - p.x) / this.s; this.cz -= (e.offsetY - p.y) / this.s; }
    }
    p.x = e.offsetX; p.y = e.offsetY;
    this.clampView();
  }

  private up(e: PointerEvent, done: boolean) {
    this.pointers.delete(e.pointerId);
    const t = this.tap;
    this.tap = null;
    if (!done || !t || t.id !== e.pointerId || t.moved) return;
    const p = this.toWorld(t.x, t.y);
    this.at.waypoint.toggleAt(p.x, p.z, 14 / this.s);
  }

  private drawBase() {
    const c = this.base, ctx = c.getContext('2d')!, w = this.w, h = this.h, s = this.s;
    ctx.setTransform(c.width / w, 0, 0, c.height / h, 0, 0);
    ctx.fillStyle = OUTSIDE;
    ctx.fillRect(0, 0, w, h);
    const o = this.toScreen(0, 0);
    ctx.imageSmoothingEnabled = s < 1 / CELL * 2;
    ctx.drawImage(this.city, o.sx, o.sy, this.city.width * CELL * s, this.city.height * CELL * s);

    // the names: the landmarks first, then the streets, longest first, where there is room for them
    const taken: [number, number, number, number][] = [];
    const free = (x0: number, y0: number, x1: number, y1: number) => x1 > 0 && y1 > 0 && x0 < w && y0 < h
      && !taken.some((r) => x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]);
    ctx.lineJoin = 'round';
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    for (const l of this.data.labels) {
      const { sx, sy } = this.toScreen(l.x, l.y), name = l.name, tw = ctx.measureText(name).width;
      if (!free(sx - 10, sy - 10, sx + 14 + tw, sy + 10)) continue;
      taken.push([sx - 10, sy - 10, sx + 14 + tw, sy + 10]);
      this.data.landmark(ctx, l.cat, sx, sy);
      this.text(ctx, name, sx + 12, sy + 4, INK);
    }
    ctx.font = '11px Inter, system-ui, sans-serif';
    for (const [name, x, z, size] of this.data.streets) {
      if (size * s < 50) break;
      const { sx, sy } = this.toScreen(x, z), tw = ctx.measureText(name).width;
      if (!free(sx - tw / 2 - 2, sy - 8, sx + tw / 2 + 2, sy + 6)) continue;
      taken.push([sx - tw / 2 - 2, sy - 8, sx + tw / 2 + 2, sy + 6]);
      this.text(ctx, name, sx - tw / 2, sy + 4, '#d9d6c3');
    }
    const m = SCALES.find((v) => v * s >= 60) ?? SCALES[SCALES.length - 1];
    drawScale(ctx, h, m, m * s);
  }

  private text(ctx: CanvasRenderingContext2D, t: string, x: number, y: number, fill: string) {
    ctx.strokeStyle = OUTSIDE;
    ctx.lineWidth = 3;
    ctx.strokeText(t, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(t, x, y);
  }

  private drawMarks() {
    const c = this.marks, ctx = c.getContext('2d')!, w = this.w, h = this.h;
    ctx.setTransform(c.width / w, 0, 0, c.height / h, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.drawnOthers = [];
    for (const o of this.at.others()) {
      const { sx, sy } = this.toScreen(o.x, o.z);
      if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
      drawOther(ctx, sx, sy, o.label);
      this.drawnOthers.push({ player: o.player, label: o.label, sx, sy });
    }
    const wp = this.at.waypoint.at;
    if (wp) { const { sx, sy } = this.toScreen(wp.x, wp.z); drawPin(ctx, sx, sy); }
    const p = this.at.pose(), { sx, sy } = this.toScreen(p.x, p.z);
    drawPlayer(ctx, sx, sy, p.h);
  }
}
