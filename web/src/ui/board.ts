import { coarsePointer, el } from '../util';

/** near a vehicle on foot, or in one: get in or out (the E key's, as a button to tap or click; nav/board.ts) */
export function makeBoardButton(press: () => void) {
  const b = el('button', '');
  b.id = 'board-button';
  b.type = 'button';
  b.hidden = true;
  // (pointerdown, not click: on foot a touch elsewhere is a stick, and the press must not wait for its release)
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); press(); });
  b.addEventListener('click', (e) => { if (e.detail === 0) press(); }); // (the keyboard)
  let shown: string | null = null;
  return {
    /** what it says (given whether there is a keyboard to name E on); null: hidden */
    set(label: (key: boolean) => string | null) {
      const t = label(!coarsePointer());
      if (t === shown) return;
      shown = t;
      b.hidden = t === null;
      if (t !== null) b.textContent = t;
    },
  };
}
