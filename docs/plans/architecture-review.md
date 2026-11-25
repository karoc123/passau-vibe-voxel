# Architecture: open packages towards a server

The target is [ADR 0009](../adr/0009-layers-and-owners.md) (layers, owners) under [ADR 0008](../adr/0008-server-vision.md).
Two packages are left; one at a time, not in parallel with an E/M package. Every package: `tools/wt.sh tsc`,
`core-deps` and the fast set green; extra gates named.

## A8. Views per player; world time owned by the host (M)

- **Goal:** the client no longer drives the world: `SimInput` (frame `dt`, hour, day, focus) leaves the client's frame.
- **Do:** (a) a per-player `view { focus, viewer }` command, kept in the player's state; `WorldSim.update(dt)` takes
  no focus; the active circle is computed from the players' views (one player: the same circle; several circles is
  interest management, not this package). `LifePhysics` takes its origin from the map, not from a focus. (b) hour and
  day are world state set by the host (`WorldSim.setTime`), changed by a mode request the sandbox grants (the bar
  keeps working); the snapshot carries them and `Daylight` reads them from the client.
- **Not here:** (c) the link's `frame(dt, …)` becoming `advance(dt)` on the in-thread link only, the worker ticking
  on its own timer. It changes the worker's pacing and waits for M4's render clock.
- **Neutral:** (a) and (b) in-thread.
- **Files:** `sim/world-sim.ts`, `sim/traffic.ts` (`frame`), `physics/rapier/life-phys.ts` (origin), `sim/mode.ts`,
  `sim/modes/sandbox.ts`, `sim/contract/`, `client/`, `app/`, `main.ts`, `host/`.
- **Gates:** `life-edit` (rates, determinism), `mirror-check`, `popin-check`, `rapier-car`, `surface-gap` (the
  origin), `host-smoke`; `judder` by hand.
- **Open question (owner):** does the creative camera simulate the world where it looks? Until answered, an
  observer's camera stays a focus, behind one switch so either answer stays cheap.

## A11. One read path (S, plus measuring)

- **Goal:** the page draws from snapshots in every mode; `LocalSimClient` and `TrafficView` as `Pick<Traffic>` go.
- **Do:** first a body's drawn pose as a quaternion in the snapshot (the mirror lerps it today instead of slerping),
  compared by `mirror-check`; measure the in-thread mirror's cost (the worker's apply measured 0.22–0.27 ms a frame);
  then `app/session.ts` builds `MirrorSimClient(ThreadLink)` by default. In-thread the link is synchronous, so no
  added latency.
- **Later, not here:** `TrafficMirror` without a whole `Traffic` behind it (`client/` still imports
  `sim/traffic.ts`; the path maths as shared functions over the road data).
- **Gates:** `mirror-check` loses its reference side, so record the direct path's instance matrices once as a golden
  before the flip; `popin-check`; `judder` car/plane/boat/drone unchanged.

## Left over, no package yet

- State a server should own that the client still decides: seed, mode and physics options come from the page URL
  (`app/session.ts` `sessionOptions`); the page's player is the constant `PAGE_PLAYER`; the client asks for the road
  physics (`SimClient.loadPhysics`); a new craft's spot comes from the shell's search and the car type from
  `enterSeat.choice`, both trusted by the sandbox.
- The page's and the worker's loaders still spell their file names (`data/…`) instead of `core/data-contract.ts`.
- The drone's numbers are code (`fpv-flight.ts`), covered by `PROTOCOL` only, not by the tuning hash.
- A network transport sends its hello as the first message, the same way, in `openSession`.
- `main.ts` still holds go-to/search and the weather/day/share controls; `types.ts` still re-exports `core/meta.ts`.
