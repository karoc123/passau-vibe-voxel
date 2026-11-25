# Architecture: open packages towards a server

The target is [ADR 0009](../adr/0009-layers-and-owners.md) (layers, owners) under [ADR 0008](../adr/0008-server-vision.md).
No package is open. A new one: one at a time, not in parallel with an E/M package; `tools/wt.sh tsc`, `core-deps` and
the fast set green; extra gates named.

## Left over, no package yet

- `TrafficMirror` without a whole `Traffic` behind it: `client/` still imports `sim/traffic.ts` (the R1 baseline);
  the path maths as shared functions over the road data.
- Open question (owner): does the creative camera simulate the world where it looks? Until answered an observer's
  camera is a view like a player's, behind one switch (`app/session.ts` `OBSERVER_VIEW`).
- The link's `frame(dt, …)` becoming `advance(dt)` on the in-thread link only, the worker ticking on its own timer:
  changes the worker's pacing, waits for M4's render clock.
- State a server should own that the client still decides: seed, mode, physics options and the starting time of day
  come from the page URL (`app/session.ts` `sessionOptions`); the page's player is the constant `PAGE_PLAYER`; the
  client asks for the road physics (`SimClient.loadPhysics`); a new craft's spot comes from the shell's search and the
  car type from `enterSeat.choice`, both trusted by the sandbox.
- The drone's numbers are code (`fpv-flight.ts`), covered by `PROTOCOL` only, not by the tuning hash.
- A network transport sends its hello as the first message, the same way, in `openSession`.
- `main.ts` still holds go-to/search and the weather/day/share controls.
