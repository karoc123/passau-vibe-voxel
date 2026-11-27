# To do

Open work only. When something lands, delete its line. Owner questions are in `FRAGEN.md`.

## Next, in this order (owner 2026-11-27)

- Extraction concepts: 3-5 for Passau, co-op 1-4 players against AI enemies first (Escape from Duckov as the
  reference: playable alone), PvP of teams of 1-4 later; the owner picks or mixes. The other genres are dropped.
  The first four (old town raid, crash site, river run, holding the castle) rejected: the whole map, not house and
  alley fights; the game is moving by air, water and land.
- Roads by algorithm, for any map: measured (`road-drive`); the caps now take holes and verges of the carriageway and
  slabs over passages under it, the committed map not yet rebuilt with them (a full rebuild, then lower the gate's
  budgets). Left, in `voxelize.py`: deck ends metres off the road, pits, asphalt voxels on the ground, kinked fast
  roads (`roads.md`, "How the main roads drive").
- Roofs probe (after the roads: both change the pipeline): small, simple houses a rule-based roof (gable, hip, flat
  along the long side, even steps), large and special ones their surveyed roof tidied; landmarks untouched. Not
  smoothed.
- 0.5 m blocks probe (after the roofs): what it costs (bytes, triangles, mesh time, phone frames), then walked.

Decided: desktop first, the phone must keep running well (the owner tests on it); the traffic sim is frozen (fixes
only); meadows and roofs are never smoothed; the world ticks at 30 Hz.

## Now: the server (target-architecture.md, owner 2026-11-26)

- **Step 8** of target-architecture.md.

## Later, in this order of likelihood

- Overload (target-architecture.md): all three steps built (host/overload.ts), but the third cuts a whole session's
  snapshots to every second tick (not for a player in a vehicle or firing), not the others' agents inside one: that
  needs AgentWire to keep what a snapshot leaves out. Cars given back refill slowly (from sources).
- Bandwidth (owner 2026-11-26: <= 20 kB/s mean, 50 peak, phones over the internet): at the cathedral, deflated per
  player, ~10 kB/s on foot, ~13 driving, ~15 in the helicopter, ~1 far off; ws-smoke holds it under 25; a round of
  16 at the cathedral 13–16 (`load` holds 20). One player alone: on foot ~2, flying ~3.5, driving 90 km/h through
  the city 5–6 with a worst second of 8–11 (`drive-bytes` holds 20 / 50); a cell coming into the circle shows no peak.
  What is left is every tick's moving bodies (~5 kB/s raw each: the traffic within 60 m of a crater) and a driven or
  hit car's whole state beside its body every tick (~1). Not measured: a busy square, a late joiner after many
  craters (a node's whole op list), a phone on 4G. Binary only after a Pi measurement.
- Host tick under sustained fire (16 launchers by the cathedral, 150 s): p50 ~6, p95 ~13, p99 ~16 ms. What is left
  of it is the shots' flight and traces (~2 ms a tick) and deflating the snapshots (~6 s of the 150); measured on a
  shared machine, p99 10–35 between runs.
- The page under a volley (`volley`, phone 4x CPU): a node's crater ~4 ms on its main thread (its columns made again
  ~1.5, sent to the mesher ~1), 16 shooters ~30 ms/s and no frame held up by them, 32 ~60 ms/s with the worst frame's
  edits 26–50 ms. Next if it shows: the columns made in the mesher worker instead of on the page (they are copied
  there anyway), not before a real phone shows hitches.
- E20: a headless probe mode (no city, players placed, an item, a round end), once E15/E16 exist.
- M7–M10: wire compaction, lag compensation for hits (with the first weapon).

## On hold until the game is decided (owner 2026-11-24)

- Once a concept is picked: player building and destruction (FRAGEN 7, 8), round length. Decided: a lobby later.
- Creative mode (the map maintained by hand, kept apart from a round's damage): who may write (the team only, never
  in a deployed build), where the edits live, how they survive a pipeline rebuild. A concept first.
- E15 health and items, E16 spawn/despawn/keep.
- Enterable houses: probed, on hold (owner 2026-11-27, `building-looks.md`).
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

- The edit keep radius (600 m) and delay (120 s) are guesses.
- Temporary damage needs the tile cache to expose a node's raw files.
- Kept things: crafts and cars left still go 120 s after the last player leaves (only craters last, until the host
  restarts); wrecks are kept as cars.
- Solo, the worker and the page each fetch and decode the nodes round the player (on foot ~60 of the worker's ~80
  files; 4x CPU throttle): the worker's decoding ~30 ms and its gunzip off the page's thread, its first snapshot 6-8 s
  before the city's first frame. Left as is; a channel page to worker only when a measurement shows the start waits.
- The own car answers ~15–30 ms later in solo since step 1 (render clock ~0.5 tick behind): its prediction runs only
  over a network. Its page world has the terrain alone, so the traffic, other players' cars and coaches come as a
  correction (the traffic does not brake for the car run ahead as it does for a craft); pushing along a wall the two
  worlds part more often (a third of the snapshots stepped again). Rapier on the page: 1.7 MB gzipped loaded on the
  first drive, ~20 MB to instantiate, its memory ~100 MB more with the city's terrain round the car (Node's RSS).
- Prediction: an event told ahead that the host then never has (a plane's crash on a craft or car that turned or braked
  away within a round trip) stays told: tint, shake, message, the plane snapped back. Left: rare, a crafts' meet tells
  none, and taking it back runs through the client, the craft link and the plane's nav.
- Floatplane at 240 km/h low over the city (tools/fly-stream.mjs): no ground missing, queue empty, the host's collision
  tiles in time. Left on a phone (4x CPU, 2 M budget): 1 m reaches a median ~320 m ahead (2 m beyond; the budget, not
  the stream: a lead of 3 s instead of 2 took 1 m from under the plane); ~16-20 frames a minute over 50 ms (up to
  ~80 ms) on a ~15 ms frame, the stream's share ~6, the town's life ~4 ms a frame (far traffic ~1.4 ms, posing the
  cars in view). Not measured: the GPU's uploads, the workers on a slow CPU (CDP throttles only the main thread). (A
  profiled run's one ~600 ms frame is the CDP profiler starting, not the page.)
