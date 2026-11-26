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

## Later, in this order of likelihood

- E17–E18: prediction of the player's craft, then the car (one-body world). Belongs to step 7.
- E20: a headless probe mode (no city, players placed, an item, a round end), once E15/E16 exist.
- M6–M10: prediction, wire compaction, lag compensation for hits (with the first weapon).

## On hold until the game is decided (owner 2026-11-24)

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

- Hans-Hösl-Straße 20 (way 1100616130, grid -2926,432): from the north the north wall is gone and the roof hangs
  down inside (`shoot.mjs --focus bld:1100616130`: f-nw broken, f-sw whole). Mesher (chamfer walls, roof slopes) or
  facing culling; the owner sees more such houses.
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
