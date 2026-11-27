# To do

Open work only. When something lands, delete its line. Owner questions are in `FRAGEN.md`.

## Now: the server (target-architecture.md, owner 2026-11-26)

- **Step 8** of target-architecture.md; the car's prediction waits for the owner (FRAGEN 17).

- Overload (target-architecture.md): all three steps built (host/overload.ts), but the third cuts a whole session's
  snapshots to every second tick (not for a player in a vehicle or firing), not the others' agents inside one: that
  needs AgentWire to keep what a snapshot leaves out. Cars given back refill slowly (from sources).

## Later, in this order of likelihood

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
- E18: the car's prediction (one-body world), if the owner says so (FRAGEN 17).
- E20: a headless probe mode (no city, players placed, an item, a round end), once E15/E16 exist.
- M7–M10: wire compaction, lag compensation for hits (with the first weapon).

## On hold until the game is decided (owner 2026-11-24)

- Concepts to choose from later (concepts-and-scale.md): manhunt, courier/rally, bridgehead PvP, extraction (§0),
  flood rescue. Open: genre, round length, PvP. Decided: a lobby later.
- Creative mode (the map maintained by hand, kept apart from a round's damage): who may write (the team only, never
  in a deployed build), where the edits live, how they survive a pipeline rebuild. A concept first.
- E15 health and items, E16 spawn/despawn/keep.
- M2 `?pace=1`: real frame times and judder on the owner's machine.
- Debug spawning of crafts and car type stays client-trusted until placed vehicles replace it.

## Pipeline and city

- The buildings' looks before landmark work (the painted windows land on broken blocks and do not carry walkable,
  differing houses): `building-looks.md`, waiting for the owner's answers there.
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
- Getting past something standing on a road where no turn fits (one-way, a bus on a narrow street): one in sight
  waits until out of sight. Backing to the junction behind and taking another road needs a drawn reverse leg over a
  junction (new path maths and wire).
- The parked-car cap (8/24) sits beside presence, not per cell.
- Kept things: crafts and cars left still go 120 s after the last player leaves (only craters last), restart or
  not; wrecks are kept as cars.
- Solo, the worker and the page each fetch and decode the nodes round the player (on foot ~60 of the worker's ~80
  files; 4x CPU throttle): the worker's decoding ~30 ms and its gunzip off the page's thread, its first snapshot 6-8 s
  before the city's first frame. Left as is; a channel page to worker only when a measurement shows the start waits.
- The own car answers ~15–30 ms later since step 1 (render clock ~0.5 tick behind), and a round trip later over the
  network (no prediction for it yet). The world keeps ticking while the tab is hidden.
- Prediction: a car braking for the own craft is reckoned on at its speed (corrections ~0.2 m each snapshot for ~0.6
  s, eased). An event told ahead that the host then never has (a plane's crash on a craft or car that turned or braked
  away within a round trip) stays told: tint, shake, message, the plane snapped back. Left: rare, a crafts' meet tells
  none, and taking it back runs through the client, the craft link and the plane's nav.
- Floatplane at 240 km/h low over the city (tools/fly-stream.mjs): no ground missing, queue empty, the host's collision
  tiles in time. Left on a phone (4x CPU, 2 M budget): 1 m reaches only ~224 m ahead (2 m beyond), and ~1 frame/s over
  50 ms, up to ~70 ms, half of them the stream's taking in meshes (pages.show). Not measured: the GPU's uploads, the
  workers on a slow CPU (CDP throttles only the main thread).
