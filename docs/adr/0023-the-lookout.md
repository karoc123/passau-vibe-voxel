# 0023 Air defence's first step: a lookout, and players in vehicles as targets

Status: accepted (2026-11-27). Builds on [ADR 0015](0015-health-and-damage.md), [ADR 0018](0018-npc-enemies.md)
and [ADR 0022](0022-enemy-camps.md); answers 0018's "a player in a vehicle is no target yet".

## Decision

- Air defence is no zone: it is fire from a place in the world, cut off by a sight line. Its first step tries the
  feel with no gun: a **lookout**, an enemy NPC that guards a high place of a camp.
- Any enemy NPC takes a player in a vehicle as a target, as one on foot: it needs a clear line to the vehicle's body
  and aims at its middle; a hit harms the vehicle, and its share reaches those in it.
- A lookout differs from a guard only by its numbers, its own in the tuning: a long sight (250 m), a tight spread, a
  two-second warning before its first burst, no leash. None is fixed in code.
- A camp may list a lookout's place; it is manned, stood down and refilled with its squad. The Oberhaus has one, at
  the edge of a level top at the castle's west end, chosen from the voxels for the open sky over the old town and
  the rivers. The debug request can put one down too.
- Its starting numbers: a helicopter 20 s in its clear sight 150 m off loses about half its health.

## Why

- A gun with a sight line gives a player answers (low, behind a hill, over the water, on foot to it) that a zone
  does not, and asks for almost nothing new: the mind, the shot and the damage are those already built.
- Trying the feel before a gun exists keeps the first step small; the gun as a thing comes next if it carries.

## Consequences

- A guard now fires at a car or a boat passing in its sight too.
- A lookout's view reaches no further than the voxels the host holds round it; its sight stays inside that.
- There is no lead: at speed, its spread decides more than its aim.
