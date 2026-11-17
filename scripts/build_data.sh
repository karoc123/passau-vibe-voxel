#!/bin/sh
# Full data pipeline for Passau: download (cached in data/raw) -> mosaic -> voxelize -> everything the viewer loads
# from web/public/data. Needs uv and curl; ~6 GB of RAM for voxelize.py.
set -e
cd "$(dirname "$0")/.."
export PYTHONPATH=scripts
sh scripts/fetch_osm.sh                  # data/raw/osm.json (Geofabrik Niederbayern, cut to the AOI)
sh scripts/fetch_bayern.sh               # data/raw/{dsm,dtm,orto}_*.tif (DOM20, DGM1, DOP20), data/raw/lod2/*.gml
uv run python scripts/prep.py            # data/prep.npz
uv run python scripts/lod2.py            # data/lod2.npz (LoD2 roof planes on the grid)
uv run python scripts/voxelize.py        # tiles/, meta.json, trees.json, traffic.json, qa_roadmask.bin.gz; data/ground.npz
uv run python scripts/places.py          # places.json (search index)
uv run python scripts/flood.py           # flood.bin, flood.json (river level slider)
uv run python scripts/boats.py           # boats.json (cruise-ship berths on the Danube quay, the excursion boats' loop)
uv run python scripts/terrain.py         # terrain.bin (the bare land shown while the tiles load)
uv run python scripts/zones.py           # zones.bin, zones.json (city blocks and buildings, for the render budget)
uv run python scripts/windows.py         # windows.bin (what each building is, for its lit windows at night)
uv run python scripts/climate.py         # climate.json (Open-Meteo, cached in data/raw/climate)
uv run python scripts/phenology.py       # phenology.json, foliage.bin (DWD + iNaturalist, cached in data/raw/dwd)
# web/public/data/windows.json (how many windows are lit, by hour and building type) is not built here: see README.md
