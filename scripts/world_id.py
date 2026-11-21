"""The world's identity in meta.json `world` (docs/adr/0001-world-layers.md, 0002-addressing.md): what a server and its
clients compare before they apply edits (L1) over a build's base (L0).

  formatVersion  the layout of the node files and of these addresses (bump it when either changes)
  buildId        hash over the contents of tiles/1 and tiles/1f (each file's name and bytes, in name order): the same
                 tiles give the same id on any machine, any changed tile a new one. The coarser levels (2, 4, 8) and the
                 rest of meta.json follow from these and the code, and are not part of it
  paletteLen, paletteHash  meta.json palette: how many entries, the hash of them (append-only, scripts/palette_check.py)
  origin, base   the map's corner in the project grid and the volume's floor (m a.s.l.), as meta.json has them
  grid           the project grid's corner (scripts/map.json grid x0, y0, EPSG:25832): column = easting - x0, row =
                 y0 - northing, what edits are addressed in
  voxel          the edge of a cell in metres

Runs after scripts/tile_fields.py (the last step that writes tiles/1) and before web/tools/tris.mjs, every build (it
reads ~60 MB); meta.json is written only when `world` changed. Every step that reads meta.json leaves `world` out of its
signature (build_data.sh M=), so writing it re-triggers nothing.

usage: uv run python scripts/world_id.py
"""
import hashlib
import json
from pathlib import Path

import aoi

OUT = Path("web/public/data")
FORMAT_VERSION = 1


def tiles_hash(levels=("1", "1f")):
    h = hashlib.sha256()
    for lv in levels:
        d = OUT / "tiles" / lv
        for p in sorted(d.glob("*.bin")):
            b = p.read_bytes()
            h.update(f"{lv}/{p.name}:{len(b)}\n".encode())
            h.update(b)
    return h.hexdigest()


def world(meta):
    pal = meta["palette"]
    g = aoi.CONFIG["grid"]
    return dict(formatVersion=FORMAT_VERSION, buildId=tiles_hash()[:32], paletteLen=len(pal),
                paletteHash=hashlib.sha256(json.dumps(pal, separators=(",", ":")).encode()).hexdigest()[:32],
                origin=meta.get("origin", [0, 0]), base=meta["base"], grid=dict(x0=g["x0"], y0=g["y0"]), voxel=1)


def tiles_bytes(meta):
    """meta.json tiles.bytes: the levels' node files as they are now (tile_fields.py's formula). Set here, every build:
    regions.py writes the voxel sections' sum and tile_fields.py the real one, but tile_fields.py does not run when
    the tiles it would write are those there already (tilefile.write leaves such a file be)"""
    return sum(p.stat().st_size for lv in meta["tiles"]["levels"] for p in (OUT / "tiles" / str(lv["s"])).glob("*.bin"))


def main():
    path = OUT / "meta.json"
    meta = json.loads(path.read_text())
    w = world(meta)
    nb = tiles_bytes(meta)
    if meta.get("world") == w and meta["tiles"].get("bytes") == nb:
        print("world", w["buildId"], "(unchanged)")
        return
    meta["world"] = w
    meta["tiles"]["bytes"] = nb
    path.write_text(json.dumps(meta))
    print("world", w["buildId"], "palette", w["paletteLen"])


if __name__ == "__main__":
    main()
