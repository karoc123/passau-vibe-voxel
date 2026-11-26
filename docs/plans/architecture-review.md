# Architecture: open packages towards a server

The target is [ADR 0009](../adr/0009-layers-and-owners.md) (layers, owners) under [ADR 0008](../adr/0008-server-vision.md).
No package is open. A new one: one at a time, not in parallel with an E/M package; `tools/wt.sh tsc`, `core-deps` and
the fast set green; extra gates named.

## Left over, no package yet

- Open question (owner): does the creative camera simulate the world where it looks? Until answered an observer's
  camera is a view like a player's, behind one switch (`app/session.ts` `OBSERVER_VIEW`).
- The link's `frame(dt, …)` becoming `advance(dt)` on the in-thread link only, the worker ticking on its own timer:
  changes the worker's pacing, waits for M4's render clock.
- State a server should own that the client still decides (open questions for the owner): the client asks for the
  road physics (`SimClient.loadPhysics`, through `Session.sim`, outside the command path): should a host or mode load
  it (at start, or when a player comes near a car) and `enterSeat` on a car wait for it, or should it become an async
  request? A new craft's spot comes from the shell's search (`nav/spots.ts`) and the car type from
  `enterSeat.choice`, both trusted by the sandbox: is where a craft appears, and which car a player gets, a rule of the
  mode (the search moved into the sim) or a sandbox choice that stays a client's request? With `?worker=1` the page
  shows the host's start time by the same rule (`host/start.ts` `hostStart`) until the first snapshot.
- The drone's numbers are code (`fpv-flight.ts`), covered by `PROTOCOL` only, not by the tuning hash.
- A network transport sends its hello as the first message, the same way, in `openSession`.
