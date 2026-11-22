// What a craft's cube swept through the voxels meets (VoxelCollision.sweep; the plane's flight reaches it through
// PlaneWorld). Types only: the cores that take a sweep (plane-flight.ts) import this, not voxel-collision.ts (fetch).
export type ImpactKind = 'terrain' | 'structure' | 'foliage' | 'city edge' | 'ceiling';
// Normal as a signed one-based axis index (x, y, z).
export type Contact = { fraction: number; axis: number };
export type Sweep = (Contact & { hit: ImpactKind }) | { fraction: number; hit: null } | 'loading';
