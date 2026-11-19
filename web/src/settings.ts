import { clamp } from './util';

// The graphics settings (the ⚙ panel, bar.ts): each also a query parameter, so a link or a screenshot tool can set it,
// and remembered in localStorage, only those the visitor changed: a new default (the code's, or a device's like the
// pre-pass's) still reaches them for the rest. On load the URL wins over what is remembered, which wins over the
// defaults; only what differs from the defaults is written into the URL. All of them apply live.
//   res      0.5..1   pixels, a share of the screen's (at most 2 per CSS pixel)
//   detail   0..1     how much of the city is at 1 m around the focus (main.ts budget, city.ts), the rest 8 m clay;
//            phones hold 0.75 M triangles at most whatever it says
//   dist     metres   the view distance (Sichtweite): the city's tiles further from the camera than this (along the
//            ground) are neither drawn nor loaded, the fog closes in before it, a coarse ground stands beyond it
//            (city.ts, daylight.ts, farground.ts); 0: the whole map
// Unless the URL or the visitor set them, res and detail are chosen once at the first visit on a GPU (autores.ts) and
// remembered with the GPU's name; they never change by themselves after that.
export type Lod = 'auto' | 'off' | 'far' | 'far4';
export interface Gfx { res: number; detail: number; shadow: number; ao: boolean; bloom: boolean; tilt: boolean; refl: boolean; grade: number; lod: Lod; lodpx: number; prepass: boolean; occl: boolean; dist: number }
export type Preset = 'low' | 'medium' | 'high';

export const SHADOWS = [0, 1024, 2048, 4096];
// the view distance's range (metres; DIST_MAX on the slider stands for the whole map, 0)
export const DIST_MIN = 600, DIST_MAX = 5000;
const KEY = 'passau.gfx', AUTO_KEY = 'passau.gfx.auto';
// raised when the measuring changes enough that remembered results should be measured again (2: the detail too)
export const AUTO_VERSION = 2;
// the settings chosen by measuring, while neither the URL nor the visitor set them
export const AUTO_KEYS = ['res', 'detail'] as const;
export type AutoKey = typeof AUTO_KEYS[number];
export type Measured = Record<AutoKey, number>;

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
export const prepassPays = (gpu: string) => /Intel/i.test(gpu) && /Direct3D11/i.test(gpu);

// the GPU's name as WebGL tells it ('' if it does not)
export function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2'), ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}

// the view distance of Low and Medium (High: the whole map)
const LOW_DIST = 1500, MEDIUM_DIST = 2500;

// High is what the viewer did before there were settings (phones: 2048 shadows, no tilt-shift)
export function presets(phone: boolean, wide: boolean, prepass = false): Record<Preset, Gfx> {
  const high: Gfx = { res: 1, detail: 1, shadow: phone ? 2048 : 4096, ao: true, bloom: true, tilt: wide && !phone, refl: true, grade: 1, lod: 'auto', lodpx: 1.2, prepass, occl: true, dist: 0 };
  return {
    low: { ...high, res: 0.6, detail: 0.5, shadow: 1024, ao: false, bloom: false, tilt: false, refl: false, lodpx: 2.2, dist: LOW_DIST },
    medium: { ...high, res: 0.8, detail: 0.75, shadow: 2048, tilt: false, lodpx: 1.6, dist: MEDIUM_DIST },
    high,
  };
}

const num = (s: string | null, lo: number, hi: number) => (s === null || s === '' || !Number.isFinite(+s) ? undefined : clamp(+s, lo, hi));
const bool = (s: string | null) => (s === null ? undefined : s !== '0');

function fromQuery(q: URLSearchParams): Partial<Gfx> {
  const shadow = num(q.get('shadow'), 0, 4096), lod = q.get('lod'), dist = num(q.get('dist'), 0, 1e6);
  const g: Partial<Gfx> = {
    res: num(q.get('res'), 0.5, 1), detail: num(q.get('detail'), 0, 1), grade: num(q.get('grade'), 0, 2), lodpx: num(q.get('lodpx'), 0.5, 4),
    shadow: shadow === undefined ? undefined : SHADOWS.reduce((a, b) => (Math.abs(b - shadow) < Math.abs(a - shadow) ? b : a)),
    ao: bool(q.get('ao')), bloom: bool(q.get('bloom')), tilt: bool(q.get('tilt')), refl: bool(q.get('refl')), prepass: bool(q.get('prepass')), occl: bool(q.get('occl')),
    lod: lod === null ? undefined : lod === '0' ? 'off' : lod === '2' ? 'far' : lod === '4' ? 'far4' : 'auto',
    // (0, or anything past the slider's end: the whole map)
    dist: dist === undefined ? undefined : dist <= 0 || dist >= DIST_MAX ? 0 : Math.max(DIST_MIN, Math.round(dist)),
  };
  for (const k of Object.keys(g) as (keyof Gfx)[]) if (g[k] === undefined) delete g[k];
  return g;
}

function toQuery(g: Gfx, d: Gfx, q: URLSearchParams) {
  const put = (k: string, on: boolean, v: string) => { if (on) q.set(k, v); else q.delete(k); };
  put('res', g.res !== d.res, String(+g.res.toFixed(2)));
  put('detail', g.detail !== d.detail, String(+g.detail.toFixed(2)));
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
  put('dist', g.dist !== d.dist, String(g.dist));
}

