// The viewer's own data types (flood.json, zones.json, places). meta.json's (Meta with its labels and views, WorldId,
// TileLevel) and a node's ColumnData are in core/meta.ts, re-exported here for one step.
export type { ColumnData, Facts, Label, Meta, TileLevel, Vec3Tuple, View, WorldId } from './core/meta';

// flood.json (scripts/flood.py): of it the viewer reads only the river's points (its other fields are unread)
export interface FloodInfo {
  // the river's points every 24 m, x y pairs (sim/river.ts)
  river: number[];
}

// zones.json (scripts/zones.py): per building its box, four numbers x0, y0, w, h in one flat list (boxes; from before,
// buildings: per building [cx, cy, columns, x0, y0, x1, y1]); per label of meta.json, the building under it (0: none,
// else id + 1); keys: per building its stable key ("w<osm id>", "r<osm id>", "lod2:<gml:id>"), what outlives the build
// (building ids are build-local; 60000..65535 are reserved for players' builds)
export interface Zones {
  boxes?: number[];
  buildings?: number[][];
  labels: number[];
  keys?: string[];
}

export type Place = [name: string, kind: string, x: number, y: number, size: number, alt: string];
