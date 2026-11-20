#!/bin/sh
# Full data pipeline for Passau: download (cached in data/raw) -> mosaic -> voxelize -> everything the viewer loads
# from web/public/data. Needs uv, curl and node (web/node_modules installed); ~8 GB of RAM for voxelize.py over the
# whole map as one region (less per region: scripts/map.json `regions`). Every step after the fetches reads only
# data/raw and the steps before it, so a rerun on the same data/raw rebuilds the same files (see README.md).
#
# Incremental: each step runs only when what it reads or writes changed since it last ran (scripts/stamp.py, records
# in data/cache/stamps/; FORCE=1 runs them all, FORCE=places,flood some), and voxelize.py rebuilds only the regions
# whose inputs or code changed (scripts/regions.py; data/cache/regions/). The extent, the volume's floor and the
# rivers' levels are set in scripts/map.json.
set -e
cd "$(dirname "$0")/.."
export PYTHONPATH=scripts
# OSM: data/raw/osm.json is kept once it exists (a new Geofabrik extract changes the whole model);
# OSM_REFRESH=1 fetches the current extract (Geofabrik Niederbayern, cut to the AOI)
if [ ! -s data/raw/osm.json ] || [ -n "$OSM_REFRESH" ]; then sh scripts/fetch_osm.sh; fi
sh scripts/fetch_bayern.sh               # data/raw/{dsm,dtm,orto}_*.tif (DOM20, DGM1, DOP20), data/raw/lod2/*.gml,
                                         # data/raw/laser/*.laz, data/raw/baeume_aoi.csv; skips files it has
S="uv run python scripts/stamp.py"
A="scripts/aoi.py scripts/map.json"      # (what every step reads of the map)
$S prep -i $A data/raw/dsm_*.tif data/raw/dtm_*.tif data/raw/orto_*.tif -o data/prep.npz \
  -- python scripts/prep.py              # data/prep.npz
$S lod2 -i $A data/raw/lod2 -o data/lod2.npz -- python scripts/lod2.py   # data/lod2.npz (LoD2 roof planes and footprints on the grid)
$S laser -i $A data/raw/laser data/prep.npz -o data/laser.npz -- python scripts/laser.py  # data/laser.npz (LiDAR vegetation statistics per cell)
uv run python scripts/voxelize.py        # (region by region: --regions NXxNY, -j N; only the regions that changed, --status
                                         # tells which; --only ROW_COL builds one again) tiles/, meta.json, trees.json,
                                         # traffic.json, qa_roadmask.bin.gz; data/ground.npz, data/footprints.npz,
                                         # data/crowns.npz (needs data/lod2.npz, or NO_LOD2=1)
                                         # (scripts/tiles_lod.py: only tiles/2, 4 and 8 again, from tiles/1 and 1f)
P=web/public/data
M="$P/meta.json#-tiles.tris,tiles.bytes" # (meta.json as voxelize.py wrote it: tile_fields.py and tris.mjs add these)
$S places -i $A scripts/osm.py data/raw/osm.json -o $P/places.json -- python scripts/places.py   # places.json (search index)
$S flood -i $A data/ground.npz data/prep.npz $M -o data/flood.bin $P/flood.json \
  -- python scripts/flood.py             # data/flood.bin, flood.json (river level slider; needs ground.npz, meta.json)
$S boats -i $A scripts/osm.py data/ground.npz data/raw/osm.json -o $P/boats.json \
  -- python scripts/boats.py             # boats.json (cruise-ship berths on the Danube quay, the excursion boats' loop)
$S terrain -i $A scripts/window.py data/ground.npz $M -o $P/terrain data/terrain.bin \
  -- python scripts/terrain.py           # terrain/ (the bare land in chunks, while the tiles load and far off); data/terrain.bin
$S zones -i $A scripts/window.py scripts/osm.py data/footprints.npz data/raw/osm.json $M -o data/zones.bin $P/zones.json \
  -- python scripts/zones.py             # data/zones.bin, zones.json (the building of each column; needs footprints.npz)
$S objects -i $A data/raw/osm.json data/ground.npz -o $P/objects \
  -- python scripts/objects.py           # objects/ (each building's and street's box, for the viewer's ?focus=; needs ground.npz)
$S windows -i $A scripts/osm.py data/footprints.npz data/raw/osm.json -o $P/windows.bin \
  -- python scripts/windows.py           # windows.bin (what each building is, for its lit windows; needs footprints.npz)
uv run python scripts/climate.py         # climate.json (Open-Meteo, cached in data/raw/climate)
$S phenology -i $A scripts/foliage_photos.json data/raw/dwd $P/trees.json data/crowns.npz -o $P/phenology.json data/foliage.bin \
  -- python scripts/phenology.py         # phenology.json, data/foliage.bin (DWD + iNaturalist, cached in data/raw/dwd; needs trees.json)
$S tile_fields -i $A scripts/window.py scripts/tilefile.py data/zones.bin data/flood.bin data/foliage.bin $P/windows.bin $M \
  -o $P/tiles -- python scripts/tile_fields.py   # tiles/: each node's buildings, rivers, foliage, window light (from the data/ maps above)
$S tris -i web/tools/tris.mjs web/src $P/tiles $M -o $P/meta.json \
  -- sh -c "cd web && node tools/tris.mjs"       # meta.json tiles.tris, required by the viewer (the viewer's mesher over
                                                 # every tile; needs web/node_modules and the tiles' buildings)
$S lamps -i web/tools/lamps.mjs web/src data/zones.bin data/foliage.bin data/terrain.bin $P/traffic.json $M -o $P/streetlamps.json \
  -- sh -c "cd web && node tools/lamps.mjs"      # streetlamps.json (the lamps along the streets; needs data/zones.bin, data/foliage.bin)
# web/public/data/windows.json (how many windows are lit, by hour and building type) is not built here: see README.md
