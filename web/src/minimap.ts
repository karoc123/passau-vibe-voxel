import type { Rect } from './ui/help';
import type { RoadData } from './sim/types';
import type { Pose } from './sim/contract/pose';
import type { Label, Meta } from './core/meta';
import type { Place } from './types';
import type { Waypoint } from './waypoint';
import { coarsePointer, el } from './util';
import './minimap.css';

const CELL = 8; // metres per pixel of the atlas
const RIVER_SAMPLE = 24; // flood.json samples the river on this grid (scripts/flood.py SAMPLE)
const REACH = 560; // metres from the player to each edge of the minimap
const SCALE = 200;
const BASE = '#222b2a';
export const OUTSIDE = '#171c20';
const WATER = '#306973';
export const INK = '#f4f5f1';
const PIN = '#ff4fd8';
const OTHER = '#62d8ff';
const LANDMARKS: Record<string, string> = {
  church: 'M0-5V4M-3-2H3', castle: 'M-5 4v-8h2v2h2v-2h2v2h2v-2h2v8Z',
  bridge: 'M-5-2H5M-5 4v-6m10 6v-6M-3 4a3 4 0 0 1 6 0', tower: 'M-2 4v-6l2-3 2 3v6ZM-4 4H4',
  water: 'M-5-2q2-2 5 0t5 0M-5 2q2-2 5 0t5 0', industry: 'M-5 4v-4l4-3v3l4-3v7Z',
  transport: 'M-4-4h8v7h-8ZM-2 3l-2 2m6-2 2 2M-2 0h4', district: 'M-5 4v-4l3-3 3 3v4M1 4h4v-6L2-5 0-3',
  sport: 'M-5-3H5V3H-5ZM0-3v6', park: 'M0-5l-4 7h8ZM0 2v3', education: 'M-5-3q3-1 5 1 2-2 5-1v7q-3-1-5 1-2-2-5-1Z M0-2v7',
  health: 'M0-4V4M-4 0H4', shopping: 'M-4-1H4L3 4H-3ZM-2-1v-3h4v3',
  culture: 'M-5-2l5-3 5 3ZM-3 0v3m3-3v3m3-3v3M-5 5H5', civic: 'M-5 4h10v-6l-5-3-5 3ZM0 4v-3',
  sight: 'M-5 0q5-7 10 0-5 7-10 0ZM0-1a1 1 0 1 0 0 2 1 1 0 0 0 0-2',
};

const SHOWN_KEY = 'passau.minimap';
const EXPAND = '<svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';

export type MapPose = Pick<Pose, 'x' | 'z' | 'h'>;
/** another player on a map: who, their label (the name they chose, else their id) and where they are (on foot or in
 * what they drive or fly; y: the height, for the name over them) */
export interface MapMark { player: string; label: string; x: number; y: number; z: number }
/** what both maps mark: the player, the waypoint, the others */
export interface MapMarks { pose: () => MapPose; waypoint: Waypoint; others: () => readonly MapMark[] }
/** a marker as last drawn on a map, in its CSS pixels (the tools) */
export interface DrawnMark { player: string; label: string; sx: number; sy: number }

/** the city's ground as the maps draw it (the built blocks, the rivers, the roads) and its names (the landmarks, the
 * streets); version: bumped when what is drawn changes */
export class MapData {
  version = 0;
  readonly W: number;
  readonly D: number;
  readonly labels: Label[];
  // [name, x, z, size] longest first
  streets: [string, number, number, number][] = [];
  private roads: readonly RoadData[] = [];
  private river: ArrayLike<number> = [];
  private readonly icons = new Map<string, Path2D>();
  // the built blocks [x0, z0, x1, z1] (core/built.ts), null: the whole map; what is not built shows as outside
  private readonly built: [number, number, number, number][] | null;

  constructor(meta: Meta) {
    this.W = meta.W; this.D = meta.D;
    this.built = meta.built ?? null;
    this.labels = meta.labels.slice().sort((a, b) => (b.far ?? 0) - (a.far ?? 0));
  }

  setRoads(roads: readonly RoadData[]) { this.roads = roads; this.version++; }
  setRiver(river: ArrayLike<number>) { this.river = river; this.version++; }
  setPlaces(places: readonly Place[]) {
    this.streets = places.filter((p) => p[1] === 'street').map((p) => [p[0], p[2], p[3], p[4]] as [string, number, number, number])
      .sort((a, b) => b[3] - a[3]);
    this.version++;
  }

