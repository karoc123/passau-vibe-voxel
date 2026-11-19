import * as THREE from 'three';
import { dataTexture, fetchGzip, fetchJson } from './util';
import type { VoxelUniforms } from './voxelMaterial';

interface WinType { med: { weekday: number[]; weekend: number[] }; shape: number[]; floors: number; colour: [number, number, number] }
interface WinStats { bins: [number, number][]; types: Record<string, WinType> }

// building kinds in windows.bin (scripts/windows.py) and the measured type each one follows (scripts/window_stats.py)
const KIND_MODEL = ['residential', 'residential', 'office', 'hotel', 'office', 'public', 'religious', 'public'];
const CENTRES = [16.5, 18.5, 20.5, 22.5, 27];

// windows.bin: per building (zones.py id) its kind and habit, a byte each (128 to a row of the texture, as uBldOn);
// the light the windows spill on the street comes with the tiles (scripts/tile_fields.py, fields.ts)
export async function loadWindows(U: VoxelUniforms) {
  const [stats, buf] = await Promise.all([fetchJson<WinStats>('data/windows.json'), fetchGzip('data/windows.bin')]);
  const b = new Uint8Array(buf), rows = Math.max(1, Math.ceil(b.length / 128)), table = new Uint8Array(rows * 128);
  table.set(b);
  const tex = dataTexture(table, 128, rows, THREE.RedFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  U.uWinB.value = tex;
  KIND_MODEL.forEach((m, k) => {
    const t = stats.types[m];
    t.shape.forEach((q, i) => { U.uWinShape.value[k * 9 + i] = q; });
    U.uWinFloors.value[k] = t.floors;
    U.uWinCol.value[k].set(...t.colour);
  });
  return { set: (hour: number, day: number) => setWindows(U, stats, hour, day) };
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
