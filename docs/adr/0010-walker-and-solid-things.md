# 0010 The walker and the solid things

Status: accepted (2026-11-26). Builds on [ADR 0008](0008-server-vision.md).

## Context

The walker collided with voxels only: it passed through cars, other players and crafts. Each new kind of thing would
have needed walk code of its own. The walk is the page's (it answers at once); the host only bounds its poses. Cars
are physics bodies on the host; the page sees them, and everything else, only as drawn from snapshots.

## Decision

- Every solid kind declares a shape: an upright box on its pose (a car's from its model, a train coach, another
  player on foot, the crafts that stand about). Nothing else is needed for a new kind to be solid.
- The page's walk meets the shapes of what it draws near the walker, by one rule: a stride may not go further into
  a shape, and each frame the walker is first pushed out of any shape that moved into it, never into a wall. So a
  car driven at the walker shoves it along, and two walkers push each other apart.
- People of the crowd are not solid: they walk the footways in thousands and avoid nobody, so they would wall the
  walker in.

## Why not the physics engine

A kinematic character on the host's physics would make the walk wait a round trip (or need prediction against
bodies the page does not run), and only cars are bodies there. The shapes work in multiplayer as they are: another
player's car reaches every page in the snapshots, and each page keeps its own walker out of it.

## Consequences

- What the walker meets is what it sees: a car is met where it is drawn, a tick or so behind the host.
- The host does not check walkers against things: a modified page could walk through a car. Cars do not feel
  walkers (they drive through and the walker is shoved). Both change if walkers ever become bodies on the host.
