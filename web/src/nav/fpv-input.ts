import type { FlightInput } from '../sim/contract/inputs';
import { gamepads } from './input';
import './fpv-input.css';

const CHANNELS = [
  { key: 'roll', name: 'Roll', direction: 'Move roll right.' },
  { key: 'pitch', name: 'Pitch', direction: 'Push pitch forward.' },
  { key: 'yaw', name: 'Yaw', direction: 'Move yaw right.' },
  { key: 'throttle', name: 'Throttle', direction: 'Raise throttle from its lowest position.' },
] as const;

type Channel = typeof CHANNELS[number]['key'];
interface Binding {
  index: number;
  inverted: boolean;
  min: number;
  center: number;
  max: number;
}
type Profile = Record<Channel, Binding>;
interface AxisRow {
  axis: HTMLSelectElement;
  inverted: HTMLInputElement;
  value: HTMLOutputElement;
}
interface Learning {
  origin: number[];
  bindings: Binding[];
  returnAxis: number | null;
}
interface Calibrating {
  min: number[];
  max: number[];
}

const button = (label: string) => {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  return el;
};
const padKey = (pad: Gamepad) => JSON.stringify([pad.index, pad.id]);
const profileKey = (pad: Gamepad) => 'fpv-controller-v1:' + JSON.stringify([pad.id, pad.mapping, pad.axes.length]);
const binding = (index: number, inverted = false, center = 0): Binding => ({ index, inverted, min: -1, center, max: 1 });
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function defaultProfile(pad: Gamepad): Profile {
  return pad.mapping === 'standard' && pad.axes.length >= 4
    ? { roll: binding(2), pitch: binding(3, true), yaw: binding(0), throttle: binding(1, true) }
    : { roll: binding(-1), pitch: binding(-1), yaw: binding(-1), throttle: binding(-1) };
}

function readBinding(value: unknown, count: number): value is Binding {
  if (!value || typeof value !== 'object') return false;
  const { index, inverted, min, center, max } = value as Binding;
  return Number.isInteger(index) && index >= -1 && index < count && typeof inverted === 'boolean' &&
    Number.isFinite(min) && Number.isFinite(center) && Number.isFinite(max) &&
    min >= -1 && max <= 1 && max - min >= 0.4 && min < center && center < max;
}

function axisValue(channel: Channel, raw: number, axis: Binding) {
  if (channel === 'throttle') {
    const fraction = clamp((raw - axis.min) / (axis.max - axis.min), 0, 1);
    const positive = axis.inverted ? 1 - fraction : fraction;
    return clamp((positive - 0.025) / 0.95, 0, 1);
  }
  const offset = raw - axis.center;
  const range = offset < 0 ? axis.center - axis.min : axis.max - axis.center;
  const position = clamp(offset / range, -1, 1) * (axis.inverted ? -1 : 1);
  const magnitude = Math.abs(position);
  return magnitude <= 0.05 ? 0 : Math.sign(position) * (magnitude - 0.05) / 0.95;
}

export class FpvInput {
  readonly element = document.createElement('details');
  private readonly summary = document.createElement('summary');
  private readonly content = document.createElement('div');
  private readonly devices = document.createElement('select');
  private readonly rows = new Map<Channel, AxisRow>();
  private readonly learnButton = button('Learn axes');
  private readonly rangeButton = button('Calibrate range');
  private readonly cancelButton = button('Cancel calibration');
  private readonly message = document.createElement('p');
  private readonly raw = document.createElement('div');
  private readonly profiles = new Map<string, Profile>();
  private selected = '';
  private selectedName = '';
  private selectedIndex = -1;
  private selectedId = '';
  private selectedMapping: GamepadMappingType | null = null;
  private selectedAxes = 0;
  private selectedProfile = '';
  private optionsKey = '';
  private pads: Gamepad[] = [];
  private profile: Profile | null = null;
  private learning: Learning | null = null;
  private calibrating: Calibrating | null = null;
  private note = '';
  private latest: FlightInput | null = null;
  private nextDraw = 0;

