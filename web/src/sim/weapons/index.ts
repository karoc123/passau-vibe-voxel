// The one list of the weapon packages, so adding or removing a weapon is its folder (and its view's) and one line
// here (and in view/weapons/index.ts).
import { mg } from './mg/mg';
import type { Weapon } from './weapon';

const WEAPONS: readonly Weapon[] = [mg];

/** the weapon in slot (1..SLOTS), or null: an empty slot */
export const weaponIn = (slot: number): Weapon | null => WEAPONS.find((w) => w.slot === slot) ?? null;
