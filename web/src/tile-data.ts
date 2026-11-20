export interface RawColumns { counts: Uint16Array; runs: Uint16Array }
// planes: the roof plane per column, bld: the building per column (both apron included), kept with the columns so a
// foliage job can re-mesh its base tile
export interface Columns extends RawColumns { ground: Uint8Array; planes?: Uint16Array | null; bld?: Uint16Array | null }
// What the shader reads of a node (fields.ts), interleaved for its textures: cell RGBA per cell (N x N: the river's
// level and bed, foliage class and tree), spill RG per cell of twice the size with its apron ((N / 2 + 2)^2)
export interface Fields { cell: Uint8Array; spill: Uint8Array }

// The node file's format (scripts/tilefile.py MAGIC, N): a node holds TILE_N x TILE_N cells (and its apron), so a level-1
// tile is TILE_N m a side; meta.json tiles.N says the same
export const TILE_MAGIC = 0x32545856; // "VXT2", little-endian
export const TILE_N = 128;

// A node file (scripts/tilefile.py): a header of tagged sections -- cnts, grnd, runs, and (levels, not foliage) plns,
// bldg, flod, fols, spil (scripts/tile_fields.py)
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
  const runs = u16('runs')!, planes = u16('plns'), bld = u16('bldg');
  // (planar in the file: it packs smaller)
  const fl = u8('flod'), fo = u8('fols'), sp = u8('spil');
  let fields: Fields | null = null;
  if (fl && fo && sp) {
    const a = N * N, m = (N / 2 + 2) ** 2, cell = new Uint8Array(a * 4), spill = new Uint8Array(m * 2);
    for (let i = 0; i < a; i++) { cell[4 * i] = fl[i]; cell[4 * i + 1] = fl[a + i]; cell[4 * i + 2] = fo[i]; cell[4 * i + 3] = fo[a + i]; }
    for (let i = 0; i < m; i++) { spill[2 * i] = sp[i]; spill[2 * i + 1] = sp[m + i]; }
    fields = { cell, spill };
  }
  return { counts, ground, runs, planes, bld, fields };
}
