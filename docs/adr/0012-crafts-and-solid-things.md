# 0012 The crafts and the solid things

Status: accepted (2026-11-26). Extends [ADR 0010](0010-walker-and-solid-things.md).

## Context

The crafts collided with voxels only: a boat passed through the river's traffic boats and other players' boats, a
hovercraft through cars and parked crafts, and the traffic boats through everything. The crafts move on the host, each
at its own fixed step through its own collision; cars are road physics bodies there, or poses on their lanes.

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
- The vessels are solid to the walker too, where the page draws them.

## Why not the physics engine

Making crafts bodies in the road physics would replace their arcade laws, couple their fixed steps to its sub-steps,
and need the physics loaded (it is loaded only when wanted). A box test against a handful of shapes near the craft
costs about 50 µs a craft a tick and works for every craft alike.

## Consequences

- To the road physics' cars (a driven car) the crafts with a shape are walls it does not move, as a train's coaches
  are: a car bumps off a hovercraft and does not shove it. The traffic's cars without a body still do not feel crafts,
  and a craft wedged against a shore by a moving thing is passed through.
- The planes have a shape (the fuselage, not the wings) but no meet: solid to others, they do not feel what they run
  into. The drone and the paraglider have none: light, they would be walls to what meets them.
- A held vessel may come in late; a ship rafted outside it is not held back with it.
- Shapes are upright boxes: a helicopter let down onto a car is pushed off sideways, it does not land on the roof.
