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

interface Runs { counts: Uint16Array; runs: Uint16Array }
// the buildings (bld, per column) whose roof an edit changed: a column of theirs in box whose top (its last run's end
// and palette entry) differs between a and b -- a building's slopes are fitted to its whole roof (roofs.ts)
export function roofsChanged(N: number, a: Runs, b: Runs, bld: Uint16Array | null | undefined, box: Box): number[] {
  if (!bld) return [];
  const S = N + 2, out = new Set<number>();
  const offs = (c: Runs) => { const o = new Uint32Array(S * S + 1); for (let i = 0; i < S * S; i++) o[i + 1] = o[i] + c.counts[i]; return o; };
  const oa = offs(a), ob = offs(b);
  const top = (c: Runs, off: Uint32Array, i: number) => {
    const n = c.counts[i];
    if (!n) return -1;
    const k = (off[i] + n - 1) * 3;
    return (c.runs[k] + c.runs[k + 1]) * 65536 + c.runs[k + 2];
  };
  for (let Y = box.y0; Y < box.y1; Y++) for (let X = box.x0; X < box.x1; X++) {
    const i = X + S * Y;
    if (bld[i] && top(a, oa, i) !== top(b, ob, i)) out.add(bld[i]);
  }
  return [...out];
}
