// The move keys the map, the walk and the ride share (nav.ts): W/S forward and back, A/D turn, Q/E nose up and down,
// Shift faster; the arrows alike. Held while down; Nav binds them (and clears them on a focus loss).
export type Action = 'f' | 'b' | 'tl' | 'tr' | 'tu' | 'td';
const KEYMAP: Record<string, Action> = {
  KeyW: 'f', KeyS: 'b', KeyA: 'tl', KeyD: 'tr', KeyQ: 'tu', KeyE: 'td',
  ArrowUp: 'f', ArrowDown: 'b', ArrowLeft: 'tl', ArrowRight: 'tr',
};

export class MoveKeys {
  private readonly held = new Set<Action>();
  shift = false;

  /** the action of a key, if it is a move key */
  static of(code: string): Action | undefined { return KEYMAP[code]; }

  add(a: Action) { this.held.add(a); }
  delete(a: Action) { this.held.delete(a); }
  clear() { this.held.clear(); }
  get size() { return this.held.size; }
  /** a turn key (A/D/Q/E, left/right) is held */
  get turning() { return [...this.held].some((a) => a[0] === 't'); }
  /** 1, -1 or 0: pos held, neg held, both or neither */
  axis(pos: Action, neg: Action) { return (this.held.has(pos) ? 1 : 0) - (this.held.has(neg) ? 1 : 0); }
}
