#!/bin/sh
# Bayerische Vermessungsverwaltung OpenData (CC BY 4.0, www.geodaten.bayern.de): DOM20 surface model (0.2 m),
# DGM1 terrain (1 m) and DOP20 orthophoto (0.2 m), 1 km tiles in EPSG:25832 covering the AOI (scripts/aoi.py).
set -e
cd "$(dirname "$0")/.."
TILES=$(PYTHONPATH=scripts uv run python -c "
from aoi import world_bounds
x0, y0, x1, y1 = world_bounds(10)
print(' '.join(f'{e}_{n}' for e in range(int(x0 // 1000), int(x1 // 1000) + 1) for n in range(int(y0 // 1000), int(y1 // 1000) + 1)))")
cd data/raw
O=https://download1.bayernwolke.de/a
get() { [ -s "$2" ] || { for i in 1 2 3 4 5; do curl -sS -f -m 3600 -C - -o "$2.part" "$1" && mv "$2.part" "$2" && break; sleep 15; done; }; ls -la "$2"; }
for t in $TILES; do
  get $O/dom20/DOM/32${t}_20_DOM.tif dsm_$t.tif
  get $O/dgm/dgm1/$t.tif dtm_$t.tif
  get $O/dop20/data/32$t.tif orto_$t.tif
done
