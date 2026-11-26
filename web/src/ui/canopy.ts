import { el } from '../util';

// on a touch screen, the paraglider's G: let go of the wing (a free fall), and while falling open one again; shown
// only when it can do one or the other
export function makeCanopyButton(press: () => void) {
  const b = el('button', '', 'Release');
  b.id = 'canopy-button';
  b.type = 'button';
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); press(); });
  b.addEventListener('click', (e) => { if (e.detail === 0) press(); }); // (the keyboard)
  let shown: string | null = null;
  return {
    /** 'release' on the wing, 'open' falling, null neither */
    show(what: 'release' | 'open' | null) {
      if (what === shown) return;
      shown = what;
      b.classList.toggle('on', !!what);
      if (what) b.textContent = what === 'release' ? 'Release' : 'Open canopy';
    },
  };
}