  constructor() {
    this.element.className = 'fpv-input';
    this.summary.textContent = 'Controller setup';
    this.content.className = 'fpv-input-content';
    this.message.className = 'fpv-input-message';
    this.message.setAttribute('role', 'status');
    this.raw.className = 'fpv-input-raw';
    this.devices.setAttribute('aria-label', 'Controller');
    const grid = document.createElement('div');
    grid.className = 'fpv-input-grid';

    for (const { key, name } of CHANNELS) {
      const title = document.createElement('label');
      const axis = document.createElement('select');
      const inverted = document.createElement('input');
      const invertLabel = document.createElement('label');
      const value = document.createElement('output');
      const id = `fpv-axis-${key}`;
      title.htmlFor = axis.id = id;
      title.textContent = name;
      inverted.type = 'checkbox';
      inverted.setAttribute('aria-label', `Invert ${name.toLowerCase()}`);
      invertLabel.append(inverted, 'Invert');
      value.setAttribute('for', id);
      // Values change continuously beside the input and stay out of live announcements.
      value.setAttribute('aria-live', 'off');
      grid.append(title, axis, invertLabel, value);
      this.rows.set(key, { axis, inverted, value });

      axis.addEventListener('change', () => {
        if (!this.profile) return;
        this.profile[key] = binding(Number(axis.value), inverted.checked);
        this.persist();
      });
      inverted.addEventListener('change', () => {
        if (!this.profile) return;
        this.profile[key].inverted = inverted.checked;
        this.persist();
      });
    }

    const actions = document.createElement('div');
    actions.className = 'fpv-input-actions';
    actions.append(this.learnButton, this.rangeButton, this.cancelButton);
    const deviceLabel = document.createElement('label');
    deviceLabel.className = 'fpv-input-device';
    deviceLabel.append('Controller', this.devices);
    this.content.append(deviceLabel, grid, actions, this.message, this.raw);
    this.element.append(this.summary, this.content);
    this.devices.addEventListener('change', () => {
      const pad = this.pads.find(p => padKey(p) === this.devices.value);
      if (pad) this.select(pad);
    });
    this.learnButton.addEventListener('click', () => {
      const pad = this.pad;
      if (!pad) return;
      this.note = '';
      this.learning = { origin: [...pad.axes], bindings: [], returnAxis: null };
    });
    this.rangeButton.addEventListener('click', () => {
      if (this.calibrating) this.saveRange();
      else if (this.pad && this.mappingValid()) {
        this.note = '';
        this.calibrating = {
          min: Array(CHANNELS.length).fill(1),
          max: Array(CHANNELS.length).fill(-1),
        };
      }
    });
    this.cancelButton.addEventListener('click', () => {
      this.learning = this.calibrating = null;
      this.note = '';
    });
    this.draw();
  }

  get ready() { return this.latest !== null; }
  get deviceKey() { return this.pad ? this.selected + this.selectedProfile : null; }
  private get pad() { return this.pads.find(p => p.index === this.selectedIndex && p.id === this.selectedId); }

  update(): FlightInput | null {
    this.pads = gamepads();
    if (!this.selected && this.pads.length) this.select(this.pads.find(pad => pad.axes.length >= 4) ?? this.pads[0]);
    const pad = this.pad;
    if (pad && (pad.axes.length !== this.selectedAxes || pad.mapping !== this.selectedMapping)) this.select(pad);
    if (pad) {
      if (this.learning) this.learn(pad);
      if (this.calibrating && this.profile) this.sampleRange(pad, this.profile, this.calibrating);
    } else if (this.learning || this.calibrating) {
      this.learning = this.calibrating = null;
      this.note = '';
    }

    this.latest = pad && this.profile && this.mappingValid() && !this.learning && !this.calibrating
      ? this.read(pad, this.profile) : null;

    const now = performance.now();
    if (now >= this.nextDraw) {
      this.nextDraw = now + 100;
      this.draw();
    }
    return this.latest;
  }

