import './touch.css';

// (touch.css shows them on foot on a touch screen only; the right thumb's taps and holds on the view fire: foot.ts)
function roundButton(id: string, cls: string, glyph: string, label: string) {
  const b = Object.assign(document.createElement('button'), { id, type: 'button', className: cls });
  b.innerHTML = `<span aria-hidden="true">${glyph}</span>`;
  b.setAttribute('aria-label', label);
  document.body.append(b);
  return b;
}

/** Jump (Space), over the right thumb's look area */
export function makeJumpButton(jump: () => void) {
  const b = roundButton('jump-button', '', '⤒', 'Jump');
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); jump(); });
  b.addEventListener('click', (e) => { if (e.detail === 0) jump(); }); // (the keyboard)
  return b;
}

/** beside Jump: the next slot, and aim (a tap narrows the view, another widens it) */
export function makeTouchArms(next: () => void, aim: () => boolean) {
  const slot = roundButton('slot-button', 'arms-touch', '⇄', 'Next weapon');
  const sight = roundButton('aim-button', 'arms-touch', '◎', 'Aim');
  slot.addEventListener('click', next);
  sight.addEventListener('click', () => sight.classList.toggle('on', aim()));
  return { set(aiming: boolean) { if (sight.classList.contains('on') !== aiming) sight.classList.toggle('on', aiming); } };
}
