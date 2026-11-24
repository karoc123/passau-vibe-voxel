# Handoff: refactor to-dos

These are self-contained work packages for agents started by the owner. Pick one package, read the linked item(s) in
[code-health.md](code-health.md) (file and line references there are of commit `6adf465a`, so re-locate them), do
it on its own branch, and report.

## Rules for every package

- Commit locally on a branch named after the package. **Never push.** Do not touch `.github/` (CI, Pages).
- Open data only. `scripts/palette.json` is append-only. In shaders, add no new and no `flat` varyings.
- Do not create or rewrite `CLAUDE.md` or `IDEAS.md`.
- Keep it simple and do not over-engineer. The long-term goal is a server-hosted, multiplayer-capable world, so keep
  simulation free of three.js and the DOM where you touch it (see [ADR 0006](../adr/0006-world-sim-seam.md)).
- Behaviour-neutral refactors must prove they are neutral: the same check counts, and for the pipeline a byte-exact
  `check.py golden --compare`.
- `npm` is not on PATH. Use `web/node_modules/.bin/…` or `node`. Port 5173 is the owner's dev server, so use another
  port for previews and stop it afterwards.
- A full data rebuild (`sh scripts/build_data.sh`, about 12 min) changes committed tiles. Do not run it unasked. Say
  in the report whether one is needed. Palette entries it appends go in their own commit.

## Gates

- `cd web && node tools/gates.mjs` runs the fast set (15 gates, about 25 s). `--full` runs all 20, and
  `--golden FILE` adds the mesh comparison: record it with `node tools/mesh-golden.mjs write FILE` *before* the change.
- `scripts/check.sh` runs palette, overrides and interiors. `scripts/check.sh --fixture` also runs `check.py verify`
  (minutes). Some verify failures already exist on main, so compare against main and do not expect all-green.
- `node tools/gates.mjs --list` shows which gate guards which files.

## Owner direction (2026-11-24)

- No fine-tuning of game rules, UI or lag mitigation while it is unclear what the game will be: E15, E16, E21, M2,
  M4–M10 and UI work wait for the vision. E14 is built lean (sandbox only).
- First aim: an architecture that stays stable and separated for future extension and gets more multiplayer-ready
  (classic clean-architecture work: clear layers, dependencies pointing inward, sim free of render/DOM).
- Experiments are welcome, e.g. a cel-shading look.
- City and data packages are an option, but not urgent.
- The paraglider is only the transition after jumping out of a plane; it is removed when left (as today) and needs no
  hint.

## Overview

"Ready" means it can start now. "In progress" names the working branch. "Ready to merge" means the verified
local branch can be merged into `main`. "Waits" means: start only after the named work is on `main` (check
`git log`). When a package lands, delete its section and its row here, and turn "Waits" rows whose blockers are
gone into "Ready". For a partially completed package, remove the landed item and keep the rest of the package open.

| Package | What | Size | Status |
|---|---|---|---|
| M2 | `?pace=1`: real frame times and live judder on the owner's machine | S | On hold (owner direction 2026-11-24) |
| M3–M10 | Render clock, snapshot buffer, input seq/ack, prediction, wire, lag compensation ([plan](smooth-motion-and-lag.md); M3 = E13, M6–M8 = E17–E19) | S–L | Later |
| A2 | Headless modules out of the root into `core/` ([review](architecture-review.md)) | S–M | In progress |
| A3–A4, A6–A14 | Architecture packages ([review](architecture-review.md), order and owner answers there) | S–M each | A3 next (one move package at a time); rest waits as listed |
| E15, E16, E21 | Health/items, spawn, avatar | S–M each | On hold until the game's vision is clear |
| E17–E20 | Prediction, worker by default, probe mode ([plan](entities-and-modes.md)) | M–L | Later (owner: worker not urgent) |
| R6 | The rest of `voxelize.py`'s stages: the class raster | S–M | **Ready** (needs a data rebuild) |
| R7 | Build time | M | **Ready** |
| F2 | Walk to a vehicle and get in | M | **Set aside** (owner, ADR 0008) |
| Q5 | A crown over a roof is not a tower | S–M | **Ready** |
| F7 | Motorbike falls (steering landed) | S–M | **Ready** |
| F11 | The map as a set of 1 km blocks: grow along the Inn to Ingling | M | **Ready** (needs a data rebuild) |
| F8 | Step 3: drop unread flood data | S–M | **Ready** (data rebuild) |
| Q7 | Spot fixes the general rules leave (low priority) | S each | **Ready** (data rebuild for Q8 first) |

