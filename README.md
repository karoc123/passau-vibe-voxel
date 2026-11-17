# Passau in voxels

A 3200 × 1408 m diorama of Passau, the city of three rivers, at 1 m voxels, in the style of MagicaVoxel renders:
the Altstadt peninsula between Danube and Inn with the cathedral (Dom St. Stephan) at its centre, the Dreiflüsseeck
where Danube, Inn and Ilz meet, Veste Oberhaus and the Ilzstadt to the north, the Innstadt to the south, and west to
the Hauptbahnhof and St. Nikola. The grid is north-up and anchored on the cathedral (`scripts/aoi.py`).

The date, the hour, the weather and the rivers' level are sliders; cars, trains, pedestrians and bikes move on the
real OSM network.

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
| **DOM20**, digital surface model, 0.2 m ([Bayerische Vermessungsverwaltung](https://www.geodaten.bayern.de)) | CC BY 4.0 | Building heights and roof shapes, tree crowns, parked vehicles, bridge decks |
| **DGM1**, digital terrain model, 1 m (Bayerische Vermessungsverwaltung) | CC BY 4.0 | Ground relief; the rivers where OSM's outlines are cut by the map edge |
| **DOP20**, orthophoto, 0.2 m (Bayerische Vermessungsverwaltung) | CC BY 4.0 | Roof colours, foliage tones, grass OSM doesn't map, vehicle colours, the three rivers' own colours |
| **[OpenStreetMap](https://www.openstreetmap.org/copyright)**, [Geofabrik](https://download.geofabrik.de/europe/germany/bayern/niederbayern.html) daily extract for Niederbayern | ODbL, © OpenStreetMap contributors | Footprints and 3D parts, facade and roof colours, roads, paths, railways, bridges, trees, street lamps, names, the traffic network |
| **[Deutscher Wetterdienst](https://opendata.dwd.de/climate_environment/CDC/)**, phenological observations | [DL-DE BY 2.0](https://www.govdata.de/dl-de/by-2-0), source: Deutscher Wetterdienst | When each tree species leafs out, colours and drops its leaves (stations within 100 km of Passau below 500 m) |
| **[iNaturalist](https://www.inaturalist.org/)** "Leaves" annotations, weekly counts | see iNaturalist's terms | The same, for species the DWD does not record |
| **[Open-Meteo](https://open-meteo.com/)** historical archive (ERA5) for 48.574° N, 13.466° E | CC BY 4.0 | The typical weather of each day of the year |
| **[Wikimedia Commons](https://commons.wikimedia.org/)** photos (listed in `scripts/foliage_photos.json`) | per photo | Autumn and summer colour of each species' canopy |

Attribution to show wherever the model is published: *Bayerische Vermessungsverwaltung – www.geodaten.bayern.de
(CC BY 4.0)* and *© OpenStreetMap contributors (ODbL)*. The viewer's credits line carries both.

Inherited from the upstream project, measured on Warsaw and not yet on Passau (both are used as generic Central
European values):
- `web/public/data/windows.json`: how many windows are lit at night, by building type, hour and weekday. Upstream
  counted them on dated night photos of Warsaw. The file is kept as it is; nothing in this repository rebuilds it.
- The colour of lawns through the year (`LAWN_LAB` in `scripts/phenology.py`).

## Build the data

```sh
sh scripts/build_data.sh
```

Needs [uv](https://docs.astral.sh/uv/) and `curl`. The first run downloads about 0.9 GB of Bavarian rasters, the
Geofabrik extract and the DWD tables into `data/raw` (git-ignored, reused afterwards). `voxelize.py` takes about two
minutes and ~6 GB of RAM. The steps:

| Step | Writes |
|---|---|
| `fetch_osm.sh` | `data/raw/osm.json`: OSM cut to the AOI + 100 m (`OVERPASS=1` asks the public Overpass servers instead of Geofabrik) |
| `fetch_bayern.sh` | `data/raw/{dsm,dtm,orto}_*.tif`: the 1 km sheets covering the AOI |
| `prep.py` | `data/prep.npz`: the rasters mosaicked on the grid (surface 0.5 m, terrain 1 m, orthophoto 0.2 m) |
| `voxelize.py` | `web/public/data/tiles/`, `meta.json`, `trees.json`, `traffic.json`, `qa_roadmask.bin.gz`; `data/ground.npz` |
| `places.py` | `places.json`: the search index (streets, squares, buildings, stops) |
| `flood.py` | `flood.bin`, `flood.json`: which cells the rivers reach at each level |
| `terrain.py` | `terrain.bin`: the bare land shown while the tiles load |
| `zones.py` | `zones.bin`, `zones.json`: city blocks and buildings, for the render budget |
| `windows.py` | `windows.bin`: what each building is (residential, office, church …), for its windows at night |
| `climate.py` | `climate.json` |
| `phenology.py` | `phenology.json`, `foliage.bin` |

Checks that run at build time are logged to `data/debug/report.json`; `scripts/floating.py` and
`scripts/surface_check.py` are whole-map checks to run by hand (`FINALDUMP=1` makes `voxelize.py` save the volume
for them).

## How the data is fused (scripts/voxelize.py)

- **Heights** come from the surface model, per building part; OSM's `height` wins only for spires the model
  under-samples and for buildings that went up after the survey flight.
- **Rivers.** OSM's multipolygons of the Danube and the Ilz are cut by the map edge and do not close, so the rivers are
  taken from the terrain model: flat cells at the water's level. Each river keeps its own colour from the orthophoto
  (the Danube dark green, the Inn milky jade, the Ilz peat-dark), smoothed over ~50 m.
- **The historic core** (`landmarks.HISTORIC_CORE`: the Altstadt and the Innstadt) gets plastered houses in warm
  colours where OSM gives none, and pitched tiled roofs fitted to the surface model.
- **Vegetation.** A cell is a tree if the surface model stands over the terrain and the orthophoto is green (or an OSM
  tree is near), and it is not a building's wall edge. OSM trees without a crown in the model are drawn as young trees.
- **Set pieces** (`scripts/passau.py`): the cathedral's two tower cupolas and its crossing dome, rebuilt in copper
  with lanterns and crosses.
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
- Only the cathedral has hand-made detail; Veste Oberhaus, the Rathaus tower and the bridges are as the data gives them.
- Trees come from OSM only (no municipal tree register is merged), so most crowns have no species and follow the
  median calendar.
- Parked cars are frozen from the survey flight; moving traffic is simulated, not real.
