import { el } from '../util';

// on foot on a touch screen: Jump (Space), over the right thumb's look area (the sticks: nav.ts footSticks)
export function makeJumpButton(jump: () => void) {
  const b = el('button', '', '<span aria-hidden="true">⤒</span>');
  b.id = 'jump-button';
  b.type = 'button';
  b.setAttribute('aria-label', 'Jump');
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); jump(); });
  b.addEventListener('click', (e) => { if (e.detail === 0) jump(); }); // (the keyboard)
  return b;
}
