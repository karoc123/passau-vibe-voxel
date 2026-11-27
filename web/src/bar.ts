import { PlaceSearch } from './search';
import { coarsePointer, el } from './util';

const FOLD_KEY = 'passau.barFolded';

export class Bar {
  readonly el = el('div', '');
  readonly search: PlaceSearch;
  // folds the panel to this one round button (and the mode buttons beside it): as the "?" button's credits, out of
  // the way of the thumbs. Folded at first on touch screens and narrow ones, open on the desktop; then as last left
  // (localStorage, FOLD_KEY).
  private readonly foldButton = el('button', 'bar-fold', '<span aria-hidden="true"></span>', this.el);

  constructor() {
    this.el.id = 'bar';
    this.foldButton.type = 'button';
    this.foldButton.addEventListener('click', () => {
      this.fold(!this.folded);
      this.foldButton.blur();
      try { localStorage.setItem(FOLD_KEY, this.folded ? '1' : '0'); } catch { /* storage blocked: folded as by default next time */ }
    });
    let kept: string | null = null;
    try { kept = localStorage.getItem(FOLD_KEY); } catch { /* storage blocked */ }
    this.fold(kept === '1' || (kept !== '0' && (coarsePointer() || matchMedia('(max-width: 600px)').matches)));
    this.search = new PlaceSearch(this.el, 'Search Passau…');
  }

  get folded() { return this.el.classList.contains('folded'); }
  fold(on: boolean) {
    this.el.classList.toggle('folded', on);
    this.foldButton.setAttribute('aria-expanded', String(!on));
    this.foldButton.setAttribute('aria-label', on ? 'Show the map controls' : 'Hide the map controls');
    this.foldButton.title = on ? 'Show controls' : 'Hide controls';
  }
  get rect() { return this.el.getBoundingClientRect(); }
}
