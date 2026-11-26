// ?focus=bld:<id> | bld:r<id> | street:<id>: the camera frames one building (OSM way, or relation with r) or street
// (OSM way) of the map. Its box comes from data/objects/<id % 64>.json (scripts/objects.py: one small file per id
// shard, never the whole map). The view: from compass bearing ?az= (degrees, where the camera stands seen from the
// object: 180 = from the south; default 200), ?el= degrees over the horizon (default 30, streets 55), ?fit= distance
// factor (default 1: the object's box just fills the view). With ?crop=fit only the tiles round the object load.
import { CLIENT_FILES, dataUrl } from './core/data-contract';
import { fetchJson } from './util';

const SHARDS = 64;

export interface FocusView {
  key: string;
  pos: [number, number, number];
  target: [number, number, number];
  /** half the box's size across the ground, metres (for crop=fit) */
  reach: number;
  box: [number, number, number, number, number, number];
}

function focusKey(q: string): { key: string; id: number } | null {
  const m = /^(bld|building|street):([wr]?)(\d+)$/.exec(q.trim());
  if (!m) return null;
  const id = Number(m[3]);
  return { key: (m[1] === 'street' ? 's' : m[2] === 'r' ? 'r' : 'w') + id, id };
}

export async function focusView(q: string, qs: URLSearchParams, fovDeg: number, aspect: number): Promise<FocusView | null> {
  const k = focusKey(q);
  if (!k) { console.error(`focus: "${q}" is not bld:<id>, bld:r<id> or street:<id>`); return null; }
  const shard = await fetchJson<Record<string, [number, number, number, number, number, number]>>(dataUrl(`${CLIENT_FILES.objects}${k.id % SHARDS}.json`)).catch(() => null);
  const box = shard?.[k.key];
  if (!box) { console.error(`focus: ${q} is not on the map (data/objects/${k.id % SHARDS}.json)`); return null; }
  const [x0, z0, x1, z1, y0, y1] = box;
  const street = k.key[0] === 's';
  const num = (name: string, d: number) => { const v = Number(qs.get(name)); return qs.get(name) !== null && Number.isFinite(v) ? v : d; };
  const az = num('az', 200) * Math.PI / 180, el = num('el', street ? 55 : 30) * Math.PI / 180, fit = num('fit', 1);
  const cx = (x0 + x1) / 2 + 0.5, cz = (z0 + z1) / 2 + 0.5;
  const ty = street ? y0 + 1 : y0 + 0.45 * (y1 - y0);
  const r = Math.max(10, 0.5 * Math.hypot(x1 - x0, z1 - z0, street ? 0 : y1 - y0));
  // the box's sphere inside the narrower of the two fields of view
  const half = Math.min(fovDeg / 2, Math.atan(Math.tan(fovDeg * Math.PI / 360) * aspect) * 180 / Math.PI) * Math.PI / 180;
  const d = fit * r / Math.sin(half);
  const pos: [number, number, number] = [cx + d * Math.cos(el) * Math.sin(az), ty + d * Math.sin(el), cz - d * Math.cos(el) * Math.cos(az)];
  return { key: k.key, pos, target: [cx, ty, cz], reach: Math.max(x1 - x0, z1 - z0) / 2, box };
}
