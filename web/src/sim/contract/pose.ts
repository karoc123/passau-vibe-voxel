// The contract between the world sim and its clients (docs/adr/0009-layers-and-owners.md, the contract layer): where
// something is (map metres, x east, y up, z south; heading h: 0 +z, pi/2 +x). Types only (tools/core-deps.mjs R5).

export interface Pose { x: number; y: number; z: number; h: number }
/** where a player walking as a person puts them (their feet, their heading), and whether they walk: the walker's
 * input (contract/commands.ts SeatInput); arm: the weapon slot in their hand, the page's word (only drawn: the others
 * see that gun on the avatar); swim: afloat in deep water, the page's word too (drawn swimming, the soles FLOAT under
 * the water's top: nav/foot.ts) */
export interface WalkPose extends Pose { moving: boolean; arm?: number; swim?: boolean; roof?: RoofSpot;
  /** on the grappling hook's line, reeled to this point (only in a walker's input: the host bounds the walk by the
   * reel's speed while it is, and counts no fall) */
  hook?: { x: number; y: number; z: number };
  /** lying where it fell (a dead NPC) */
  down?: boolean }
/** where on a solid thing's roof the walker stands, as its page saw the thing: the thing's id (sim/solids.ts Solid),
 * v across and u along it from its middle, y over its roof. The page sees a moving car or train a round trip late; the
 * host puts the walker there on the thing as it has it (only in a walker's input: the host keeps its own pose) */
export interface RoofSpot { id: string; v: number; u: number; y: number }

export interface RoadPose extends Pose { pitch: number; roll: number }
