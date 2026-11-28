import { el } from '../util';
import { weaponIn } from '../sim/weapons';
import { SLOTS } from '../sim/weapons/weapon';

/** on foot: the crosshair and the slots, the one in hand marked; next: a tap on them (a touch screen shows the one in
 * hand alone and has no other switch) */
export function makeArmsHud(next: () => void) {
  const box = el('div', '');
  box.id = 'arms';
  el('div', 'crosshair', '', box);
  const slots = el('div', 'slots', '', box), cells: HTMLElement[] = [];
  for (let i = 1; i <= SLOTS; i++) cells.push(el('span', '', `${i} ${weaponIn(i)?.name ?? '–'}`, slots));
  slots.addEventListener('click', next);
  let shown = 0;
  return {
    set(slot: number) {
      if (slot === shown) return;
      shown = slot;
      cells.forEach((c, i) => c.classList.toggle('on', i + 1 === slot));
    },
  };
}
