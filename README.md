# Passau in voxels

A 3200 × 1408 m diorama of Passau, the city of three rivers, at 1 m voxels, in the style of MagicaVoxel renders:
the Altstadt peninsula between Danube and Inn with the cathedral (Dom St. Stephan) at its centre, the Dreiflüsseeck
where Danube, Inn and Ilz meet, Veste Oberhaus and the Ilzstadt to the north, the Innstadt to the south, and west to
the Hauptbahnhof and St. Nikola. The grid is north-up and anchored on the cathedral (`scripts/aoi.py`).

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
`cam=x,y,z,tx,ty,tz`, `date=M-D`, `hour=`, `weather=clear|cloudy|rain|snow`, `tilt=0`, `ui=0`.

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

Needs [uv](https://docs.astral.sh/uv/) and `curl`. The first run downloads about 0.8 GB of Bavarian rasters, 0.26 GB
of LoD2 models, 0.7 GB of LiDAR point clouds and the 0.37 GB single-tree GeoPackage (cut and deleted), the Geofabrik extract and 0.7 GB of DWD tables into `data/raw` (git-ignored, reused afterwards).
From cached raw data the build takes about 4 minutes; `voxelize.py` peaks at ~7.5 GB of RAM. Given the same
`data/raw`, it reproduces the committed `web/public/data` byte for byte (checked on 2026-11-17; the gzip files are
written with `mtime=0`). The steps:

| Step | Writes |
|---|---|
| `fetch_osm.sh` | `data/raw/osm.json`: OSM cut to the AOI + 100 m, via `uv run --with osmium` (`OVERPASS=1` asks the public Overpass servers instead of Geofabrik). Skipped when `osm.json` exists, unless `OSM_REFRESH=1` |
| `fetch_bayern.sh` | `data/raw/{dsm,dtm,orto}_*.tif`: the 1 km sheets covering the AOI; `data/raw/lod2/*.gml`: the 2 km LoD2 tiles; `data/raw/tn_09262.zip`: ALKIS Tatsächliche Nutzung of the Stadt Passau (3 MB, read by `alkis_tn.py`); `data/raw/laser/*.laz`: the LiDAR point clouds (8 sheets, 0.7 GB); `data/raw/baeume_aoi.csv`: the Einzelbäume register cut to the AOI (0.4 MB; the 370 MB GeoPackage is read once by `clip_baeume.py`, with sqlite3 under `python -I`, and deleted). Files already there are not fetched again |
| `laser.py` | `data/laser.npz`: per 1 m cell vegetation statistics from the point clouds (highest return, lowest tenth, pulses caught in the canopy, single-return pulses, ground returns); optional for `voxelize.py` (`NO_LASER=1` ignores it) |
| `prep.py` | `data/prep.npz`: the rasters mosaicked on the grid (surface 0.5 m, terrain 1 m, orthophoto 0.2 m) |
| `lod2.py` | `data/lod2.npz`: LoD2 roof planes, roof types and footprints on the grid |
| `voxelize.py` | `web/public/data/tiles/`, `meta.json`, `trees.json` (the tree register, `scripts/trees.py`: OSM and Einzelbäume), `traffic.json`, `qa_roadmask.bin.gz`; `data/ground.npz`, `data/footprints.npz`. Stops without `data/lod2.npz` (`NO_LOD2=1` builds from the surface model and OSM alone) |
| `places.py` | `places.json`: the search index (streets, squares, buildings, stops) |
| `flood.py` | `flood.bin`, `flood.json`: which cells the rivers reach at each level |
| `boats.py` | `boats.json`: cruise-ship berths on the Danube quay, the excursion boats' loop |
| `terrain.py` | `terrain.bin`: the bare land shown while the tiles load |
| `zones.py` | `zones.bin`, `zones.json`: city blocks and buildings, for the render budget (needs `data/footprints.npz`) |
| `windows.py` | `windows.bin`: what each building is (residential, office, church …), for its windows at night (needs `data/footprints.npz`) |
| `climate.py` | `climate.json`: the typical weather of each day (Open-Meteo, cached in `data/raw/climate`) |
| `phenology.py` | `phenology.json`, `foliage.bin` (DWD and iNaturalist, cached in `data/raw/dwd`; needs `trees.json`) |

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
  are conifers: cones in needle green, evergreen in the viewer.
- **Set pieces** (`scripts/passau.py`): the Dom rebuilt (west towers with copper cupolas, front with gable and
  portal, nave and aisles with arched windows, east end and crossing drum from LoD2); Veste Oberhaus and Niederhaus
  under clean roofs with OSM's walls as battlements; the Poststeg footbridge over the station's tracks.
- **Labels and camera presets**: `scripts/landmarks.py` (`LABELS`, `EXTRA_LABELS`, `make_views`), plus named parks
  over 2.5 ha (`scripts/labels.py`).
- **Per-building curation** goes in `scripts/overrides.json`, keyed by OSM id (wall and roof colour and material,
  facade zones, a crown band, a label). It is empty so far. Prefer fixing `building:colour`, `height` and
  `building:part` in OSM itself.

## Viewer (web/)

three.js + Vite + TypeScript. The city is streamed in tiles (`web/public/data/tiles/{1,1f,8}/x_y.bin`): 128 × 128
cells of 1 m (buildings and ground; foliage in `1f`) or 8 m. `web/src/city.ts` draws as much of the city at 1 m as a
triangle budget allows, the blocks nearest the focus first; the 8 m level stands in as clay where the budget ends.
Tiles are meshed in workers; the traffic simulation (`web/src/sim/`) runs within ~900 m of the camera.

```sh
cd web
pnpm check                                   # tsc
pnpm build                                   # static site in web/dist
node tools/shot_linux.mjs out.png "view=city&date=7-15&hour=13&weather=clear" 1600 1000   # headless screenshot (Linux/WSL)
```

`web/tools/` holds the upstream project's measurement and QA scripts (Playwright); most launch Chrome with macOS
flags and several predate the current viewer, so expect to adapt them.

No analytics: the page loads nothing beyond its own files and the Google font.

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
