import { $, el } from '../util';

export interface SliderSpec {
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

/** a slider under its value, which names the nearest of its marks */
export class Slider {
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

/** buttons named as their values, or [value, name] */
export const choices = (cls: string, label: string, names: (string | [string, string])[], host: HTMLElement) =>
  el('div', `row ${cls}`, `<span class="val">${label}</span><span class="choices">${names.map((n) => (typeof n === 'string' ? [n, n] : n))
    .map(([v, n]) => `<button type="button" data-v="${v}">${n}</button>`).join('')}</span>`, host);
