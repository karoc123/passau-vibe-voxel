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

## Overview

"Ready" means it can start now. "In progress" names the working branch. "Ready to merge" means the verified
local branch can be merged into `main`. "Waits" means: start only after the named work is on `main` (check
`git log`). When a package lands, delete its section and its row here, and turn "Waits" rows whose blockers are
gone into "Ready". For a partially completed package, remove the landed item and keep the rest of the package open.

| Package | What | Size | Status |
|---|---|---|---|
| R6 | Split `voxelize.py` into stages | L | **Ready** |
| R7 | Build time | M | **Ready** |
| R5 | Check harnesses out of `src/` | M | **In progress** (`r5`) |
| F2 | Walk to a vehicle and get in | M | **Ready** |
| Q5 | A crown over a roof is not a tower | S–M | **Ready** |
| F7 | Motorbike falls (steering landed) | S–M | **Ready** |
| F11 | The map as a set of 1 km blocks: grow along the Inn to Ingling | M | **Ready** (needs a data rebuild) |
| F8 | Step 3: drop unread flood data | S–M | **Ready** (data rebuild) |
| Q7 | Spot fixes the general rules leave (low priority) | S each | **Ready** (data rebuild for Q8 first) |

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

### R7. Build time (code-health 19, M)

- **Landed:** `traffic.build` split into steps, `traffic.LANE` checked against `LANE_W` by the `lanes` gate in `scripts/check.sh` (merge `e106f98b`).

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
