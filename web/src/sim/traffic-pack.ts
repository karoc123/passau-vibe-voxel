// traffic.json's polylines unpacked (scripts/trafficpack.py): a road's, footpath's or track's "q", one flat list of
// whole numbers (the first point's x and y in decimetres and its level, then each next point's differences to the one
// before), back to its points "p" [[x, y, z], ...]. A file from before the packing (with "p") is taken as it is.
type Packed = { p?: number[][]; q?: number[] };

export function unpackPoints(q: ArrayLike<number>) {
  const p: number[][] = new Array(q.length / 3);
  let X = 0, Y = 0, Z = 0;
  for (let i = 0, j = 0; i < q.length; i += 3, j++) {
    X += q[i]; Y += q[i + 1]; Z += q[i + 2];
    p[j] = [X / 10, Y / 10, Z];
  }
  return p;
}

// in place; returns its argument
export function unpackTraffic<T extends { roads?: Packed[]; peds?: Packed[]; trains?: Packed[] }>(td: T): T {
  for (const list of [td.roads, td.peds, td.trains]) for (const e of list ?? []) if (e.q) { e.p = unpackPoints(e.q); delete e.q; }
  return td;
}
