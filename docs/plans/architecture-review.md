# Architecture: open packages towards a server

The target is [ADR 0009](../adr/0009-layers-and-owners.md) (layers, owners) under [ADR 0008](../adr/0008-server-vision.md).
No package is open. A new one: one at a time, not in parallel with an E/M package; `tools/wt.sh tsc`, `core-deps` and
the fast set green; extra gates named.

## Left over, no package yet

- Open question (owner): does the creative camera simulate the world where it looks? Until answered an observer's
  camera is a view like a player's, behind one switch (`app/session.ts` `OBSERVER_VIEW`).
- The link's `frame(dt, …)` becoming `advance(dt)` on the in-thread link only, the worker ticking on its own timer:
  changes the worker's pacing, waits for M4's render clock.
- A new craft's spot (the shell's search, `nav/spots.ts`) and the car type (`enterSeat.choice`) are the sandbox's
  debug spawning, trusted from the client: not to be moved to the server; replaced later by placed vehicles (a game
  player walks to one and gets in). With `?worker=1` the page shows the host's start time by the same rule
  (`host/start.ts` `hostStart`) until the first snapshot.
- A network transport sends its hello as the first message, the same way, in `openSession`.