## Packages

### R6. The rest of `voxelize.py`'s stages (code-health 18, S–M)

Landed (merges of `r6`, `r6b`): `voxelize.py` runs as `STAGES`, 20 `def stage(ctx)` functions over a `Ctx`
(SimpleNamespace) with plain field names, the bridges' decks and bridgeheads a `bridges` stage of their own (timed as
"bridge decks, bridgeheads"); `scripts/constants.py`; `tunnels.plan/build`, `underpass.build` return their results;
`traffic.build(open_cut=..., bored=(floor, ids), walked=underpass.Walked)`, no module globals in tunnels/underpass.
Left:

- **Class raster (code-health 18):** `caps.py` still finds steps by `ground.npz` rgb and paved ids by colour (the
  colours now come from `constants.py`, so a colour change follows). A class raster written by `voxelize.py` changes
  the outputs: golden differs by design, and it needs a data rebuild.

### R7. Build time (code-health 19, M)

- **Landed:** `traffic.build` split into steps, `traffic.LANE` checked against `LANE_W` by the `lanes` gate in `scripts/check.sh` (merge `e106f98b`).

- **Build time:** vegetation 21 %, `debris.support_floating` 17 %. See `data/debug/timings.json` and
  [build-speed-2.md](build-speed-2.md).

## Engine packages (audit of main 21d7830e, 2026-11-23)

The owner's direction: the engine's architecture first, so the vision can change cheaply. Target: ADR 0006, 0007 and
[ADR 0008](../adr/0008-server-vision.md) (one world per server, server authoritative, 10–50 players, edits kept by presence).
Only the car is decided in the world sim today; the sim is built and ticked by the presentation (`sim/life.ts`
creates `Traffic`, `main.ts` ticks it only while it is drawn); edits belong to the renderer (`dig.ts` edits streamed
nodes, `stream.ts` publishes and drops them).
Every package is behaviour-neutral unless it says otherwise: same gate counts.

E6 landed (merge `08f44469`): cores in `sim/craft/`, `sim/river.ts`; presentation in `view/`; core-deps scans
`core/`, `sim/`, `physics/` whole. `nav/craft-collision.ts` stays in `nav/` (type import of `VoxelCollision`, which
imports `fetch`; E4 moves `VoxelCollision` to the sim side).

E1 landed (merge after E5): `sim/world-sim.ts` `WorldSim` owns the traffic, the road physics (through an injected
loader, given `WorldSim.tuning`) and the drive commands by player id; `StreetLife(scene, sim)` only draws; `main.ts`,
`life-edit.mjs`, `life-phys.mjs`, `popin-check.mjs` create and tick it. Open from E1: the tick still runs only while the
life is drawn (`main.ts`, `if (life.group.visible)`; owner's call); `WorldSim.events` is one object per update (a server
with several clients needs tick-numbered event lists, E2); `nav.ts` still writes `life.sim.traffic.keep` and `ctl` (E2).

E2 landed: `Person.id` (own numbering per kind; `EntityRef {kind, id}`), `WorldSim.players` with `follow`, `walkAs`,
`walkPose`, `release`, `seat`; `Traffic.held` replaces `keep`/`ctl`; ride and possession in `nav/ride.ts`; the sim ticks
whether or not it is drawn (about 0.5 ms a frame at 60 fps, measured); `eventsSince(tick)` keeps `EVENT_TICKS` = 300.
Open points went to E7.