  private select(pad: Gamepad) {
    this.selected = padKey(pad);
    this.selectedIndex = pad.index;
    this.selectedId = pad.id;
    this.selectedMapping = pad.mapping;
    this.selectedAxes = pad.axes.length;
    this.selectedName = pad.id || `Controller ${pad.index + 1}`;
    this.selectedProfile = profileKey(pad);
    this.learning = this.calibrating = null;
    this.note = '';
    this.profile = this.load(pad);
    for (const { axis } of this.rows.values()) {
      axis.replaceChildren(new Option('Choose axis', '-1'));
      for (let index = 0; index < pad.axes.length; index++) axis.add(new Option(`Axis ${index + 1}`, String(index)));
    }
    this.syncRows();
    if (!this.mappingValid()) this.element.open = true;
  }

  private load(pad: Gamepad): Profile {
    const cached = this.profiles.get(this.selectedProfile);
    if (cached) return cached;
    try {
      const saved = JSON.parse(localStorage.getItem(this.selectedProfile) ?? 'null');
      if (saved && CHANNELS.every(({ key }) => readBinding(saved[key], pad.axes.length))) return saved as Profile;
    } catch {
      // The current session still supports calibration when browser storage is blocked.
    }
    return defaultProfile(pad);
  }

  private persist() {
    if (!this.profile) return;
    this.profiles.set(this.selectedProfile, this.profile);
    try {
      localStorage.setItem(this.selectedProfile, JSON.stringify(this.profile));
    } catch {
      // Keep using the controller calibration in memory.
    }
  }

  private syncRows() {
    if (!this.profile) return;
    for (const { key } of CHANNELS) {
      const row = this.rows.get(key)!;
      row.axis.value = String(this.profile[key].index);
      row.inverted.checked = this.profile[key].inverted;
    }
  }

  private mappingValid() {
    if (!this.profile) return false;
    const indices = CHANNELS.map(({ key }) => this.profile![key].index);
    return indices.every(index => index >= 0) && new Set(indices).size === CHANNELS.length;
  }

  private read(pad: Gamepad, profile: Profile): FlightInput | null {
    const input: FlightInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    for (const { key } of CHANNELS) {
      const raw = pad.axes[profile[key].index];
      if (!Number.isFinite(raw)) return null;
      input[key] = axisValue(key, raw, profile[key]);
    }
    return input;
  }

  private learn(pad: Gamepad) {
    const learn = this.learning!;
    if (learn.returnAxis !== null) {
      if (Math.abs(pad.axes[learn.returnAxis] - learn.origin[learn.returnAxis]) < 0.15) learn.returnAxis = null;
      return;
    }
    const delta = pad.axes.map((value, axis) => value - learn.origin[axis]);
    const available = delta.map((_, index) => index).filter(index => !learn.bindings.some(axis => axis.index === index));
    available.sort((a, b) => Math.abs(delta[b]) - Math.abs(delta[a]));
    const [index, second] = available;
    if (!(Math.abs(delta[index]) >= 0.4) || second !== undefined && Math.abs(delta[index]) < Math.abs(delta[second]) + 0.15) return;
    const center = CHANNELS[learn.bindings.length].key === 'throttle' ? 0 : clamp(learn.origin[index], -0.85, 0.85);
    learn.bindings.push(binding(index, delta[index] < 0, center));
    if (learn.bindings.length < CHANNELS.length) {
      learn.returnAxis = index;
      return;
    }
    const [roll, pitch, yaw, throttle] = learn.bindings;
    this.profile = { roll, pitch, yaw, throttle };
    this.learning = null;
    this.note = 'Axes assigned. Calibrate range to match your stick endpoints.';
    this.syncRows();
    this.persist();
  }

  private sampleRange(pad: Gamepad, profile: Profile, range: Calibrating) {
    CHANNELS.forEach(({ key }, index) => {
      const raw = pad.axes[profile[key].index];
      if (!Number.isFinite(raw)) return;
      range.min[index] = Math.min(range.min[index], raw);
      range.max[index] = Math.max(range.max[index], raw);
    });
  }

