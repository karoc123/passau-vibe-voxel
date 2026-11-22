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
| R6 | Split `voxelize.py` into stages | L | **Ready** |
| R7 | Smaller independent items | M each | **Ready** |
| F4 | The player car in the same Rapier world as the AI bodies | M–L | **Ready** |
| R5 | Check harnesses out of `src/` | M | **Ready** |
| F2 | Walk to a vehicle and get in | M | **Ready** |
| F5 | Trains and boats into the world sim | M | Waits for F4 |
| Q3 | Underpass stairwells never cut a carriageway or a track | S–M | **Ready** |
| Q4 | What passes under a bridge stays open | M | Ready to merge (`q4`) |
| Q5 | A crown over a roof is not a tower | S–M | **Ready** |
| Q6 | Roof caps at a ridge: no spikes | S–M | **Ready** |
| Q8 | A bridge deck does not sag to the ground beside it | S–M | **Ready** (not in parallel with Q4's deck-width step or R6's deck stage) |
| F7 | Motorbike handling | M | **Ready** |
| F11 | The map as a set of 1 km blocks: grow along the Inn to Ingling | M | **Ready** (needs a data rebuild) |
| Q2 | A carriageway over water is a bridge | M | **Ready** |
| Q9 | A road or rail tunnel under a street is a covered passage | M | Waits for Q4 |
| F8 | Water surface from the world, river slider removed | M–L | **Ready** |
| F6 | Trains have hitboxes | S–M | Waits for F5 |
| F10 | Minimap on M, and the collection point for map features | M | **Ready** |
| Q7 | Spot fixes the general rules leave (low priority) | S each | Waits for Q2–Q4, Q8, Q9 |

## Packages

### R5. Check harnesses out of `src/` (code-health 16 = T2, M)

- **Waits for:** nothing (R4 landed: `nav/craft.ts` `PlayerCraft`, `CRAFTS` in `main.ts`, `nav/orbit.ts`, `nav/foot.ts`).
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

Q1 landed with its data (`e414b3ba`, rebuild `12eb1e87`: 22 053 terrain water cells dropped, boat and plane gates
green). ALKIS ponds OSM does not map (23 000 cells) stay land; drawing them is a possible later package.

### Q2. A carriageway over water is a bridge (M)

- **Waits for:** nothing. Q1 landed in code (`e414b3ba`, terrain water only within 8 m of ALKIS or OSM water). Its
  data is built (`12eb1e87`); re-measure this list on it first (Q1 should take 9 of the 20 ways).
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

### Q8. A bridge deck does not sag to the ground beside it (S–M)

- **Waits for:** nothing. Do not run it in parallel with Q4's deck-width step or R6's deck stage. All three change
  the same block in `voxelize.py` ("# bridges / decks").
- **Today:** the deck's height is a profile along each bridge way. Each metre takes the 30th percentile of the
  surface model sampled across the way (±0.7 × half width, ±1.5 m along). Over land a sample is kept down to 1.5 m
  *under* the terrain model (`h_ > gd_ - 1.5`); only over water must it stand 1.5 m over it. The median filters after
  that knock down only what stands *over* the profile (pylons, cables). Then every point takes the 10th percentile
  of its layer within 10 m. So nothing removes a dip, and that last step spreads a dip 10 m each way. Where a way
  runs along the edge of its deck (OSM a metre or two off it) or the deck is narrow, some samples fall beside the
  deck onto the road or rail under the bridge, and a short bridge sinks to it.
- **Measured (data of 9781149b):** Dietzing (way 106617552, service, `bridge=yes`, `layer=1`, 23 m over the
  B 85 cutting). The way runs along the deck's north edge (lower rows). Its raw profile is 121–122 m over BASE,
  except for 3 samples mid-span at 114.8–115.5 (the B 85 under it, DTM 114.2). The built deck (`surface.npz` `deck`)
  is 115.1 at the west end and rises to 121 at the east end. The surface model is level at 121.5 over the whole
  span. Both OSM ends lie 6–8 m short of the banks, on the cutting's slopes. The end extension carries the deck on
  level from its end height until the ground comes within 1.5 m, so it starts from 115 and stops at once. A read-only
  scan of the raw profiles found 9 of 107 bridge ways with mid-span samples within 1.5 m of the terrain model (not
  over water) between samples 3 m or more over it. These are candidates to look at, not findings: the scan does not
  move footbridges as `snap_footbridge` does. They are path 1210300121 (-1746,797), footway 412953527 (1236,470),
  primary_link 121880279 (1149,486), Stockbauersteig 27663642 (1652,-1749), Innsteg 8092867, and with no deck at all
  Poststeg 8099444, footway 401782358 and path 163931217 (in the road-defects scan already).
