// The one list of the weapon packages' drawings (sim/weapons/index.ts lists their sims): one line each.
import { launcherView } from './launcher/launcher-view';
import { mgView } from './mg/mg-view';
import type { WeaponView } from './weapon-view';

export const WEAPON_VIEWS: readonly (() => WeaponView)[] = [mgView, launcherView];