E3 landed: `core/world-edits.ts` `apply(op, region)` is the one way to edit (ops are `core/layers.ts` `WorldOp`s, kept
per node in order); the streamer only draws `liveEdits`; `sim/edit-keeper.ts` (owned by `WorldSim`, run before the
ticks) keeps an edit while a focus (`WorldSim.foci`: the viewer's focus and every player's entity) is within
`Tuning.edits.radius` (600 m) and drops it `after` (120 s, world time) once none is; nodes sharing an op go together.
Open from E3: radius and delay are guesses (owner); a placed block leaves trees poking through (old life-edit rule);
temporary damage (an op with an expiry) needs the TileCache to expose a node's raw files to rebuild it from its
remaining ops; `initWorldEdits` is called by `dig.ts` and may move to `main.ts` once something else edits.

E4 landed: `sim/craft/craft-core.ts` `CraftCore` (`clock`, `reach`, `neutral`, `events`, `reset`, `step`, `pose`,
`velocity`, `drawn`, `unstick?`), cores for boat, hovercraft, helicopter, paraglider, drone, floatplane, jet
(`sim/craft/cores.ts` `CORES`, built from `WorldSim.tuning`); `WorldSim.crafts` by craft id with a pilot seat
(`addCraft`, `placeCraft`, `removeCraft`, `enterCraft`, `craftInput`, `resetCraft`, `leaveCraft`, `craftEvents`), stepped
before the traffic; pilots are foci; `VoxelCollision` in `sim/craft/` with cache and clock injected; the nav files are
shells. Open from E4: the shell still makes and removes the craft (a mode's job later; does a left craft stay in the
world?); `drawn(alpha)` ignores alpha (interpolation is smoother, not neutral); the drone has no `Tuning` entry;
craft commands apply at once (E7).

E5 landed (merge on `main` after `3ba77d23`): `sim/tuning.ts` `Tuning` and a frozen `DEFAULT_TUNING`; `RIDE` lives in
`sim/vehicles.ts`; `BoatMotion`, `CraftMotion`, `RapierCar` (`rideTuning`), `LifePhysics` (5th parameter) take their part
with the default as fallback. Nothing in `nav/` passes `DEFAULT_TUNING` yet: `WorldSim` (E1) and E4 pass it from the top.

E9 landed (merge after `6ab2e094`, plan and measurements in `docs/plans/local-server.md`): the page holds only a
`SimClient` (`sim/sim-client.ts`): `SimCommand`s as plain data, queued and applied at the start of the next update,
`CommandResult`s for refusable commands, `TrafficView`/`CraftView` for drawing. `LocalSimClient` (default, page thread),
`MirrorSimClient` over snapshots (`sim/snapshot.ts`, `TrafficMirror`) via `ThreadLink` (`?mirror=1`) or `WorkerLink`
(`?worker=1`, `sim.worker.ts`); `sim-host.ts` wires the WorldSim the same in both; new fast gate `mirror-check` (two
sims, one through snapshots, bit-equal over 2700 frames). Worker: +1 frame input latency (no prediction yet), sim time
leaves the page (~0.05 ms/frame + ~0.25 ms snapshot apply). Open from E9: worker not default (waits for client
prediction); no interest filter per client; snapshots are plain objects (no typed arrays/deltas); a Rapier body through
the mirror lerps instead of slerping (no gate); the worker's ground is level-1 nodes only (`tile-world.ts`) and decodes
nodes the page also decodes; Rapier is bundled twice (page and worker chunk); `window.__sim` is now the client.

