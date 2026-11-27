import { DIST_MAX, DIST_MIN, type Gfx, type Preset, SHADOWS, type Settings } from '../settings';
import { el } from '../util';
import { choices, Slider, type SliderSpec } from './controls';

const PRESET: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** The menu's Graphics: the quality presets, and under "Advanced" each setting on its own (settings.ts). Every control
 * applies at once (onChange) and is kept by the settings. mark: where the preset's name is shown (the section's head). */
export class Graphics {
  private readonly sync: (() => void)[] = [];

  constructor(box: HTMLElement, mark: HTMLElement, private readonly s: Settings, private readonly onChange: (c: Partial<Gfx>) => void, maxShadow: number) {
    this.sync.push(() => { mark.textContent = PRESET[s.preset ?? ''] ?? 'custom'; });

    const quality = choices('quality', 'Quality', Object.entries(PRESET), box);
    quality.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      // (the TAA as it is: no preset turns it on or off)
      if (b) { const { taa: _, ...p } = s.presets[b.dataset.v as Preset]; this.change(p); }
    });
    this.sync.push(() => quality.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.preset)));

    const adv = el('details', 'adv', '<summary>Advanced</summary>', box);
    const pick = <K extends keyof Gfx>(key: K, label: string, opts: [Gfx[K], string][], cls = '') => {
      const row = choices(`pick ${cls}`, label, opts.map(([v, n]) => [String(v), n]), adv);
      row.dataset.key = key;
      row.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button');
        const o = b && opts.find(([v]) => String(v) === b.dataset.v);
        if (o) this.change({ [key]: o[0] } as Partial<Gfx>);
      });
      this.sync.push(() => row.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(s.now[key]))));
      return row;
    };
    const slide = (key: 'res' | 'detail' | 'grade' | 'lodpx', spec: Omit<SliderSpec, 'onInput' | 'onChange' | 'near' | 'log' | 'marks'> & { marks?: Record<string, number> }) => {
      const sl = new Slider(adv, { near: spec.step / 2, log: false, marks: {}, ...spec, onInput: (v) => this.change({ [key]: v }) });
      sl.input.name = key;
      this.sync.push(() => {
        // the resolution and the detail say whether measured or set (settings.ts, autores.ts)
        if (key === 'res' || key === 'detail') sl.setMarks({ [s.source(key)]: key === 'res' ? s.renderRes : s.now[key] });
        sl.set(document.activeElement === sl.input ? sl.value : key === 'res' ? s.renderRes : s.now[key]);
      });
      return sl;
    };
    const onOff: [boolean, string][] = [[true, 'on'], [false, 'off']];
    slide('res', { min: 0.5, max: 1, step: 0.05, show: (v) => `Resolution ${Math.round(v * 100)} %` });
    // (the triangles drawn: about the whole map at 8 m at 0, all of it at 1 m at 1; main.ts budget)
    slide('detail', { min: 0, max: 1, step: 0.05, show: (v) => `Detail ${v >= 1 ? 'all at 1 m' : `${Math.round(v * 100)} %`}` });
    // the view distance: the slider's end is the whole map (0)
    const dist = new Slider(adv, { min: DIST_MIN, max: DIST_MAX, step: 100, near: 50, log: true, marks: { low: s.presets.low.dist, medium: s.presets.medium.dist },
      show: (v) => `View distance ${v >= DIST_MAX ? 'max (5 km)' : `${(v / 1000).toFixed(1)} km`}`, onInput: (v) => this.change({ dist: v >= DIST_MAX ? 0 : v }) });
    dist.input.name = 'dist';
    this.sync.push(() => { if (document.activeElement !== dist.input) dist.set(s.now.dist || DIST_MAX); });
    pick('shadow', 'Shadows', SHADOWS.filter((n) => n <= maxShadow).map((n) => [n, n ? `${n / 1024}k` : 'off']));
    pick('ao', 'Ambient occlusion', onOff);
    pick('bloom', 'Bloom', onOff);
    pick('tilt', 'Tilt-shift blur', onOff);
    pick('refl', 'Reflections', onOff);
    slide('grade', { min: 0, max: 2, step: 0.1, marks: { default: 1, off: 0 }, show: (v) => `Film grade ${v.toFixed(1)}` });
    pick('lod', 'Far tiles at 2, 4 and 8 m', [['auto', 'auto'], ['off', 'never'], ['far', '2 m'], ['far4', '4 m'], ['far8', '8 m']]);
    const px = slide('lodpx', { min: 0.6, max: 3, step: 0.1, marks: { default: 1.2 }, show: (v) => `Coarser below ${v.toFixed(1)} px` });
    this.sync.push(() => { px.input.disabled = s.now.lod !== 'auto'; });
    pick('occl', 'Occlusion culling', onOff);
    pick('taa', 'Temporal upscaling', onOff);
    pick('prepass', 'Depth pre-pass', onOff, 'dev');
    el('div', 'menu-note', 'Resolution and detail “auto”: chosen once for this GPU (the resolution first, less detail only if still far too slow), then fixed until you set them. View distance: the city further away is neither loaded nor drawn, hidden in haze. Temporal upscaling: drawn at a lower resolution (67 % unless you set it) and sharpened over several frames instead of SMAA; can blur a little in fast motion. Depth pre-pass: slower on some GPUs. All kept in this browser.', adv);
    this.show();
  }

  private change(c: Partial<Gfx>) {
    for (const k of Object.keys(c) as (keyof Gfx)[]) if (c[k] === this.s.now[k]) delete c[k];
    if (!Object.keys(c).length) return;
    this.s.set(c);
    this.onChange(c);
    this.show();
  }

  show() { for (const f of this.sync) f(); }
}
