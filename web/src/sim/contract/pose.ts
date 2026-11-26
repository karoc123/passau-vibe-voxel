// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): where
// something is (map metres, x east, y up, z south; heading h: 0 +z, pi/2 +x). Types only (tools/core-deps.mjs R5).

export interface Pose { x: number; y: number; z: number; h: number }
/** where a player walking as a person puts them (their feet, their heading), and whether they walk: the walker's
 * input (contract/commands.ts SeatInput); arm: the weapon slot in their hand, the page's word (only drawn: the others
 * see that gun on the avatar) */
export interface WalkPose extends Pose { moving: boolean; arm?: number }

export interface RoadPose extends Pose { pitch: number; roll: number }
