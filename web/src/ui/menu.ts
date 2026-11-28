import { cleanName, NAME_MAX } from '../sim/player-name';
import { el } from '../util';

// The player's own settings (not the graphics: settings.ts), the Esc menu that holds them and the graphics, the day and
// the weather (sections of their own), and the start menu.

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

/** where in the menu a thing goes: quick (entries under Resume), game (the sections after Settings), last (after the
 * Start menu), sandbox (what is granted for trying things out) */
type Part = 'quick' | 'game' | 'last' | 'sandbox';

/** the menu Esc and the ☰ button open: Resume, the entries given (entry), the settings and the sections given
 * (section), back to orbit mode, full screen, the start menu (the page loaded again without its server) */
export function makeMenu(prefs: Prefs, a: MenuActions) {
  const box = el('div', 'menu', '');
  box.id = 'menu';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Menu');
  const card = el('div', 'menu-card', '<h2>Menu</h2>', box);
  // what an open menu shows anew: the entries' labels, which of them are offered
  const fresh: (() => void)[] = [];
  const button = (label: string | (() => string), run: (e: MouseEvent) => void, into: HTMLElement, shown?: () => boolean) => {
    const b = el('button', 'menu-entry', typeof label === 'string' ? label : '', into);
    b.type = 'button';
    b.addEventListener('click', run);
    if (typeof label !== 'string') fresh.push(() => { b.textContent = label(); });
    if (shown) fresh.push(() => { b.hidden = !shown(); });
    return b;
  };
  const resume = button('Resume', (e) => { close(); a.resumed(e.detail > 0 && !(e instanceof PointerEvent && e.pointerType !== 'mouse')); }, card);
  const parts = {} as Record<Part, HTMLElement>;
  const part = (p: Part) => { parts[p] = el('div', `menu-part ${p}`, '', card); };
  part('quick');
  const settings = el('details', 'menu-more', '<summary>Settings</summary>', card);
  const showSettings = settingsFields(prefs, settings, a.changed);
  part('game');
  /** a folded section: its body, and a mark beside its title */
  const section = (title: string, where: Part = 'game') => {
    const d = el('details', 'menu-more', `<summary>${title} <span class="mark"></span></summary>`, parts[where]);
    return { box: el('div', 'menu-section', '', d), mark: d.querySelector<HTMLElement>('.mark')! };
  };
  /** an entry that closes the menu and runs; label: fixed, or what it says when the menu opens; shown: offered or not */
  const entry = (label: string | (() => string), run: () => void, where: Part = 'quick', shown?: () => boolean) =>
    button(label, () => { close(); run(); }, parts[where], shown);
  button('Back to orbit mode', () => { close(); a.toOrbit(); }, card, a.canOrbit);
  const fs = button('', () => { toggleFullscreen(); }, card);
  const fsNote = el('div', 'menu-note', 'Full screen: not offered by this browser (on an iPhone, Safari has none for a page).', card);
  button('Start menu', () => { location.assign(startUrl()); }, card);
  part('last');
  part('sandbox');

  const burger = el('button', '', '<span aria-hidden="true">☰</span>');
  burger.id = 'menu-button';
  burger.type = 'button';
  burger.setAttribute('aria-label', 'Menu');
  burger.addEventListener('click', () => (isOpen() ? close() : open()));

  const showFs = () => { fs.textContent = fullscreen() ? 'Leave full screen' : 'Full screen'; };
  document.addEventListener('fullscreenchange', showFs);
  document.addEventListener('webkitfullscreenchange', showFs);
  let openedAt = -Infinity;
  const isOpen = () => !box.hidden;
  function open() {
    if (isOpen()) return;
    openedAt = performance.now();
    for (const f of fresh) f();
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
  // (bubbling: an open overlay closes first and stops the key, fullmap.ts; a field's Esc is the field's)
  addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || document.getElementById('start-menu')) return;
    const t = e.target as Element | null;
    if (!isOpen() && t?.closest?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    // (the browser's Esc that ended the mouse's lock opened it; the same key seen a moment after must not close it)
    if (!isOpen()) open(); else if (performance.now() - openedAt > 300) close();
  });
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  return { open, close, isOpen, section, entry, el: box };
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
