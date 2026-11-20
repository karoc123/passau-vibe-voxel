# Passau in voxels

A 3200 × 1408 m diorama of Passau, the city of three rivers, at 1 m voxels, in the style of MagicaVoxel renders:
the Altstadt peninsula between Danube and Inn with the cathedral (Dom St. Stephan) at its centre, the Dreiflüsseeck
where Danube, Inn and Ilz meet, Veste Oberhaus and the Ilzstadt to the north, the Innstadt to the south, and west to
the Hauptbahnhof and St. Nikola. The grid is north-up and anchored on the cathedral (`scripts/aoi.py`; the extent is set in `scripts/map.json`).

The date, the hour, the weather and the rivers' level are sliders; cars, trains, pedestrians and bikes move on the
real OSM network; river-cruise ships moor at the Danube quay by season and the Dreiflüsse excursion boats run their
loop; at night street lights, lit windows and floodlit landmarks come on. Landmarks carry labels, and a search box
(`/`) finds streets, squares, buildings and stops.

Live: <https://karoc123.github.io/passau-vibe-voxel/> (GitHub Pages, deployed on every push to `main` by
`.github/workflows/pages.yml`).

```sh
cd web && pnpm install && pnpm dev     # http://localhost:5173  (?view=dom&date=7-15&hour=13&weather=clear)
```

Camera presets (`?view=`): `overview`, `dom`, `oberhaus`, `fromoberhaus`, `eck`, `city`. Other URL parameters:
`cam=x,y,z,tx,ty,tz`, `date=M-D`, `hour=`, `weather=clear|cloudy|rain|snow`, `tilt=0`, `ui=0`, `crop=R` (a tiny
scene: see "Agent tools").

