import { cleanName, NAME_MAX } from '../sim/player-name';
import { el } from '../util';

// The player's own settings (not the graphics: settings.ts), the Esc menu that holds them, and the start menu.

/** the frame-rate caps offered (0: none, the display's own rate) */
const FPS_CAPS = [30, 60, 0] as const;
const PREFS_KEY = 'passau.player';
const START_KEY = 'passau.start';

export interface Prefs {
  /** the name the others see ('' none: their id on the map) */
  name: string;
  /** frames drawn per second at most (0: no cap) */
  fps: number;
}

/** what was set before (localStorage), else the defaults: 30 frames on a phone (its battery), 60 elsewhere */
export function loadPrefs(phone: boolean): Prefs {
  const p: Prefs = { name: '', fps: phone ? 30 : 60 };
  try {
    const s = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    p.name = cleanName(s.name);
    if ((FPS_CAPS as readonly number[]).includes(s.fps as number)) p.fps = s.fps!;
  } catch { /* storage blocked or spoilt: the defaults */ }
  return p;
}

function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* not remembered */ }
}

// the name field and the cap's choice, both menus'; changed: a setting changed (already saved)
function settingsFields(p: Prefs, parent: HTMLElement, changed: (p: Prefs) => void) {
  const box = el('div', 'menu-settings', `<label>Name <input type="text" name="name" maxlength="${NAME_MAX * 2}"
    autocomplete="nickname" spellcheck="false" placeholder="optional, shown to the others"></label>
    <label>Frame rate <select name="fps">${FPS_CAPS.map((f) => `<option value="${f}">${f ? `${f} fps` : 'unlimited'}</option>`).join('')}</select></label>`, parent);
  const name = box.querySelector('input')!, fps = box.querySelector('select')!;
  const show = () => { name.value = p.name; fps.value = String(p.fps); };
  show();
  name.addEventListener('change', () => { p.name = cleanName(name.value); name.value = p.name; savePrefs(p); changed(p); });
  fps.addEventListener('change', () => { p.fps = Number(fps.value); savePrefs(p); changed(p); });
  return show;
}

// ------------------------------------------------------------------ full screen
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void; webkitFullscreenEnabled?: boolean };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
const fsDoc = document as FsDoc, fsRoot = document.documentElement as FsEl;
// (Safari before 16.4 and iPadOS: the webkit names; the iPhone's Safari has neither for a page, only for a video)
const fsAble = () => !!(fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen) && (document.fullscreenEnabled ?? fsDoc.webkitFullscreenEnabled ?? false);
const fullscreen = () => !!(document.fullscreenElement ?? fsDoc.webkitFullscreenElement);
function toggleFullscreen() {
  try {
    if (fullscreen()) void (document.exitFullscreen?.() ?? fsDoc.webkitExitFullscreen?.());
    else if (fsRoot.requestFullscreen) void fsRoot.requestFullscreen().catch(() => {});
    else fsRoot.webkitRequestFullscreen?.();
  } catch { /* refused (not in a gesture): nothing changes */ }
}

// ------------------------------------------------------------------ the Esc menu
export interface MenuActions {
  /** the menu opened (paused: the game's keys off, the mouse let go) or closed */
  paused(on: boolean): void;
  /** Resume pressed (not Esc): mouse, the click that may take the mouse again */
  resumed(mouse: boolean): void;
  /** the entry Back to orbit mode is offered (not already in it) */
  canOrbit(): boolean;
  toOrbit(): void;
  /** a setting changed */
  changed(p: Prefs): void;
}

/** the menu Esc opens (and the ☰ button, for touch): Resume, the settings, back to orbit mode, full screen, the start
 * menu (the page loaded again without its server) */
