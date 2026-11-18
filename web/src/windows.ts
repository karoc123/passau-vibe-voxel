import * as THREE from 'three';
import type { Meta } from './types';
import { dataTexture, fetchGzip, fetchJson } from './util';
import type { VoxelUniforms } from './voxelMaterial';

interface WinType { med: { weekday: number[]; weekend: number[] }; shape: number[]; floors: number; colour: [number, number, number] }
interface WinStats { bins: [number, number][]; types: Record<string, WinType> }

// building kinds in windows.bin (scripts/windows.py) and the measured type each one follows (scripts/window_stats.py)
const KIND_MODEL = ['residential', 'residential', 'office', 'hotel', 'office', 'public', 'religious', 'public'];
const CENTRES = [16.5, 18.5, 20.5, 22.5, 27];

export async function loadWindows(meta: Meta, U: VoxelUniforms) {
  const [stats, buf] = await Promise.all([fetchJson<WinStats>('data/windows.json'), fetchGzip('data/windows.bin')]);
  const cells = new Uint8Array(buf), tex = dataTexture(cells, meta.W, meta.D, THREE.RedFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  U.uWinMap.value = tex;
  U.uSpillMap.value = spillMap(cells, meta.W, meta.D);
  KIND_MODEL.forEach((m, k) => {
    const t = stats.types[m];
    t.shape.forEach((q, i) => { U.uWinShape.value[k * 9 + i] = q; });
    U.uWinFloors.value[k] = t.floors;
    U.uWinCol.value[k].set(...t.colour);
  });
  return { set: (hour: number, day: number) => setWindows(U, stats, hour, day), cells }; // cells: non-zero on a building
}

function setWindows(U: VoxelUniforms, stats: WinStats, hour: number, day: number) {
  const weekday = new Date(Date.UTC(2026, 0, day)).getUTCDay(), weekend = weekday === 0 || weekday === 6;
  const t = hour < 12 ? hour + 24 : hour;
  const i = CENTRES.findIndex((c) => c > t), a = i < 0 ? CENTRES.length - 1 : Math.max(i - 1, 0), b = i < 0 ? a : i;
  const f = a === b ? 0 : (t - CENTRES[a]) / (CENTRES[b] - CENTRES[a]);
  KIND_MODEL.forEach((m, k) => {
    const med = stats.types[m].med[weekend ? 'weekend' : 'weekday'];
    U.uWinMed.value[k] = med[a] + (med[b] - med[a]) * Math.min(Math.max(f, 0), 1);
  });
  // the shops and cafés on the ground floors: all lit through the evening, a quarter of them after one
  const shop = 1 - 0.75 * Math.min(Math.max((t - 21.5) / 3.5, 0), 1) * (1 - Math.min(Math.max((t - 29.5) / 1.5, 0), 1));
  const m = U.uWinMed.value, res = (m[1] + m[3]) / 2 / 0.14, off = (m[2] + m[5]) / 2 / 0.14;
  U.uShop.value = shop;
  U.uSpill.value.set(0.55 * res + 0.45 * shop, 0.65 * off + 0.35 * shop);
}

// Light from the windows on the street before them: each 2 m cell of a facade (a building's cell beside open ground)
// sends its light out over the cells around it, blurred twice (~4 and ~6 m: a tent), homes and hotels in r, offices
// and public buildings in g; the shader weighs the two by how many of each are lit now (uSpill) -- churches, none.
const SPILL_S = 2;
function spillMap(cells: Uint8Array, W: number, D: number) {
  const w = Math.ceil(W / SPILL_S), h = Math.ceil(D / SPILL_S), kind = new Int8Array(w * h).fill(-1);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
    const v = cells[y * W + x];
    if (v) kind[(y >> 1) * w + (x >> 1)] = v & 7;
  }
  const a = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, k = kind[i];
    if (k < 0 || k === 6) continue;
    const open = +(kind[i - 1] < 0) + +(kind[i + 1] < 0) + +(kind[i - w] < 0) + +(kind[i + w] < 0);
    if (!open) continue;
    (k === 2 || k === 4 || k === 5 || k === 7 ? b : a)[i] = Math.min(open, 2);
  }
  const blur = (s: Float32Array, r: number) => {
    const t = new Float32Array(w * h), n = 2 * r + 1;
    for (let y = 0; y < h; y++) { let acc = 0; for (let x = -r; x < w + r; x++) {
      if (x + r < w) acc += s[y * w + x + r]; if (x - r - 1 >= 0) acc -= s[y * w + x - r - 1];
      if (x >= 0 && x < w) t[y * w + x] = acc / n; } }
    for (let x = 0; x < w; x++) { let acc = 0; for (let y = -r; y < h + r; y++) {
      if (y + r < h) acc += t[(y + r) * w + x]; if (y - r - 1 >= 0) acc -= t[(y - r - 1) * w + x];
      if (y >= 0 && y < h) s[y * w + x] = acc / n; } }
  };
  for (const s of [a, b]) { blur(s, 1); blur(s, 2); }
  // a straight facade on one side of a lane comes to ~0.2 here: ~0.5 in the texture, a lane between two to ~1
  const out = new Uint8Array(w * h * 2);
  for (let i = 0; i < w * h; i++) { out[2 * i] = Math.min(255, a[i] * 640); out[2 * i + 1] = Math.min(255, b[i] * 640); }
  const tex = dataTexture(out, w, h, THREE.RGFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  return tex;
}
