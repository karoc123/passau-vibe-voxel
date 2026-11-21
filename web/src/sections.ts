// An edited level-1 node is meshed in sections (docs/adr/0003-remesh-cost.md): SEC x SEC columns each, a mesh of their
// own, so that an edit meshes again only the sections it can change (mesher.worker.ts meshSections, stream.ts). An
// unedited node keeps its one mesh. Pure: shared by the worker and the main thread.
export const SEC = 16;

// a box of columns in apron coordinates (column X = x + 1 of node cell x: 0 .. N + 1), [x0, x1) x [y0, y1)
export interface Box { x0: number; y0: number; x1: number; y1: number }

// sections a side
export const perSide = (N: number) => Math.ceil(N / SEC);

// b grown by m columns each way, within the node and its apron (S = N + 2 columns a side)
export const grow = (b: Box, m: number, S: number): Box =>
  ({ x0: Math.max(0, b.x0 - m), y0: Math.max(0, b.y0 - m), x1: Math.min(S, b.x1 + m), y1: Math.min(S, b.y1 + m) });

export const union = (a: Box | null, b: Box): Box =>
  (a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b });

export const meets = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export const inside = (a: Box, b: Box) => a.x0 >= b.x0 && a.y0 >= b.y0 && a.x1 <= b.x1 && a.y1 <= b.y1;

// section k's columns (node cells sx * SEC .. , apron coordinates)
export function sectionBox(N: number, k: number): Box {
  const p = perSide(N), sx = k % p, sy = (k - sx) / p;
  return { x0: sx * SEC + 1, y0: sy * SEC + 1, x1: Math.min(N, sx * SEC + SEC) + 1, y1: Math.min(N, sy * SEC + SEC) + 1 };
}

// the section of node cell (x, y), 0 <= x, y < N
export const sectionOf = (N: number, x: number, y: number) => Math.floor(y / SEC) * perSide(N) + Math.floor(x / SEC);

// the sections a box meets
export function sectionsMeeting(N: number, b: Box): number[] {
  const p = perSide(N), out: number[] = [];
  for (let k = 0; k < p * p; k++) if (meets(sectionBox(N, k), b)) out.push(k);
  return out;
}

// the columns an edit's region (map cells, [x0, y0, x1, y1)) covers in level-1 node (tx, ty), apron coordinates; null
// where it misses the node and its apron
export function hotBox(N: number, tx: number, ty: number, r: readonly number[]): Box | null {
  const b = { x0: Math.max(0, Math.floor(r[0]) - tx * N + 1), y0: Math.max(0, Math.floor(r[1]) - ty * N + 1),
    x1: Math.min(N + 2, Math.ceil(r[2]) - tx * N + 1), y1: Math.min(N + 2, Math.ceil(r[3]) - ty * N + 1) };
  return b.x0 < b.x1 && b.y0 < b.y1 ? b : null;
}
