# 0016 Placed vehicles, found by the host from the map

Status: accepted (2026-11-27). The second game building block; builds on [ADR 0015](0015-health-and-damage.md).

## Decision

- Vehicles stand in the world for anyone to take: helicopters on landing room, speedboats off a bank (a landing stage
  first), hovercraft on a bank facing the water, floatplanes on long open water, paragliders on high ground over a
  clear drop, cars beside the slower roads. The jet and the drone are not placed. Debug spawning stays as a tool.
- The host finds the stands itself from the voxels and the roads, a block of the map at a time, when a player first
  comes near it. No hand-placed list and no pipeline step: any map gets them, and a map's edits need no rebuild.
- A stand is stocked only near players and emptied again when they leave, while its vehicle is untouched. A stocked
  craft is asleep until touched. Taken, moved, harmed or wrecked, the vehicle is used: from then on a left vehicle
  like any other, and the stand refills after a while, never in front of a player.
- A craft crosses the wire only when its state changed, so what stands costs nothing after it was first sent.
- Players and, later, NPCs take them with the same seat commands; a placed paraglider is launched by its pilot's seat.
- The speedboat has a passenger's seat beside its pilot (owner's decision).

## Why

Algorithmic stands keep the framework map-agnostic, which a game of squads across the whole map needs. Stocking only
near players keeps 42 km² as cheap as the street life; sleeping and the craft delta keep standing vehicles off the
host's tick and the phone's bandwidth.

## Consequences

- Several helicopters, boats and cars stand within sight of most places; a block holds one craft of a class.
- Finding a block's stands costs a few ms a tick for a few ticks, once per block per host run.
- An asleep craft does not feel a crater under it until someone touches it.
- A vehicle taken from a stand and left on it blocks the refill until it is gone.