// What the visitor changed ({ v: 2, ...those }). Entries of older versions (no v) hold every setting, as they were
// when one was changed: what equals today's defaults is taken as never chosen, and the pre-pass always (its default
// now depends on the GPU), so new defaults reach them; the entry is rewritten so.
function stored(defaults: Gfx): Partial<Gfx> {
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return {};
    // checked as a query would be: an old or hand-edited entry cannot set anything out of range
    const o = JSON.parse(s) as Record<string, unknown>, q = new URLSearchParams(), legacy = o.v !== 2;
    delete o.v;
    for (const [k, v] of Object.entries(o)) q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : v === 'off' ? '0' : v === 'far' ? '2' : v === 'far4' ? '4' : String(v));
    const g = fromQuery(q);
    if (legacy) {
      delete g.prepass;
      for (const k of Object.keys(g) as (keyof Gfx)[]) if (g[k] === defaults[k]) delete g[k];
      localStorage.setItem(KEY, JSON.stringify({ v: 2, ...g }));
    }
    return g;
  } catch { return {}; }
}

// what was measured on an earlier visit, if on the same GPU and by the same measuring
function storedAuto(gpu: string): Measured | null {
  try {
    const o = JSON.parse(localStorage.getItem(AUTO_KEY) ?? 'null') as { res?: unknown; detail?: unknown; gpu?: unknown; v?: unknown } | null;
    return o && o.gpu === gpu && o.v === AUTO_VERSION && typeof o.res === 'number' && typeof o.detail === 'number'
      ? { res: clamp(o.res, 0.5, 1), detail: clamp(o.detail, 0, 1) } : null;
  } catch { return null; }
}

export class Settings {
  readonly defaults: Gfx;
  readonly presets: Record<Preset, Gfx>;
  readonly now: Gfx;
  // what measuring chose (autores.ts): being measured, or fixed. It holds res and detail where isAuto says so.
  auto: (Measured & { measuring: boolean }) | null = null;
  private readonly chosen: Partial<Gfx>;
  private readonly inUrl: Partial<Gfx>;
  private saveT = 0;

  constructor(phone: boolean, wide: boolean, prepass: boolean, private readonly gpu = '') {
    this.presets = presets(phone, wide, prepass);
    this.defaults = this.presets.high;
    this.inUrl = fromQuery(new URLSearchParams(location.search));
    this.chosen = stored(this.defaults);
    this.now = { ...this.defaults, ...this.chosen, ...this.inUrl };
    const m = storedAuto(gpu);
    if (m) this.setAuto(m, false, false);
  }

  // res or detail as measured: neither the URL nor the visitor set it, and it was measured (or is being)
  isAuto(k: AutoKey) { return this.auto !== null && !(k in this.chosen) && !(k in this.inUrl); }

  // where res or detail comes from, as the panel says it
  source(k: AutoKey) {
    return k in this.chosen ? 'manual' : k in this.inUrl ? 'from link' : !this.isAuto(k) ? 'default' : this.auto!.measuring ? 'auto, measuring…' : 'auto';
  }

  // nothing set the resolution or the detail: they are to be measured (autores.ts)
  get toMeasure() { return this.auto === null && AUTO_KEYS.every((k) => !(k in this.chosen) && !(k in this.inUrl)); }

  // the preset the settings match, if any (what was measured leaves it as it is)
  get preset(): Preset | null {
    return (Object.keys(this.presets) as Preset[]).find((p) => (Object.keys(this.now) as (keyof Gfx)[])
      .every((k) => ((k === 'res' || k === 'detail') && this.isAuto(k)) || this.presets[p][k] === this.now[k])) ?? null;
  }

  // what measuring chose: measuring tells it is not final yet; when final it is remembered for this GPU
  setAuto(m: Measured, measuring: boolean, save = !measuring) {
    this.auto = { ...m, measuring };
    for (const k of AUTO_KEYS) if (this.isAuto(k)) this.now[k] = m[k];
    if (save) try { localStorage.setItem(AUTO_KEY, JSON.stringify({ ...m, gpu: this.gpu, v: AUTO_VERSION })); } catch { /* not remembered */ }
  }

  // a change by the visitor: kept, and shown in the URL. A resolution or detail they set replaces the measured one for good.
  set(change: Partial<Gfx>) {
    Object.assign(this.now, change);
    Object.assign(this.chosen, change);
    // after a pause: a slider dragged would replace the history entry on every step (browsers throttle that)
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      // only what differs from the defaults; res and detail whenever set, so that they are not measured again
      const keep = Object.fromEntries(Object.entries(this.chosen).filter(([k, v]) => k === 'res' || k === 'detail' || v !== this.defaults[k as keyof Gfx]));
      try { localStorage.setItem(KEY, JSON.stringify({ v: 2, ...keep })); } catch { /* private mode, blocked storage: just not remembered */ }
      this.writeUrl();
    }, 300);
  }

  writeUrl() {
    const q = new URLSearchParams(location.search), d = { ...this.defaults };
    // what was measured is this GPU's: not put into links
    for (const k of AUTO_KEYS) if (this.isAuto(k)) d[k] = this.now[k];
    toQuery(this.now, d, q);
    const s = `${q}`;
    if (s !== location.search.slice(1)) history.replaceState(history.state, '', s ? `?${s}` : location.pathname);
  }
}
