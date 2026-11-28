import { gameKey } from '../nav/input';
import { coarsePointer, el } from '../util';

/** a box on the screen the map's labels keep clear of */
export interface Rect { x0: number; x1: number; y0: number; y1: number }

/** what a situation's help says: id for the CSS and the tools, title over it (none: ''), keys as 'key what · key what',
 * the most needed first (the strip shows the first STRIP of them), touch what the thumbs do */
export interface Help { id: string; title?: string; keys: string; touch: string }

export const MAP_HELP: Help = { id: 'map',
  keys: 'Drag: move · Right button drag: turn and tilt · Wheel: zoom · W/A/S/D move · Q/E tilt · Click a person or a car: follow it · / search · F: into the nearest empty craft',
  touch: 'One finger drags the map, two turn and zoom it. Tap a person or a car to follow it.' };
export const WALK_HELP: Help = { id: 'walk',
  keys: 'W/S walk · A/D step sideways · Mouse: look · Shift run · Space jump · Left button: fire · Right button: grappling hook · 1/2 weapon · E get in · X in the air: open the paraglider · Q/E look up and down',
  touch: 'Left thumb: drag to walk, far to run. Right thumb: drag to look, tap to fire, hold to keep firing. Tap the weapon\'s name for the next one. The hook button: grappling hook. In the air, Open paraglider.' };
const WHO: Record<string, string> = { person: 'Following a pedestrian', car: 'Following a car', bus: 'Following a bus', moto: 'Following a motorbike' };
/** following what: the ride's label (person, car, bus, moto) */
export const rideHelp = (what: string): Help => ({ id: 'ride', title: WHO[what] ?? '',
  keys: 'Drag: look around · W/A/S/D: off again, over the map', touch: 'Drag to look around.' });

// the keys every situation has, after its own
const EVERYWHERE = 'M minimap · , full map · N labels · Esc menu';
// how many of a situation's keys the strip shows, and for how long it shows at first (H brings it back)
const STRIP = 5, STRIP_MS = 180e3;
const STRIP_KEY = 'passau.helpStrip';

/** the one help: on a desktop a strip of the situation's first keys at the bottom left, for the first minutes (H: all
 * of them, and the strip again); in the menu's section (box) the situation's whole help, the keys or the thumbs'.
 * current: the situation now */
export function makeHelp(box: HTMLElement, current: () => Help) {
  const touch = coarsePointer();
  const strip = el('div', '');
  strip.id = 'help';
  const inMenu = el('div', 'menu-help', '', box);
  const toggle = el('label', 'menu-check', '<input type="checkbox"> Show the key strip at first (H: all keys)', box);
  const check = toggle.querySelector('input')!;
  toggle.hidden = touch;
  let on = true;
  try { on = localStorage.getItem(STRIP_KEY) !== '0'; } catch { /* storage blocked: shown */ }
  check.checked = on;
  // all: every key listed (H); since: when the strip was last brought up
  let all = false, since = performance.now(), shown = '';
  check.addEventListener('change', () => {
    on = check.checked;
    since = performance.now();
    try { localStorage.setItem(STRIP_KEY, on ? '1' : '0'); } catch { /* not remembered */ }
  });
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyH' || !gameKey(e) || e.repeat) return;
    all = !all;
    since = performance.now();
    e.preventDefault();
  });
  let rects: Rect[] = [];
  const measure = () => { const r = strip.getBoundingClientRect(); rects = r.width ? [{ x0: r.left - 6, x1: r.right + 6, y0: r.top - 6, y1: r.bottom + 6 }] : []; };
  new ResizeObserver(measure).observe(strip);
  addEventListener('resize', measure);
  const cells = (keys: string[]) => keys.map((k) => `<span>${k}</span>`).join('');
  return {
    /** each frame: the situation's help where it shows */
    update(now: number) {
      const h = current(), brief = !all && on && now - since < STRIP_MS, key = `${h.id}|${h.title}|${h.keys}|${all}|${brief}`;
      if (key === shown) return;
      shown = key;
      const keys = h.keys.split(' · '), title = h.title ? `<b>${h.title}</b>` : '';
      strip.dataset.situation = inMenu.dataset.situation = h.id;
      strip.hidden = touch || !(all || brief);
      strip.className = all ? 'all' : '';
      strip.innerHTML = title + (all ? cells([...keys, ...EVERYWHERE.split(' · '), 'H: hide the keys']) : cells([...keys.slice(0, STRIP), 'Esc menu', 'H: all keys']));
      inMenu.innerHTML = title + (touch ? `<span>${h.touch}</span>` : cells([...keys, ...EVERYWHERE.split(' · ')]));
    },
    get rects() { return rects; },
  };
}