E8 landed (merge after `9de35751`): a left craft stays (empty-seat input per type: helicopter lets down, drone cuts
throttle, plane glides and stays down once crashed, boats hands off), a parked car stays; both dropped by the shared
presence rule (`sim/edit-keeper.ts` `Presence`, `Tuning.edits`). Commands `enterCraft`/`leaveCraft`; `SimClient.crafts()`;
snapshot `crafts` (all placed, full core state); shells `board(craft)`, F boards the nearest empty craft within 150 m;
`nav/crafts-view.ts` draws crafts not piloted locally; life-edit scenario `left`. Open from E8: no on-screen hint for F,
not on foot; 1–2 frames on leave where nobody draws the craft; paraglider still removed on leave; the parked-car cap
(8/24) kept beside presence; `EditKeeping`/`Tuning.edits` not renamed to presence; no interest filter for crafts.

M1 landed: the frame is input (car, Nav's controls, own-camera crafts) → `sim.update` → `life.update` (this frame's
poses) → `Nav.place` (the ride camera) → what reads the camera; `Rider.update` split into `control` and `place`.
`tools/judder.mjs` (needs a dev server and Chrome; not in the gate runner): J and E 0.0 / ≤ 0.04 cm in all 7 patterns at
80 km/h (before: J 36.9 cm), camera 9.00 m behind. Open: crafts with their own camera still place it before the sim
(M3/E13); `life.update`'s viewer is last frame's camera; the worker's snapshot clock (M4).

E7 landed (merge after `e86b1663`): `WorldSim.send` queues every player command (`sim/commands.ts` `PlayerCommand`),
applied in order in one `apply()` at the start of the update; the seat table in `WorldSim` (`occupants` keyed
`kind:id:role`), one seat per player, a second seat switches (the old one left only if the new one can be taken);
`leaveSeat` replaces `release`/`releaseWheel`/`leaveCraft`; LifePhysics' own claim queue is gone (`takeWheel` returns
a boolean, always reported); walk poses bounded (`sim/walk-bounds.ts`, `Tuning.walk`: 12 m/s across, 10 up, 80 down,
0.5 m slack, `walkAs` within 5 m), a clamp reported and `Foot.correct` puts the walk back; `LOCAL_PLAYER` in
`nav/player.ts`. Open from E7: commands apply at the update's start, not per tick (E13); results nobody reads
(`spawnCraft`, `placeCraft`) pile up; a fall over 80 m/s is slowed by the clamp; `walkAs` start height not bounded;
no seq/tick (M5).

E10–E12 landed (merge `ce55404f`): `sim/entities.ts` (EntityKind car/person/craft, `Entities` exists/pose/seats over
per-kind adapters, `SEATS` per type); `Seat {entity, role, index}`, seat key `kind:id:role:index`; `enterSeat`,
`seatInput`, `leaveSeat` replace `takeWheel`/`drive`/`walkAs`/`walkPose`/`enterCraft`/`craftInput` (no aliases);
`seated`/`unseated`, `craft`, `drive`, `impact` events with tick and entity; `craftEvents`/`driverNotes` read the log
(`SeatReads`), the snapshot drops `player.notes`/`craftEvents`; `WorldSim.mayEnter` (always true). Open: events land on
the next running tick (one frame late at 60 fps, gone with E13); empty crafts' events are published; no gate for
`impact` (browser only); no interest filter; `mayEnter` may move to `GameMode` (E14).

E13 = M3 landed (merge `c52918f8`): `WorldSim.update` clamps dt (`MAX_DT` 0.1 s) and runs whole ticks (`runTick`: commands,
edit keeper/left-vehicle rule, crafts `keep()` + `clock.run(STEP)`, `Traffic.tick`, events); `Traffic.frame()`/`tick()`;
crafts' `drawn(alpha)` blends (plane/drone nlerp, others shortest-angle); `FrameTime {dt, tick, alpha}`; craft shells
`place(dt)` after the sim; `seatInput` `seq`/`tick`, `ack {seq, tick}` (tick first applied in). judder.mjs measures
plane/boat/drone (`--what`): 28/28 ≤ 0.5 cm (before: E up to 88.7 cm). `window.__crafts` tool hook. Open: no teleport
counter for remote interpolation, worker alpha one update behind (M4); turning flight not measured; inputs not
buffered by tick (M5); `life.update` viewer is last frame's camera.

