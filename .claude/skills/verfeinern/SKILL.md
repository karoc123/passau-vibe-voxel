---
name: verfeinern
description: Refine one building or street of the Passau voxel model with a per-object override, checked by before/after screenshots. Usage /verfeinern building <osm-id> | street <osm-id>
disable-model-invocation: true
argument-hint: building <osm-id> | building r<osm-id> | street <osm-id>
---

# Verfeinern: one object, one override file

Target: `$ARGUMENTS` (`building <way id>`, `building r<relation id>` or `street <way id>`). Below, KIND is `building`
or `street`, ID the id as given, FOCUS `bld:ID` or `street:ID`, FILE `scripts/overrides/KIND/ID.json`.

You run unattended: decide from the data, never ask. Your whole result is FILE, committed on your own branch. Touch
no other tracked file: many agents refine other objects in parallel and their branches must merge cleanly. The
override format is documented in the docstring of `scripts/overrides.py`, the parts in `scripts/parts.py` (`uv run
python scripts/parts.py` prints them with their parameters); README.md "Per-object overrides" is the overview.

Sources: open data only (OSM tags, LoD2, the DOP20 orthophoto, the DOM20 surface model, all via `scripts/look.py`).
Facade colours and details nobody measured stay as the model has them; the data you can point to is the bar for
every parameter.

## 1. Set up the worktree

1. Work in a git worktree of the repo on a branch `verfeinern/KIND-ID` (create it from `main` if you are on `main`).
   `M` = the main checkout (`git worktree list`, first line).
2. `web/node_modules`: `ln -s $M/web/node_modules web/node_modules` if missing (call `node` / `pnpm exec` directly).
3. `data/`: if missing, link the read-only inputs and copy the rest from the main checkout (the build writes there):
   `mkdir data; ln -s $M/data/raw data/raw; for f in prep lod2 laser; do ln -s $M/data/$f.npz data/$f.npz; done`,
   then `cp -r` every other entry of `$M/data` into `data/`. If `data/cache/regions` is then empty, build once:
   `uv run python scripts/voxelize.py -j 2 && sh scripts/build_data.sh` (~6 min).
4. Pick your own port for screenshots: 5200 plus the id's digits modulo 700 (never 5173). Scratch output goes in
   your session's scratchpad (`S` below), never in the repo.

Done when `uv run python scripts/voxelize.py --status` lists every region with nothing changed.

## 2. Gather what the data says

1. `uv run python scripts/overrides.py info KIND ID`: tags, place, size. A building with `building:part`s: the parts
   may carry the detail you want; their ids work the same way.
2. `uv run python scripts/look.py KIND ID --out $S/look`, then read `$S/look/look.png` (orthophoto | surface model |
   LoD2, 5 px per metre, 10 m grid in map cells) and `look.json`: heights over the ground (DOM20, LoD2 eaves and
   ridge, ridge bearing, roof type), `dom20_towers` (a tower's width every 2 m down from its top: a spire narrows
   fast, a dome bulges, a lantern is a narrow step), the orthophoto's roof colour. For finer orthophoto detail cut
   it yourself: `window.npz_region("data/prep.npz", "orto", (r0*5, r1*5, c0*5, c1*5))` (map cells; EPSG:25832 x =
   827371 + column, y = 5390500 - row).
3. If FILE exists, read it: you are refining an earlier override.

Done when you can name each thing the model gets wrong about this object and the measurement that shows it.

## 3. Shoot before

`cd web && node tools/shoot.mjs --focus FOCUS --port $PORT --out $S/before` (six shots: `f-sw`, `f-se`, `f-ne`,
`f-nw`, `f-top`, `f-night`; ~1 min). Read every PNG and `shots.json` (errors there first: a `focus:` error means the
id is not on the map). Compare what you see with step 2's findings.

## 4. Write the override

1. `uv run python scripts/overrides.py new KIND ID` (once: writes FILE with its `osm` basis), then edit FILE.
2. Only what step 2 measured, as parameters: `roof.shape` with `eaves`/`ridge` from LoD2 or DOM20, a `helm` from a
   tower's width profile, dormers, chimneys or oriels where the orthophoto shows them (EPSG:25832 points read off the
   picture, `repeat` for a row), `windows` rows from the storey heights, a street's `width`, `sidewalk`, `surface`,
   `trees`, `lamps` from the orthophoto. A tag that is simply wrong in OSM (height, colour, surface) is still worth
   an override here; say in `note` that OSM should be fixed too.
3. `note`: what you changed and the measurement behind each value. `sources`: the datasets you used.
4. `uv run python scripts/overrides.py check`: valid, nothing stale.

## 5. Rebuild the regions it touches

`uv run python scripts/voxelize.py --status` (one to four regions: `changed: osm`), then
`uv run python scripts/voxelize.py -j 2 && sh scripts/build_data.sh` (a few minutes). Done when the build ends without
a traceback and `grep -h override data/cache/regions/*/log.txt` shows your object's line (cells for a roof, voxels
for parts, strips for sidewalks: not 0).

## 6. Shoot after and compare

`cd web && node tools/shoot.mjs --focus FOCUS --port $PORT --out $S/after --compare $S/before` (it "fails" by design:
the object changed). Read each `$S/after/diff/*.png` (before | after | difference). The differences belong on the
object and its own ground: anything elsewhere is a bug to find before going on.

## 7. Review against the data

Answer each, with the evidence:
- Better: in which shots does the object look more like the orthophoto and the surface model than before?
- Consistent: heights within ~1 m of LoD2/DOM20, positions on the orthophoto, colours from a source, the object's
  neighbours as they were.
- Clean: no voxels floating, cut into neighbours, or poking through walls; the night shot still plausible.

Crop the same region from a before and an after shot side by side (PIL) to judge at full size: at 1 m voxels a
change that is right in the data can still read as noise (a kerb on a diagonal, a helm the surface model already
gave). Iterate on FILE (back to step 4) until all three hold. If no override of the available parameters makes the object
clearly better, delete FILE: committing nothing is a valid result.

## 8. Commit

`git add FILE` (that file only: the regenerated `web/public/data` is rebuilt after merging, so leave it uncommitted),
then commit on `verfeinern/KIND-ID` with the message `Override KIND ID (<name>): <what changed>`, the
measurements in the body and the before/after directories. Never push. Finish with a short report: what changed and
why, the paths of `$S/before`, `$S/after` and `$S/after/diff`, and anything you could not express (a parameter or
part the library lacks).
