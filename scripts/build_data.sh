#!/bin/sh
# Full data pipeline for Passau: download (cached in data/raw) -> mosaic -> voxelize -> everything the viewer loads
# from web/public/data. Needs uv, curl and node (web/node_modules installed); ~8 GB of RAM for voxelize.py. Every step
# after the fetches reads only data/raw and the steps before it, so a rerun on the same data/raw rebuilds the same
# files (see README.md).
set -e
cd "$(dirname "$0")/.."
export PYTHONPATH=scripts
# OSM: data/raw/osm.json is kept once it exists (a new Geofabrik extract changes the whole model);
# OSM_REFRESH=1 fetches the current extract (Geofabrik Niederbayern, cut to the AOI)
if [ ! -s data/raw/osm.json ] || [ -n "$OSM_REFRESH" ]; then sh scripts/fetch_osm.sh; fi
sh scripts/fetch_bayern.sh               # data/raw/{dsm,dtm,orto}_*.tif (DOM20, DGM1, DOP20), data/raw/lod2/*.gml,
                                         # data/raw/laser/*.laz, data/raw/baeume_aoi.csv; skips files it has
uv run python scripts/prep.py            # data/prep.npz
uv run python scripts/lod2.py            # data/lod2.npz (LoD2 roof planes and footprints on the grid)
uv run python scripts/laser.py           # data/laser.npz (LiDAR vegetation statistics per cell, for the trees)
uv run python scripts/voxelize.py        # (region by region: --regions NXxNY, -j N) tiles/, meta.json, trees.json, traffic.json, qa_roadmask.bin.gz;
                                         # data/ground.npz, data/footprints.npz (needs data/lod2.npz, or NO_LOD2=1)
                                         # (scripts/tiles_lod.py: only tiles/2, 4 and 8 again, from tiles/1 and 1f)
uv run python scripts/places.py          # places.json (search index)
uv run python scripts/flood.py           # data/flood.bin, flood.json (river level slider; needs ground.npz, meta.json)
uv run python scripts/boats.py           # boats.json (cruise-ship berths on the Danube quay, the excursion boats' loop)
uv run python scripts/terrain.py         # terrain/ (the bare land in chunks, while the tiles load and far off); data/terrain.bin
uv run python scripts/zones.py           # data/zones.bin, zones.json (the building of each column; needs footprints.npz)
uv run python scripts/windows.py         # windows.bin (what each building is, for its lit windows; needs footprints.npz)
uv run python scripts/climate.py         # climate.json (Open-Meteo, cached in data/raw/climate)
uv run python scripts/phenology.py       # phenology.json, data/foliage.bin (DWD + iNaturalist, cached in data/raw/dwd; needs trees.json)
uv run python scripts/tile_fields.py     # tiles/: each node's buildings, rivers, foliage, window light (from the data/ maps above)
(cd web && node tools/tris.mjs)          # meta.json tiles.tris, required by the viewer (the viewer's mesher over
                                         # every tile; needs web/node_modules and the tiles' buildings)
(cd web && node tools/lamps.mjs)         # streetlamps.json (the lamps along the streets; needs data/zones.bin, data/foliage.bin)
# web/public/data/windows.json (how many windows are lit, by hour and building type) is not built here: see README.md