> **Derived from [warsaw-vibe-voxel](https://github.com/stared/warsaw-vibe-voxel) by Piotr Migdał (MIT licence, see
> `LICENSE`).** The pipeline and the viewer are his; this repository ports them to Passau and Bavarian open data.
>
> Original projects:
> - Warsaw: [github.com/stared/warsaw-vibe-voxel](https://github.com/stared/warsaw-vibe-voxel), the code this repository
>   is forked from, and its write-up [Invisible Cities, one shot](https://quesma.com/blog/invisible-cities-one-shot/)
> - Portland: [portland.ooo-yay.com](https://portland.ooo-yay.com/), the same idea for Portland, Oregon


## Data sources and licences

| Source | Licence | Used for |
|---|---|---|
| **DOM20**, digital surface model, 0.2 m ([Bayerische Vermessungsverwaltung](https://www.geodaten.bayern.de)) | CC BY 4.0 | Building heights where LoD2 has no roof, tree crowns, parked vehicles, bridge decks |
| **DGM1**, digital terrain model, 1 m (Bayerische Vermessungsverwaltung) | CC BY 4.0 | Ground relief; the rivers where OSM's outlines are cut by the map edge |
| **DOP20**, orthophoto, 0.2 m (Bayerische Vermessungsverwaltung) | CC BY 4.0 | Roof colours, foliage tones, grass and fields OSM doesn't map, vehicle colours, the three rivers' own colours |
| **LoD2** 3D building models, CityGML (Bayerische Vermessungsverwaltung) | CC BY 4.0 | Roof planes (pitched roofs, ridges), building footprints the OSM outlines are moved onto, buildings OSM lacks |
| **Laserdaten**, airborne LiDAR point clouds (LAZ), Feb 2021, ~11 points/m² (Bayerische Vermessungsverwaltung) | CC BY 4.0 | Tree canopy heights, crown bases, conifers (dense in the leaf-off scan) vs. broadleaved trees, trimming the surface model's smeared crown rims |
| **Einzelbäume 3D**, single trees with height from the 2024 flight, GeoPackage of district 124014, cut to the map (Bayerische Vermessungsverwaltung) | CC BY 4.0 | A trunk under every crown, one crown per tree |
| **ALKIS Tatsächliche Nutzung** (actual land use), shapefile of the Stadt Passau (Bayerische Vermessungsverwaltung) | CC BY 4.0 | The class of open land OSM says nothing about: forest, copse, grassland, arable land, park, waste land, car park, cemetery |
| **[OpenStreetMap](https://www.openstreetmap.org/copyright)**, [Geofabrik](https://download.geofabrik.de/europe/germany/bayern/niederbayern.html) daily extract for Niederbayern | ODbL, © OpenStreetMap contributors | Footprints and 3D parts, facade and roof colours, roads, paths, railways, bridges, trees, street lamps, names, the traffic network |
| **[Deutscher Wetterdienst](https://opendata.dwd.de/climate_environment/CDC/)**, phenological observations | [DL-DE BY 2.0](https://www.govdata.de/dl-de/by-2-0), source: Deutscher Wetterdienst | When each tree species leafs out, colours and drops its leaves (stations within 100 km of Passau below 500 m) |
| **[iNaturalist](https://www.inaturalist.org/)** "Leaves" annotations, weekly counts | see iNaturalist's terms | The same, for species the DWD does not record |
| **[Open-Meteo](https://open-meteo.com/)** historical archive (ERA5) for 48.574° N, 13.466° E | CC BY 4.0 | The typical weather of each day of the year |
| **[Wikimedia Commons](https://commons.wikimedia.org/)** photos (listed in `scripts/foliage_photos.json`) | per photo | Autumn and summer colour of each species' canopy |

Attribution to show wherever the model or its data is published (the viewer's credits line carries all of it):
- *Datenquelle: Bayerische Vermessungsverwaltung – [www.geodaten.bayern.de](https://www.geodaten.bayern.de)*, licence
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (DOM20, DGM1, DOP20, LoD2, ALKIS Tatsächliche Nutzung, Laserdaten, Einzelbäume 3D; the model is a modified,
  derived work of them)
- *© OpenStreetMap contributors*, [ODbL](https://www.openstreetmap.org/copyright). The files in `web/public/data`
  are a Produced Work built from OSM; the cut `data/raw/osm.json` itself is ODbL.
- *Weather data by [Open-Meteo.com](https://open-meteo.com/)* (CC BY 4.0), *Quelle: Deutscher Wetterdienst*
  (phenology, DL-DE BY 2.0)

`web/public/data/meta.json` records the OSM snapshot's timestamp and the Bavarian sources (written by
`scripts/voxelize.py`).

Inherited from the upstream project, measured on Warsaw and not yet on Passau (used as generic Central European
values):
- `web/public/data/windows.json`: how many windows are lit at night, by building type, hour and weekday. Upstream
  counted them on dated night photos of Warsaw. The file is kept as it is; nothing in this repository rebuilds it.
  (`windows.bin`, which building is of which type, is Passau's own, from OSM.)
- The colour of lawns through the year (`LAWN_LAB` in `scripts/phenology.py`) and the plaster palette for old-town
  houses without an OSM colour.

## Build the data

```sh
sh scripts/build_data.sh
```

Needs [uv](https://docs.astral.sh/uv/), `curl`, and Node with `web/node_modules` installed (`cd web && pnpm install`:
the triangle counts run the viewer's mesher). The first run downloads about 0.8 GB of Bavarian rasters, 0.26 GB of LoD2 models, 0.7 GB of LiDAR point clouds and the 0.37 GB single-tree GeoPackage (cut and deleted), the Geofabrik extract and 0.7 GB of DWD tables into `data/raw` (git-ignored, reused afterwards).
From cached raw data the build takes about 5½ minutes (WSL, 20 cores: prep, lod2, laser 1 min, the volume in 8
regions of 1024 m, 4 at once, 3½ min, the steps after it 1 min, 45 s of them `tris.mjs`); a region's process peaks
at ~4 GB of RAM (the Altstadt's, 1024 m and its halo), the steps after the regions at 0.8 GB; `data/cache` holds
0.2 GB. Given the same `data/raw`, it reproduces the committed `web/public/data` byte for byte (checked on
2026-11-20; the gzip files are written with `mtime=0`).

**Incremental.** A rerun does only what changed: each step runs when what it reads or writes changed since it last ran
(`scripts/stamp.py`, records in `data/cache/stamps/`; `FORCE=1` runs every step, `FORCE=flood,boats` some), and
`voxelize.py` builds again only the regions whose inputs or code changed (see "Regions"). With nothing changed the
whole of `build_data.sh` takes 4 s. To iterate on one place: `uv run python scripts/voxelize.py --only x=COL,y=ROW`
(the region holding that map cell, built again whatever its hash; `--status` lists the regions and what changed for
each), then `sh scripts/build_data.sh` for the steps after it (the Altstadt's region: 2½ min, then 1 min; a small
region at the map's edge: 20 s).

**The map's config: `scripts/map.json`.** The extent (a window of the project grid: its corner on 1024 m blocks, its
size), the volume's floor, the rivers' level (one, or per stretch: boxes in EPSG:25832, each with its own level;
`uv run python scripts/river_levels.py` measures them along the rivers' OSM lines from the terrain model), the
anchor, and the default cover of regions (`size`, `jobs`). `MAP_CONFIG=path` picks another file. The project grid
(column = easting − 827371, row = 5390500 − northing) never moves: hashes, noise and curated places key on it, so a
larger map keeps today's cells as they are; the outputs (tiles, the viewer's coordinates, `data/*.npz`) are in map
cells, the project grid's less the map's corner. The steps:

| Step | Writes |
|---|---|
| `fetch_osm.sh` | `data/raw/osm.json`: OSM cut to the AOI + 100 m, via `uv run --with osmium` (`OVERPASS=1` asks the public Overpass servers instead of Geofabrik). Skipped when `osm.json` exists, unless `OSM_REFRESH=1` |
| `fetch_bayern.sh` | `data/raw/{dsm,dtm,orto}_*.tif`: the 1 km sheets covering the AOI; `data/raw/lod2/*.gml`: the 2 km LoD2 tiles; `data/raw/tn_09262.zip`: ALKIS Tatsächliche Nutzung of the Stadt Passau (3 MB, read by `alkis_tn.py`); `data/raw/laser/*.laz`: the LiDAR point clouds (8 sheets, 0.7 GB); `data/raw/baeume_aoi.csv`: the Einzelbäume register cut to the AOI (0.4 MB; the 370 MB GeoPackage is read once by `clip_baeume.py`, with sqlite3 under `python -I`, and deleted). Files already there are not fetched again |
| `laser.py` | `data/laser.npz`: per 1 m cell vegetation statistics from the point clouds (highest return, lowest tenth, pulses caught in the canopy, single-return pulses, ground returns); optional for `voxelize.py` (`NO_LASER=1` ignores it) |
| `prep.py` | `data/prep.npz`: the rasters mosaicked on the grid (surface 0.5 m, terrain 1 m, orthophoto 0.2 m) |
| `lod2.py` | `data/lod2.npz`: LoD2 roof planes, roof types and footprints on the grid |
| `voxelize.py` | `web/public/data/tiles/`, `meta.json`, `trees.json` (the tree register, `scripts/trees.py`: OSM and Einzelbäume), `traffic.json`, `qa_roadmask.bin.gz`; `data/ground.npz`, `data/footprints.npz`, `data/crowns.npz`; region by region, only the regions that changed (`data/cache/regions/`). Stops without `data/lod2.npz` (`NO_LOD2=1` builds from the surface model and OSM alone) |
| `places.py` | `places.json`: the search index (streets, squares, buildings, stops) |
| `flood.py` | `data/flood.bin` (which cells the rivers reach at each level, the river bed), `flood.json` (the surveyed surface, the river's points) |
| `boats.py` | `boats.json`: cruise-ship berths on the Danube quay, the excursion boats' loop |
| `terrain.py` | `terrain/near`, `terrain/far{k}`: the bare land in chunks, shown while the tiles load and beyond the view distance; `data/terrain.bin` (the whole, for the tools) |
| `zones.py` | `data/zones.bin` (the building of each 1 m column), `zones.json`: each building's box (a building shows once all its tiles are in), the building under each label (needs `data/footprints.npz`) |
| `objects.py` | `objects/<k>.json`: every building's and street's box by OSM id, in 64 files by id, for the viewer's `?focus=` (needs `data/ground.npz`) |
| `windows.py` | `windows.bin`: what each building is (residential, office, church …), per building, for its windows at night (needs `data/footprints.npz`) |
| `climate.py` | `climate.json`: the typical weather of each day (Open-Meteo, cached in `data/raw/climate`) |
| `phenology.py` | `phenology.json`, `data/foliage.bin` (DWD and iNaturalist, cached in `data/raw/dwd`; needs `trees.json`) |
| `tile_fields.py` | into every node file of `tiles/` (`scripts/tilefile.py`: a header of tagged sections): per cell the building, the rivers' level and bed, foliage and the light of lit windows on the street, at the node's own cell size, from the `data/` maps above. Nothing of the map's size is loaded by the viewer whole: each node brings its part. Run again after `voxelize.py` or `tiles_lod.py` |
| `web/tools/tris.mjs` | `meta.json` `tiles.tris`: every tile's triangles per level as the viewer meshes it (its own mesher, run in Node), for the render budget; the viewer needs it (needs the tiles' buildings, `tile_fields.py`) |
| `web/tools/lamps.mjs` | `streetlamps.json`: the street lamps placed along the streets in town (`web/src/streetlamps.ts`; needs `data/zones.bin`, `data/foliage.bin`, `data/terrain.bin`, `traffic.json`) |

**Windows.** The steps after the volume (`tiles.py`'s export in `voxelize.py`, `tiles_lod.py`, `tile_fields.py`,
`zones.py`, `terrain.py`) work window by window (`scripts/window.py`): a window's core is a rectangle of the grid on
1024 m boundaries (a node of every tile level, a terrain chunk), and the step reads only the region of the core and a
halo around it (its reach: the tiles 16 m, `tile_fields.py` 32 m, `terrain.py` 8 m, `zones.py` 0), the `data/` files
row band by row band. `--windows NXxNY` or `--window-size METRES` choose the cover (the whole map in one window by
default); every cover writes the same bytes (`uv run python scripts/window_check.py STEP` checks it).

**Regions.** `voxelize.py` builds the volume region by region (`scripts/region.py`, `scripts/regions.py`): a region
is a window's core and a halo of 384 m round it, built in a process of its own, which reads its own cut of OSM (the
elements within 64 m of it), writes its core's tiles and leaves its core's rasters, volume and lists in
`data/cache/regions/<row>_<col>/`. `--regions NXxNY`, `--region-size METRES` or `--whole` choose the cover
(`scripts/map.json`'s by default: 1024 m, 4 at once; `-j N`); every cover writes the same bytes (`uv run python
scripts/region_check.py` checks it, with the steps after it, and that an incremental rebuild changes nothing). A region
is built again only when the hash of what it reads changed (`scripts/region_inputs.py`: its windows of
`data/prep.npz`, `lod2.npz`, `laser.npz`, hashed per 128 m block once per file; its OSM cut; the raw files it reads;
the code files its process loaded, by their syntax tree (comments rebuild nothing); the map's config; the large
features' decisions it took), or the palette registry no longer starts with the colours it was built with, or its files
are gone. A region keeps its core's volume as compressed 128 m column blocks (`vol.npz`, ~2 MB a km², 1/160 of the
raw volume). The driver holds nothing of the map's size (`scripts/mapstore.py`): the map-sized files are written row
band by row band from the regions' cores, and the passes over the whole map read the regions' rasters and volume
blocks where they look. What makes
a region's core independent of what lies beyond its halo: the volume's floor and the rivers' level pinned per project
(`aoi.BASE`, `aoi.RIVER_LEVEL`), noise and hashes on the project grid's coordinates (fixed to EPSG:25832, `aoi.py`),
a palette registry (`scripts/palette.json`: ids never depend on the order colours are met; a build adds new colours
to it, sorted), a feature decided over its whole outline when it spans under 192 m, and beyond that (a long lawn,
car park or untagged path) over its whole outline too, from counts made by every region over its core in a feature
pass before the regions and added up by the driver (`scripts/features.py`, `data/cache/features.json`), sizes
and levels of connected areas (the rivers' bodies, straw fields) counted within a window of 192 m, nearest-cell fills
bounded, box filters summed exactly, the floating-debris passes judging pieces up to 64 m across, curated places in
EPSG:25832 or project grid rows and columns, built only where the region holds them. The labels, the camera presets,
the tram paths and `traffic.json` are made after the regions, network-wide over OSM's vectors and the lists the
regions hand over, sampling the rasters (a label's box, a path's cells: never the map's size); `flood.py` and
`boats.py` still work on the whole map's rasters (see `scripts/window.py`).

Python dependencies (`pyproject.toml`, `uv.lock`): numpy, scipy, rasterio, affine, shapely, webcolors (BSD-3-Clause),
pyproj (MIT), pillow (MIT-CMU), laspy (BSD-2-Clause) with lazrs (MIT / Apache-2.0) for the LAZ files; osmium (BSD-2-Clause) only for `fetch_osm.sh`, added there by `uv run --with`.

Checks that run at build time are logged to `data/debug/report.json`; `scripts/floating.py` and
`scripts/surface_check.py` are whole-map checks to run by hand (`FINALDUMP=1` makes `voxelize.py` save the volume
for them).

## How the data is fused (scripts/voxelize.py)

- **Buildings.** OSM outlines are moved onto the LoD2 footprints (OSM stands ~3 m off the Bavarian data here);
  buildings LoD2 has and OSM lacks (sheds, back houses) are added from LoD2. Roofs are LoD2's planes where they agree
  with the surface model, otherwise the surface model; OSM's `height` wins only for spires the model under-samples and
  for buildings that went up after the survey flight.
- **Rivers.** OSM's multipolygons of the Danube and the Ilz are cut by the map edge and do not close, so the rivers are
  taken from the terrain model: flat cells at the water's level. Each river keeps its own colour from the orthophoto
  (the Danube dark green, the Inn milky jade, the Ilz peat-dark), smoothed over ~50 m.
- **The historic core** (`landmarks.HISTORIC_CORE`: the Altstadt and the Innstadt) gets plastered houses in warm
  colours where OSM gives none, and pitched tiled roofs fitted to the surface model.
- **Vegetation.** A cell is a tree if the surface model stands over the terrain and the orthophoto is green (or an OSM
  tree is near), and it is not a building's wall edge. OSM trees without a crown in the model are drawn as young trees.
  Where the 2021 laser scan saw open ground beside its canopy, the surface model's smeared crown rims are cut back;
  canopy heights are the laser's (grown by up to 1.5 m to the 2024 surface; the surface model wins where a tree has
  been cut since). Every crown stands on a trunk: OSM's trees and the Einzelbäume register's (merged within 3 m, OSM
  keeping the species), one crown per trunk. Crown depth follows the laser's crown base (halfway to the default for
  broadleaved trees, whose winter scan reads low); crowns that stop the winter pulses (a fifth of them single returns)
  are conifers: cones in needle green, evergreen in the viewer. Inside every broadleaf crown stands its bare wood (a
  material of its own, wood): the trunk on up to a fork, a leader, 3-5 limbs and branches out towards the rim a metre
  or two under the leaves, one voxel thick, drawn per tree from a generator seeded by its trunk's project grid cell.
  The viewer meshes wood where it meets leaves too (`mesher.worker.ts`, 1 m foliage tiles only) and lets the leaves
  fall tree by tree in autumn, every one of them by winter, so a bare tree is its trunk and branches; on the 2-8 m
  levels, which have no branches, a bare crown is a thinned grey-brown mass.
- **Bridgeheads.** The terrain model leaves out bridges, and often with them the last metres of an approach or the
  plaza over a road diving under the bridgehead. Ground next to a deck at a bridge's end (within 20 m of a bridge way's
  end that a way on the ground goes on from) is lifted to the surface model's level where that stands 2 m or more over
  the terrain, level, at the deck's height or on a ramp down from it (12 % at most, up to 40 m out); never under a way
  that does not come off the bridge, on railway land, by the water or under a crown (`bridgehead_fill` in
  `voxelize.py`).
- **Set pieces** (`scripts/passau.py`): the Dom rebuilt (west towers with copper cupolas, front with gable and
  portal, nave and aisles with arched windows, east end and crossing drum from LoD2); Veste Oberhaus and Niederhaus
  under clean roofs with OSM's walls as battlements; the Poststeg footbridge over the station's tracks.
- **Labels and camera presets**: `scripts/landmarks.py` (`LABELS`, `EXTRA_LABELS`, `make_views`), plus named parks
  over 2.5 ha (`scripts/labels.py`).
- **Per-object overrides** (see below). Prefer fixing `building:colour`, `height`, `building:part`, `width` and
  `surface` in OSM itself where OSM is wrong; an override is for what OSM does not model.

## Per-object overrides (scripts/overrides/)

One JSON file per object, so that many agents can each refine one building or street (the `/verfeinern` skill,
`.agents/skills/verfeinern/SKILL.md`, linked from `.claude/skills/` for Claude Code) and their branches merge without conflicts:
`scripts/overrides/building/<way id>.json` (`r<id>.json` for a relation; an outline or a `building:part`) and
`scripts/overrides/street/<way id>.json` (a highway way). A file says *what* to build as parameters, never voxels, so
it is rebuilt from the data on every build, in any region cover and on a larger map. The format, its keys and its
CLI are documented in `scripts/overrides.py`; the parts in `scripts/parts.py` (`uv run python scripts/parts.py`
lists them and their parameters).

- **Buildings**: wall and roof colour and material; `roof.shape` (`flat`, `gabled`, `hipped`, `pyramidal`, with
  `eaves`, `ridge` in metres over the footprint's median ground and `ridge_dir`), which rebuilds the roof surface
  (and the viewer's roof plane shading) from parameters; facade `zones` and a `crown` band; `windows` (real window
  openings on every straight edge: bay, rows); `parts`; a `label`. Applied in `voxelize.py`: the roof shape before
  the roof is rounded to voxels, zones, windows and parts on the finished building.
- **Parts** (`scripts/parts.py`): `helm` (a tower's pyramid, cone, needle, dome or onion with cross or ball),
  `dormer`, `chimney`, `bay_window` (oriel), `arcade` (arches cut into the ground floor). Placed `at` the centre,
  the highest column, an EPSG:25832 point or a fraction along and across the footprint, `repeat`ed by a step. A new
  part is a function and an entry in `PARTS`.
- **Streets**: `width`, `lanes`, `surface` (set as the way's OSM tags when OSM is read, so the volume, the traffic
  and the lamps all see them), `sidewalk` (paved strips left and right of the carriageway, with a kerb line),
  `trees` and `lamps` every so many metres along a side (added as OSM nodes, ids from 10^15: young trees where the
  surface model has no crown, lamps with their poles and light).
- **Validation and staleness**: every build (`region_inputs.cut_osm`) validates all files (unknown keys, bad colours
  or materials, a file name that is not an id of the right kind: the build stops with the list) and warns when an
  object's OSM geometry changed since the override was written (its `osm` block holds hashes of geometry and tags,
  written by `overrides.py new`, refreshed by `overrides.py rebase`) or the object vanished. `uv run python
  scripts/overrides.py check` does the same by hand.
- **Rebuilds**: an override is in the key of the regions whose core lies within 128 m of its object
  (`region_inputs.OVERRIDE_REACH`), so editing one file rebuilds those regions only (one to four:
  `voxelize.py --status`), then the steps after them.
- Not covered (yet): changing a building's footprint or height outright (OSM's job: `height`, `building:part`),
  per-facade colours by compass side (zones run along the long axis), street furniture other than trees and lamps,
  a street's own height (kerbs are drawn flush: the ground is a height field).

**Looking at an object: `uv run python scripts/look.py building|street ID [--out DIR]`** draws the orthophoto, the
surface model and the LoD2 roofs round it with the OSM outline (`look.png`, 5 px per metre, a 10 m grid) and prints
what the parameters come from: its OSM tags, the heights over the ground (DOM20 percentiles, LoD2 eaves and ridge,
the ridge's bearing, the roof type), towers in the surface model with their width at every 2 m of height, the
roof's colour in the orthophoto. `overrides.py info` gives the object's place and its `?focus=` link.

## Viewer (web/)

three.js + Vite + TypeScript. The city is streamed in tiles (`web/public/data/tiles/{1,1f,2,4,8}/x_y.bin`): 128 × 128
cells of 1 m (buildings and ground; foliage in `1f`), 2, 4 or 8 m. `web/src/city.ts` picks each node's level by its
size on screen and a budget of triangles drawn (the detail setting), the nodes nearest the camera finest; the whole
map at 8 m is the least it draws, and within ~100 m of a camera near the ground nothing is coarser than 2 m.
Each node's file also brings what the shader reads per cell (the buildings, the rivers' levels and bed, foliage, the
window light on the street: `scripts/tile_fields.py`); the nodes shown hold pages of two array textures
(`web/src/fields.ts`), so no texture or array grows with the map. Tiles are meshed in workers; the traffic simulation (`web/src/sim/`) runs within ~900 m of the camera.

```sh
cd web
pnpm check                                   # tsc
pnpm build                                   # static site in web/dist
node tools/shot_linux.mjs out.png "view=city&date=7-15&hour=13&weather=clear" 1600 1000   # headless screenshot (Linux/WSL)
```

`web/tools/` holds the upstream project's measurement and QA scripts (Playwright); most launch Chrome with macOS
flags and several predate the current viewer, so expect to adapt them.

No analytics: the page loads nothing beyond its own files and the Google font.

## Agent tools (checking a change)

For agents (and people) changing the code. All run from `web/` with no GPU and no extra dependency; in a git
worktree first `ln -s <main checkout>/web/node_modules web/node_modules` (don't install).

**FPV collision: `node tools/collision.mjs`** (~1 s). The drone's `VoxelCollision` (`src/nav/voxel-collision.ts`)
over a small synthetic world (`src/nav/collision-checks.ts`: a ground height per column, boxes for walls and decks,
written as real node files and served through a stubbed fetch): a sweep before the tiles are in waits, the drone's
cube falling onto the road and onto a deck, flying into a wall and out of the map, the surface it settles on. Exit
code 1 on a failure; check any change to `voxel-collision.ts` or the tile format with it.

**Rapier car: `node tools/rapier-car.mjs`** (~2 s). The Rapier car (`src/physics/rapier/`) on synthetic voxel
terrain (`src/physics/rapier/scenarios.ts`): terraces and platforms up and down, walls, cliffs, the river, paved
ramps along, across and diagonal, a bridge. Ground and slope cases print how much the car wobbles (`pitchJit`,
`rollJit`: RMS of the pitch and roll rate less their 0.5 s mean, rad/s; `liftPct`: share of samples with a wheel
off the ground; `lifts`: how often one left it) and how floaty it is (`vyErr`: RMS of the body's vertical speed less
the road's under its axles, m/s, 0 for a car glued to the road; `heave`: how far the body bobs over the road, cm;
`lightPct`: share of the time the wheels carry under half its weight; `airPct`: no wheel down). `crest_50`/`crest_30`
drive over the top of a 25 % street (`airS`, `hopCm`, `landLoad`, `settleS`), `settle_heave`/`settle_pitch` kick the body
on level ground (overshoot, settle time, frequency), `steer_step` holds half the steering at 50 km/h (`yawRise`,
`yawGain`, `latG`, `rollDeg`). `--set stiffness=34,gravity=1.25,...` runs anything with other numbers for the ride
(`car.ts` RIDE) or the car's surface (`terrain.ts` DRIVE: `tol`, `sigma`). `--real X,Z,HEADING,KMH,SECS` drives
straight in the real city, `--road I[,KMH[,REV]]` follows road I of `traffic.json`, `--roads [KMH]` runs the steepest
ten roads both ways and prints the means (the benchmark for the car's feel on real ramps). `node
tools/rapier-car-bench.mjs`: collider build and step costs along a route.

**Tiny scene: `?crop=R`** (or `?crop=x0,z0,x1,z1` in metres). Only the 128 m tiles within R m of the camera's first
target are loaded and drawn, no far ground; the rest of the map is empty. With `cam=` it frames any spot; Ctrl+C in the
viewer copies a `?cam=` link of the spot under the mouse. `crop=192` is a 4 x 4-tile patch: ~16 nodes instead of
~200-300.

**Screenshots: `node tools/shoot.mjs`**. Builds `dist`, serves it with `vite preview` on port 5194 (`--port`; never
5173, the dev server's), shoots in headless Chrome with what moves held still (shader clock, clouds, street life
hidden, shadow drawn whole) and a fixed date/hour/weather (`date=7-15&hour=13&weather=clear` unless the shot sets
them), so two runs of the same code differ by < 0.02 % of pixels. Typical use:

```sh
# the reference first, before the change (or from a second worktree on the old commit); outputs into a scratch dir
node tools/shoot.mjs --set quick --out /tmp/…/ref          # tiny-street, tiny-dom: ~15 s a shot
# … change the code …
node tools/shoot.mjs --set quick --out /tmp/…/new --compare /tmp/…/ref   # table + /tmp/…/new/diff/*.png (ref | new | |d| x4)
node tools/shoot.mjs --shots street,oberhaus-night --crop 256 --out …     # named shots, cropped
node tools/shoot.mjs --shots 'mine=cam=1600,40,700,1650,20,720&hour=20' --crop 128 --out …   # ad hoc: name=query
node tools/shoot.mjs --no-shoot --out new --compare ref    # compare two existing sets only
```

`--list` shows the named shots (`overview`, `oberhaus`, `dom`, `eck`, `street`, night, autumn, winter, snow, `tiny-*`)
and sets (`quick`, `default`, `seasons`, `all`). `--q "dist=900&shadow=2048"` adds to every shot's query, `--phone`
shoots at 412 x 860 with touch, `--eval 'window.__three.city().held'` records any page expression per shot
(`window.__three` exposes camera, scene, renderer, daylight, city(), setGfx …: `main.ts`). `DIR/shots.json` has per shot: ms to `__ready`, to loaded, total,
one frame's ms, the nodes shown per level and console errors (look there first). The diff fails (exit 1) above
`--fail` % (default 0.5) of pixels off by more than 24. The renderer is `--gl llvmpipe` (Mesa through ANGLE's
Vulkan; falls back to `swiftshader`): compare only sets taken with the same `--gl` and `--size` (the two renderers
differ by up to ~9 % px on glazing).

**One object: `?focus=bld:<id>` / `?focus=street:<id>`** (`bld:r<id>` for a relation) frames that building or street
(`web/src/focus.ts`; `&az=` the compass bearing the camera stands at, default 200, `&el=` degrees over the horizon,
`&fit=` a distance factor, `&crop=fit` only the tiles round it). Its box comes from `data/objects/<id % 64>.json`
(`scripts/objects.py`: every building's and street's box, split by id into 64 small files). `node tools/shoot.mjs
--focus bld:<id> --out DIR` shoots it from four sides, from above and at night (`f-sw`, `f-se`, `f-ne`, `f-nw`,
`f-top`, `f-night`), ~6 s a shot; `--compare` as above for before and after.

Measured (WSL, 20 cores shared with other agents, 1280 x 800): a whole-city shot 45-77 s under SwiftShader (frames
of 2-5 s), 33-50 s under llvmpipe; a `crop=192` shot 14-16 s under llvmpipe (~4 s to `__ready`, ~4 s loading, frames of
0.2-0.5 s, ~2 s the screenshot itself).

## FPV Acro prototype

Start the viewer with `cd web && pnpm dev`. Choose an orbit view near where you want to start, then click
**FPV Acro** in the top-left toolbar. On Windows with a controller connected, use the Windows browser and move a stick
or press a controller button so its axes appear under **Controller setup**.

1. Use **Learn axes** and follow the four stick prompts, or select and invert each axis by hand. Standard gamepads start
   with a Mode 2 layout. The live values should show positive right roll, forward pitch and right yaw.
2. Use **Calibrate range** to sample both ends of each channel. Leave the attitude sticks centred and lower throttle
   before finishing. The browser saves the profile for this device on this site.
3. Lower throttle fully and click **Arm controller**. The drone starts in the air. Around 39% throttle holds altitude
   when level. Centred attitude sticks hold the current orientation. Set camera tilt before arming.

**T** resets to the launch point, **Enter** arms the last input source again and **Esc** returns to the map. The keyboard
option uses W/S for pitch, Q/E for roll, A/D for yaw and R/F to raise or cut throttle. It starts at hover throttle.

The flight uses independent 1 m collision data for terrain, structures and trees across the whole 3,200 × 1,408 m model.
A swept drone volume catches thin voxels even at speed. Hard impacts deflect and spin the drone briefly while it
stays armed. The drone can settle on the ground and take off again with throttle. The flight waits if a collision tile
is still loading. Moving traffic, seasonal leaf visibility and changes to the river level are visual effects in this spike.
Roof and wall collisions follow the source voxels, including where a rendered roof or facade is smoothed.

## Driving

Click **Take the wheel** in the top-left toolbar to drive the car you're following or pick a nearby car.
W/S (or the up/down arrows) accelerate, brake and reverse. A/D or the left/right arrows steer. Space applies the handbrake and
loosens lateral grip. A standard gamepad uses the left stick, RT/LT, and the bottom face button. **Park car** leaves
the same car where you stop, and **Esc** takes you back to the map.

The car is a rigid body on four ray-cast wheels with suspension (Rapier, `web/src/physics/rapier/`: `drive-world.ts`,
`car.ts`), over colliders built from the same 1 m voxel data near the car (`terrain.ts`), including bridge decks; the
ground's 1 m steps are smoothed into a surface of the car's own, steps up to ~1 m that are not ground (platforms, low
walls) get an invisible ramp. Traffic cars and buses near it are solid; hit one at more than ~15 km/h (between the
two) and it is knocked out of the traffic, tumbles and stays where it comes to rest. People walking or cycling that
the car runs into are shoved away along the hit and tip over flat (a short scripted fall of the street life's figure,
no physics: `sim/life.ts` `knockDown`), and lie there until the car is ~35 m away. The traffic recognises the player vehicle in its
spatial checks. It can jump, flip and land on its roof, where it stays (park it, take
another). Driving into the river ends in a splash and a restart a little way back; a landing from ~8 m is a crash
(no control for a moment). Rapier (`@dimforge/rapier3d-compat`, Apache-2.0, ~1.7 MB gzip) is loaded in the background
~1.5 s after the city is shown; taking the wheel before that waits for it. Rapier is the only car physics. The mode's
panel and input are `web/src/nav/drive.ts`; one drive (the traffic and people near the car, knock-outs, the river and
back, crash landings, where to come back to: the last poses on its wheels on the terrain's ground with no water under
it) is `nav/drive-session.ts`, with no DOM, checked headless by `tools/rapier-car.mjs` (`drive_*`).

## Third-person walking

Click **Walk** in the toolbar to start on foot at the current view or beside the vehicle you're following. Use W/A/S/D
or the arrow keys to move relative to the camera, Shift to sprint and Space to jump. Move the mouse to look around
and scroll to zoom. On touch screens, drag to look, pinch to zoom and tap the ground to walk there.
**Esc** releases the mouse and returns to the map. The chase camera pulls in near walls, and the character uses the viewer's voxel walking
collision for kerbs, stairs, walls and bridge decks.

## Known limits

- **River level.** The slider moves the water in metres relative to the level on the survey day. It is not calibrated
  to the Passau gauges and shows no historic flood levels; below the surveyed level the river bed is schematic.
- Windows are procedural, generated in the shader from floor height and material, not real window positions.
- The surface model is matched from aerial images: it is noisier than LiDAR on roofs and stands a metre or two over
  open water (cleared in `voxelize.py`).
- Only the Dom, the two fortresses and the Poststeg have hand-made detail; the Rathaus tower, the other churches and
  the river bridges are as the data gives them.
- Lit windows at night follow Warsaw's statistics (`windows.json`, see above), and the night lighting (street lights,
  floodlit landmarks) is placed by rule, not from a lighting survey.
- Boats are simulated: berths and the excursion loop come from OSM, but the season's ship numbers, the timetable and
  the high-water stop are rules of thumb (`web/src/sim/boats.ts`), not real schedules.
- Trees come from OSM only (no municipal tree register is merged), so most crowns have no species and follow the
  median calendar.
- Parked cars are frozen from the survey flight; moving traffic is simulated, not real.
