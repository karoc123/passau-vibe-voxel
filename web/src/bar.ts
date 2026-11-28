import { PlaceSearch } from './search';
import { el } from './util';

/** top left beside ☰: the search, and under it the status of the vehicle the player is in (main.ts: the mode tools) */
export class Bar {
  readonly el = el('div', '');
  readonly search: PlaceSearch;

  constructor() {
    this.el.id = 'bar';
    this.search = new PlaceSearch(this.el, 'Search Passau…');
  }

  get rect() { return this.el.getBoundingClientRect(); }
}
