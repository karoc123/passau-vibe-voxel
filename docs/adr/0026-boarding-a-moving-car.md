# 0026 Getting into a moving car

Status: accepted (2026-11-27).

## Decision

- A car may be got into from foot while it rolls, as driver or as passenger, a car of the traffic as well as one
  another player drives, up to running speed (7 m/s, about 25 km/h). Faster, the seat is refused as moving.
- The host decides, by where it has the walker and the car in the same tick, with the reach it allows standing still.
- The car keeps its speed under its new driver; it is not stopped.

## Why

- The owner wants to jump into a car that is rolling off, as one does in such games (2026-11-27); waiting for it to
  stop felt like a lock.
- Running speed is what a walker can keep up with beside a door, so the reach still means "beside it". A car passing
  at the town's speed (about 13 m/s) is beyond a run: getting into it would be a leap, not a step.
- Over a link the page draws the car a little behind the host's; at a run that is a step or two along its side,
  within the reach, so a player running beside a door is not refused for lag.

## Consequences

- A car slowing at a light or rolling off from it can be taken; one cruising past cannot.
- A passenger can join another player's car while it creeps along, without it stopping.
