export type Pt = { x: number; y: number; z: number };
export type Dir = [number, number];

export interface PathData { p: [number, number, number][] }

export interface Path extends PathData {
  cum: Float32Array;
  // per point, the way to the right of it the offset path takes (at): the normal of a segment at either end, between
  // two the mitre (along their normals' bisector, 1 / cos(half the turn) long, at most MITRE)
  mit: Float32Array;
  L: number;
  startD: Dir;
  endD: Dir;
  startD15: Dir;
  endD15: Dir;
}

export const pt = (): Pt => ({ x: 0, y: 0, z: 0 });

function dirAt(e: PathData, i: number): Dir {
  const a = e.p[i], b = e.p[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

// arc lengths and end directions (also over the first and last ~15 m, for classifying turns)
export function prepPath<T extends PathData>(e: T): T & Path {
  const P = e as T & Path, n = e.p.length;
  P.cum = new Float32Array(n);
  for (let i = 1; i < n; i++) P.cum[i] = P.cum[i - 1] + Math.hypot(e.p[i][0] - e.p[i - 1][0], e.p[i][1] - e.p[i - 1][1]);
  P.L = P.cum[n - 1];
  P.startD = dirAt(e, 0);
  P.endD = dirAt(e, n - 2);
  P.mit = new Float32Array(2 * n);
  // (the segments either side of point i of some length: a repeated point has none)
  const seg = (i: number, step: number) => {
    for (let j = i; j >= 0 && j < n - 1; j += step) if (P.cum[j + 1] > P.cum[j]) return dirAt(e, j);
    return null;
  };
  for (let i = 0; i < n; i++) {
    const a0 = seg(i - 1, -1), b0 = seg(i, 1), a = a0 ?? b0 ?? [1, 0], b = b0 ?? a;
    let nx = -(a[1] + b[1]), ny = a[0] + b[0];
    const l = Math.hypot(nx, ny);
    if (l < 1e-6) { nx = -b[1]; ny = b[0]; } else { nx /= l; ny /= l; } // (a turn right back: the later segment's normal)
    const k = Math.min(MITRE, 1 / Math.max(1e-6, nx * -b[1] + ny * b[0]));
    P.mit[2 * i] = nx * k; P.mit[2 * i + 1] = ny * k;
  }
  const d = Math.min(15, P.L), a = pt(), b = pt();
  const unit = (): Dir => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return [(b.x - a.x) / l, (b.y - a.y) / l]; };
  at(P, P.L - d, 0, a); at(P, P.L, 0, b); P.endD15 = unit();
  at(P, 0, 0, a); at(P, d, 0, b); P.startD15 = unit();
  return P;
}

// the mitre at a sharp corner at most this many times the offset (a turn of up to 120 degrees mitred in full)
const MITRE = 2;

// The point at arc length s (extended straight beyond either end), off metres to the right. Off the line it is on the
// offset path that joins the segments' offsets at their corners mitred: from point to point the offset swings from one
// corner's mitre to the next's, so a lane's path is continuous round a corner (on the segment's own normal it moved
// sideways by up to off * sqrt 2 at a right angle, all at once).
export function at(e: Path, s: number, off: number, out: Pt): Pt {
  let x, y, z, nx, ny;
  const m = e.mit, n = e.p.length;
  if (s <= 0) {
    const [dx, dy] = e.startD, p = e.p[0];
    x = p[0] + dx * s; y = p[1] + dy * s; z = p[2]; nx = m[0]; ny = m[1];
  } else if (s >= e.L) {
    const [dx, dy] = e.endD, p = e.p[n - 1];
    x = p[0] + dx * (s - e.L); y = p[1] + dy * (s - e.L); z = p[2]; nx = m[2 * n - 2]; ny = m[2 * n - 1];
  } else {
    const c = e.cum;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const k = (lo + hi) >> 1; if (c[k] < s) lo = k; else hi = k; }
    const a = e.p[lo], b = e.p[hi], seg = c[hi] - c[lo] || 1e-6, f = (s - c[lo]) / seg;
    x = a[0] + (b[0] - a[0]) * f; y = a[1] + (b[1] - a[1]) * f; z = a[2] + (b[2] - a[2]) * f;
    nx = m[2 * lo] + (m[2 * hi] - m[2 * lo]) * f; ny = m[2 * lo + 1] + (m[2 * hi + 1] - m[2 * lo + 1]) * f;
  }
  out.x = x + nx * off; out.y = y + ny * off; out.z = z;
  return out;
}

// Where things are looked at from: x, z on the ground (the grid's x, y), y the height (none: on the ground, the
// distance along it). What moves comes and goes only far from it (view/life.ts, view/trains.ts).
export interface Viewer { x: number; z: number; y?: number }
// is the point (x, y on the grid, z its height) at least r m from the viewer?
export const farFrom = (v: Viewer, x: number, y: number, z: number, r: number) => (x - v.x) ** 2 + (y - v.z) ** 2 + (v.y === undefined ? 0 : (v.y - z) ** 2) >= r * r;

export const Turn = { Left: -1, Straight: 0, Right: 1, Back: 2 } as const;
export type Turn = (typeof Turn)[keyof typeof Turn];

// grid y points south, so a positive cross product is a right turn
export function turnOf(e: Path, n: Path): Turn {
  const A = e.endD15, B = n.startD15;
  const dot = A[0] * B[0] + A[1] * B[1], cross = A[0] * B[1] - A[1] * B[0];
  if (dot < -0.5) return Turn.Back;
  if (dot > 0.75) return Turn.Straight;
  return cross > 0 ? Turn.Right : Turn.Left;
}

// the lane a turn lands in on the next road (lane 0 is the leftmost)
export const landingLane = (t: Turn, lane: number, lanes: number) => (t === Turn.Left ? 0 : t === Turn.Right ? lanes - 1 : Math.min(lane, lanes - 1));

export const cellKey = (x: number, y: number, size: number) => ((x / size) | 0) * 100003 + ((y / size) | 0);
