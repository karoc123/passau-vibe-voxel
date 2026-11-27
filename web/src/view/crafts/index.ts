// The one list of the craft looks: one line a package.
import type { CraftType } from '../../sim/contract/ids';
import { boatLook } from './boat/boat-look';
import type { CraftLook } from './craft-look';
import { droneLook } from './drone/drone-look';
import { fighterLook } from './fighter/fighter-look';
import { gunshipLook } from './gunship/gunship-look';
import { floatplaneLook } from './floatplane/floatplane-look';
import { helicopterLook } from './helicopter/helicopter-look';
import { hovercraftLook } from './hovercraft/hovercraft-look';
import { jetLook } from './jet/jet-look';
import { paragliderLook } from './paraglider/paraglider-look';
import { wrecked } from './wreck';

const LOOKS: { readonly [K in CraftType]: () => CraftLook<K> } = {
  boat: boatLook,
  hovercraft: hovercraftLook,
  helicopter: helicopterLook,
  paraglider: paragliderLook,
  drone: droneLook,
  floatplane: floatplaneLook,
  jet: jetLook,
  fighter: fighterLook,
  gunship: gunshipLook,
};

/** a new look of a craft of type */
export const craftLook = <K extends CraftType>(type: K): CraftLook<K> => wrecked(type, LOOKS[type]());
