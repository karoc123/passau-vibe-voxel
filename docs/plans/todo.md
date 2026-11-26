# To do

Open work only. When something lands, delete its line. Owner questions are in `FRAGEN.md`.

## Now: the server (target-architecture.md, owner 2026-11-26)

- **Steps 5–8** in the order of target-architecture.md.
- The network host sends every tick's snapshot of what is within ~1 km of the player (ws-smoke: ~5 MB/s by the
  cathedral, ~1.5 MB/s by the dam, before deflate): the page draws between a tick and the one before, so sending fewer
  would judder. The 350 m agent ring (step 5) and wire compaction (step 8) cut it. `?every=2` halves the bytes, but the page then shows motion stopping in a quarter of
  its frames (ws-smoke: 75 % moved): it would have to draw across the gap.
- A player on the free camera has no body: another sees nothing of them until they walk, drive or fly.
- A player on foot is drawn to the others as one of the crowd in a bright shirt (view/life.ts), not as their own
  walker figure; their seat on a ride or in a vehicle is lost when the page reconnects to its host.
- With steps 1–2: input commands by tick with ack and buffer (M5); drop bit-exact determinism checks; remove the
  observer-view switch (the free camera is a presence).

## Next: weapons (owner 2026-11-26): the grenade launcher

- The core and the MG landed. Slot 2, a grenade launcher whose grenade blows a ~3 m crater (the same for all players,
  kept until the host restarts; later it dies with the round; no collapse, no debris), 1 per 1.5 s, as a package:
  `src/sim/weapons/launcher/` (with its `gate.mjs`, found by tools/gates.mjs), `src/view/weapons/launcher/`, one line
  in each `index.ts`. The host decides flight and blast; others see the grenade in flight and the blast. Still to
  build in the core: the edit path for damage (a blast's crater through the world's edits).
- The weapon held in the hand is missing: first person sees no gun, others see none on the avatar. Each package
  brings its model (the view side), the core only where it hangs.

## Later, in this order of likelihood

- Bandwidth for internet play, phones included (owner 2026-11-26). Measured at the cathedral: ~1.7 MB/s per player
  after deflate (people and cars ~95 %); an edit sends its whole node, ~4.5 MB to everyone. Target <= 20 kB/s mean,
  50 kB/s peak. Levers in order (deflate kB/s after each, on foot): edits as ops in sight; radius per kind (cars
  350 m, people 200 m; a pilot more) 280; rounding 111; arrays, static fields once, what the client can derive left
  out 47; agents at 10 Hz drawn by dead reckoning, bodies/crafts/avatars stay 30 Hz 9; trains/boats as timetables 7.
  ws.ts `threshold: 1024` leaves small messages uncompressed (~64). Binary only after a Pi measurement.
- E17–E18: prediction of the player's craft, then the car (one-body world). Belongs to step 7.
- E20: a headless probe mode (no city, players placed, an item, a round end), once E15/E16 exist.
- M6–M10: prediction, wire compaction, lag compensation for hits (with the first weapon).

## On hold until the game is decided (owner 2026-11-24)

- Concepts to choose from later (2026-11-26 study): extraction at the Domplatz (co-op, §0), courier/taxi runs
  against the clock (no combat), a bridgehead PvP, chase the helicopter, flood rescue, a demolition round.
- E15 health and items, E16 spawn/despawn/keep, E21 the player's avatar (owner: on foot always an avatar of its own,
  never one of the crowd).
- M2 `?pace=1`: real frame times and judder on the owner's machine.
- F2 walk to a vehicle and get in (set aside, ADR 0008). Debug spawning of crafts and car type stays client-trusted
  until placed vehicles replace it.

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
- Buildings seen through: `tools/see-through.mjs --all` counts 1045 (gate: BASELINE in 4 nodes). ~250 go with roofs.ts
  eave fills (gone with all fills off: 795), the rest other holes (e.g. 25_19 bld 1708: a cell of roof 1 m over its
  slope on the eave). Hans-Hösl-Straße 20's NW side is roof voxels from 2 m up (a 35 m roof strip under a 38.8 m
  eave, caps.py / voxelize data): reads as the roof hanging down, no longer a hole.
- A placed block leaves trees poking through; the edit keep radius (600 m) and delay (120 s) are guesses.
- Temporary damage needs the tile cache to expose a node's raw files.
- On leaving a seat, 1–2 frames where nobody draws the craft; empty crafts' events are published.
- A fall over 80 m/s is slowed by the walk clamp; `walkAs` start height is unbounded.
- The parked-car cap (8/24) sits beside presence; it goes with presence per cell (target step 6).
- The worker decodes nodes the page also decodes.
- The own car and boat answer ~15–30 ms later since step 1 (render clock ~0.5 tick behind): prediction (step 7)
  removes it. The world keeps ticking while the tab is hidden.
- Aircraft wings do not collide. Not measured: does tile streaming keep up with the floatplane at ~245 km/h.
- Minimap: click for a waypoint, a full-screen map, other players on it.
