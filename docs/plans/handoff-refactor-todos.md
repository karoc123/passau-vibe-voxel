# Handoff: refactor to-dos

These are self-contained work packages for agents started by the owner. Pick one package, read the linked item(s) in
[code-health.md](code-health.md) (file and line references there are of commit `6adf465a`, so re-locate them), do
it on its own branch, and report.

## Rules for every package

- Commit locally on a branch named after the package. **Never push.** Do not touch `.github/` (CI, Pages).
- Open data only. `scripts/palette.json` is append-only. In shaders, add no new and no `flat` varyings.
- `CLAUDE.md` only points to `AGENTS.md`; change `AGENTS.md` only when the owner asks. Do not create `IDEAS.md`.
- Keep it simple and do not over-engineer. The long-term goal is a server-hosted, multiplayer-capable world, so keep
  simulation free of three.js and the DOM where you touch it (see [ADR 0006](../adr/0006-world-sim-seam.md)).
- Behaviour-neutral refactors must prove they are neutral: the same check counts, and for the pipeline a byte-exact
  `check.py golden --compare`.
- `npm` is not on PATH: run dev commands through `web/tools/wt.sh` (setup, tsc, gates, vite on a free port; in a
  worktree it uses the main checkout's node_modules and data). Port 5173 is the owner's dev server; stop your own
  vite afterwards.
- A full data rebuild (`sh scripts/build_data.sh`, about 12 min) changes committed tiles. Do not run it unasked. Say
  in the report whether one is needed. Palette entries it appends go in their own commit.

## Gates

- `cd web && node tools/gates.mjs` runs the fast set (under a minute). `--full` runs all, and
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
| E15, E16, E21 | Health/items, spawn, avatar | S–M each | On hold until the game's vision is clear |
| E17–E20 | Prediction, worker by default, probe mode ([plan](entities-and-modes.md)) | M–L | Later (owner: worker not urgent) |
| F2 | Walk to a vehicle and get in | M | **Set aside** (owner, ADR 0008) |
| Q7 | Spot fixes the general rules leave (low priority) | S each | **Ready** (data rebuild for Q8 first) |

## Engine packages

Target: ADR 0006, 0007, [ADR 0008](../adr/0008-server-vision.md) and [ADR 0009](../adr/0009-layers-and-owners.md). What
is left of the architecture work is in [architecture-review.md](architecture-review.md); the commits are in `git log`.
Open points left by landed engine work:

- **Edits:** keep radius (600 m) and delay (120 s) are guesses; a placed block leaves trees poking through;
  temporary damage needs the TileCache to expose a node's raw files.
- **Wire:** no interest filter per client; snapshots are plain objects (no typed arrays or deltas); the worker's
  ground is level-1 nodes only and decodes nodes the page also decodes; no gated run carries edit notes over the clone
  link.
- **Timing (M5):** no teleport counter; inputs not buffered by tick;
  `life.update`'s viewer is last frame's camera.
- **Seats and crafts:** 1–2 frames on leave where nobody draws the craft; empty crafts' events are published; the
  parked-car cap (8/24) sits beside presence (`Tuning.presence`); a fall over 80 m/s is slowed by the walk clamp;
  `walkAs` start height unbounded.
- **Sessions and modes:** edit outcomes go only to the sending session; an unknown `?mode=` warns and falls back;
  `mayEdit` is asked twice (before the nodes are held and in the tick), so it must be a plain answer.

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

Q1 landed with its data (`e414b3ba`, rebuild `12eb1e87`: 22 053 terrain water cells dropped, boat and plane gates
green). ALKIS ponds OSM does not map (23 000 cells) stay land; drawing them is a possible later package.

Q5 (a crown over a roof takes LoD2's roof, `crown_roofs` counter) landed in code; its data rebuild is still due. Left:
at -1102,1292 a 1-2 m strip stands 10 m over LoD2 where the surface model's step inside one building lies a cell or
two off LoD2's (walls return as vegetation there, so the crown rule leaves it).

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
  - Inn fixture (`scripts/fixtures/inn.json`): the Wels-Passau railway's Inn bridge (ways 131994367, 131994370,
    near 1292,1440) is a through truss; its deck is right, but the truss is not drawn (the surface model's top chords
    stand 11 m over the rails, which is why `DECK_SAG_KNOWN` lists the two ways).
- Road spots older than this list are in [road-defects.md](road-defects.md).

## Feature packages

These add behaviour, so they are judged in the browser as well as by the gates. Each comes with a short plan in
`docs/plans/` if it is bigger than S.

### F2. Walk to a specific vehicle and get in (set aside)

- Set aside by the owner (ADR 0008). If it returns: F2a road vehicles via `takeWheel` after E2, F2b crafts after E4.

## Also open (for later)

- **Road spots the general fixes do not reach:** see [road-defects.md](road-defects.md). They are road 1360 under a
  building, Bräugasse, Triftsperrstraße, the Schulstraße kink, road 2510, Steffelmühlweg, and bridges without a deck
  over water (Fritz-Abelein-Brücke, Triftsperre).
- **Aircraft:** wings do not collide. The floatplane's streaming measurement (does tile streaming keep up at ~245 km/h;
  if not, `focus()` 2 s ahead of the plane) is not done.
