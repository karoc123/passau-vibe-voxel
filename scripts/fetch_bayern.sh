#!/bin/sh
# Bayerische Vermessungsverwaltung OpenData (CC BY 4.0, www.geodaten.bayern.de): DOM20 surface model (0.2 m),
# DGM1 terrain (1 m) and DOP20 orthophoto (0.2 m), 1 km tiles in EPSG:25832 covering the AOI (scripts/aoi.py);
# LoD2 building models (CityGML, roof planes for scripts/lod2.py), 2 km tiles named by their even SW corner in km;
# ALKIS Tatsächliche Nutzung (actual land use, shapefile) of the Stadt Passau (09262) and the Landkreis Passau (09275),
# for scripts/alkis_tn.py;
# Laserdaten (airborne LiDAR point clouds, LAZ, Feb 2021 leaf-off, ~11 points/m2), 1 km tiles, for scripts/laser.py;
# Einzelbäume 3D (single trees with height, from the 2024 flight) of the Landkreis/Stadt GeoPackage 124014, cut to the
# AOI once (scripts/clip_baeume.py) into baeume_aoi.csv; the 370 MB GeoPackage is deleted after the cut.
# Not the Vermessungsverwaltung's: Tree Species Germany 2022 and 2016 (DLR Earth Observation Center, Wegler et al.,
# CC BY 4.0), the dominant tree species of the forests at 10 m, EPSG:3035 cloud-optimised GeoTIFFs; only the map's
# window is read (HTTP ranges, ~1 MB each) by scripts/clip_species.py into treespecies_2022.tif, treespecies_2016.tif.
set -e
cd "$(dirname "$0")/.."
# the sheets under the built blocks (scripts/map.json `blocks`) and a region's halo round them (what the regions read;
# a block not built gets none of its own)
TILES=$(PYTHONPATH=scripts uv run python -c "
from aoi import sheets
from region import HALO
print(' '.join(sheets(1000, HALO)))")
TILES2=$(PYTHONPATH=scripts uv run python -c "
from aoi import sheets
from region import HALO
print(' '.join(sheets(2000, HALO)))")
BOUNDS=$(PYTHONPATH=scripts uv run python -c "
from aoi import world_bounds
print(*(round(v) for v in world_bounds(10)))")
ROOT=$(pwd)
cd data/raw
O=https://download1.bayernwolke.de/a
get() { [ -s "$2" ] || { for i in 1 2 3 4 5; do curl -sS -f -m 3600 -C - -o "$2.part" "$1" && mv "$2.part" "$2" && break; sleep 15; done; }; ls -la "$2"; }
for t in $TILES; do
  get $O/dom20/DOM/32${t}_20_DOM.tif dsm_$t.tif
  get $O/dgm/dgm1/$t.tif dtm_$t.tif
  get $O/dop20/data/32$t.tif orto_$t.tif
done
mkdir -p lod2
for t in $TILES2; do
  get $O/lod2/citygml/$t.gml lod2/$t.gml
done
for k in 09262 09275; do  # Stadt Passau, Landkreis Passau (the map's west and north edges reach into it)
  get $O/tn/lkr/tn_$k.zip tn_$k.zip
done
mkdir -p laser
for t in $TILES; do
  get https://geodaten.bayern.de/odd_data/laser/$t.laz laser/$t.laz
done
# (the tree register and the species maps are cut to the map's bounds: cut again when they changed, e.g. the map grew)
if [ "$(cat cut_bounds.txt 2>/dev/null)" != "$BOUNDS" ]; then rm -f baeume_aoi.csv treespecies_2022.tif treespecies_2016.tif; fi
if [ ! -s baeume_aoi.csv ]; then
  mkdir -p baeume_dl  # the download in a directory of its own, read only by the clip (sqlite3, python -I)
  get https://geodaten.bayern.de/odd/m/8/baeume3d/data/124014_baeume.gpkg baeume_dl/124014_baeume.gpkg
  uv run --project "$ROOT" python -I "$ROOT/scripts/clip_baeume.py" baeume_dl/124014_baeume.gpkg baeume_aoi.csv.part $BOUNDS && mv baeume_aoi.csv.part baeume_aoi.csv
  rm -f baeume_dl/124014_baeume.gpkg
fi
ls -la baeume_aoi.csv
for y in 2022 2016; do
  if [ ! -s treespecies_$y.tif ]; then
    uv run --project "$ROOT" python -I "$ROOT/scripts/clip_species.py" \
      https://download.geoservice.dlr.de/TREE_SPECIES_DE/files/treespecies_de_$y.tif treespecies_$y.tif.part $BOUNDS
    mv treespecies_$y.tif.part treespecies_$y.tif
  fi
  ls -la treespecies_$y.tif
done
echo "$BOUNDS" > cut_bounds.txt
