import type { Rect } from './hud';
import type { RoadData } from './sim/types';
import type { Pose } from './sim/contract/pose';
import type { Label, Meta } from './core/meta';
import { el } from './util';
import './minimap.css';

const CELL = 8; // metres per pixel of the atlas
const RIVER_SAMPLE = 24; // flood.json samples the surveyed water on this grid (scripts/flood.py)
const REACH = 560; // metres from the player to each edge of the minimap
const SCALE = 200;
const BASE = '#222b2a';
const OUTSIDE = '#171c20';
const WATER = '#306973';
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

type MapPose = Pick<Pose, 'x' | 'z' | 'h'>;

/** A read-only map. Positions are world metres (x east, z south, h: 0 towards +z, π/2 towards +x). */
export class Minimap {
  rects: Rect[] = [];
  private readonly button = el('button', '', '<span>Map</span>');
  private readonly canvas = el('canvas', '');
  private readonly ctx = this.canvas.getContext('2d')!;
  private readonly atlas = document.createElement('canvas');
  private readonly labels: Label[];
  private readonly icons = new Map<string, Path2D>();
  private roads: readonly RoadData[] = [];
  private river: ArrayLike<number> = [];
  private dirty = true;
  private lastT = -Infinity;
  private last: MapPose | null = null;
  private barBottom = -1;

  constructor(meta: Meta) {
    this.labels = meta.labels.slice().sort((a, b) => (b.far ?? 0) - (a.far ?? 0));
    this.atlas.width = Math.ceil(meta.W / CELL);
    this.atlas.height = Math.ceil(meta.D / CELL);
    this.canvas.id = 'minimap';
    this.canvas.hidden = true;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'North-up minimap with your position and heading, rivers, roads and landmarks');
    this.button.id = 'minimap-button';
    this.button.type = 'button';
    this.button.title = 'Minimap (M)';
    this.button.setAttribute('aria-controls', this.canvas.id);
    this.button.setAttribute('aria-pressed', 'false');
    this.button.setAttribute('aria-keyshortcuts', 'M');
    this.button.addEventListener('click', () => this.toggle());
    const resize = new ResizeObserver(() => { this.last = null; this.measure(); });
    resize.observe(this.button);
    resize.observe(this.canvas);
    addEventListener('resize', () => this.measure());
  }

  setRoads(roads: readonly RoadData[]) { this.roads = roads; this.dirty = true; }
  setRiver(river: ArrayLike<number>) { this.river = river; this.dirty = true; }

  toggle() {
    if (document.body.classList.contains('noui')) return;
    this.canvas.hidden = !this.canvas.hidden;
    this.button.setAttribute('aria-pressed', String(!this.canvas.hidden));
    this.last = null;
    this.lastT = -Infinity;
    this.measure();
  }

  update(now: number, readPose: () => MapPose, barBottom: number) {
    if (this.canvas.hidden) return;
    if (this.barBottom !== barBottom) {
      this.barBottom = barBottom;
      this.canvas.style.setProperty('--bar-bottom', `${barBottom}px`);
      this.measure();
    }
    if (now - this.lastT < 32) return;
    const pose = readPose();
    const last = this.last;
    if (last && !this.dirty && Math.hypot(pose.x - last.x, pose.z - last.z) < 1.5 && Math.abs(pose.h - last.h) < 0.02) return;
    this.lastT = now;
    this.last = pose;
    if (this.dirty) this.buildAtlas();
    this.draw(pose);
  }

  private measure() {
    this.rects = [this.button, this.canvas].flatMap((node) => {
      const r = node.getBoundingClientRect();
      return r.width ? [{ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom }] : [];
    });
  }

  private buildAtlas() {
    this.dirty = false;
    const ctx = this.atlas.getContext('2d')!;
    ctx.fillStyle = BASE;
    ctx.fillRect(0, 0, this.atlas.width, this.atlas.height);
    ctx.fillStyle = WATER;
    const water = new Path2D(), step = RIVER_SAMPLE / CELL;
    for (let i = 0; i + 1 < this.river.length; i += 2) {
      const x = (this.river[i] + 0.5) / CELL, z = (this.river[i + 1] + 0.5) / CELL;
      water.rect(x - step / 2, z - step / 2, step, step);
    }
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
      path.moveTo(first[0] / CELL, first[1] / CELL);
      for (const [x, z] of rest) path.lineTo(x / CELL, z / CELL);
    }
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.strokeStyle = '#607170';
    ctx.lineWidth = 1;
    ctx.stroke(local);
    ctx.strokeStyle = '#c5bfa3';
    ctx.lineWidth = 1.5;
    ctx.stroke(main);
  }

  private draw(pose: MapPose) {
    const ctx = this.ctx, size = this.canvas.clientWidth;
    if (size === 0) return;
    const px = Math.round(size * Math.min(2, devicePixelRatio));
    if (this.canvas.width !== px || this.canvas.height !== px) this.canvas.width = this.canvas.height = px;
    const mid = size / 2, zoom = mid / REACH;
    ctx.setTransform(px / size, 0, 0, px / size, 0, 0);
    ctx.fillStyle = OUTSIDE;
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(this.atlas, mid - pose.x * zoom, mid - pose.z * zoom, this.atlas.width * CELL * zoom, this.atlas.height * CELL * zoom);

    const drawn: [number, number][] = [[mid, mid], [16, 18], [22, size - 17]];
    for (const l of this.labels) {
      const x = mid + (l.x - pose.x) * zoom, y = mid + (l.y - pose.z) * zoom;
      if (x < 10 || y < 10 || x > size - 10 || y > size - 10 || drawn.some(([a, b]) => Math.hypot(x - a, y - b) < 18)) continue;
      drawn.push([x, y]);
      this.landmark(l.cat, x, y);
    }

    ctx.save();
    ctx.translate(mid, mid);
    ctx.rotate(Math.PI - pose.h); // the chevron is drawn pointing north (−z)
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7); ctx.closePath();
    ctx.fillStyle = '#ffc068';
    ctx.fill();
    ctx.strokeStyle = OUTSIDE;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTSIDE;
    ctx.fillStyle = '#f4f5f1';
    ctx.lineWidth = 3;
    ctx.strokeText('N', 10, 19); ctx.fillText('N', 10, 19);
    const y = size - 9;
    ctx.fillStyle = OUTSIDE;
    ctx.fillRect(8, y - 15, Math.max(39, SCALE * zoom + 4), 18);
    ctx.fillStyle = '#f4f5f1';
    ctx.fillText(`${SCALE} m`, 10, y - 3);
    ctx.fillRect(10, y, SCALE * zoom, 1.5);
  }

  private landmark(category: string | undefined, x: number, y: number) {
    const ctx = this.ctx, key = category && Object.hasOwn(LANDMARKS, category) ? category : 'sight';
    let path = this.icons.get(key);
    if (!path) { path = new Path2D(LANDMARKS[key]); this.icons.set(key, path); }
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = OUTSIDE;
    ctx.fill();
    ctx.strokeStyle = '#f4f5f1';
    ctx.lineWidth = 1.1;
    ctx.stroke(path);
    ctx.restore();
  }
}