  /** the ground into canvas at cell metres a pixel */
  paint(canvas: HTMLCanvasElement, cell: number) {
    canvas.width = Math.ceil(this.W / cell);
    canvas.height = Math.ceil(this.D / cell);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1 / cell, 0, 0, 1 / cell, 0, 0);
    ctx.fillStyle = BASE;
    if (!this.built) ctx.fillRect(0, 0, this.W, this.D);
    else for (const [x0, z0, x1, z1] of this.built) ctx.fillRect(x0, z0, x1 - x0, z1 - z0);
    ctx.fillStyle = WATER;
    const water = new Path2D(), step = RIVER_SAMPLE;
    for (let i = 0; i + 1 < this.river.length; i += 2) water.rect(this.river[i] + 0.5 - step / 2, this.river[i + 1] + 0.5 - step / 2, step, step);
    ctx.fill(water);

    const local = new Path2D(), main = new Path2D();
    const seen = new Set<string>();
    for (const road of this.roads) {
      // The sim stores the same road in each direction. End nodes distinguish segments of the same OSM way.
      const key = `${road.w}/${Math.min(road.a, road.b)}/${Math.max(road.a, road.b)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const path = road.c >= 2 || road.v >= 16 ? main : local;
      const [first, ...rest] = road.p;
      path.moveTo(first[0], first[1]);
      for (const [x, z] of rest) path.lineTo(x, z);
    }
    // (the strokes a pixel or so wide at any cell)
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.strokeStyle = '#607170';
    ctx.lineWidth = cell;
    ctx.stroke(local);
    ctx.strokeStyle = '#c5bfa3';
    ctx.lineWidth = 1.5 * cell;
    ctx.stroke(main);
  }

  landmark(ctx: CanvasRenderingContext2D, category: string | undefined, x: number, y: number) {
    const key = category && Object.hasOwn(LANDMARKS, category) ? category : 'sight';
    let path = this.icons.get(key);
    if (!path) { path = new Path2D(LANDMARKS[key]); this.icons.set(key, path); }
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = OUTSIDE;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.1;
    ctx.stroke(path);
    ctx.restore();
  }
}

/** the player's chevron at (x, y), heading h (drawn pointing north, −z, at h = π) */
export function drawPlayer(ctx: CanvasRenderingContext2D, x: number, y: number, h: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI - h);
  ctx.beginPath();
  ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7); ctx.closePath();
  ctx.fillStyle = '#ffc068';
  ctx.fill();
  ctx.strokeStyle = OUTSIDE;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/** the waypoint's pin, its point at (x, y) */
export function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 6, y - 10); ctx.arc(x, y - 13, 7, Math.PI * 0.8, Math.PI * 0.2); ctx.closePath();
  ctx.fillStyle = PIN;
  ctx.fill();
  ctx.strokeStyle = OUTSIDE;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y - 13, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = OUTSIDE;
  ctx.fill();
}

/** another player: a dot and their label */
export function drawOther(ctx: CanvasRenderingContext2D, x: number, y: number, label: string) {
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = OTHER;
  ctx.fill();
  ctx.strokeStyle = OUTSIDE;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeText(label, x + 8, y + 4);
  ctx.fillStyle = OTHER;
  ctx.fillText(label, x + 8, y + 4);
}

/** a scale bar of metres m, `px` pixels long, at the bottom left of a map size high */
export function drawScale(ctx: CanvasRenderingContext2D, height: number, m: number, px: number) {
  const y = height - 9;
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.fillStyle = OUTSIDE;
  ctx.fillRect(8, y - 15, Math.max(39, px + 4), 18);
  ctx.fillStyle = INK;
  ctx.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, 10, y - 3);
  ctx.fillRect(10, y, px, 1.5);
}

/** A north-up map round the player. Positions are world metres (x east, z south, h: 0 towards +z, π/2 towards +x).
 * A click sets the waypoint there (on the waypoint: clears it), its corner button opens the full map; a tap on a
 * touch screen opens the full map (a waypoint is set there: a thumb is too broad for this one). Shown or not as last
 * left (M, the menu), at first on a touch screen only. */
export class Minimap {
  rects: Rect[] = [];
  /** the others as last drawn (the tools) */
  drawnOthers: DrawnMark[] = [];
  private readonly box = el('div', '');
  private readonly canvas = el('canvas', '', '', this.box);
  private readonly expand = el('button', 'map-expand', EXPAND, this.box);
  private readonly ctx = this.canvas.getContext('2d')!;
  private readonly atlas = document.createElement('canvas');
  private atlasVersion = -1;
  private lastT = -Infinity;
  // the pose last drawn (what a click is read against); stale: to be drawn again (shown, resized)
  private last: MapPose | null = null;
  private stale = true;
  private lastMarks = -1;
  private barBottom = -1;

  constructor(private readonly data: MapData, private readonly marks: MapMarks, openFull: () => void) {
    this.box.id = 'minimap';
    let kept: string | null = null;
    try { kept = localStorage.getItem(SHOWN_KEY); } catch { /* storage blocked */ }
    this.box.hidden = kept === null ? !coarsePointer() : kept !== '1';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'North-up minimap with your position and heading, rivers, roads and landmarks; click for a waypoint');
    const b = this.expand;
    b.type = 'button';
    b.title = 'Full map (,)';
    b.setAttribute('aria-keyshortcuts', ',');
    b.addEventListener('click', () => { b.blur(); openFull(); });
    this.canvas.addEventListener('click', (e) => { if (coarsePointer()) openFull(); else this.click(e); });
    const resize = new ResizeObserver(() => { this.stale = true; this.measure(); });
    resize.observe(this.box);
    addEventListener('resize', () => this.measure());
  }

  get shown() { return !this.box.hidden; }

  toggle() {
    if (document.body.classList.contains('noui')) return;
    this.box.hidden = !this.box.hidden;
    try { localStorage.setItem(SHOWN_KEY, this.box.hidden ? '0' : '1'); } catch { /* not remembered */ }
    this.stale = true;
    this.lastT = -Infinity;
    this.measure();
  }

  update(now: number, barBottom: number) {
    if (this.box.hidden) return;
    if (this.barBottom !== barBottom) {
      this.barBottom = barBottom;
      this.box.style.setProperty('--bar-bottom', `${barBottom}px`);
      this.measure();
    }
    if (now - this.lastT < 32) return;
    const pose = this.marks.pose(), others = this.marks.others(), last = this.last;
    // (redrawn when the player moved or turned, the waypoint changed, or 10 times a second while others are about)
    const marks = this.marks.waypoint.version;
    if (last && !this.stale && this.atlasVersion === this.data.version && marks === this.lastMarks && Math.hypot(pose.x - last.x, pose.z - last.z) < 1.5
      && Math.abs(pose.h - last.h) < 0.02 && (!(others.length || this.drawnOthers.length) || now - this.lastT < 100)) return;
    this.lastT = now;
    this.stale = false;
    this.last = { x: pose.x, z: pose.z, h: pose.h };
    this.lastMarks = marks;
    if (this.atlasVersion !== this.data.version) { this.atlasVersion = this.data.version; this.data.paint(this.atlas, CELL); }
    this.draw(this.last, others);
  }

  private measure() {
    const r = this.box.getBoundingClientRect();
    this.rects = r.width ? [{ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom }] : [];
  }

  private click(e: MouseEvent) {
    const pose = this.last, r = this.canvas.getBoundingClientRect(), size = r.width;
    if (!pose || !size) return;
    const zoom = size / 2 / REACH;
    const x = pose.x + (e.clientX - r.left - size / 2) / zoom, z = pose.z + (e.clientY - r.top - size / 2) / zoom;
    this.marks.waypoint.toggleAt(x, z, 12 / zoom);
  }

  private draw(pose: MapPose, others: readonly MapMark[]) {
    const ctx = this.ctx, size = this.canvas.clientWidth;
    if (size === 0) return;
    const px = Math.round(size * Math.min(2, devicePixelRatio));
    if (this.canvas.width !== px || this.canvas.height !== px) this.canvas.width = this.canvas.height = px;
    const mid = size / 2, zoom = mid / REACH;
    ctx.setTransform(px / size, 0, 0, px / size, 0, 0);
    ctx.fillStyle = OUTSIDE;
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(this.atlas, mid - pose.x * zoom, mid - pose.z * zoom, this.atlas.width * CELL * zoom, this.atlas.height * CELL * zoom);

    const drawn: [number, number][] = [[mid, mid], [16, 18], [22, size - 17], [size - 16, 16]];
    for (const l of this.data.labels) {
      const x = mid + (l.x - pose.x) * zoom, y = mid + (l.y - pose.z) * zoom;
      if (x < 10 || y < 10 || x > size - 10 || y > size - 10 || drawn.some(([a, b]) => Math.hypot(x - a, y - b) < 18)) continue;
      drawn.push([x, y]);
      this.data.landmark(ctx, l.cat, x, y);
    }

    this.drawnOthers = [];
    for (const o of others) {
      const x = mid + (o.x - pose.x) * zoom, y = mid + (o.z - pose.z) * zoom;
      if (x < 4 || y < 4 || x > size - 4 || y > size - 4) continue;
      drawOther(ctx, x, y, o.label);
      this.drawnOthers.push({ player: o.player, label: o.label, sx: x, sy: y });
    }
    // the waypoint, held at the edge when it is off the map (its direction)
    const wp = this.marks.waypoint.at;
    if (wp) {
      let dx = (wp.x - pose.x) * zoom, dy = (wp.z - pose.z) * zoom;
      const k = Math.max(Math.abs(dx), Math.abs(dy)) / (mid - 8);
      if (k > 1) { dx /= k; dy /= k; }
      drawPin(ctx, mid + dx, mid + dy);
    }
    drawPlayer(ctx, mid, mid, pose.h);

    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTSIDE;
    ctx.fillStyle = INK;
    ctx.lineWidth = 3;
    ctx.strokeText('N', 10, 19); ctx.fillText('N', 10, 19);
    drawScale(ctx, size, SCALE, SCALE * zoom);
  }
}
