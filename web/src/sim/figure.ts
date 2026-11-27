// The figure on foot (a player's and an NPC's alike) is three quarters of a grown-up: at full size it looked too big
// against the city's 1 m blocks (owner 2026-11-27, after walking a 0.5 m world). Its size is read from here by the
// page and the host alike: the figure drawn, the eyes, the walker's body and a shot's. What it climbs (a block's step)
// and how fast it walks are the city's and stay; vehicles keep their size.

/** the figure's size against a grown-up's (1.85 m) */
export const FIGURE_SCALE = 0.75;
/** the top of the head over the soles (m) */
export const FIGURE_TOP = 1.85 * FIGURE_SCALE;
/** the eyes over the feet (m): the first-person camera's, so a shot leaves where the player looks from */
export const EYE = 1.7 * FIGURE_SCALE;
/** a chest's height over the feet: what an NPC looks and aims at */
export const CHEST = 1.2 * FIGURE_SCALE;
/** the body's half width (m): the walker's circle among the solids, a shot's box */
export const BODY_R = 0.3 * FIGURE_SCALE;
/** the body's height (m) as the walker meets a ceiling and as a shot meets it */
export const BODY_HEAD = 1.9 * FIGURE_SCALE;
