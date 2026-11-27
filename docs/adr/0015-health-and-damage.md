# 0015 One health model, decided by the host

Status: accepted (2026-11-27). The first game building block; builds on [ADR 0008](0008-server-vision.md).

## Decision

- Health belongs to a life: a player (wherever they are, so it survives getting in and out of vehicles), a car, a
  craft; an NPC will be one more kind of life. Every type's numbers are data in the tuning: max, a factor per damage
  kind (bullet, blast, crash, fall), the share of a vehicle's damage that reaches those in it, the speed a crash or a
  fall is taken at without harm. A weapon says what it does in its own package.
- The host alone decides harm, from what it has itself: a shot's ray, a blast's reach, the road physics' contacts of a
  driven car, the velocity a craft loses in a tick (one rule for every craft), and a fall read off the walk's poses.
  A page's word on its own harm would be a cheat's, and the walk is the page's.
- At 0 a vehicle is a wreck: its controls are dead and its seat refused, those in it are harmed only by what reaches
  them. A player at 0 is down, then back after a few seconds at full health where they last stood on the ground; the
  page follows the host's word. A game mode may change how long, where, and whether a vehicle wrecks; there is no
  mode-as-data layer (the owner's call).
- Health crosses only when it changes, and only to sessions that see the life (their own player always); a life at
  full health is never sent.

## Why

One model keeps players, vehicles and NPCs comparable without a rule per pair. Deciding on the host is what makes a
co-op game against NPCs fair over the network. Sending changes only keeps a standing fight free of bytes.

## Consequences

- Hard driving and flying now cost health: a crash that used to be a shake can wreck the vehicle.
- A fall on foot is measured from poses that arrive unevenly; a long stall mid-air splits it into two smaller falls.
- A plane that crashes is still put back by its own laws; a wrecked one glides down with its controls dead.
