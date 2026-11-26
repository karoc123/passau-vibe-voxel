// What every mode reads from the keyboard, the gamepad and the window's focus, in one place: one
// typing guard, one gamepad reader, one focus-loss policy.
//
// Keys: a mode listens to keydown itself and first asks gameKey(e): not with Ctrl, Cmd or Alt (browser shortcuts), not
// while typing in a field. A global toggle (a key that works in every mode, e.g. N for the labels, M for a minimap)
// is one more listener of the same shape:
//   addEventListener('keydown', (e) => { if (gameKey(e) && !e.repeat && e.code === 'KeyM') { minimap.toggle(); e.preventDefault(); } });
//
// Focus: when the window loses the focus (another window, a tab switch) the held keys, touches and hold buttons are
// let go (onFocusLoss) and a craft's input is hands off (inFocus false: its neutral input, the car's PARK; the world
// sim goes on, ADR 0008) until it is back; the panel says PAUSED. The drone is disarmed and wants arming again
// (fpv.ts: a radio's throttle may have moved meanwhile).

/** a gamepad's stick inside this is at rest */
export const DEADZONE = 0.12;
export const PAUSED = 'Hands off (window not in focus)';

/** the key is meant for a page control: typed into a text field or a list, or Space and Enter on a focused button,
 *  checkbox or summary (they press it). A range slider is no text field: the walk keys walk after one was dragged. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target as Element | null;
  if (!t?.closest) return false;
  if (t.closest('textarea, select, [contenteditable]:not([contenteditable=false]), input:not([type=range], [type=checkbox], [type=radio], [type=button])')) return true;
  return (e.code === 'Space' || e.code === 'Enter') && !!t.closest('button, summary, input');
}

/** a key for the modes: no browser shortcut (Ctrl, Cmd, Alt) and not typing */
export const gameKey = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e);

/** the gamepads connected ([] when the Gamepad API is missing or blocked: the keyboard still works) */
export function gamepads(): Gamepad[] {
  try { return Array.from(navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p?.connected); }
  catch { return []; }
}

/** the first gamepad with the standard mapping (the car, the boat, the plane; the drone picks its radio itself) */
export const gamepad = (): Gamepad | null => gamepads().find((p) => p.mapping === 'standard') ?? null;

/** a stick's axis past the dead zone, rescaled to -1..1 */
export function padAxis(v: number | undefined, dead = DEADZONE) {
  const a = v ?? 0;
  return Math.sign(a) * Math.min(1, Math.max(0, (Math.abs(a) - dead) / (1 - dead)));
}

let blurred = false;
addEventListener('blur', () => { blurred = true; });
addEventListener('focus', () => { blurred = false; });

/** the window has the focus and is shown: a craft takes the player's input only then */
export const inFocus = () => !blurred && !document.hidden;

/** run when the window loses the focus or is hidden: let go of what is held */
export function onFocusLoss(run: () => void) {
  addEventListener('blur', run);
  document.addEventListener('visibilitychange', () => { if (document.hidden) run(); });
}

/** the keys a mode holds down (codes from its set), let go on keyup and when the focus is lost */
export class HeldKeys {
  private readonly down = new Set<string>();

  constructor(private readonly codes: ReadonlySet<string>) {
    addEventListener('keyup', (e) => this.down.delete(e.code));
    onFocusLoss(() => this.clear());
  }

  /** a keydown: held if it is one of the set (true: the caller takes it, preventDefault) */
  press(e: KeyboardEvent) {
    if (!this.codes.has(e.code)) return false;
    this.down.add(e.code);
    return true;
  }

  /** 1 if any of these is held, else 0 */
  any(...codes: string[]) { return Number(codes.some((c) => this.down.has(c))); }
  has(code: string) { return this.down.has(code); }
  clear() { this.down.clear(); }
}