E14 landed lean (merge `92bef3f5`): `sim/mode.ts` (`GameMode {id, request, mayEnter?, mayEdit?}`, five `ModeRequest`s,
narrow `ModeWorld`), `sim/modes/sandbox.ts` (today's logic, edits only with `?dig=1`); `WorldSim.mode` replaces
`mayEnter`; `spawnCraft`/`placeCraft`/`resetCraft`/`resetDriver`/`dropCraft` are `{kind: 'request'}` commands; SimServer
asks `mayEdit`; `?mode=` (MODES in sim-host.ts). Left out on purpose: lifecycle hooks, `mayTransfer`, `Traffic.population`.
Open: unread results pile up; unknown `?mode=` warns and falls back; `ModeWorld.sit` bypasses `mayEnter`.

A1 landed (merge `1977e553`): `core-deps` checks a layer table (R1), value cycles (R2), determinism words (R3) and
`window.__*` only in main.ts (R4) against a shrinking `BASELINE` (51 entries; `node tools/core-deps.mjs --baseline`
prints it, the diff may only remove lines). A5 landed (merge `2d37a14e`): `CloneLink` (structuredClone + `plainData`
for snapshots, JSON for frames/commands) in mirror-check, life-edit `left`/`events`, popin-check `--mirror`; no bugs
found. Open: no gated run carries body poses, the driver snapshot or edit notes over the clone link.

## Pipeline quality packages (from play reports, 2026-11-22)

The owner reported spots in play. The instruction: make the pipeline better as a whole, no single fixes now. Each
package below is one general rule; the reported spots are its verify spots. Causes were found read-only in `data/`
(`ground.npz`, `surface.npz`, `prep.npz`, `laser.npz`, `lod2.npz`, `data/raw/osm.json`); "measured" numbers are of
the build on main `22e88f17`.

Rules for all of them, on top of the rules above:

- `cam` values are project-grid coordinates. Map cell = `x + 6144`, `z + 2048` (`meta.json` `origin`).
- Each one changes committed tiles, so each needs a full data rebuild at the end. Do not run it unasked; iterate with
  `voxelize.py --just x=COL,y=ROW` on a fixture or one region and say in the report that the rebuild is due.
- Add a guard for each rule to `check.py verify` (a patch in `scripts/fixtures/road-defects.json` or a new counter
  in the build report), so the spot cannot come back unnoticed.
- R6 moves the same code in `voxelize.py`. Do not run a Q package in parallel with the R6 stage that holds its block.

Q1 landed with its data (`e414b3ba`, rebuild `12eb1e87`: 22 053 terrain water cells dropped, boat and plane gates
green). ALKIS ponds OSM does not map (23 000 cells) stay land; drawing them is a possible later package.

### Q5. A crown over a roof is not a tower (S–M)

- **Waits for:** nothing.
- **Today:** `voxelize.py` `lod2_roofs` takes the LoD2 roof where it is within 3.5 m of the surface model, and up
  to 6 m under it in patches under 30 cells ("a crown over the roof"). A bigger or higher patch counts as "a tower
  LoD2 lacks" and keeps the surface model. A large tree over a low house fails both tests: at -5851,435 the LoD2
  roof is 5 m over the ground, the crown over its south half 19–24 m, and the house is built 20 m tall there with
  the trunks inside. The inner side of that "tower" has no wall, which is the missing wall the owner saw.
- **Measured:** 11 900 building cells are built 6 m or more over their LoD2 roof; on 6 700 of them the laser's top
  return is vegetation at that height (`laser.npz` `veg_top`, `n_canopy`), in about 1 900 patches.
- **Do:** one rule: where the surface model stands over the LoD2 roof and the laser says the top is vegetation (or
  an Einzelbaum crown from `crowns.npz` covers the cell), the roof is LoD2's, whatever the patch's size. A real
  tower has no vegetation returns and keeps the surface model.
- **Do:** check the wall at a height step inside one building on a real tower (a church tower over its nave): if
  the inner wall is missing there too, that is a second defect; note it, do not fix it here.
- **Do:** a build counter: building cells over their LoD2 roof by 6 m or more under vegetation (should go to near 0).
- **Gates:** `check.py verify`; `shoot.mjs --compare` on `dom` and `oberhaus` (towers and spires must not shrink).
- **Verify spots:** `?cam=-5819.4,178.2,351.3,-5850.7,108.9,435`; others of the kind at -1102,1292; 2919,-85;
  -5099,519.

### Q7. Spot fixes the general rules leave (S each, low priority)

- **Waits for:** nothing (Q2, Q8, Q9 landed; take measurements on data rebuilt after Q8). This is the list of what may be left.
- **Preferred fix:** correct OpenStreetMap itself (open data, and the next extract carries it), else an override in
  `scripts/overrides/`.
  - B 8 over the Baderbachl mouth (way 73317832 near -3048,-88): the road has no `bridge` tag, the stream under
    it is `tunnel=yes`. (Q2 carries it over as a culvert; a `bridge=culvert` tag in OSM is still right.)
  - Anton-Niederleuthner-Brücke's end (way 8027919, primary, near 2613,477) and footway 853342668 beside it: no
    `bridge` tag, 6 m over the Ilz, so Q2 leaves them on water (2 m and 8 m of centreline).
  - Passage under the B 8 (way 73518491) and under the railway (way 73518482): mapped shorter than the road and the
    tracks are wide; the steps 73518490 and 73518489 start inside them.
  - B 12 bridge over the Rottalbahn (way 34755059): 25 m long; the deck is wider than three lanes.
  - Stelzhamerstraße tunnel (way 8022045, -1282,1156): left solid by Q9 (the `tunnels` counter reports it blocked).
    The railway embankment over it is high only in its middle third; on the slopes tracks 27355998 and 593528918
    run 0–1 m over the floor. Needs the embankment level corrected.
  - Rail tunnels 24153461 and 101216178 under the ZOB: north portal (1285,993) blocked for 3 m by the walls of
    building 96488064 carried down into the trench.
  - Passage through a building at voxel 1998,21,681 (owner, 2026-11-23): the house is built solid where a way runs
    through it. Check first whether OSM maps the way as `tunnel=building_passage` / `covered=yes` and whether
    `clearance.py` reads it there. `?cam=1938.5,69.3,669.7,1998,21.7,681.7&date=07-16&hour=20.38`.
- Road spots older than this list are in [road-defects.md](road-defects.md).

## Feature packages

These add behaviour, so they are judged in the browser as well as by the gates. Each comes with a short plan in
`docs/plans/` if it is bigger than S.

### F2. Walk to a specific vehicle and get in (set aside)

- Set aside by the owner (ADR 0008). If it returns: F2a road vehicles via `takeWheel` after E2, F2b crafts after E4.

### F7. Motorbike falls (S–M)

- **Waits for:** nothing. Steering landed in `80b7f7aa`: `Tune` `steerRamp` (0.3 s) and `latG` (0.8) in
  `physics/rapier/car.ts`, check `bike_keys`. What is left is when the rider comes off.
- **Today:** the rider comes off by the rules in `physics/rapier/player-car.ts`: an `impact` or a `knock` of 7 m/s
  (25 km/h) or more (`FALL_IMPACT`), which includes touching any traffic car and any wall or kerb that costs that
  speed in one step; a crash landing; or lying on its side. The righting in `car.ts` `bike()` works only with two
  or more wheels on the ground. No test for a glancing hit.
- **Do first:** show the cause of each fall in the note for a while ("came off: wall 9 m/s", "knock", "on its
  side") and ride the real map, so the tuning is aimed at what happens in play.
- **Do:** falls only when it makes sense: a head-on hit (the speed lost along the heading), not a glancing scrape
  or a nudge on a car's corner; raise or split `FALL_IMPACT`. Righting also with one wheel down and for a short
  time in the air. Keep the wheelie.
- **Gates:** `vehicles` 35/35 plus `bike_scrape` (a wall at 10° at 50 km/h: stays on), `bike_wall` unchanged
  (head-on: comes off). `rapier-car` 45/45.

### F8. Step 3: drop the flood data nobody reads (S–M, data)

- **Landed (merge `063026e0`):** steps 1–2. `nav/river.ts` `waterTop` is the water surface for boat, plane,
  hovercraft and `BoatTraffic` (per ship, via `Traffic.water` / `World.waterColumn`); the slider, `flood.ts`,
  `uDrop` and the sandbank branch are gone. `main.ts` still fetches `flood.json`, only for `river`.
- **Do (needs a full rebuild, tile format change: follow ADR 0004):** `scripts/flood.py` shrinks to the river points
  (a small `river.json` or into `meta.json`) and one bit per cell "river" for the reflections. Drop the spill grid
  (`flood.bin`), the bed estimate, `flood.json`'s `base`, `surface0`, `fall`, `voxel_top`, `spill0`, `stretches`,
  and the `flod` section's first plane (`tilefile.py`, `tile_fields.py`, `core/tile-sections.ts`, `fields.ts`
  `riverAt().x`, `tile_roundtrip.py`).
- **Also:** stale text left by steps 1–2: `scripts/flood.py`'s docstring (points to the deleted `flood.ts`), the
  `flod` layout in `core/tile-sections.ts`, README lines on flood data.
- **Watch:** a ship can jump in height when its tile loads (fallback: own last value, any ship's, then 4 m).
- **Gates:** fast set; `tile-roundtrip`; `shoot.mjs --compare` on `eck` and `kachlet` with `--q seed=1` on both.

### F11. The map as a set of 1 km blocks: grow along the Inn to Ingling (M)

- **Today:** the map is one rectangle (`scripts/map.json` `map`: 9,344 x 3,456 m, corner on 1,024 m blocks). Each
  1,024 m block is already built as its own region (`scripts/regions.py`, `window.cover`). The Klinikum lies just
  south of the map's edge, Ingling roughly 1.2 km beyond it (estimated from approximate coordinates; check).
- **Why not just a bigger rectangle:** 2 km more to the south over the full width is about 19 km2 of mostly
  irrelevant land; following the Inn is about 4–6 km2.
- **Do:** let `map.json` name the built blocks (the rectangle stays the bounding box; a block not listed is empty).
  Adapt what assumes a full rectangle: `scripts/fetch_bayern.sh` (downloads the rectangle's 1 km tiles), the
  region cover, `mapstore.py`'s assembly and the whole-map passes (labels, traffic, flood, boats), the viewer's
  tile index (empty tiles already exist), and the map's edge at a missing block (what the player sees and that
  vehicles cannot leave).
- **Do:** then add the blocks along the Inn from the Innstadt to Ingling (Kraftwerk Passau-Ingling).
- **Rebuild:** yes, plus the downloads for the new blocks (open data, CC BY 4.0, as today).

## Also open (for later)

- **Road spots the general fixes do not reach:** see [road-defects.md](road-defects.md). They are road 1360 under a
  building, Bräugasse, Triftsperrstraße, the Schulstraße kink, road 2510, Steffelmühlweg, and bridges without a deck
  over water (Fritz-Abelein-Brücke, Triftsperre).
- **Aircraft:** wings do not collide. The floatplane's streaming measurement (phase 4 in [plane.md](plane.md)) is
  not done.
