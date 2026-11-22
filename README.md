# Passau in voxels

A 9344 × 3456 m diorama of Passau, the city of three rivers, at 1 m voxels, in the style of MagicaVoxel renders:
the Altstadt peninsula between Danube and Inn with the cathedral (Dom St. Stephan), the Dreiflüsseeck where Danube,
Inn and Ilz meet, Veste Oberhaus and the Ilzstadt, the Innstadt to the south, the Hauptbahnhof and St. Nikola; west up
the Danube past Hacklberg, Heining and the Kachlet dam to Schalding, both banks; north over Haidenhof, Ries, Grubweg
and the Ilz valley up to Hals and its loops. The grid is north-up and anchored on the cathedral (`scripts/aoi.py`; the
extent is set in `scripts/map.json`).

The date, the hour, the weather and the rivers' level are sliders; cars, trains, pedestrians and bikes move on the
real OSM network; river-cruise ships moor at the Danube quay by season and the Dreiflüsse excursion boats run their
loop; at night street lights, lit windows and floodlit landmarks come on. Landmarks carry labels, and a search box
(`/`) finds streets, squares, buildings and stops.

Live: <https://karoc123.github.io/passau-vibe-voxel/> (GitHub Pages, deployed on every push to `main` by
`.github/workflows/pages.yml`).

```sh
cd web && pnpm install && pnpm dev     # http://localhost:5173  (?view=dom&date=7-15&hour=13&weather=clear)
```