- **Do:** one rule: a deck is the level the surface model holds over the gap, never the ground seen beside the deck.
  Between a way's first and last sample that stand clearly over the terrain (3 m or more), drop the samples within
  1.5 m of the terrain model, as over water. Only the ends may come down to the ground (abutments, ramps).
- **Do:** where a way's samples on one side see the ground and on the other side the deck, take the profile on the
  deck's side. This is the sideways shift `snap_footbridge` does for footbridges of 15 m or more, applied to the
  profile of every bridge way.
- **Do:** keep the 10th-percentile step (it was added for cable stays over the outer lanes), but run it on the
  profile with the dips already dropped.
- **Do:** a build counter and a `verify` check: bridge ways whose built deck lies 2 m or more under the way's own deck
  level (the median of its samples 3 m or more over the terrain) anywhere between its ends.
- **Gates:** `check.py verify` (the Gaißabrücke `deck` patch and the bridgehead cases in `road-defects.json` must
  hold); `clearance.py` lane scan not worse. No fixture covers the Dietzing bridge, so iterate with
  `voxelize.py --just` on its region.
- **Verify spot:** Dietzing over the B 85: `?cam=-2107,138.8,-1709,-2087,115.7,-1658` (road-defects #11).

### Q9. A road or rail tunnel under a street is a covered passage, not solid ground (M)

- **Waits for:** Q4. Both change the same ground passes, and Q4's per-pass debug arrays and corridor rule are the
  tools for this package. One agent may do both together.
- **Today:** a way tagged `tunnel=yes` is left out of the ground (`ways.underground`). `tunnels.py` bores it only
  under a hill (2 m or more of ground over a 6 m crown). `underpass.py` carves only foot passages. Nothing carves a
  carriageway or a railway in a tunnel under a street, an embankment or a junction. The ground passes fill its trench
  up to the street on purpose: `ground.py` `tunnel` (the street over a short road tunnel, 1.5–6 m) and `sag`
  (road-defects #4 at -882,667, the junction over this tunnel's ramp, fixed 7a9a5d40). The result is a whole street
  with solid earth under it, and the ramp ends at a wall.
- **Measured (data of 9781149b):** B 85 link 11773610 (`primary_link`, `tunnel=yes`, `layer=-1`, 37 m). Its
  portals stand at ground 15 (west, -896,656, where the ramp 96131677 comes down) and 14 (east, -860,664, on to way
  8010553). Along the tunnel the built ground is 19–20 (the street on the layer-1 junction ways 96131676, 122157777,
  96131670 and the embankment road 122157776), the DTM is 16.5–19 (interpolated under the structure) and the DSM is
  20. The laser has no ground return there. `gsrc` (the sag lift's source) is set over the trench south-east of the
  line. By its rule, the tunnel lift takes the cells on the line itself; this was not traced, and Q4's per-pass
  arrays would make it a lookup. A screenshot at the spot shows the ramp running into an earth wall. A read-only
  scan of the ground raster found other `tunnel=yes` carriageways and railways under shallow cover whose built ground
  stands 3 m or more over the line between their portals for most of their length:
  - service 1205663780 under the St 2125 (-1640,595), the passage of road-defects #5;
  - Granitbahn 836854485 (rail, 12 m, 2033,1034);
  - Stelzhamerstraße 8022045 (tertiary, 41 m, -1282,1156), a third of its length.

  Check each in the voxels: the scan reads the ground raster, not the tiles.
- **Do:** one rule: a `tunnel=yes` carriageway or railway that `tunnels.py` does not bore and `underpass.py` does
  not take is carved as a covered passage:
  - the floor graded between its portals' ground, as `tunnels.py` does;
  - the width of its bed;
  - the vehicle's clearance: 4 m for a road and 5 m for a train. Where the street over it leaves less room, carve
    what fits, down to about 3 m, and note it;
  - the street on a 1 m slab over it, at the level the ground passes give.

  The passes keep lifting the street, and the passage is cut after them. Prefer a "covered" profile in `tunnels.py`
  over a new module: that keeps one place for tunnels, and `traffic.py` already reads `tunnels.FLOOR`, so cars drive
  through.
- **Do:** a `verify` check: along every `tunnel=yes` carriageway and railway, the clearance from the floor to the
  first solid voxel is at least the vehicle's, and the street over it has no hole.
- **Gates:** `check.py verify` on the fixtures. The `b85` fixture holds this tunnel and the #4 patches (the street
  over it, `min_m` 19), which must hold. The `kachlet` fixture holds the St 2125 passage (#5): its patches must
  hold. The walkers' and cars' paths (`traffic.py`) must still connect.
- **Verify spots:**
  - the ramp into the tunnel: `?cam=-957.8,53.2,614.6,-894,16.8,656.7` (road-defects #12)
  - the street over it, which must stay whole: `?cam=-806.7,49.5,685.6,-881.7,17,667.6` (road-defects #4)

### Q7. Spot fixes the general rules leave (S each, low priority)

- **Waits for:** Q2–Q4, Q8, Q9. Do nothing here before them; this is only the list of what may be left.
- **Preferred fix:** correct OpenStreetMap itself (open data, and the next extract carries it), else an override in
  `scripts/overrides/`.
  - B 8 over the Baderbachl mouth (way 73317832 near -3048,-88): the road has no `bridge` tag, the stream under
    it is `tunnel=yes`.
  - Passage under the B 8 (way 73518491) and under the railway (way 73518482): mapped shorter than the road and the
    tracks are wide; the steps 73518490 and 73518489 start inside them.
  - B 12 bridge over the Rottalbahn (way 34755059): 25 m long; the deck is wider than three lanes.
  - Dietzing bridge over the B 85 (way 106617552, -2087,-1658): drawn along the deck's north edge, both ends
    6–8 m short of the banks. Realign it only if Q8 leaves the deck low.
- Road spots older than this list are in [road-defects.md](road-defects.md).

## Feature packages

These add behaviour, so they are judged in the browser as well as by the gates. Each comes with a short plan in
`docs/plans/` if it is bigger than S.

### F2. Walk to a specific vehicle and get in (M)

- **Waits for:** nothing. R4 landed: enter and leave go through `PlayerCraft` (`nav/craft.ts`) and `nav.leaveCraft()`; walking is `nav/foot.ts`.
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

- **Waits for:** nothing. It is in `physics/rapier/car.ts` and `sim/vehicles.ts`, not in the input shells.
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

- **Waits for:** nothing. R3 landed the shared `nav/river.ts` this builds on; `main.ts` passes the river points to boat and plane.
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
- **Do, step 1 (code only, no data change):** one water module (`nav/river.ts`, plain, no three.js): the
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

### F10. Minimap on M, and the collection point for map features (M)

- **Waits for:** nothing. F9 landed: labels in `meta.json` carry a `cat` (church, castle, bridge, tower, water,
  industry, transport, district, sport, park, education, health, shopping, culture, civic, sight) for icons; the
  curated list is `PLACES` in `scripts/labels.py`; N is wired in `main.ts` via `gameKey` (add M the same way).
- **Do:** M toggles a minimap: north-up or heading-up, the player's position and heading, rivers and main roads,
  the labels of F9 as icons. Draw it from data the viewer already has (`meta.json` labels, the low-LOD tiles or
  a small pre-rendered map image from the pipeline); no new data source.
- **Keep it a seam:** the minimap reads positions from the sim side (player, later other players and vehicles), so
  multiplayer markers are a data change, not a rewrite (see ADR 0006, 0007).
- **Collect here:** further map ideas belong in this package's section rather than a new file: click to set a
  waypoint, a full-screen map, showing other players, places from the search.

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
