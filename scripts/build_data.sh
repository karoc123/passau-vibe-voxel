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
                                         # data/raw/laser/*.laz, data/raw/baeume_aoi.csv, data/raw/treespecies_{2022,2016}.tif
                                         # (DLR Tree Species Germany, the map's window); skips files it has
S="uv run python scripts/stamp.py"
A="scripts/aoi.py scripts/map.json#-regions"  # (what every step reads of the map: not how voxelize.py schedules the regions)
# Steps that read nothing of each other run side by side (bg): each into its own log (data/cache/logs/NAME.log), shown
# in a fixed order once all of a group are done (join); the build stops if any of them failed
L=data/cache/logs
mkdir -p $L
JOBS=""
bg() { _n=$1; shift; "$@" > $L/$_n.log 2>&1 & eval "pid_$_n=$!"; JOBS="$JOBS $_n"; }
join() {
  _fail=""
  for _n in $JOBS; do
    eval "_p=\$pid_$_n"
    if wait "$_p"; then cat $L/$_n.log; else cat $L/$_n.log; echo "[$_n] FAILED (log: $L/$_n.log)"; _fail="$_fail $_n"; fi
  done
  JOBS=""
  if [ -n "$_fail" ]; then echo "failed:$_fail"; exit 1; fi
}
bg lod2 $S lod2 -i $A data/raw/lod2 -o data/lod2.npz -- python scripts/lod2.py   # data/lod2.npz (LoD2 roof planes and footprints on the grid)
$S prep -i $A data/raw/dsm_*.tif data/raw/dtm_*.tif data/raw/orto_*.tif -o data/prep.npz data/orto.npy \
  -- python scripts/prep.py              # data/prep.npz, data/orto.npy (the ortho at 0.2 m, for scripts/look.py)
$S laser -i $A data/raw/laser data/prep.npz -o data/laser.npz -- python scripts/laser.py  # data/laser.npz (LiDAR vegetation statistics per cell)
join
uv run python scripts/voxelize.py ${JUST:+--just $JUST}  # (reads data/raw/treespecies_*.tif too: region_inputs.py RAW_FILES)
                                         # (region by region: --regions NXxNY, -j N; only the regions that changed, --status
                                         # tells which; --only ROW_COL builds one again; JUST=ROW_COL[,ROW_COL] builds those
                                         # alone, the rest left stale: to look, not to commit) tiles/, meta.json, data/trees.json,
                                         # traffic.json, data/qa_roadmask.bin.gz; data/ground.npz, data/footprints.npz,
                                         # data/crowns.npz (needs data/lod2.npz, or NO_LOD2=1)
                                         # (scripts/tiles_lod.py: only tiles/2, 4 and 8 again, from tiles/1 and 1f)
P=web/public/data
M="$P/meta.json#-tiles.tris,tiles.bytes,world" # (meta.json as voxelize.py wrote it: tile_fields.py, tris.mjs and
                                               # world_id.py add these)
bg places $S places -i $A scripts/osm.py data/raw/osm.json -o $P/places.json -- python scripts/places.py   # places.json (search index)
bg flood $S flood -i $A data/ground.npz -o data/river.bin $P/flood.json \
  -- python scripts/flood.py             # data/river.bin, flood.json (where the rivers are; needs ground.npz)
bg boats $S boats -i $A scripts/osm.py data/ground.npz data/raw/osm.json -o $P/boats.json \
  -- python scripts/boats.py             # boats.json (cruise-ship berths on the Danube quay, the excursion boats' loop)
bg terrain $S terrain -i $A scripts/window.py data/ground.npz $M -o $P/terrain data/terrain.bin \
  -- python scripts/terrain.py           # terrain/ (the bare land in chunks, while the tiles load and far off); data/terrain.bin
bg zones $S zones -i $A scripts/window.py scripts/osm.py scripts/lod2_ids.py data/footprints.npz data/raw/osm.json data/raw/lod2 $M \
  -o data/zones.bin $P/zones.json -- python scripts/zones.py  # data/zones.bin, zones.json (the building of each column
                                         # and each building's stable key; needs footprints.npz)
bg objects $S objects -i $A data/raw/osm.json data/ground.npz -o $P/objects \
  -- python scripts/objects.py           # objects/ (each building's and street's box, for the viewer's ?focus=; needs ground.npz)
bg windows $S windows -i $A scripts/osm.py data/footprints.npz data/raw/osm.json -o $P/windows.bin \
  -- python scripts/windows.py           # windows.bin (what each building is, for its lit windows; needs footprints.npz)
bg climate uv run python scripts/climate.py         # climate.json (Open-Meteo, cached in data/raw/climate)
bg phenology $S phenology -i $A scripts/foliage_photos.json scripts/tree_genera.json scripts/alkis_tn.py data/raw/dwd data/raw/tn_09262.zip data/raw/tn_09275.zip \
  data/raw/treespecies_2022.tif data/raw/treespecies_2016.tif data/trees.json data/crowns.npz data/ground.npz -o $P/phenology.json data/foliage.bin \
  -- python scripts/phenology.py         # phenology.json, data/foliage.bin (DWD + iNaturalist, cached in data/raw/dwd; needs trees.json)
join                                     # (the steps above read only what voxelize.py wrote, not each other)
$S tile_fields -i $A scripts/window.py scripts/tilefile.py scripts/caps.py scripts/constants.py data/zones.bin data/river.bin data/foliage.bin \
  data/surface.npz data/prep.npz data/ground.npz data/qa_roadmask.bin.gz $P/windows.bin $M \
  -o $P/tiles -- python scripts/tile_fields.py   # tiles/: each node's buildings, rivers, foliage, window light, sloped caps
                                                 # (from the data/ maps above)
uv run python scripts/world_id.py       # meta.json world (build id over tiles/1 and 1f, palette, grid): every
                                         # build, cheap; written only when it changed. Before tris, which records
                                         # meta.json whole as its output
$S tris -i web/tools/tris.mjs web/src $P/tiles $M -o $P/meta.json \
  -- sh -c "cd web && node tools/tris.mjs"       # meta.json tiles.tris, required by the viewer (the viewer's mesher over
                                                 # every tile; needs web/node_modules and the tiles' buildings)
$S lamps -i web/tools/lamps.mjs web/src data/zones.bin data/foliage.bin data/terrain.bin $P/traffic.json $M -o $P/streetlamps.json \
  -- sh -c "cd web && node tools/lamps.mjs"      # streetlamps.json (the lamps along the streets; needs data/zones.bin, data/foliage.bin)
# web/public/data/windows.json (how many windows are lit, by hour and building type) is not built here: see README.md
