export interface RawColumns { counts: Uint16Array; runs: Uint16Array }
// planes: level 1's roof plane per column (decode), kept with the columns so a foliage job can re-mesh its base tile
export interface Columns extends RawColumns { ground: Uint8Array; planes?: Uint16Array | null }

export function decodeTile(buf: ArrayBuffer, N: number) {
  const n2 = (N + 2) * (N + 2);
  const counts = new Uint16Array(buf, 0, n2), ground = new Uint8Array(buf, n2 * 2, n2);
  let nr = 0;
  for (let i = 0; i < n2; i++) nr += counts[i];
  const end = n2 * 3 + nr * 6, runs = new Uint16Array(buf.slice(n2 * 3, end));
  // (level 1: the roof plane of each column's top face, scripts/tiles.py)
  const planes = buf.byteLength >= end + n2 * 2 ? new Uint16Array(buf.slice(end, end + n2 * 2)) : null;
  return { counts, ground, runs, planes };
}
