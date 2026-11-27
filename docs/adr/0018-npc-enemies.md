# 0018 NPCs on foot as enemies, decided by the host

Status: accepted (2026-11-27). The fourth game building block; builds on [ADR 0015](0015-health-and-damage.md) and
[ADR 0017](0017-the-walk-on-the-host.md).

## Decision

- An enemy NPC keeps a duty (a guard stands, a patrol walks a loop) and runs one small state machine on the host:
  it notices a player on foot by a clear sight line within a range, attacks (fires while it sees them, follows a
  little), searches where it last saw them, then goes back. Hearing, cover, a field of view and NPCs working together
  come as later steps.
- It fires a player's weapon through the same path a player's shot takes; its aim strays more with distance and it
  reacts after a moment, so it does not hit every shot. Its spread is seeded, so a run repeats.
- An NPC is a life: weapons hurt it; at 0 it lies where it fell, is no body to shots, and is taken away later.
- On the wire an NPC is a short sample (place, heading, velocity, what it does) that the page reckons on, as the
  crowd's: sent when the reckoning drifts, seldom far off, never while it stands. The page draws it as an avatar in
  colours of its own.
- Where NPCs stand is a game mode's choice, later; for now the sandbox puts one down on a debug request.

## Why

- The host already has what an NPC must perceive and harm; deciding there keeps a co-op fight fair.
- A walking NPC sent as an avatar's pose every tick cost ~4.5 kB/s raw; ten in sight now cost a player well under
  the 3 kB/s the owner set.

## Consequences

- An NPC sees through voxels not yet loaded as through a wall: none at all.
- A player in a vehicle is no target yet.
