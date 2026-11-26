// The move keys the map, the walk and the ride share (nav.ts): W/S forward and back, A/D sideways on foot (sl, sr) and
// a turn elsewhere (turn()), Q/E nose up and down, Shift faster; the arrows forward, back and turn. Held while down;
// Nav binds them (and clears them on a focus loss).
export type Action = 'f' | 'b' | 'tl' | 'tr' | 'tu' | 'td' | 'sl' | 'sr';
const KEYMAP: Record<string, Action> = {
  KeyW: 'f', KeyS: 'b', KeyA: 'sl', KeyD: 'sr', KeyQ: 'tu', KeyE: 'td',
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
  get turning() { return [...this.held].some((a) => a[0] === 't' || a[0] === 's'); }
  /** left and right off foot: the arrows and A/D alike (1 right, -1 left) */
  turn() { return Math.max(-1, Math.min(1, this.axis('tr', 'tl') + this.axis('sr', 'sl'))); }
  /** 1, -1 or 0: pos held, neg held, both or neither */
  axis(pos: Action, neg: Action) { return (this.held.has(pos) ? 1 : 0) - (this.held.has(neg) ? 1 : 0); }
}
