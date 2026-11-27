# To do

Open work only. When something lands, delete its line. Owner questions are in `FRAGEN.md`.

## Next, in this order (owner 2026-11-27)

- Game building blocks (owner 2026-11-27): a stable framework first, the game later; blocks that combine so concepts
  are tried fast. Direction: the whole map, moving by air, water and land (a squad's chain: helicopter, paraglider, on
  foot, speedboat), no house or alley fights. Decided: leaving a vehicle has several causes, each its own block (fuel,
  vehicle damage, fire from guns such as air defence; maybe more); one damage model for players, vehicles and enemies; enemies
  are NPCs on foot that also use vehicles (stationary guns besides); a seat may carry a tool (a co-pilot's job, not
  only firing), modular, not every seat; the speedboat gets two seats. No mode-as-data layer: a concept that carries
  comes later and turns the framework into a game. Loot and routes: not yet. NPCs: the walk run by the host too, ways
  found on a walkable grid made round them (craters count; no pipeline nav data); today's passers-by may go. An NPC
  boards with a player's commands and fires a player's weapons; once aboard, a vehicle's own AI may steer instead.
  Perception (sight lines, noise) built in small steps. A helicopter lands anywhere: that stays (owner 2026-11-27).
  Wind and weather noted for later. "Only on foot" needs no block.
  Order (the owner leaves it to us): NPCs on foot (built, ADR 0017, 0018: guard or patrol, sight, MG, search, lives,
  their samples; left: hearing, cover, a field of view, players in vehicles as targets, where a mode puts them, the
  numbers tried in play); a fuel tank (built, ADR 0020; the minutes halved again after play; left: refuelling, the minutes tried in play, a car's roll-out
  without engine braking); the gunner built (ADR 0019; left: the swing's numbers tried in play; a military helicopter
  with door guns is a new craft, not yet), no scout; a grappling hook as an item noted for later; NPCs in vehicles
  only once enemies on foot have been seen and played;
  air defence (owner 2026-11-27): no zones, a gun with a sight line, manned by an NPC, a player may take a gun won,
  it fires at whatever its mount can aim at, a reaction time and tracers warn (concept in the scratchpad's
  konzept-geschuetze-flugabwehr.md; first step: an NPC post that fires at vehicles, then the gun; owner: at a chosen place such as the Feste
  Oberhaus, not spread over the map). An armed aircraft whose NPCs attack from the air: a concept being written. Health and
  damage built (ADR 0015); left of it: the crowd not harmed, the
  numbers tried in play (a hard landing or a drone's bump may wreck too readily). Placed vehicles built as a first draft (ADR 0016; how and where not yet refined with
  the owner, expect changes);
  left of it: cars at the mapped car parks too, a crater under an asleep craft, the draw cost of a dozen standing
  crafts on the phone, the numbers (wake 400 m, refill 300 s) tried in play.
- Roads by algorithm, for any map: measured (`road-drive`); the caps take holes and verges of the carriageway and
  slabs over passages under it (rebuilt 2026-11-27: bumps 93 -> 69, edges 113 -> 76, steep 100 -> 99, tight 296,
  p99 1.97 -> 1.85, p99.9 6.19 -> 4.98 m/s^2). Left, in `voxelize.py`: deck ends metres off the road, pits, asphalt voxels on the ground, kinked fast
  roads (`roads.md`, "How the main roads drive").
- Roofs: rule buildings (`scripts/roofs.py`), the owner picked the look `slopes` (2026-11-27), on in the map config
  and in the committed map (rebuilt 2026-11-27); for the owner to look at in the viewer. Not smoothed.
- 0.5 m blocks: not pursued (owner 2026-11-27: little gain for 3x the cost). But the walker in the half-size world
  felt better proportioned: the figure's size against the city is open.

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
  16 at the cathedral 13–15 after the 1500 craters of its sustained run (`load` holds 20; it had crept to 18–19.5). One player alone: on foot ~2, flying ~3.5, driving 90 km/h through
  the city 5–6 with a worst second of 8–11 (`drive-bytes` holds 20 / 50); a cell coming into the circle shows no peak.
  What is left is every tick's moving bodies (the most of a round's bytes: the traffic within 60 m of a crater and
  the driven cars). Not measured: a busy square, a late joiner after many
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
