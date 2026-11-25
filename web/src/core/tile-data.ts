import { DECODED_TAGS } from './tile-sections';

export interface RawColumns { counts: Uint16Array; runs: Uint16Array }
// planes: the roof plane per column, bld: the building per column (both apron included), kept with the columns so a
// foliage job can re-mesh its base tile; rooms: a level-1 node's room spans (decodeTile), null where it has none
// caps: a level-1 node's sloped surfaces (core/surface.ts; null: none), kept with the columns as they are (an edit kills
// the caps it touches by itself: capField's liveness); roofCaps: a node's roofs' surfaces (every level; roofs.ts roofField;
// null: none), likewise
export interface Columns extends RawColumns { ground: Uint8Array; planes?: Uint16Array | null; bld?: Uint16Array | null; rooms?: Uint16Array | null; caps?: Uint16Array | null; roofCaps?: Uint16Array | null }
// What the shader reads of a node (fields.ts), interleaved for its textures: cell RGBA per cell (N x N: river 1 or 0,
// unused 0, foliage class and tree), spill RG per cell of twice the size with its apron ((N / 2 + 2)^2)
export interface Fields { cell: Uint8Array; spill: Uint8Array }

// The node file's format (scripts/tilefile.py MAGIC, N): a node holds TILE_N x TILE_N cells (and its apron), so a level-1
// tile is TILE_N m a side; meta.json tiles.N says the same
export const TILE_MAGIC = 0x32545856; // "VXT2", little-endian
export const TILE_N = 128;

// A node's rooms (scripts/interiors.py): voxels carved out of a building on purpose -- empty in its runs -- as spans of
// four values, (column, z0, len, fill): the column as counts has them (apron included), sorted by column and then z0,
// fill the palette entry that stood there (what a coarser level and the occlusion culling take the room for). Only
// level-1 nodes with rooms have them (the section room); per column where its spans start, for a column's lookup:
export function roomOffsets(rooms: Uint16Array, n2: number) {
  const off = new Uint32Array(n2 + 1);
  for (let k = 0; k < rooms.length; k += 4) off[rooms[k] + 1]++;
  for (let i = 0; i < n2; i++) off[i + 1] += off[i];
  return off;
}

// A node file (scripts/tilefile.py): a header of tagged sections (core/tile-sections.ts TILE_SECTIONS) -- cnts, grnd,
// runs, and (levels, not foliage) plns, bldg, fols, spil, rivr (scripts/tile_fields.py), room (level 1, where it has
// rooms; roomOffsets), caps (level 1, where it has sloped ground: core/surface.ts capField), roof (roofCaps: every level,
// where it has sloped roofs: roofs.ts roofField). extra: every other section, raw (a tag this reader does not know, a
// reserved one: brik, a retired one: flod). A node without rivr (written before it) has no river: its fields say 0
export function decodeTile(buf: ArrayBuffer, N: number) {
  const dv = new DataView(buf);
  if (buf.byteLength < 8 || dv.getUint32(0, true) !== TILE_MAGIC) throw new Error('tile: not a VXT2 node file (scripts/tile_fields.py)');
  const n = dv.getUint32(4, true), sec = new Map<string, [number, number]>();
  for (let k = 0, at = 8 + 8 * n; k < n; k++) {
    const o = 8 + 8 * k, tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)), len = dv.getUint32(o + 4, true);
    sec.set(tag, [at, len]);
    at += len + (-len & 3);
  }
  const u16 = (t: string) => { const s = sec.get(t); return s ? new Uint16Array(buf.slice(s[0], s[0] + s[1])) : null; };
  const u8 = (t: string) => { const s = sec.get(t); return s ? new Uint8Array(buf, s[0], s[1]) : null; };
  const n2 = (N + 2) * (N + 2), cnt = sec.get('cnts')!, grnd = sec.get('grnd')!;
  const counts = new Uint16Array(buf, cnt[0], n2), ground = new Uint8Array(buf, grnd[0], n2);
  const runs = u16('runs')!, planes = u16('plns'), bld = u16('bldg'), rooms = u16('room'), caps = u16('caps'), roofCaps = u16('roof');
  // (planar in the file: it packs smaller)
  const rv = u8('rivr'), fo = u8('fols'), sp = u8('spil');
  let fields: Fields | null = null;
  if (fo && sp) {
    const a = N * N, m = (N / 2 + 2) ** 2, cell = new Uint8Array(a * 4), spill = new Uint8Array(m * 2);
    for (let i = 0; i < a; i++) { cell[4 * i] = rv ? (rv[i >> 3] >> (i & 7)) & 1 : 0; cell[4 * i + 2] = fo[i]; cell[4 * i + 3] = fo[a + i]; }
    for (let i = 0; i < m; i++) { spill[2 * i] = sp[i]; spill[2 * i + 1] = sp[m + i]; }
    fields = { cell, spill };
  }
  const extra = new Map<string, Uint8Array>();
  for (const [t, [at, len]] of sec) if (!DECODED_TAGS.has(t)) extra.set(t, new Uint8Array(buf, at, len));
  return { counts, ground, runs, planes, bld, rooms, caps, roofCaps, fields, extra };
}
