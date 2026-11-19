import { clamp } from './util';

// The graphics settings (the ⚙ panel, bar.ts): each also a query parameter, so a link or a screenshot tool can set it,
// and remembered in localStorage once the visitor changes one. On load the URL wins over what is remembered, which
// wins over the defaults; only what differs from the defaults is written into the URL. All of them apply live.
//   res      0.5..1   pixels, a share of what the render size (perf.ts) gives
//   shadow   0 | 1024 | 2048 | 4096   the sun's shadow map size, 0 none
//   ao=0, bloom=0, tilt=0|1, refl=0  ambient occlusion, bloom, the tilt-shift blur, the reflections in water (post.ts)
//   grade    0..2     the film grade's strength (post.ts)
//   lod      0: 1 m tiles only, 2: never finer than 2 m, 4: never finer than 4 m (to look at them close up; else the
//            distance levels choose, city.ts), lodpx their switch
//   prepass=1  the depth pre-pass (prepass.ts)
//   occl=0     no occlusion culling (city.ts, occlusion.ts)
export type Lod = 'auto' | 'off' | 'far' | 'far4';
export interface Gfx { res: number; shadow: number; ao: boolean; bloom: boolean; tilt: boolean; refl: boolean; grade: number; lod: Lod; lodpx: number; prepass: boolean; occl: boolean }
export type Preset = 'low' | 'medium' | 'high';

export const SHADOWS = [0, 1024, 2048, 4096];
const KEY = 'passau.gfx';

// The depth pre-pass (prepass.ts) by default where it is known to pay: an Intel GPU through ANGLE's Direct3D 11 (Windows
// Chrome and Edge). On an Iris Xe, 1400 x 900, 6 fresh page loads each, the scene pass's GPU time without / with it:
// Oberhaus 10.9 (one load in six at 16.5) / 7.6 ms, the overview 11.9 / 11.5, the city 8.0 / 8.0, a street 5.5 / 4.9.
// Without it the tiles' shader there runs at one of two speeds, chosen per page load and kept (at Oberhaus 10.8 or
// 16.5 ms; between a fifth and half of the loads slow): the same program, uniforms, draws and render targets, its
// pixels ~1.7x slower (scissored to a few pixels both took 2.9 ms), not undone by compiling the program afresh or by
// recreating the shadow maps, render targets or textures. The same shader compiled without its discards (PREPASSED)
// and drawn the usual way took 10.3 ms on every load, slow or fast before: the driver handles a pixel shader that may
// discard and writes depth one of two ways. With the pre-pass the costly shader runs without discards, about once per
// pixel. (WSL's D3D12 on the same GPU: the depth pass cost more than it saved, off.)
export function prepassPays() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2'), ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return /Intel/i.test(name) && /Direct3D11/i.test(name);
  } catch { return false; }
}

// High is what the viewer did before there were settings (phones: 2048 shadows, no tilt-shift)
export function presets(phone: boolean, wide: boolean, prepass = false): Record<Preset, Gfx> {
  const high: Gfx = { res: 1, shadow: phone ? 2048 : 4096, ao: true, bloom: true, tilt: wide && !phone, refl: true, grade: 1, lod: 'auto', lodpx: 1.2, prepass, occl: true };
  return {
    low: { ...high, res: 0.6, shadow: 1024, ao: false, bloom: false, tilt: false, refl: false, lodpx: 2.2 },
    medium: { ...high, res: 0.8, shadow: 2048, tilt: false, lodpx: 1.6 },
    high,
  };
}

const num = (s: string | null, lo: number, hi: number) => (s === null || s === '' || !Number.isFinite(+s) ? undefined : clamp(+s, lo, hi));
const bool = (s: string | null) => (s === null ? undefined : s !== '0');

function fromQuery(q: URLSearchParams): Partial<Gfx> {
  const shadow = num(q.get('shadow'), 0, 4096), lod = q.get('lod');
  const g: Partial<Gfx> = {
    res: num(q.get('res'), 0.5, 1), grade: num(q.get('grade'), 0, 2), lodpx: num(q.get('lodpx'), 0.5, 4),
    shadow: shadow === undefined ? undefined : SHADOWS.reduce((a, b) => (Math.abs(b - shadow) < Math.abs(a - shadow) ? b : a)),
    ao: bool(q.get('ao')), bloom: bool(q.get('bloom')), tilt: bool(q.get('tilt')), refl: bool(q.get('refl')), prepass: bool(q.get('prepass')), occl: bool(q.get('occl')),
    lod: lod === null ? undefined : lod === '0' ? 'off' : lod === '2' ? 'far' : lod === '4' ? 'far4' : 'auto',
  };
  for (const k of Object.keys(g) as (keyof Gfx)[]) if (g[k] === undefined) delete g[k];
  return g;
}

function toQuery(g: Gfx, d: Gfx, q: URLSearchParams) {
  const put = (k: string, on: boolean, v: string) => { if (on) q.set(k, v); else q.delete(k); };
  put('res', g.res !== d.res, String(+g.res.toFixed(2)));
  put('shadow', g.shadow !== d.shadow, String(g.shadow));
  put('ao', g.ao !== d.ao, g.ao ? '1' : '0');
  put('bloom', g.bloom !== d.bloom, g.bloom ? '1' : '0');
  put('tilt', g.tilt !== d.tilt, g.tilt ? '1' : '0');
  put('refl', g.refl !== d.refl, g.refl ? '1' : '0');
  put('grade', g.grade !== d.grade, String(+g.grade.toFixed(2)));
  put('lod', g.lod !== d.lod, g.lod === 'off' ? '0' : g.lod === 'far' ? '2' : g.lod === 'far4' ? '4' : '1');
  put('lodpx', g.lodpx !== d.lodpx, String(+g.lodpx.toFixed(2)));
  put('prepass', g.prepass !== d.prepass, g.prepass ? '1' : '0');
  put('occl', g.occl !== d.occl, g.occl ? '1' : '0');
}

function stored(): Partial<Gfx> {
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return {};
    // checked as a query would be: an old or hand-edited entry cannot set anything out of range
    const o = JSON.parse(s) as Record<string, unknown>, q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : v === 'off' ? '0' : v === 'far' ? '2' : v === 'far4' ? '4' : String(v));
    return fromQuery(q);
  } catch { return {}; }
}

export class Settings {
  readonly defaults: Gfx;
  readonly presets: Record<Preset, Gfx>;
  readonly now: Gfx;
  private saveT = 0;

  constructor(phone: boolean, wide: boolean, prepass = false) {
    this.presets = presets(phone, wide, prepass);
    this.defaults = this.presets.high;
    this.now = { ...this.defaults, ...stored(), ...fromQuery(new URLSearchParams(location.search)) };
  }

  // the preset the settings match, if any
  get preset(): Preset | null {
    return (Object.keys(this.presets) as Preset[]).find((p) => (Object.keys(this.now) as (keyof Gfx)[]).every((k) => this.presets[p][k] === this.now[k])) ?? null;
  }

  // a change by the visitor: kept, and shown in the URL
  set(change: Partial<Gfx>) {
    Object.assign(this.now, change);
    // after a pause: a slider dragged would replace the history entry on every step (browsers throttle that)
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(this.now)); } catch { /* private mode, blocked storage: just not remembered */ }
      this.writeUrl();
    }, 300);
  }

  writeUrl() {
    const q = new URLSearchParams(location.search);
    toQuery(this.now, this.defaults, q);
    const s = `${q}`;
    if (s !== location.search.slice(1)) history.replaceState(history.state, '', s ? `?${s}` : location.pathname);
  }
}