  private saveRange() {
    const pad = this.pad;
    const profile = this.profile;
    const range = this.calibrating;
    if (!pad || !profile || !range) return;
    for (const [index, { key, name }] of CHANNELS.entries()) {
      const min = range.min[index], max = range.max[index];
      if (max - min < 0.4) {
        this.note = `Move ${name.toLowerCase()} to both ends of its range, then save again.`;
        return;
      }
      const center = pad.axes[profile[key].index];
      if (key !== 'throttle' && (center - min < 0.1 || max - center < 0.1 || !Number.isFinite(center))) {
        this.note = `Release ${name.toLowerCase()} to its center, then save again.`;
        return;
      }
    }
    CHANNELS.forEach(({ key }, index) => {
      const axis = profile[key];
      axis.min = range.min[index];
      axis.max = range.max[index];
      axis.center = key === 'throttle' ? (axis.min + axis.max) / 2 : pad.axes[axis.index];
    });
    this.calibrating = null;
    this.note = 'Range calibrated.';
    this.persist();
  }

  private draw() {
    const pad = this.pad;
    const optionsKey = JSON.stringify([this.selected, ...this.pads.map(padKey)]);
    if (optionsKey !== this.optionsKey) {
      this.optionsKey = optionsKey;
      this.devices.replaceChildren();
      if (!pad) this.devices.add(new Option(this.selected ? `Disconnected: ${this.selectedName}` : 'No controller', this.selected));
      for (const device of this.pads) {
        const name = device.id || `Controller ${device.index + 1}`;
        this.devices.add(new Option(`${name} ${device.mapping ? '' : '(raw)'}`.trimEnd(), padKey(device)));
      }
      this.devices.value = this.selected;
      this.devices.disabled = this.devices.options.length <= 1;
    }
    const editing = !!(this.learning || this.calibrating);
    const summary = this.latest ? 'Controller setup · ready' : 'Controller setup';
    if (this.summary.textContent !== summary) this.summary.textContent = summary;
    this.learnButton.disabled = !pad || pad.axes.length < 4 || editing;
    this.rangeButton.disabled = !pad || !this.mappingValid() || !!this.learning;
    const rangeLabel = this.calibrating ? 'Save range' : 'Calibrate range';
    if (this.rangeButton.textContent !== rangeLabel) this.rangeButton.textContent = rangeLabel;
    this.cancelButton.hidden = !editing;
    for (const { key } of CHANNELS) {
      const { axis, inverted, value } = this.rows.get(key)!;
      axis.disabled = inverted.disabled = !pad || pad.axes.length < 4 || editing;
      const raw = pad && this.profile ? pad.axes[this.profile[key].index] : undefined;
      const normalized = raw !== undefined && Number.isFinite(raw) && this.profile ? axisValue(key, raw, this.profile[key]) : null;
      value.value = normalized === null ? '—' : key === 'throttle' ? `${Math.round(normalized * 100)}%` : normalized.toFixed(2);
    }
    this.raw.textContent = pad ? 'Raw · ' + pad.axes.map((value, index) => `${index + 1} ${value.toFixed(2)}`).join('  /  ') : '';
    const message = this.instructions(pad);
    if (this.message.textContent !== message) this.message.textContent = message;
  }

  private instructions(pad: Gamepad | undefined) {
    if (!pad) return 'Connect a controller, then move a stick or press a button.';
    if (pad.axes.length < 4) return 'This controller exposes fewer than four axes. Check its USB joystick mode.';
    if (this.learning) {
      return this.learning.returnAxis === null ? CHANNELS[this.learning.bindings.length].direction : 'Return the stick to where it started.';
    }
    if (this.calibrating) return this.note || 'Sweep every stick to both ends. Release roll, pitch and yaw before saving.';
    if (!this.mappingValid()) return 'Lower throttle and center the other sticks, then learn axes or assign each channel by hand.';
    return this.note || 'Lower throttle before arming.';
  }
}