Camera presets (`?view=`): `overview`, `dom`, `oberhaus`, `fromoberhaus`, `eck`, `kachlet`, `schalding`,
`hacklberg`, `ilztal`, `north`, `city`. Other URL parameters: `cam=x,y,z,tx,ty,tz` (x and z in the project grid's
metres: column = easting − 827371, row = 5390500 − northing, y over the volume's floor; so a link keeps its place
when the map grows; the viewer works in map cells, the project grid's less `meta.json` `origin`), `date=M-D`, `hour=`, `weather=clear|cloudy|rain|snow`, `tilt=0`, `ui=0`, `crop=R` (a tiny
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
| **Laserdaten**, airborne LiDAR point clouds (LAZ), Feb 2021, ~11 points/m² (Bayerische Vermessungsverwaltung) | CC BY 4.0 | Tree canopy heights, crown bases, conifers (dense and bright in the leaf-off scan) vs. broadleaved trees outside the species map, trimming the surface model's smeared crown rims |
| **Einzelbäume 3D**, single trees with height from the 2024 flight, GeoPackage of district 124014, cut to the map (Bayerische Vermessungsverwaltung) | CC BY 4.0 | A trunk under every crown, one crown per tree |
| **ALKIS Tatsächliche Nutzung** (actual land use), shapefiles of the Stadt Passau and the Landkreis Passau (Bayerische Vermessungsverwaltung) | CC BY 4.0 | The class of open land OSM says nothing about: forest, copse, grassland, arable land, park, waste land, car park, cemetery |
| **[Tree Species Germany](https://geoservice.dlr.de/web/maps/eoc:tcde:2022)** 2022 and 2016, 10 m, the map's window of the [GeoTIFFs](https://download.geoservice.dlr.de/TREE_SPECIES_DE/files/) – DLR Earth Observation Center (Wegler et al.) | CC BY 4.0 | The forests' trees by genus: pine, spruce, Douglas fir, fir, larch, beech, oak, birch, alder (2016 where 2022 shows canopy loss): conifer or broadleaved crown, evergreen or bare in winter, the larch's and the broadleaves' seasons |
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
- *Tree Species Germany 2022/2016 – DLR Earth Observation Center (Wegler et al.)*, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
  (`data/raw/treespecies_*.tif` are cut-outs of it, unchanged)

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
the triangle counts run the viewer's mesher). The first run downloads about 4.3 GB of Bavarian rasters (40 sheets of 1 km), 0.5 GB of LoD2 models, 3.5 GB of LiDAR point clouds, 41 MB of ALKIS land use and the 0.37 GB single-tree GeoPackage (cut and deleted), the Geofabrik extract and 0.7 GB of DWD tables into `data/raw` (git-ignored, reused afterwards).
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
region at the map's edge: 20 s). After an edit of `voxelize.py` (or a module the regions load) every region is stale;
to look at one place first: `JUST=ROW_COL sh scripts/build_data.sh` (`voxelize.py --just ROW_COL[,ROW_COL..]` or
`--just x=COL,y=ROW`: those regions alone, the others left as they are, stale ones included, and the steps after them
run on that mix: ~3 min on the real map instead of ~9). It writes no `data/cache/regions.stamp`, so the next plain
`sh scripts/build_data.sh` builds the regions left stale and runs the steps after them again: run it before
committing data.

**The map's config: `scripts/map.json`.** The extent (a window of the project grid: its corner on 1024 m blocks, its
size), the volume's floor, the rivers' level (one, or per stretch: boxes in EPSG:25832, each with its own level;
`uv run python scripts/river_levels.py` measures them along the rivers' OSM lines from the terrain model; the first
box that holds a cell is its stretch: the Danube above the Kachlet dam at 299.75 m, its boxes stepping along the weir
and on to the lock's upper gates, the Danube below it, the Ilz above the Hals weir, the loop below it (its boxes stepping along the weir, OSM way 440171244) and the river past Hals; elsewhere 290.921 m;
stretches 2 m or more apart are pools apart: voxelize.py cuts a water body where their water meets (a box edge along a bank cuts nothing), so no level is a median
across a weir), the anchor, and the default cover of regions (`size`; `jobs`: how many at once, `auto` the cores less 4, within `mem_gb` or `REGION_MEM_GB`, else 75 % of the memory available: `scripts/regions.py` plan). `MAP_CONFIG=path` picks another file. The project grid
(column = easting − 827371, row = 5390500 − northing) never moves: hashes, noise and curated places key on it, so a
larger map keeps today's cells as they are; the outputs (tiles, the viewer's coordinates, `data/*.npz`) are in map
cells, the project grid's less the map's corner (`meta.json` `origin`). The viewer's shaders hash and pattern by the
project grid's coordinates too (`voxelMaterial.ts` `uOrg`: a voxel's tone, window rhythms, the leaves' turn, the
ground's stones; the lamps' colours), and `?cam=` is in them. The steps:

| Step | Writes |
|---|---|
| `fetch_osm.sh` | `data/raw/osm.json`: OSM cut to the AOI + 100 m, via `uv run --with osmium` (`OVERPASS=1` asks the public Overpass servers instead of Geofabrik). Skipped when `osm.json` exists, unless `OSM_REFRESH=1` |
| `fetch_bayern.sh` | `data/raw/{dsm,dtm,orto}_*.tif`: the 1 km sheets covering the AOI; `data/raw/lod2/*.gml`: the 2 km LoD2 tiles; `data/raw/tn_09262.zip`, `tn_09275.zip`: ALKIS Tatsächliche Nutzung of the Stadt Passau (3 MB) and the Landkreis Passau (38 MB; the map's west and north edges reach into it), read by `alkis_tn.py`; `data/raw/laser/*.laz`: the LiDAR point clouds (40 sheets, 3.5 GB); `data/raw/baeume_aoi.csv`: the Einzelbäume register cut to the AOI (0.4 MB; the 370 MB GeoPackage is read once by `clip_baeume.py`, with sqlite3 under `python -I`, and deleted); `data/raw/treespecies_2022.tif`, `treespecies_2016.tif`: DLR Tree Species Germany cut to the map's window (EPSG:3035 as published, ~60 kB each; `clip_species.py` under `python -I` reads only the window's tiles of the 530 MB cloud-optimised GeoTIFFs over HTTP ranges, `scripts/species_map.py` puts them on the grid for `voxelize.py`; without them, or with `NO_SPECIES_MAP=1`, the conifers come from OSM and the laser alone). Files already there are not fetched again |
| `laser.py` | `data/laser.npz`: per 1 m cell vegetation statistics from the point clouds (highest return, lowest tenth, pulses caught in the canopy, single-return pulses, ground returns); optional for `voxelize.py` (`NO_LASER=1` ignores it) |
| `prep.py` | `data/prep.npz`: the rasters mosaicked on the grid (surface 0.5 m, terrain 1 m, each 1 m cell's colour: the median of its 5 x 5 orthophoto pixels); `data/orto.npy`: the orthophoto at 0.2 m, for `look.py` |
| `lod2.py` | `data/lod2.npz`: LoD2 roof planes, roof types and footprints on the grid |
| `voxelize.py` | `web/public/data/tiles/`, `meta.json`, `traffic.json` (its polylines packed: `scripts/trafficpack.py`); `data/trees.json` (the tree register, `scripts/trees.py`: OSM and Einzelbäume), `data/qa_roadmask.bin.gz` (both not served: the viewer reads neither), `data/ground.npz`, `data/footprints.npz`, `data/crowns.npz`; region by region, only the regions that changed (`data/cache/regions/`). Stops without `data/lod2.npz` (`NO_LOD2=1` builds from the surface model and OSM alone) |
| `places.py` | `places.json`: the search index (streets, squares, buildings, stops) |
| `flood.py` | `data/flood.bin` (which cells the rivers reach at each level, the river bed), `flood.json` (the surveyed surface, the river's points) |
| `boats.py` | `boats.json`: cruise-ship berths on the Danube quay, the excursion boats' loop |
| `terrain.py` | `terrain/near`, `terrain/far{k}`: the bare land in chunks, shown while the tiles load and beyond the view distance; `data/terrain.bin` (the whole, for the tools) |
| `zones.py` | `data/zones.bin` (the building of each 1 m column), `zones.json`: each building's box, four numbers each in one flat list (a building shows once all its tiles are in), the building under each label, each building's stable key (`w<osm id>`, `r<osm id>`, `lod2:<gml:id>`: `scripts/lod2_ids.py`; building ids are build-local, docs/adr/0002-addressing.md) (needs `data/footprints.npz`) |
| `objects.py` | `objects/<k>.json`: every building's and street's box by OSM id, in 64 files by id, for the viewer's `?focus=` (needs `data/ground.npz`) |
| `windows.py` | `windows.bin`: what each building is (residential, office, church …), per building, for its windows at night (needs `data/footprints.npz`) |
| `climate.py` | `climate.json`: the typical weather of each day (Open-Meteo, cached in `data/raw/climate`) |
| `phenology.py` | `phenology.json`, `data/foliage.bin` (DWD and iNaturalist, cached in `data/raw/dwd`; needs `data/trees.json`) |
| `tile_fields.py` | into every node file of `tiles/` (`scripts/tilefile.py`: a header of tagged sections): per cell the building, the rivers' level and bed, foliage and the light of lit windows on the street, at the node's own cell size, from the `data/` maps above; at 1 m the `caps` of sloped paved ground and bridge decks, at every level the `roof` caps of pitched roofs (`scripts/caps.py`, from `data/surface.npz`: docs/adr/0005-surface-caps.md). Nothing of the map's size is loaded by the viewer whole: each node brings its part. Run again after `voxelize.py` or `tiles_lod.py`. Over 1024 m windows in 8 processes (`-j N`; `-j 1` without `--windows`/`--window-size`: the whole map in one window, the same bytes) |
| `world_id.py` | `meta.json` `world`: the build id (a hash over the contents of `tiles/1` and `1f`), the palette's length and hash, origin, base, the project grid (docs/adr/0001-world-layers.md); every build, written only when it changed. `scripts/palette_check.py [REV]` checks the palette registry is append-only against a git revision |
| `web/tools/tris.mjs` | `meta.json` `tiles.tris`: every tile's triangles per level as the viewer meshes it (its own mesher, run in Node), for the render budget; the viewer needs it (needs the tiles' buildings, `tile_fields.py`). In 8 processes (`--jobs K`), each node meshed again only when its files or the mesher's code changed (`data/cache/tris.json`; `--no-cache`) |
| `web/tools/lamps.mjs` | `streetlamps.json`: the street lamps placed along the streets in town (`web/src/streetlamps.ts`; needs `data/zones.bin`, `data/foliage.bin`, `data/terrain.bin`, `traffic.json`) |

**Windows.** The steps after the volume (`tiles.py`'s export in `voxelize.py`, `tiles_lod.py`, `tile_fields.py`,
`zones.py`, `terrain.py`) work window by window (`scripts/window.py`): a window's core is a rectangle of the grid on
1024 m boundaries (a node of every tile level, a terrain chunk), and the step reads only the region of the core and a
halo around it (its reach: the tiles 16 m, `tile_fields.py` 32 m, `terrain.py` 8 m, `zones.py` 0), the `data/` files
row band by row band. `--windows NXxNY` or `--window-size METRES` choose the cover (the whole map in one window by
default); every cover writes the same bytes (`uv run python scripts/check.py windows` checks it, see "Checks").

**Regions.** `voxelize.py` builds the volume region by region (`scripts/region.py`, `scripts/regions.py`): a region
is a window's core and a halo of 384 m round it, built in a process of its own, which reads its own cut of OSM (the
elements within 64 m of it), writes its core's tiles and leaves its core's rasters, volume and lists in
`data/cache/regions/<row>_<col>/`. `--regions NXxNY`, `--region-size METRES` or `--whole` choose the cover
(`scripts/map.json`'s by default: 1024 m, 4 at once; `-j N`); every cover writes the same bytes (`uv run python
scripts/check.py covers` checks it, with the steps after it, and that an incremental rebuild changes nothing). A region
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

**Checks.** What the build notes on the way is logged to `data/debug/report.json` (a few of its checks stop the
build: a carriageway painted as pavement). The checks of the pipeline itself run on a fixture map, not on the map
of `scripts/map.json`, so that they cost the same however large the map grows: `scripts/fixtures/altstadt.json`,
2048 × 1152 m round the Altstadt (a `MAP_CONFIG` like `map.json`, built with the normal pipeline from the same
`data/raw`, in workspaces under `data/check/<fixture>/`; the inputs `prep`, `lod2`, `laser.npz` built for it once
per code and config). `uv run python scripts/check.py COMMAND` (each prints its time and peak RAM, exits 1 on a
failure; `-j 2` regions at once by default):

| Command | Checks | Time (-j 2) |
|---|---|---|
| `verify` | nothing left floating (`data/debug/floating_left.json`, `floating.json` empty), every carriageway in its own colour, LoD2's roofs and the laser's canopy heights taken for most cells, OSM's outlines within 3 m of LoD2's, the cars' lanes and the footpaths of `traffic.json` on the volume's surface (sunk / hovering shares under a threshold) | 4 s on a built fixture |
| `golden --record DIR` / `--compare DIR` | every output of a fresh fixture build (`web/public/data`, the arrays of `data/*.npz` with the inputs, `data/*.bin`) hashed, or compared with the record: a refactor that must not change a byte | ~5 min |
| `covers [COVER ...]` | `voxelize.py` over the fixture as one region and over each cover (default `2x2`), then the steps after it: the same bytes; an incremental rerun builds nothing, a region built again alone (`--only`) changes nothing | ~12-16 min, 4.2 GB |
| `windows [STEP ...]` | the windowed steps (`zones`, `terrain`, `tile_fields`, `tiles_lod`) over the whole fixture and over 2 × 2 windows (both seams and a corner; `--covers 2x1,1x2` others): the same bytes | ~9 min (`tiles_lod.py`) |
| `extent` | the fixture against `altstadt_wide.json` (1024 m more to the west): every 128 m block of the volume and every tile node that sees the same map within `region.HALO` holds the same voxels, colour by colour (what growing the map relies on) | ~6.5 min the first time, then seconds |
| `all` | `verify`, `covers`, `windows`, `extent` | ~30 min |

Not covered: the node steps (`tris.mjs`, `lamps.mjs`) and `climate.py`. `FINALDUMP=1` still makes `voxelize.py`
save the whole volume (`data/cache/final_vol.npy`, for `traffic.py` run alone).

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
  are conifers: cones in needle green, evergreen in the viewer (but the larches, light green in summer, golden in
  autumn, bare in winter). Inside every broadleaf crown stands its bare wood (a
  material of its own, wood): the trunk on up to a fork, a leader, 3-5 limbs and branches out towards the rim a metre
  or two under the leaves, one voxel thick, drawn per tree from a generator seeded by its trunk's project grid cell;
  inside a larch's cone a straight leader and whorls of near-level branches every 1.2-1.7 m.
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
- **Water** (`scripts/overrides/water/<way id>.json`, a `natural=water` area): a `level` of its own (m a.s.l.; the
  polygon then leaves the river bodies whose median level the rest of the water takes), `walls` (the face colour of
  its banks, default concrete; its outline counts as a mapped wall) and `gates` (`waterway=lock_gate` lines drawn from
  the lower water to a `top`, a walkway on top, concrete under an optional `sill`; the river water by a gate's outer
  side takes its stretch's level, not the DGM's interpolated median over the approach). The Kachlet lock's two chambers
  (one full, one empty, as on the survey day) are the example; their gate ways' geometry is in the file's `osm` basis.
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
(`web/src/fields.ts`), so no texture or array grows with the map. A 1 m node with sloped streets or bridge decks also
brings their caps, the corner heights of those columns' tops, which the mesher, the walkers, the car and the drone all
take as the one surface (`web/src/core/surface.ts`, docs/adr/0005-surface-caps.md); a node of any level with pitched
roofs brings their caps likewise (section `roof`), drawn as the roofs' slopes only (`web/src/roofs.ts`; the roofs
collide as voxels); everything else is its voxels. Tiles are meshed in workers; the traffic simulation (`web/src/sim/`) runs within ~900 m of the camera.

```sh
cd web
pnpm check                                   # tsc
pnpm build                                   # static site in web/dist
node tools/shoot.mjs --shots city=view=city --out /tmp/shots   # headless screenshot (see "Agent tools")
```

`web/tools/` holds the build's Node steps (`tris.mjs`, `lamps.mjs`) and the agent checks below (`shoot.mjs`,
`collision.mjs`, `bld-ids.mjs`, `rapier-car.mjs`, `rapier-car-bench.mjs`).

No analytics: the page loads nothing beyond its own files and the Google font.

## Agent tools (checking a change)

For agents (and people) changing the code. All run from `web/` with no GPU and no extra dependency; in a git
worktree first `ln -s <main checkout>/web/node_modules web/node_modules` (don't install).

**FPV collision: `node tools/collision.mjs`** (~1 s). The drone's `VoxelCollision` (`src/nav/voxel-collision.ts`)
over a small synthetic world (`src/nav/collision-checks.ts`: a ground height per column, boxes for walls and decks,
written as real node files and served through a stubbed fetch): a sweep before the tiles are in waits, the drone's
cube falling onto the road and onto a deck, flying into a wall and out of the map, the surface it settles on. Exit
code 1 on a failure; check any change to `voxel-collision.ts` or the tile format with it.

**Boat: `node tools/boat.mjs`** (~2 s). The player's boat (`src/nav/boat-motion.ts`) on a synthetic channel
(`src/nav/boat-checks.ts`, served as `collision.mjs`'s world): speed, turning, drifting, the bank, a pier and a low
footbridge bounced off, under a bridge, put in and unstuck; then on the real data (skipped without it): put in near
the Altstadt, a lap, under the Schanzlbrücke, into the bank. Exit code 1 on a failure.

**Plane: `node tools/plane.mjs`** (~6 s). The floatplane's flight (`src/nav/plane-flight.ts`) on a synthetic world of
boxes (`src/nav/plane-checks.ts`): level flight, the throttle's range, stall and recovery, climbing costs speed, the
turn, the map's wall, the ceiling, a water landing with taxi and takeoff, crashes on land and on water and the
respawn, a skim, a tile not loaded, 10 min of random input; then on the real data (`src/nav/plane-real.ts`, skipped
without it): the Danube flown from the west edge to the Altstadt 60 m over its water, and landed on, taxied and taken
off from. Then the jet (`JET`, `src/nav/jet-checks.ts`): level top speed, stall, roll rate, a loop, inverted flight,
a hard turn, smooth pitch (the floatplane's criteria), the map's wall, crash and respawn, a gentle touch of water (a
splash), 10 min of random input; on the real data a low pass along the Danube and over the Altstadt at ~410 km/h with
every collision file 1 s late (no wait for a tile once under way). `--type floatplane|jet` runs one; `--set KEY=VALUE`
changes a number of the types run. Exit code 1 on a failure.

**Building ids: `node tools/bld-ids.mjs`** (~1 s). The mesher (`src/mesher.worker.ts` meshTile) on a synthetic
slab cut into buildings k, k + 16384 and 65535: every quad keeps its id and ground level exact, faces never merge
across ids, one id still merges into one top. Ids are 16-bit end to end; the map's stay below 60000 (`scripts/zones.py` fails there), 60000..65535 are reserved for players' builds. Exit
code 1 on a failure; check any change to the mesher's greedy merge with it.

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
(`car.ts` RIDE). `--real X,Z,HEADING,KMH,SECS` drives
straight in the real city, `--road I[,KMH[,REV]]` follows road I of `traffic.json`, `--roads [KMH]` runs the steepest
ten roads both ways and prints the means (the benchmark for the car's feel on real ramps). The `drive_*` scenarios
(`src/physics/rapier/drive-scenarios.ts`) run the drive mode's glue (`src/nav/drive-session.ts`) in Rapier's drive
world with a stand-in street life: a traffic car knocked out of the traffic (`drive_knock`), a person knocked down
(`drive_person`), into the river and back on the bank ~12 m before its edge (`drive_river_respawn`), parked in the
river (`drive_park_in_river`), a crash landing that holds the input (`drive_crash_landing`). `node
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

The flight uses independent 1 m collision data for terrain, structures and trees across the whole 9,344 × 3,456 m model.
A swept drone volume catches thin voxels even at speed. Hard impacts deflect and spin the drone briefly while it
stays armed. The drone can settle on the ground and take off again with throttle. The flight waits if a collision tile
is still loading. Moving traffic, seasonal leaf visibility and changes to the river level are visual effects in this spike.
Roof and wall collisions follow the source voxels, including where a rendered roof or facade is smoothed.

## Driving

Click **Take the wheel** in the top-left toolbar to drive the car you're following or pick a nearby car.
W/S (or the up/down arrows) accelerate, brake and reverse. A/D or the left/right arrows steer. Space applies the handbrake and
loosens lateral grip. A standard gamepad uses the left stick, RT/LT, and the bottom face button. **Park car** leaves
the same car where you stop, T puts it back on the road, and **Esc** takes you back to the map. **Vehicle: …** beside
**Take the wheel** (or V) picks what the car taken becomes: as it is (any), car, coupé, van, pickup, bus or motorbike
(`web/src/sim/vehicles.ts`, docs/plans/vehicles.md).

The car is a rigid body on four ray-cast wheels with suspension (Rapier, `web/src/physics/rapier/`: `drive-world.ts`,
`car.ts`), over colliders built from the same 1 m voxel data near the car (`terrain.ts`), including bridge decks;
sloped streets and decks are the caps the viewer draws (one surface for everybody), steps up to ~1 m that are not
capped (terraces, platforms, low walls) get an invisible ramp. Traffic cars and buses near it are solid; hit one at more than ~15 km/h (between the
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

## Boat

Click **Boat** in the toolbar (from the map view) to put a speedboat in on the river nearest the view, facing
downstream. W/S (or the arrows) throttle and reverse, A/D steer, Space drifts, T puts it back on open water, Esc
exits; touch and gamepad as the car. Up to ~67 km/h; shores, quay walls and bridge piers stop it, it passes under
the bridges. The motion is `web/src/nav/boat-motion.ts` (no DOM, fixed step), checked headless by `tools/boat.mjs`;
the mode is `nav/boat.ts`; design and controls in `docs/plans/boat.md`.

## Plane

Click **Plane** in the toolbar (from the map view) to fly a small floatplane from where the camera is, or **Plane on
the river** to start afloat on the river nearest the view. A/D turn (it banks by itself and levels when let go), W/S
nose down/up (flight convention; "Invert pitch" in the panel swaps), Shift or R throttle up, Space or F down (held,
stepless 0–100 %), T back to the last safe point, Esc exits; the wheel moves the camera. Touch: the left thumb is the
stick, the throttle a slider on the right, pinch zooms. Gamepad (standard): left stick, RT/LT or the right stick's Y
for the throttle. Speed is energy: up to ~245 km/h level at full throttle, climbing costs speed, below ~86 km/h it
stalls and sinks. Touch the water slowly (≤ 130 km/h, sinking ≤ 3 m/s, wings near level) to float and taxi; past
~97 km/h with the stick pulled it takes off. Land, roofs and fast or steep water are a crash: back at a safe pose ~3 s
earlier. The flight is `web/src/nav/plane-flight.ts` (no DOM, fixed step, all numbers in `PLANE`), checked by
`tools/plane.mjs`; the mode is `nav/plane.ts`; design in `docs/plans/plane.md`.

**Jet** in the same panel: a small aerobatic trainer, started in the air only (it needs no runway and cannot land).
The same keys, but A/D roll (200°/s; let go and the bank holds, within ~35° of level the wings level themselves) and
W/S pitch about the wings (hold S for a loop); let go and it holds its path, so a turn is bank and pull. ~450 km/h
level at full throttle (the last 15 % of the lever drawn as the afterburner), ~630 in a dive, up to 7 g; hard pulls
bleed speed, below ~166 km/h it stalls. Any water is a splash. Its numbers are `JET` in `plane-flight.ts` (the same
core as the floatplane's, `AEROBATIC` flight law), the model `nav/jet-model.ts`.

## Third-person walking

Click **Walk** in the toolbar to start on foot at the current view or beside the vehicle you're following. Use W/A/S/D
or the arrow keys to move relative to the camera, Shift to sprint and Space to jump. Move the mouse to look around
and scroll to zoom. On touch screens, drag to look, pinch to zoom and tap the ground to walk there.
**Esc** releases the mouse and returns to the map. The chase camera pulls in near walls, and the character uses the viewer's voxel walking
collision for kerbs, stairs, walls and bridge decks.

## Known limits

- **River level.** The slider moves the water in metres relative to the level on the survey day. It is not calibrated
  to the Passau gauges and shows no historic flood levels; below the surveyed level the river bed is schematic. Above
  the Kachlet dam and the Ilz's weir at Hals the rivers stand at their own levels (`scripts/map.json`
  `rivers.stretches`); the slider raises every stretch by the same metres over its own surveyed level (a real flood
  drains the impounded reach as the weir opens: not modelled), and a cell floods from the river of its own stretch.
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
