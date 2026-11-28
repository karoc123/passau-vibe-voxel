import './touch.css';

// (touch.css shows them on a touch screen only, but Get in/out; there is no Fire button: the right thumb's taps and
// holds on the view fire, foot.ts)
function button(id: string, cls = '') {
  const b = Object.assign(document.createElement('button'), { id, type: 'button', className: cls });
  document.body.append(b);
  return b;
}

function roundButton(id: string, cls: string, glyph: string, label: string) {
  const b = button(id, cls);
  b.innerHTML = `<span aria-hidden="true">${glyph}</span>`;
  b.setAttribute('aria-label', label);
  return b;
}

/** Jump (Space), over the right thumb's look area */
export function makeJumpButton(jump: () => void) {
  const b = roundButton('jump-button', '', '⤒', 'Jump');
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); jump(); });
  b.addEventListener('click', (e) => { if (e.detail === 0) jump(); }); // (the keyboard)
  return b;
}

/** beside Jump: the next slot, and the grappling hook (the right mouse button's; under the paraglider too) */
export function makeTouchArms(next: () => void, hook: () => void) {
  const slot = roundButton('slot-button', 'arms-touch', '⇄', 'Next weapon');
  const line = roundButton('hook-button', 'arms-touch', '⚓', 'Grappling hook');
  slot.addEventListener('click', next);
  // (pointerdown, not click: the hook goes where the view points now, not where it has turned to by the release)
  line.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); hook(); });
  line.addEventListener('click', (e) => { if (e.detail === 0) hook(); }); // (the keyboard)
}

/** the paraglider's G: let go of the wing (a free fall), and while falling open one again; shown only when it can do
 *  one or the other */
export function makeCanopyButton(press: () => void) {
  const b = button('canopy-button');
  b.textContent = 'Release';
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

/** in a craft with a gun: from the controls to the gun or back (the C key's, nav/board.ts swap); shown on a touch
 *  screen only while there is a seat to switch to */
export function makeSeatButton(press: () => void) {
  const b = button('seat-button');
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); press(); });
  let shown: string | null = null;
  return {
    /** what it says; null: hidden */
    show(label: string | null) {
      if (label === shown) return;
      shown = label;
      b.classList.toggle('on', !!label);
      if (label) b.textContent = label;
    },
  };
}

/** near a vehicle on foot, or in one: get in or out (the E key's, as a button to tap or click; nav/board.ts) */
export function makeBoardButton(press: () => void) {
  const b = button('board-button');
  b.hidden = true;
  // (pointerdown, not click: on foot a touch elsewhere is a stick, and the press must not wait for its release)
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); press(); });
  b.addEventListener('click', (e) => { if (e.detail === 0) press(); }); // (the keyboard)
  let shown: string | null = null;
  return {
    /** what it says (given whether there is a keyboard to name E on); null: hidden */
    set(label: (key: boolean) => string | null) {
      const t = label(!matchMedia('(pointer: coarse)').matches);
      if (t === shown) return;
      shown = t;
      b.hidden = t === null;
      if (t !== null) b.textContent = t;
    },
  };
}
