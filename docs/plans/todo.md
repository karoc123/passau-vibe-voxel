# To do

Open work only. When something lands, delete its line. Owner questions are in `FRAGEN.md`.

## Now: the server (target-architecture.md, owner 2026-11-26)

- **Step 1, the server's own clock:** the worker ticks on a timer; the client buffers snapshots and draws at server
  time minus a delay (M4 in smooth-motion-and-lag.md); the worker is the default; `ThreadLink` goes.
- **Step 2, two browsers:** a WebSocket host on Node (`ws`, added in this step); two players see each other.
- **Steps 3–8** after that, in the order of target-architecture.md.
- With steps 1–2: input commands by tick with ack and buffer (M5); drop bit-exact determinism checks; remove the
  observer-view switch (the free camera is a presence); edit outcomes go to every session, not only the sender.

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

- A placed block leaves trees poking through; the edit keep radius (600 m) and delay (120 s) are guesses.
- Temporary damage needs the tile cache to expose a node's raw files.
- On leaving a seat, 1–2 frames where nobody draws the craft; empty crafts' events are published.
- A fall over 80 m/s is slowed by the walk clamp; `walkAs` start height is unbounded.
- The parked-car cap (8/24) sits beside presence; it goes with presence per cell (target step 6).
- Rapier is bundled twice; the worker decodes nodes the page also decodes.
- Aircraft wings do not collide. Not measured: does tile streaming keep up with the floatplane at ~245 km/h.
- Minimap: click for a waypoint, a full-screen map, other players on it.
