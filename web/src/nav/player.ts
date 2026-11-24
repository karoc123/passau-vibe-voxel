import type { PlayerId } from '../sim/world-sim';

/** the viewer's own player: the one id this client sends its commands as (the sim knows only player ids; a server
 * would give each client its own) */
export const LOCAL_PLAYER: PlayerId = 'local';