export function makeMenu(prefs: Prefs, a: MenuActions) {
  const box = el('div', 'menu', '');
  box.id = 'menu';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Menu');
  const card = el('div', 'menu-card', '<h2>Menu</h2>', box);
  const entry = (label: string, run: (e: MouseEvent) => void) => {
    const b = el('button', 'menu-entry', label, card);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  };
  const resume = entry('Resume', (e) => { close(); a.resumed(e.detail > 0 && !(e instanceof PointerEvent && e.pointerType !== 'mouse')); });
  const settings = el('details', 'menu-more', '<summary>Settings</summary>', card);
  const showSettings = settingsFields(prefs, settings, a.changed);
  const orbit = entry('Back to orbit mode', () => { close(); a.toOrbit(); });
  const fs = entry('', () => { toggleFullscreen(); });
  const fsNote = el('div', 'menu-note', 'Full screen: not offered by this browser (on an iPhone, Safari has none for a page).', card);
  entry('Start menu', () => { location.assign(startUrl()); });

  const button = el('button', '', '<span aria-hidden="true">☰</span>');
  button.id = 'menu-button';
  button.type = 'button';
  button.setAttribute('aria-label', 'Menu');
  button.addEventListener('click', () => (isOpen() ? close() : open()));

  const showFs = () => { fs.textContent = fullscreen() ? 'Leave full screen' : 'Full screen'; };
  document.addEventListener('fullscreenchange', showFs);
  document.addEventListener('webkitfullscreenchange', showFs);
  let openedAt = -Infinity;
  const isOpen = () => !box.hidden;
  function open() {
    if (isOpen()) return;
    openedAt = performance.now();
    orbit.hidden = !a.canOrbit();
    fs.hidden = !fsAble();
    fsNote.hidden = !fs.hidden;
    showFs();
    showSettings();
    box.hidden = false;
    if (document.pointerLockElement) document.exitPointerLock();
    a.paused(true);
    resume.focus({ preventScroll: true });
  }
  function close() {
    if (!isOpen()) return;
    box.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    a.paused(false);
  }
  // (bubbling: an open overlay closes first and stops the key, fullmap.ts, credits.ts; a field's Esc is the field's)
  addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || document.getElementById('start-menu')) return;
    const t = e.target as Element | null;
    if (!isOpen() && t?.closest?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    // (the browser's Esc that ended the mouse's lock opened it; the same key seen a moment after must not close it)
    if (!isOpen()) open(); else if (performance.now() - openedAt > 300) close();
  });
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  return { open, close, isOpen, el: box };
}

// ------------------------------------------------------------------ the start menu
/** the page's URL without its choice of host (the start menu shows again) */
function startUrl() {
  const u = new URL(location.href);
  u.searchParams.delete('server');
  u.searchParams.delete('play');
  return u.href;
}

/** the start menu is skipped: a host named (?server=, bare: this machine's) or ?play (alone: the tools, a link) */
export const skipStart = (qs: URLSearchParams) => qs.has('server') || qs.has('play');

/** the server offered first: the one `./voxel start` built the page for (its host's port, VITE_HOST_PORT, on the
 * machine the page came from), else the last one chosen, else this machine's default; and whether it is chosen
 * (else alone) */
export function preselect(defaultPort: number): { server: string; chosen: boolean } {
  const port = import.meta.env.VITE_HOST_PORT as string | undefined;
  if (port) return { server: `ws://${location.hostname}:${port}`, chosen: true };
  try {
    const s = JSON.parse(localStorage.getItem(START_KEY) ?? 'null') as { server?: unknown; chosen?: unknown } | null;
    if (s && typeof s.server === 'string' && s.server) return { server: s.server, chosen: s.chosen === true };
  } catch { /* storage blocked: the default */ }
  return { server: `ws://${location.hostname}:${defaultPort}`, chosen: false };
}

/** the start menu over the city loading behind it: resolves to the server chosen, or null (alone); the name and the
 * frame cap may be set there too */
export function startMenu(prefs: Prefs, first: { server: string; chosen: boolean }, changed: (p: Prefs) => void): Promise<string | null> {
  const box = el('div', 'menu start-menu', '');
  box.id = 'start-menu';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Start');
  const card = el('div', 'menu-card', '<h2>Passau in voxels</h2>', box);
  const alone = el('button', 'menu-entry', 'Play alone', card);
  alone.type = 'button';
  const online = el('button', 'menu-entry', 'Play on the server', card);
  online.type = 'button';
  const addr = el('input', 'menu-addr', '', card);
  addr.type = 'text';
  addr.name = 'server';
  addr.spellcheck = false;
  addr.value = first.server;
  addr.setAttribute('aria-label', 'Server address');
  settingsFields(prefs, el('div', '', '', card), changed);
  const pick = first.chosen ? online : alone;
  pick.classList.add('preselected');
  pick.dataset.preselected = '1';
  pick.focus({ preventScroll: true });
  return new Promise((done) => {
    const go = (server: string | null) => {
      try { localStorage.setItem(START_KEY, JSON.stringify({ server: server ?? addr.value.trim(), chosen: server !== null })); } catch { /* not remembered */ }
      box.remove();
      done(server);
    };
    alone.addEventListener('click', () => go(null));
    online.addEventListener('click', () => { const s = addr.value.trim(); if (s) go(/^wss?:\/\//.test(s) ? s : `ws://${s}`); });
    addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') online.click(); });
  });
}
