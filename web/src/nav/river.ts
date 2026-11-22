// The rivers for the crafts that start on them (the boat, the floatplane): their points (flood.json `river`: x, z
// pairs, one river cell every 24 m), the one nearest a place and the way downstream there. Plain numbers, no three.js,
// no DOM, no fetch: the points come from the caller (main.ts loads them with the flood data). The water's own surface
// at a place is VoxelCollision.waterColumn's (docs/plans/handoff-refactor-todos.md F8 brings it here).

/** the river points: x, z pairs (flood.json `river`) */
export type RiverPoints = ArrayLike<number>;

// Where a craft is put in: the river point nearest (x, z), in the middle of its cell; null: none
export function nearestRiver(river: RiverPoints, x: number, z: number): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null, bd = Infinity;
  for (let k = 0; k + 1 < river.length; k += 2) {
    const d = (river[k] - x) ** 2 + (river[k + 1] - z) ** 2;
    if (d < bd) { bd = d; best = { x: river[k] + 0.5, z: river[k + 1] + 0.5 }; }
  }
  return best;
}

// Downstream at (x, z), roughly, as a heading: along the river's points within 120 m (their principal axis), the way
// that leads towards `eck` (the Dreiflüsseeck, where the Inn and the Ilz flow into the Danube: meta.views.eck), and
// east (+x) from it on (the Danube's way out of the map). Without an eck: east.
export function downstream(river: RiverPoints, x: number, z: number, eck?: { x: number; z: number }) {
  const to = eck && x < eck.x - 60 ? [eck.x - x, eck.z - z] : [1, 0];
  let n = 0, mx = 0, mz = 0, sxx = 0, sxz = 0, szz = 0;
  const near: number[] = [];
  for (let k = 0; k + 1 < river.length; k += 2) {
    if ((river[k] - x) ** 2 + (river[k + 1] - z) ** 2 >= 120 * 120) continue;
    near.push(river[k], river[k + 1]); mx += river[k]; mz += river[k + 1]; n++;
  }
  let ax = to[0], az = to[1];
  if (n >= 3) {
    mx /= n; mz /= n;
    for (let k = 0; k < near.length; k += 2) { const dx = near[k] - mx, dz = near[k + 1] - mz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
    const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    ax = Math.cos(th); az = Math.sin(th);
    if (ax * to[0] + az * to[1] < 0) { ax = -ax; az = -az; }
  }
  return Math.atan2(ax, az);
}
