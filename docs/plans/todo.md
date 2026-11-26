# To do

Open work only. When something lands, delete its line. Owner questions are in `FRAGEN.md`.

## Now: the server (target-architecture.md, owner 2026-11-26)

- **Steps 5–8** in the order of target-architecture.md.
- A player on the free camera has no body: another sees nothing of them until they walk, drive or fly.
- A player on foot is drawn to the others as one of the crowd in a bright shirt (view/life.ts), not as their own
  walker figure; their seat on a ride or in a vehicle is lost when the page reconnects to its host.
- With steps 1–2: input commands by tick with ack and buffer (M5); drop bit-exact determinism checks; remove the
  observer-view switch (the free camera is a presence).

## Later, in this order of likelihood

- Bandwidth (owner 2026-11-26: <= 20 kB/s mean, 50 peak, phones over the internet): at the cathedral, deflated per
  player, ~10 kB/s on foot, ~13 driving, ~15 in the helicopter, ~1 far off; ws-smoke holds it under 25. What is left
  is every tick's bodies (~4) and crafts (~4, a helicopter's core whole). Not measured: a busy square, a fight with
  many craters (each ~90 B, but a late joiner gets a node's whole op list), a phone on 4G. Binary only after a Pi
  measurement. Trains are still simulated with spacing on the host (step 5: from the timetable).
- E17–E18: prediction of the player's craft, then the car (one-body world). Belongs to step 7.
- E20: a headless probe mode (no city, players placed, an item, a round end), once E15/E16 exist.
- M6–M10: prediction, wire compaction, lag compensation for hits (with the first weapon).

## On hold until the game is decided (owner 2026-11-24)

- Concepts to choose from later (2026-11-26 study): extraction at the Domplatz (co-op, §0), courier/taxi runs
  against the clock (no combat), a bridgehead PvP, chase the helicopter, flood rescue, a demolition round.
- E15 health and items, E16 spawn/despawn/keep, E21 the player's avatar (owner: on foot always an avatar of its own,
  never one of the crowd).
- M2 `?pace=1`: real frame times and judder on the owner's machine.
- Debug spawning of crafts and car type stays client-trusted until placed vehicles replace it.

## Pipeline and city

- Q7: the Wels-Passau railway's Inn bridge near Ingling (ways 131994367, 131994370) is a through truss; the deck is
  right, the truss is not drawn.
- Q5 leftover at -1102,1292: a 1–2 m strip 10 m over LoD2 where the surface model's step lies a cell off LoD2's.
- Road spots the general fixes leave: `roads.md`.
- ALKIS ponds that OSM does not map (about 23 000 cells) stay land; drawing them is a possible package.
- `voxelize.py` stage split (each stage a function over a context, one per commit under the golden check): only when a
  pipeline feature needs it.

## Small defects

- Stelzhamerstraße's underpass below the railway at Auerbach (way 8022045, tunnel=yes layer=-1, grid -1282,1146):
  the road sinks and there is no passage under the tracks (new block col -2 row 1 since the map's growth).
- Buildings seen through (`tools/see-through.mjs --all --classify`): 27 left. 24 are steep roof caps (caps.py: where
  a lower roof meets a higher one along a diagonal, the shared corner takes the higher height and the lower cells twist
  up to it, 2+ m in one cell; e.g. 57_26 bld 82, 24_6 bld 437): the step should keep each plane's own height at the
  corner (the mesher draws the step's face), a data rebuild. 3 are slivers of 1-2 rays. Hans-Hösl-Straße 20's NW side
  is roof voxels from 2 m up (a 35 m strip under a 38.8 m eave, caps.py / voxelize): reads as the roof hanging down.
- A placed block leaves trees poking through; the edit keep radius (600 m) and delay (120 s) are guesses.
- Temporary damage needs the tile cache to expose a node's raw files.
- On leaving a seat, 1–2 frames where nobody draws the craft; empty crafts' events are published.
- `walkAs` start height is unbounded.
- Walkers and solid things (ADR 0010): a car does not feel a walker; the host does not check them; the walker cannot
  stand on a car's roof; a car squeezing the walker against a wall leaves it inside the car.
- The parked-car cap (8/24) sits beside presence; it goes with presence per cell (target step 6).
- The worker decodes nodes the page also decodes.
- The own car and boat answer ~15–30 ms later since step 1 (render clock ~0.5 tick behind): prediction (step 7)
  removes it. The world keeps ticking while the tab is hidden.
- Aircraft wings do not collide. Not measured: does tile streaming keep up with the floatplane at ~245 km/h.
- Getting in from foot: E is the helicopter's, hovercraft's and drone's own key, so out of those only by the button;
  a car is got into at any speed (no stopping it first); the host's reach uses a rough box for a car (2.2 m half-length).
- Passengers (the hovercraft has a cabin for ~20): the seat table takes more seats per craft, but a passenger needs a
  shell of its own (camera, getting out, the craft taken away under it), a free seat offered by the boarding, and the
  craft's passengers sent and drawn; together not cheap, and it touches the seats, boarding and snapshot.
- Minimap: click for a waypoint, a full-screen map, other players on it.
