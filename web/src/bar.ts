import { PlaceSearch } from './search';
import { dateOf } from './sun';
import { DIST_MAX, DIST_MIN, type Gfx, type Preset, SHADOWS, type Settings } from './settings';
import { $, coarsePointer, el } from './util';

const hhmm = (h: number) => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const dayMonth = (d: number) => dateOf(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

interface SliderSpec {
  min: number;
  max: number;
  step: number;
  marks: Record<string, number>;
  near: number;
  log: boolean;
  shift?: number; // a log scale of v + shift, for a range reaching zero or below
  show: (v: number) => string;
  onInput: (v: number) => void;
  onChange?: (v: number) => void;
}

class Slider {
  readonly input: HTMLInputElement;
  private readonly val: HTMLElement;
  private readonly toPos: (v: number) => number;
  private readonly fromPos: (x: number) => number;

  constructor(host: HTMLElement, private readonly spec: SliderSpec) {
    const { min, max, step, log, shift = 0 } = spec;
    this.toPos = log ? (v) => Math.log(v + shift) : (v) => v;
    this.fromPos = log ? (x) => Math.round((Math.exp(x) - shift) / step) * step : (x) => x;
    const range = log ? `min="${this.toPos(min)}" max="${this.toPos(max)}" step="0.001"` : `min="${min}" max="${max}" step="${step}"`;
    const row = el('label', 'row', `<span class="val"></span><span class="track"><input type="range" ${range}></span>`, host);
    this.input = $<HTMLInputElement>('input', row);
    this.val = $('.val', row);
    this.input.addEventListener('input', () => {
      const v = this.fromPos(+this.input.value);
      this.show(v);
      spec.onInput(v);
    });
    this.input.addEventListener('change', () => spec.onChange?.(this.fromPos(+this.input.value)));
    this.input.addEventListener('keydown', (e) => { if (/^(Arrow|Page|Home|End)/.test(e.key)) e.stopPropagation(); }); // the walk keys still walk
  }

  set(v: number) {
    this.input.value = String(this.toPos(v));
    this.show(v);
  }

  private show(v: number) {
    const { marks, near } = this.spec;
    const mark = Object.keys(marks).filter((k) => Math.abs(marks[k] - v) <= near).sort((a, b) => Math.abs(marks[a] - v) - Math.abs(marks[b] - v))[0];
    this.val.innerHTML = `${this.spec.show(v)}${mark ? ` <span class="mark">${mark}</span>` : ''}`;
  }

  setMarks(marks: Record<string, number>) { this.spec.marks = marks; }
  get value() { return this.fromPos(+this.input.value); }
}

// buttons named as their values, or [value, name]
const choices = (cls: string, label: string, names: (string | [string, string])[], host: HTMLElement) =>
  el('div', `row ${cls}`, `<span class="val">${label}</span><span class="choices">${names.map((n) => (typeof n === 'string' ? [n, n] : n))
    .map(([v, n]) => `<button data-v="${v}">${n}</button>`).join('')}</span>`, host);

// The graphics panel, folded under a ⚙ row at the bar's foot: the quality presets, and under "Advanced" each setting
// on its own (settings.ts). Every control applies at once (onChange) and is kept by the settings.
class Graphics {
  private readonly box: HTMLElement;
  private readonly sync: (() => void)[] = [];

  constructor(host: HTMLElement, private readonly s: Settings, private readonly onChange: (c: Partial<Gfx>) => void, maxShadow: number) {
    const head = el('div', 'row gear', '<button class="fold" aria-expanded="false"><span class="icon">⚙</span> Graphics <span class="mark"></span></button>', host);
    this.box = el('div', 'gfx', '', host);
    const fold = $<HTMLButtonElement>('.fold', head);
    fold.addEventListener('click', () => {
      const open = this.box.classList.toggle('open');
      fold.setAttribute('aria-expanded', String(open));
      fold.blur(); // Space would click it again instead of jumping (nav.ts)
    });
    this.sync.push(() => { $('.mark', head).textContent = PRESET[s.preset ?? ''] ?? 'custom'; });

    const quality = choices('quality', 'Quality', Object.entries(PRESET), this.box);
    quality.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      // (the TAA as it is: no preset turns it on or off)
      if (b) { const { taa: _, ...p } = s.presets[b.dataset.v as Preset]; this.change(p); }
    });
    this.sync.push(() => quality.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.preset)));

    const adv = el('details', 'adv', '<summary>Advanced</summary>', this.box);
    const pick = <K extends keyof Gfx>(key: K, label: string, opts: [Gfx[K], string][], cls = '') => {
      const row = choices(`pick ${cls}`, label, opts.map(([v, n]) => [String(v), n]), adv);
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
    el('div', 'note', 'Resolution and city at 1 m “auto”: chosen once for this GPU (the resolution first, less of the city at 1 m only if still far too slow), then fixed until you set them. View distance: the city further away is neither loaded nor drawn, hidden in haze. Temporal upscaling: drawn at a lower resolution (67 % unless you set it) and sharpened over several frames instead of SMAA; can blur a little in fast motion. Depth pre-pass: slower on some GPUs.', adv);
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
const PRESET: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const FOLD_KEY = 'passau.barFolded';

export class Bar {
  readonly el = el('div', '');
  readonly search: PlaceSearch;
  private readonly time: Slider;
  private readonly date: Slider;
  private readonly sky: HTMLElement;
  // folds the panel to this one round button (and the mode buttons beside it): as the "?" button's credits, out of
  // the way of the thumbs. Folded at first on touch screens and narrow ones, open on the desktop; then as last left
  // (localStorage, FOLD_KEY).
  private readonly foldButton = el('button', 'bar-fold', '<span aria-hidden="true"></span>', this.el);

  constructor({ days, weathers, onDay, onDayEnd, onHour, onWeather }: {
    days: Record<string, number>;
    weathers: string[];
    onDay: (d: number) => void;
    onDayEnd: (d: number) => void;
    onHour: (h: number) => void;
    onWeather: (w: string) => void;
  }) {
    this.el.id = 'bar';
    this.foldButton.type = 'button';
    this.foldButton.addEventListener('click', () => {
      this.fold(!this.folded);
      this.foldButton.blur();
      try { localStorage.setItem(FOLD_KEY, this.folded ? '1' : '0'); } catch { /* storage blocked: folded as by default next time */ }
    });
    let kept: string | null = null;
    try { kept = localStorage.getItem(FOLD_KEY); } catch { /* storage blocked */ }
    this.fold(kept === '1' || (kept !== '0' && (coarsePointer() || matchMedia('(max-width: 600px)').matches)));
    this.search = new PlaceSearch(this.el, 'Search Passau…');
    this.date = new Slider(this.el, { min: 1, max: 365, step: 1, marks: days, near: 3, log: false, show: dayMonth, onInput: onDay, onChange: onDayEnd });
    this.time = new Slider(this.el, { min: 4, max: 23.5, step: 1 / 60, marks: {}, near: 1 / 3, log: false, show: hhmm, onInput: onHour });
    this.sky = choices('sky', 'Weather', weathers, this.el);
    this.sky.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) onWeather(b.dataset.v!); });
  }

  setDay(d: number, times: Record<string, number>) { this.date.set(d); this.time.setMarks(times); }
  setDays(days: Record<string, number>) { this.date.setMarks(days); this.date.set(this.date.value); }
  setHour(h: number) { if (document.activeElement !== this.time.input) this.time.set(h); }
  setWeather(w: string, mark: string) {
    this.sky.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === w));
    $('.val', this.sky).innerHTML = `Weather${mark ? ` <span class="mark">${mark}</span>` : ''}`;
  }
  offer(w: string, possible: boolean) { $<HTMLButtonElement>(`button[data-v="${w}"]`, this.sky).disabled = !possible; }
  // the ⚙ panel at the bar's foot (settings.ts)
  graphics(s: Settings, onChange: (c: Partial<Gfx>) => void, maxShadow: number) { return new Graphics(this.el, s, onChange, maxShadow); }
  get folded() { return this.el.classList.contains('folded'); }
  fold(on: boolean) {
    this.el.classList.toggle('folded', on);
    this.foldButton.setAttribute('aria-expanded', String(!on));
    this.foldButton.setAttribute('aria-label', on ? 'Show the map controls' : 'Hide the map controls');
    this.foldButton.title = on ? 'Show controls' : 'Hide controls';
  }
  get rect() { return this.el.getBoundingClientRect(); }
}
