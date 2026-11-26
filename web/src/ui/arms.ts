import { el } from '../util';
import { weaponIn } from '../sim/weapons';
import { SLOTS } from '../sim/weapons/weapon';

/** on foot on a touch screen: Fire, held (above Jump, by the right thumb) */
export function makeFireButton(hold: (down: boolean) => void) {
  const b = el('button', '', '<span aria-hidden="true">✦</span>');
  b.id = 'fire-button';
  b.type = 'button';
  b.setAttribute('aria-label', 'Fire');
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); hold(true); });
  for (const k of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) b.addEventListener(k, () => hold(false));
  return b;
}

/** on foot: the crosshair and the slots, the one in hand marked */
export function makeArmsHud() {
  const box = el('div', '');
  box.id = 'arms';
  el('div', 'crosshair', '', box);
  const slots = el('div', 'slots', '', box), cells: HTMLElement[] = [];
  for (let i = 1; i <= SLOTS; i++) cells.push(el('span', '', `${i} ${weaponIn(i)?.name ?? '–'}`, slots));
  let shown = 0;
  return {
    set(slot: number) {
      if (slot === shown) return;
      shown = slot;
      cells.forEach((c, i) => c.classList.toggle('on', i + 1 === slot));
    },
  };
}
