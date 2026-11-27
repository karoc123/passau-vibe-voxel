// A vehicle's power (its fuel tank, a wreck's cut) lives in the state the vehicle saves and loads, so a page's copy run
// ahead loses its power when the host's does instead of predicting thrust on a dead vehicle.
import { frozen } from '../core/frozen';
import type { PowerState } from './contract/crafts';
import type { CraftType } from './contract/ids';

/** full: s a full tank lasts under full load; idle: the share of full load an engine running burns at rest */
export interface TankTuning { readonly full: number; readonly idle: number }

/** the vehicles a player drives with a tank, by type: the cars (one for every kind) and the crafts but the paraglider and
 * the drone */
export type FuelTuning = Readonly<Record<Exclude<CraftType, 'paraglider' | 'drone'> | 'car', TankTuning>>;

// The owner's starting points under load: a helicopter ~4 min, a boat ~6, a car ~10. A hovercraft between boat and
// car; a floatplane flies far, a jet burns fast.
export const FUEL: FuelTuning = frozen({
  car: frozen({ full: 600, idle: 0.1 }),
  boat: frozen({ full: 360, idle: 0.1 }),
  hovercraft: frozen({ full: 420, idle: 0.1 }),
  helicopter: frozen({ full: 240, idle: 0.1 }),
  floatplane: frozen({ full: 480, idle: 0.1 }),
  jet: frozen({ full: 300, idle: 0.1 }),
});

/** the tank's steps from empty to full: only a whole step crosses the wire (fuel goes down slowly; 0.5 % is finer than
 * a gauge is read) */
export const LEVELS = 200;

export class Tank {
  /** what is left, in steps of a full tank (LEVELS) */
  level = LEVELS;
  /** the part of a step burnt since level last went down (the host's and each copy's own: a copy starts from 0 at
   * each word of the host's, so stepping again never burns twice) */
  burnt = 0;
  /** cut by a wreck (the host's word) */
  wrecked = false;

  /** cfg: none, no tank (it never runs dry) */
  constructor(readonly cfg: TankTuning | null = null) {}

  /** its engine drives it */
  get power() { return !this.wrecked && this.level > 0; }
  /** full 1 .. empty 0, or null: no tank */
  get share() { return this.cfg ? this.level / LEVELS : null; }

  /** dt s of running at load (0 idling .. 1 full) */
  burn(load: number, dt: number) {
    const c = this.cfg;
    if (!c || this.level <= 0) return;
    this.burnt += dt * LEVELS * (c.idle + (1 - c.idle) * Math.min(1, Math.max(0, load))) / c.full;
    if (this.burnt < 1) return;
    const n = Math.floor(this.burnt);
    this.level = Math.max(0, this.level - n);
    this.burnt -= n;
  }

  save(): PowerState {
    const s: PowerState = {};
    if (this.cfg) s.fuel = this.level;
    if (this.wrecked) s.dead = true;
    return s;
  }

  load(s: PowerState) {
    this.level = s.fuel ?? LEVELS;
    this.wrecked = !!s.dead;
    this.burnt = 0;
  }
}
