# 0012 The crafts and the solid things

Status: accepted (2026-11-26). Extends [ADR 0010](0010-walker-and-solid-things.md).

## Context

The crafts collided with voxels only: boats, hovercraft and the traffic boats passed through boats, cars and crafts.
The crafts move on the host, each at its own fixed step; cars are road physics bodies there, or poses on their lanes.

## Decision

- The crafts meet the same shapes the walker meets, by one rule on the host: after each of a craft's steps it is
  pushed out of every solid thing its box reaches into, as far as its own voxel collision lets it, and its speed into
  that thing is treated as at a wall: the boat bounces with the restitution and friction it has at a shore, the
  hovercraft and the helicopter lose it and slide. A craft that declares a shape is solid to others and meets them;
  nothing else is needed for a new kind.
- What a craft meets: the cars (where the host has them), the other crafts with a shape, the river's vessels, the
  train coaches. Not the walkers: their walk is their page's, and they are shoved as by a car.
- The river's vessels give way: one under way slows to a stop when a craft is ahead of its bow or close beside it,
  and goes on once the way is clear, later by what it lost. Its route and timetable stay as they are.
- The vessels are solid to the walker too, where the page draws them. The planes meet solid things as a wall: in
  the air they crash, afloat they bump. Their wings are a second box, and a few small cubes along each wing against
  the voxels. The drone and the paraglider are light: they meet solid things but stop nothing.
- The traffic's cars without a body stop for a craft in their lane, as for a walker, and never push it. After a
  short wait they pass anything standing where the road has room and nothing comes (the oncoming lane too, its cars
  waiting); with no room they turn round, and that road is left out of routes for a while.

## Why not the physics engine

Making crafts bodies in the road physics would replace their arcade laws, couple their steps to its sub-steps and
need it loaded (only when wanted). A box test against the few shapes near a craft costs ~50 µs a tick, for any craft.

## Consequences

- To the road physics' cars (a driven car) the crafts with a shape are walls it does not move, as a train's coaches
  are: a car bumps off a hovercraft and does not shove it. A craft wedged against a shore by a moving thing is passed
  through. A craft left across a narrow road turns its traffic back. A held vessel may come in late; a ship rafted
  outside it is not held back with it. The page's run ahead learns of a plane's crash a round trip later.
- Shapes are upright boxes: a helicopter let down onto a car is pushed off sideways, it does not land on the roof.
