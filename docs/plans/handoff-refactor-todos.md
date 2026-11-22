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

- `cd web && node tools/gates.mjs` runs the fast set (14 gates, about 25 s). `--full` runs all 19, and
  `--golden FILE` adds the mesh comparison: record it with `node tools/mesh-golden.mjs write FILE` *before* the change.
- `scripts/check.sh` runs palette, overrides and interiors. `scripts/check.sh --fixture` also runs `check.py verify`
  (minutes). Some verify failures already exist on main, so compare against main and do not expect all-green.
- `node tools/gates.mjs --list` shows which gate guards which files.

## Overview

"Ready" means it can start now. "In progress" names the working branch. "Ready to merge" means the verified
local branch can be merged into `main`. "Waits" means: start only after the named work is on `main` (check
`git log`). When a package lands, delete its section and its row here, and turn "Waits" rows whose blockers are
gone into "Ready". For a partially completed package, remove the landed item and keep the rest of the package open.

| Package | What | Size | Status |
|---|---|---|---|
| R3 | Shared input, chase camera and panels | M | **Ready** |
| R6 | Split `voxelize.py` into stages | L | **Ready** |
| R7 | Smaller independent items | M each | **Ready** |
| F4 | The player car in the same Rapier world as the AI bodies | M–L | **Ready** |
| R4 | Craft interface and `nav.ts` split | L | Waits for R3 |
| R5 | Check harnesses out of `src/` | M | Waits for R3, R4 |
| F2 | Walk to a vehicle and get in | M | Waits for R4 |
| F5 | Trains and boats into the world sim | M | Waits for F4 |
| Q1 | Water only where the cadastre or OSM has water | M | **Ready** (not in parallel with R6's water stage) |
| Q3 | Underpass stairwells never cut a carriageway or a track | S–M | **Ready** |
| Q4 | What passes under a bridge stays open | M | **Ready** |
| Q5 | A crown over a roof is not a tower | S–M | **Ready** |
| Q6 | Roof caps at a ridge: no spikes | S–M | **Ready** |
| F7 | Motorbike handling | M | **Ready** |
| Q2 | A carriageway over water is a bridge | M | Waits for Q1 |
| F8 | Water surface from the world, river slider removed | M–L | Waits for R3 |
| F6 | Trains have hitboxes | S–M | Waits for F5 |
| Q7 | Spot fixes the general rules leave (low priority) | S each | Waits for Q1–Q4 |

## Packages

### R3. Shared input, chase camera and panels (code-health 11, 12 = N2, M)

- **Waits for:** nothing. The shells already hold `FixedStep` clocks and plain vectors from the cores.
- **Do:** one gamepad reader, one typing guard and one focus-loss policy (`nav/input.ts`). Plus `ChaseRig`, `SafeTrail`
  (unstick/T), `ModePanel`, `river.ts`, and one `data-mode` attribute on `body` instead of per-mode body classes and CSS
  hide lists.
- **Do:** make smoothing frame-rate independent (`1 - exp(-k dt)`).
- **Feel:** must stay the same. Check the boat, plane, jet, drone and car by hand in the browser, and keep the gates
  green.

### R4. Craft interface and `nav.ts` split (code-health 10, 19 first point = N3, L)

- **Waits for:** R3.
- **Do:** a `PlayerCraft` interface (`enter`, `leave`, `update`, `hudText`), a registry in `main.ts`, and Nav calling
  `leave()` instead of every craft polling `nav.mode`.
- **Do:** reduce the 83 literal mode comparisons. Then split `class Nav` into a mode machine, orbit input, a foot
  controller and the ride camera.
- **Test:** adding a new craft (e.g. a helicopter) should afterwards need one new file plus one registry line.

### R5. Check harnesses out of `src/` (code-health 16 = T2, M)

- **Waits for:** R3 and R4 (they move the same shells).
- **Do:** move `nav/*-checks.ts`, `plane-real.ts` and `physics/rapier/*scenarios.ts` to `web/checks/`, with one
  synthetic-world fixture and one result type.
- **Do:** create `tools/lib.mjs` for the copied `runnerImport` loader line and the `fetch` stub.
- **Update:** `tools/gates.mjs` if paths change. The check counts must stay identical.

### R6. Split `voxelize.py` into stages (code-health 13 = P4, L)

- **Waits for:** nothing. The defect assertions in `check.py verify` (`scripts/fixtures/road-defects.json`) are
  its guard. The ground-height passes are already in `scripts/ground.py` (`GROUND_PASSES`), the
  way helpers in `scripts/ways.py`.
- **Do:** one stage per commit, `def stage(ctx)` over an explicit context. Each commit must be byte-exact under
  `check.py golden --compare` (no data rebuild needed).
- **Cut:** the proposal is in code-health 13.
- **Do:** replace the module globals used as an API (`tunnels.FLOOR/IDS`, `underpass.WALK/SKIP`, `traffic.OPEN_CUT`).
- **Include code-health 18:** a class raster or palette flags instead of finding cells by colour, and one
  `scripts/constants.py`.

### R7. Smaller items from code-health 19 (M each, independent)

- **`traffic.build`:** split it, and tie the 3.0 m lane spacing to `sim/path.ts` with a check.
- **Silent `except Exception`:** around `offset_curve` (rails and lane markings are dropped without a note), log
  what is dropped.
- **Build time:** vegetation 21 %, `debris.support_floating` 17 %. See `data/debug/timings.json` and
  [build-speed-2.md](build-speed-2.md).

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

### Q1. Water only where the cadastre or OSM has water (M)

- **Waits for:** nothing.
- **Today:** `voxelize.py` ("# water", about line 713) takes OSM water areas and adds "rivers from the terrain
  model": flat DGM cells (under 0.3 m relief in 5 m) within 0.8 m of the stretch's level, in bodies of 2000 cells or
  more. Nothing ties such a body to a river. Above the Kachlet dam the level is 299.75 m and the villages behind the
  dikes lie at that height, so streets and gardens become river and houses stand in it.
- **Measured:** about 28 000 water cells lie more than 8 m from any ALKIS or OSM water, in about 10 patches, with
  11 000 building cells standing in water. The two largest are the reported spots (7026 and 4975 cells). The laser
  agrees: 65 % of those cells have ground returns, against 16 % on real river. ALKIS Tatsächliche Nutzung
  (`Fließgewässer`, `Stehendes Gewässer`, `Hafenbecken`, already downloaded, read by `scripts/alkis_tn.py`) covers
  the rivers of the whole map (2.98 M cells against the mask's 2.83 M).
- **Do:** one rule for where water is. A terrain-derived water cell must lie in or near (start with 8 m) an ALKIS
  water parcel or an OSM water area. ALKIS is the gate, not the shape: the bank still comes from the terrain model
  (the comment at `TN = dict(...)` says why parcel lines are not drawn).
- **Do:** look at the other direction too: 202 000 ALKIS water cells are not water in the build (banks, small
  streams, under bridges). Decide per class whether that is right, and note it; do not draw parcels as water blindly.
- **Do:** report counters: terrain water cells dropped by the gate, building cells standing in water (should be near 0
  outside the Kachlet plant and the locks, at -2336,432 and -2427,563).
- **Gates:** `check.py verify` on the fixtures; `golden --compare` will differ only where water changed, list it.
  Boat and plane gates (`tools/boat.mjs`, `tools/plane.mjs`) stay green: the rivers themselves must not shrink.
- **Verify spots:**
  - Heining, houses in water: `?cam=-3104.3,165.3,-159.8,-3181.8,13,-99.6`
  - Schalding, Schaldinger Straße in water: `?cam=-5842.8,151.8,-1406.6,-5661.3,13,-1375.6`
  - other patches of the same kind: -5516,-1376; -3713,-1055; -2944,69; -3623,-968; -2547,5

### Q2. A carriageway over water is a bridge (M)

- **Waits for:** Q1 (same block; Q1 removes most of the cases, what is left is this package's list).
- **Today:** water is painted after the roads and wins: `gcol[_wat | _lockm] = C["water"]`. A road OSM maps as plain
  ground over a culvert or an untagged bridge is cut by the water under it. The sag lift in `scripts/ground.py`
  would carry the road over the gap, but it skips ground within 1 m of the river level (`g > _riv + 1`).
- **Measured:** 20 ways have 3 m or more of centreline on water (684 m). 9 of them are Q1's false water. The rest
  are real crossings: the B 8 over the Baderbachl mouth (way 73317832, 9 m; the surface model runs through at
  301.3 m, the terrain model drops to 299.8 m, OSM tags the stream `tunnel=yes` but not the road `bridge`), the
  Donauradweg (way 401782105, 84 m), a service road at the Kachlet (1169805556, 124 m), and footways.
- **Do:** one rule: a way not tagged bridge or tunnel that crosses water, with the surface model continuous along
  it (within about 1 m of the way's ground on both banks), keeps its surface. Either a deck with the water under it
  (preferred, it is a bridge) or ground lifted as the sag lift does; pick one and use the deck code that exists.
- **Do:** a build counter and a `verify` check: metres of non-bridge way centreline on water, per way.
- **Gates:** `check.py verify`, a new patch for the B 8 in `road-defects.json` (kind `road`).
- **Verify spot:** Heining, B 8 "bridge missing": `?cam=-2966.1,109.8,-189.4,-3047.6,13,-87.1`

### Q3. Underpass stairwells never cut a carriageway or a track (S–M)

- **Waits for:** nothing.
- **Today:** `scripts/underpass.py` `build` cuts each stair as `ln.buffer(1.3)` down from the street and puts a
  parapet round it (`buffer(2.3)`). Only the pit fill skips road voxels (`road = np.isin(...)`); the stair cut, the
  parapet and the corridor's open branch (`vol[zf:g + 1] = 0`) do not. Where OSM draws the passage shorter than the
  road is wide, the stair starts inside the drawn carriageway and the road gets a hole with parapet blocks on it.
- **Measured:** of 20 stairs at passage ends, 2 cut a bed, and they are the two reported spots: steps 73518490
  start 3.1 m from the B 8's centreline (drawn 6.2 m wide), steps 73518489 start 0.2 m from the track's centreline
  (the passage 73518482 ends under the rail).
- **Do:** one rule: inside a carriageway (`road_mask`) or a rail bed the passage stays covered. The corridor runs on
  under the bed along the stair's line and the stair opens at the bed's edge plus a margin (about 1 m). No parapet
  voxel on a carriageway or a bed.
- **Do:** a `verify` check: no cell with `WALK >= 0` open to the sky on a carriageway or a rail bed.
- **Gates:** `check.py verify` (the haissengasse fixture has the B 8 over the Donauradweg underpass, it must not
  change); the walkers still get through (`traffic.py` reads `underpass.WALK`).
- **Verify spots:**
  - B 8, hole in the lane: `?cam=-3791.6,106,-728.3,-3840.6,14,-681.5`
  - the same passage under the railway, hole in the track: `?cam=-3791.6,106,-728.3,-3867.3,16.2,-659`

### Q4. What passes under a bridge stays open (M)

- **Waits for:** nothing.
- **Today:** the Rottalbahn (way 1464156379) runs at level 22–23 under the B 12 bridge (way 34755059, deck at
  28). In the build a strip of ground at 28 stands across the track at the deck's east edge (g = 28 at -1997,1074
  on the track's centreline; the terrain model there is 23.6), and under the deck the ground is 24–25, a metre or
  two over the track (the terrain model is interpolated under the bridge). OSM's bridge way is 25 m long and drawn
  9.3 m wide; the surface model shows the deck about 25 m along the track. So the real deck is wider than the drawn
  one and its edges are taken for an embankment.
- **Not yet known:** which pass lifts the strip. `surface.npz` `gsrc` is empty there, so it is not the sag lift;
  the bridgehead lift excludes ways under a bridge by its `under` mask, but only 2.9 m round the track. Find out
  first.
- **Do first:** write each ground pass's changed cells to `data/debug` (`ground.run` already keeps
  `ctx.changed[name]`), one small array or image per pass, so "who lifted this cell" is a lookup. Keep it.
- **Do:** one rule: a way on the ground that crosses under a bridge deck keeps a clear corridor at its own level,
  from before the deck to after it: its bed's width, its level the line between its ground on either side, at least
  the vehicle's height clear (a train 5 m, a road 4 m). No ground pass lifts in it, and ground the terrain model
  interpolated too high in it is lowered to the line.
- **Do:** the deck's width from the surface model where it is wider than the drawn way (the cells at deck level
  beside the deck, over ground 2 m or more lower), instead of leaving them to the ground passes.
- **Do:** a `verify` check: along every railway and carriageway centreline that crosses under a deck, no step of
  2 m or more and the clearance kept.
- **Gates:** `check.py verify` on all fixtures (the bridgehead cases in `road-defects.json` must hold);
  `clearance.py` lane scan not worse.
- **Verify spot:** Rottalbahn under the B 12: `?cam=-2077,55.1,1078.8,-2008.8,24,1078.8`

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

### Q6. Roof caps at a ridge: no spikes (S–M)

- **Waits for:** nothing.
- **Today:** `scripts/caps.py` `roof_fields` gives each roof cell its plane's height at its four corners and lets
  the cells round a grid point meet at one height: the lowest plane at a ridge. A cell whose corner would move more
  than its `span` (0.75 m + half its rise per metre) keeps its own plane. On a ridge that runs diagonally across the
  grid, a ridge cell's far corner lies up to 0.7 m past the ridge line, its own plane overshoots there by about a
  metre, the corner does not "fit" and keeps the overshoot: a pyramid on every second or third ridge cell. The
  voxels show the same rhythm (the ridge cells' tops alternate 14 and 15 at -4073,1187).
- **Confidence:** read from the code and the rasters (`surface.npz` `roof_z`, `roof_gx`, `roof_gy`), not
  reproduced. First step: run `roof_fields` on this window and confirm which corners keep their own plane.
- **Do:** one rule: at a ridge or hip a cell's corner is never higher than the lowest of the planes that meet
  there (the roof is the lower envelope of its planes). The `span` test may still let a cell keep its own plane
  downwards, not upwards.
- **Do:** a number for it in `caps.report`: roof corners more than 0.5 m over the lowest neighbouring plane at a
  ridge, before and after.
- **Gates:** `tools/caps-check.mjs`, `tools/mesh-golden.mjs` (differences only at ridges), `shoot.mjs --compare` on
  `dom`. Only `tile_fields.py` runs again, the voxels do not change.
- **Verify spot:** `?cam=-4122.1,119.3,1202,-4073,103.3,1187.1`

### Q7. Spot fixes the general rules leave (S each, low priority)

- **Waits for:** Q1–Q4. Do nothing here before them; this is only the list of what may be left.
- **Preferred fix:** correct OpenStreetMap itself (open data, and the next extract carries it), else an override in
  `scripts/overrides/`.
  - B 8 over the Baderbachl mouth (way 73317832 near -3048,-88): the road has no `bridge` tag, the stream under
    it is `tunnel=yes`.
  - Passage under the B 8 (way 73518491) and under the railway (way 73518482): mapped shorter than the road and the
    tracks are wide; the steps 73518490 and 73518489 start inside them.
  - B 12 bridge over the Rottalbahn (way 34755059): 25 m long; the deck is wider than three lanes.
- Road spots older than this list are in [road-defects.md](road-defects.md).

## Feature packages

These add behaviour, so they are judged in the browser as well as by the gates. Each comes with a short plan in
`docs/plans/` if it is bigger than S.

### F2. Walk to a specific vehicle and get in (M)

- **Waits for:** R4.
- **Do:** when walking, a key or tap near a parked or moving vehicle (car, bus, motorbike, boat at the bank, plane on
  the water) enters it. Leaving puts the walker beside it, and the vehicle stays where it was left.
- **Do:** go through the sim (a "take the wheel" call) rather than the presentation writing into traffic objects; see
  [ADR 0007](../adr/0007-player-control-in-world-sim.md).

### F4. The player car in the same Rapier world as the AI bodies (M–L)

- **Waits for:** nothing. `physics/rapier/car.ts` is already free of three.js and the drive runs on `FixedStep`.
- **Why:** collisions between the player car and AI cars, and destruction, need one physics world. It is also the
  shape a server needs: one world, many players.
- **Today:** `RapierDrive` (`physics/rapier/drive-world.ts`) owns its own world with one car. AI cars near edits are
  bodies in `physics/rapier/life-phys.ts`.
- **Design:** follow [ADR 0007](../adr/0007-player-control-in-world-sim.md) (player-keyed commands, one shared world).
- **Do:** one shared world with one collider budget. The player car is a body like the others, keyed by a player id.
- **Do:** write a short plan first and measure step cost with `tools/life-phys*.mjs`.
- **Gates:** `rapier-car` 42/42 and `vehicles` 30/30 must stay green (counts may change only with a reason).

### F5. Trains and boats into the world sim (M)

- **Waits for:** F4. The target design is [ADR 0007](../adr/0007-player-control-in-world-sim.md).
- **Today:** `sim/trains.ts` and `sim/boats.ts` sit in `sim/` but are three.js presentation with their own motion.
  ADR 0006 notes this.
- **Do:** split each into a plain sim part (positions on their tracks or rivers, fixed 1/30 s tick, seeded RNG, no
  three.js) and a presentation part. Add the sim parts to `tools/core-deps.mjs`.

### F6. Trains have hitboxes (S–M)

- **Waits for:** F5 (the trains' plain sim part), which waits for F4 (one Rapier world). Fold it into F5 if the same
  agent does both.
- **Today:** the player drives through trains. `nav/drive-session.ts` builds the car's obstacles from
  `life.roadVehicles()` only. `sim/trains.ts` keeps its trains private and computes each coach's pose only when it
  draws (`render`), in three.js types. Walking, the boat and the planes collide with voxels only
  (`nav/voxel-collision.ts`), so they pass through trains too.
- **Do:** the train sim publishes its coaches as boxes (entity id, pose, 2.9 × 4 × 20 m) in the tick's snapshot
  ([ADR 0007](../adr/0007-player-control-in-world-sim.md)). In the shared world each coach near a player is a
  kinematic body that is never knocked away (today's `Obstacle` turns into a wreck when hit; a train must not).
- **Do:** a hit at speed is an `impact` for the car (a crash for a bike), as a wall is.
- **Not in scope:** trains stopping for a car on the track, and train collisions for walkers, boats and planes.
  Note them as open.
- **Not recommended:** an interim list of train boxes passed into `RapierDrive.update` today. F4 replaces that
  code.
- **Gates:** `rapier-car` and `vehicles` stay green; one new scenario: a car at 50 km/h into a standing coach stops.

### F7. Motorbike handling (M)

- **Waits for:** nothing. It is in `physics/rapier/car.ts` and `sim/vehicles.ts`, not in the input shells R3 moves.
- **Today, steering:** the keyboard gives `steer` -1 or 1 at once (`nav/drive.ts`). `car.ts` `step` eases the wheel
  angle with `dt * 8`, a time constant of 0.125 s, so A or D is full lock at once. The lock falls with speed
  (`steer / (1 + v / steerFall)`, moto 0.42 rad and 9 m/s).
- **Today, falling:** on flat ground the bike does not tip. Measured with `scenarios.ts` `Sim`: 20–130 km/h at
  full lock, `up` stays 1 and all four hidden wheels stay down (at 130 km/h full lock it scrubs down to 18 km/h).
  The rider comes off by the rules in `nav/drive-session.ts`: an `impact` or a `knock` of 7 m/s (25 km/h) or more
  (`FALL_IMPACT`), which includes touching any traffic car and any wall or kerb that costs that speed in one step; a
  crash landing; or lying on its side. The righting in `car.ts` `bike()` works only with two or more wheels on the
  ground. `tools/vehicles.mjs` tests the bike at `steer` 0.33 and 0.5 only, never at keyboard lock, and has no test
  for a glancing hit.
- **Do first:** show the cause of each fall in the note for a while ("came off: wall 9 m/s", "knock", "on its
  side") and ride the real map, so the tuning is aimed at what happens in play.
- **Do, steering:** a steering ramp in `car.ts` (sim side, so it is the same for every input and for a server): the
  input builds up over about 0.3–0.5 s of holding and returns faster than it builds, as the plane's roll and pitch
  do since `c99a3a08` (a rate that follows the wish, limited by an acceleration). Per vehicle in `Tune`; cars may
  keep a short ramp. The touch stick and gamepad are analogue already: ramp only the rate, do not add lag to them.
- **Do, speed:** make the lock depend on speed so that the sideways acceleration at full lock stays under the grip
  (a bike leans, it does not skid at 60 km/h).
- **Do, stability:** falls only when it makes sense: a head-on hit (the speed lost along the heading), not a
  glancing scrape or a nudge on a car's corner; raise or split `FALL_IMPACT`. Righting also with one wheel down and
  for a short time in the air. Keep the wheelie.
- **Feel:** "it should be fun". Judge it in the browser on a real street with traffic.
- **Gates:** `vehicles` 30/30 plus new checks in `tools/vehicles.mjs`: `bike_keys` (steer 1 held from 0 at 30, 60
  and 100 km/h: upright, turns, the wheel angle takes 0.3 s or more to reach its lock), `bike_scrape` (a wall at
  10° at 50 km/h: stays on), `bike_wall` unchanged (head-on: comes off). `rapier-car` 42/42.

### F8. Water surface from the world, river slider removed (M–L)

- **Waits for:** R3 (it makes the shared `river.ts` this builds on, and moves the boat's and the plane's shells).
- **Decision:** the owner wants the river-level slider gone, and sees it as a smell that boat and plane read the
  flood level at all. It is more than a few lines (below), so it is a package.
- **Why boat and plane read it today:** the voxels hold the rivers as surveyed. The slider does not change the
  world, it draws a sheet of water over it (`flood.ts`) and sets a shader uniform. So everything that floats has to
  add the slider's rise by hand to stay on the drawn water:
  - `nav/boat.ts`: `lift = Math.max(0, this.level())`, the drawn hull raised (the physics stays on the voxels'
    water, `VoxelCollision.waterColumn`).
  - `nav/plane-flight.ts` `collisionWorld(c, H, level)`: `water()` returns the voxels' water top plus the rise.
  - `sim/boats.ts` `update(..., level)`: the ships float at `waterTop + level`, and no tours above 3.5 m.
    `waterTop` is one number for the whole map (`flood.json` `voxel_top`), which is wrong wherever a ship is not on
    that stretch.
  - Boat and plane also read `flood.json` `river` (points every 24 m) to find water to start on. That is world
    data that happens to live in the slider's file.
- **Goal:** no craft and no sim reads a level from the presentation. The water surface at a place comes from the
  world data through one module.
- **Do, step 1 (code only, no data change):** one water module (`river.ts` from R3, plain, no three.js): the
  water top at (x, z) from `VoxelCollision.waterColumn`, and the nearest water to a point. Boat, plane and
  `sim/boats.ts` use it. Remove the `level` parameters from `BoatMode`, `PlaneMode` `env`, `collisionWorld` and
  `Boats.update`, and `NO_TOURS_ABOVE`. `sim/boats.ts` takes the water top where each ship is, not `voxel_top`.
- **Do, step 2 (code only):** remove the slider (`bar.ts` `river`, `onRiver`, `showRiver`; `main.ts` `RIVER`,
  `flood.setLevel`, `riverSeen`), `flood.ts` (the sheets, `uLevel`, `uBoxes`, `uSpill0`), `uDrop` and the sandbank
  branch in `voxelMaterial.ts`, `FloodInfo` fields nobody reads, the README's and `docs/plans/boat.md`,
  `plane.md` mentions, and the "water level" sentence in ADR 0007.
- **Must stay:** the rivers in the voxels and their look, `VoxelCollision.waterColumn`, the river points for a
  start on the water, and the "is this cell river" test the reflections use (`voxelMaterial.ts`, the floodlit
  fronts' mirror: `riverAt(...).y`, the bed from the tiles' `flod` section).
- **Do, step 3 (data, separate commit, needs a full rebuild):** `scripts/flood.py` shrinks to what is still read:
  the river points (a small `river.json`, or into `meta.json`) and one byte or bit per cell "river" for the
  reflections. Drop the spill grid, the bed estimate, `flood.json`'s surface and stretches, and the `flod`
  section's first plane (`tilefile.py`, `tile_fields.py`, `core/tile-sections.ts`, `fields.ts`,
  `tile_roundtrip.py`). This changes the tile format: follow ADR 0004. If that is not wanted now, stop after step 2
  and leave the bytes unread; say so in the report.
- **Gates:** `boat` and `plane` gates green with the same counts (their checks pass `level` 0 today, so the numbers
  must not move); `core-deps` with the new module; `shoot.mjs --compare` on `eck` and `kachlet` (the rivers look
  the same at the surveyed level).
- **Check by hand:** the boat above and below the Kachlet dam, the floatplane landing on the Danube and the Inn,
  the cruise ships at the quay.

## Also open (for later)

- **Road spots the general fixes do not reach:** see [road-defects.md](road-defects.md). They are road 1360 under a
  building, Bräugasse, Triftsperrstraße, the Schulstraße kink, road 2510, Steffelmühlweg, and bridges without a deck
  over water (Fritz-Abelein-Brücke, Triftsperre).
- **Aircraft:** wings do not collide. The floatplane's streaming measurement (phase 4 in [plane.md](plane.md)) is
  not done.
