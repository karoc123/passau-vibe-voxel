import { el } from '../util';
import { onFocusLoss } from './input';

// A mode's panel in the bar's mode tools (drive, boat, plane, drone): its buttons, then a detail box with a status line
// first (role=status) and the mode's own lines. The panel is
// `.mode-active` while its mode is on (style.css: then it takes the row, and in a craft the other panels hide; which
// mode is on is body[data-mode], main.ts). Classes: generic (mode-status) and the mode's own
// (`<name>-status`, ...) for what differs.
export class ModePanel {
  readonly el = document.createElement('aside');
  readonly details: HTMLDivElement;
  readonly status: HTMLDivElement;
  private note = '';
  private noteUntil = 0;

  constructor(host: HTMLElement, readonly name: string, label: string) {
    this.el.className = `${name}-mode`;
    this.el.setAttribute('aria-label', label);
    this.details = el('div', 'mode-detail', '', this.el);
    this.status = el('div', `mode-status ${name}-status`, '', this.details);
    this.status.setAttribute('role', 'status');
    host.append(this.el);
  }

  /** a button before the detail box: run on click, then the focus given back (the keys go to the mode again) */
  button(label: string, run: () => void, cls = '') {
    const b = modeButton(label, run, this.el, cls);
    this.el.insertBefore(b, this.details);
    return b;
  }

  /** a line in the detail box */
  line(cls: string, html = '') { return el('div', `${this.name}-${cls}`, html, this.details); }

  set active(on: boolean) { this.el.classList.toggle('mode-active', on); }

  /** a message on the status line for ms */
  say(text: string, ms: number) {
    this.note = text;
    this.noteUntil = performance.now() + ms;
  }

  /** the message while it lasts, else '' (last: the last one, lasting or not) */
  get saying() { return performance.now() < this.noteUntil ? this.note : ''; }
  get last() { return this.note; }
  silence() { this.note = ''; this.noteUntil = 0; }

  /** the text of a node, written only when it changed */
  static text(node: HTMLElement, text: string) { if (node.textContent !== text) node.textContent = text; }
}

/** a mode's button: run on click, then the focus given back (the keys go to the mode again) */
export function modeButton(label: string, run: () => void, parent: HTMLElement, cls = '') {
  const b = el('button', `mode-button${cls ? ' ' + cls : ''}`, label, parent);
  b.type = 'button';
  b.addEventListener('click', () => { run(); b.blur(); });
  return b;
}

// A button held with a finger on a touch screen (the car's handbrake, the boat's drift): held while any pointer that
// went down on it is; let go when the focus is lost (style.css places and shows it per mode)
export class HoldButton {
  readonly el = el('button', '', '');
  private readonly pointers = new Set<number>();

  constructor(id: string, html: string, label: string) {
    const b = this.el;
    b.id = id;
    b.type = 'button';
    b.innerHTML = html;
    b.setAttribute('aria-label', label);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      this.pointers.add(e.pointerId);
      b.classList.add('held');
    });
    const release = (e: PointerEvent) => { this.pointers.delete(e.pointerId); b.classList.toggle('held', this.pointers.size > 0); };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) b.addEventListener(type, release);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    onFocusLoss(() => this.release());
  }

  get held() { return this.pointers.size > 0; }
  release() { this.pointers.clear(); this.el.classList.remove('held'); }
}
