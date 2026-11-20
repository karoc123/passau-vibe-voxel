"""A synthetic node file and what decodeTile should make of it (web/tools/tile-roundtrip.mjs runs this, then decodes).

usage: uv run python scripts/tile_roundtrip.py OUT_DIR [SEED]
  OUT_DIR/tile.bin       a level-1 node file, every section, written as tiles.py and tile_fields.py write them
                         (tiles.column_runs over a volume, tiles.room_section, tilefile.write)
  OUT_DIR/tile_noroom.bin  the same node without its room section (a node without rooms: every node before them)
  OUT_DIR/expected.json  N; per column (apron included, row-major) its ground and runs [z0, len, palette] -- the runs
                         the volume was painted from, not column_runs' -- planes, buildings, the fields as
                         tile-data.ts Fields interleaves them, and the room spans [column, z0, len, fill] in order
Synthetic data only: seeded random columns, plus edge cases -- empty columns, runs from z 0 and up to the top, touching
runs, palette 65535, ground 255, the apron's rows and columns all different; rooms in the gaps of some columns, the
apron's corners included, several to a column, fill 65535.
"""
import json
import sys
from pathlib import Path

import numpy as np

import tilefile
import tiles

N = tilefile.N
S = N + 2
H = 300  # voxels a column (past 255: z0 and len need their 16 bits)
TOP_ID = 65535


def columns(rng):
    """[[(z0, len, palette)] bottom -> top] per column, never two touching runs of one palette (they'd be one run)"""
    out = []
    for c in range(S * S):
        r, k = divmod(c, S)
        apron = r in (0, S - 1) or k in (0, S - 1)
        kind = c % 7 if not apron else 7 + (r + k) % 3
        runs = []
        if kind == 0:  # empty
            pass
        elif kind == 1:  # one run, the whole column
            runs = [(0, H, int(rng.integers(1, TOP_ID + 1)))]
        elif kind == 2:  # touching runs, length 1, the last at the top, the highest palette
            runs = [(z, 1, 1 + z % 2) for z in range(H - 6, H - 1)] + [(H - 1, 1, TOP_ID)]
        else:  # random runs, some touching
            z = int(rng.integers(0, 3))
            while z < H and len(runs) < 12:
                ln = int(rng.integers(1, min(40, H - z) + 1))
                pal = int(rng.integers(1, TOP_ID + 1))
                if runs and runs[-1][0] + runs[-1][1] == z and runs[-1][2] == pal:
                    pal = pal % TOP_ID + 1
                runs.append((z, ln, pal))
                z += ln + int(rng.integers(0, 4) == 0) * int(rng.integers(0, 50))
        out.append(runs)
    return out


def rooms_of(cols, rng):
    """room spans (row, col, z0, len, fill) as interiors.runs() gives them: in the gaps between the runs of some
    columns"""
    out = []
    for c, runs in enumerate(cols):
        r, k = divmod(c, S)
        if not (c % 5 == 3 or c in (0, S - 1, S * S - S, S * S - 1)):
            continue
        z = 0
        for z0, ln, _ in runs + [(H, 0, 0)]:
            if z0 > z:  # a gap: a room in (part of) it
                a = z + int(rng.integers(0, z0 - z))
                b = a + int(rng.integers(1, z0 - a + 1))
                out.append((r, k, a, b - a, TOP_ID if len(out) % 9 == 0 else int(rng.integers(1, TOP_ID))))
            z = z0 + ln
    return np.array(out, np.int64).reshape(-1, 5)


def main():
    out = Path(sys.argv[1])
    rng = np.random.default_rng(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
    cols = columns(rng)
    vol = np.zeros((H, S * S), np.uint16)
    for c, runs in enumerate(cols):
        for z0, ln, pal in runs:
            vol[z0:z0 + ln, c] = pal
    counts, runs = tiles.column_runs(vol.reshape(H, S, S))
    ground = rng.integers(0, 256, S * S, dtype=np.uint8)
    ground[[0, S * S - 1]] = 0, 255
    planes = rng.integers(0, 65536, S * S, dtype=np.uint16)
    bld = rng.integers(0, 65536, S * S, dtype=np.uint16)
    a, m = N * N, (N // 2 + 2) ** 2
    flod, fols = rng.integers(0, 256, 2 * a, dtype=np.uint8), rng.integers(0, 256, 2 * a, dtype=np.uint8)
    spil = rng.integers(0, 256, 2 * m, dtype=np.uint8)
    rooms = rooms_of(cols, rng)
    room = tiles.room_section(rooms, 0, 0)
    out.mkdir(parents=True, exist_ok=True)
    sec = dict(cnts=counts.tobytes(), grnd=ground.tobytes(), runs=runs.tobytes(), plns=planes.tobytes(),
               bldg=bld.tobytes(), flod=flod.tobytes(), fols=fols.tobytes(), spil=spil.tobytes())
    tilefile.write(out / "tile_noroom.bin", sec)
    tilefile.write(out / "tile.bin", dict(sec, room=room))
    # (the fields interleaved as decodeTile does: cell RGBA = river level, bed, foliage class, tree; spill RG)
    cell = np.stack([flod[:a], flod[a:], fols[:a], fols[a:]], 1).ravel()
    spill = np.stack([spil[:m], spil[m:]], 1).ravel()
    exp = dict(N=N, ground=ground.tolist(), columns=[[list(r) for r in rs] for rs in cols], planes=planes.tolist(),
               bld=bld.tolist(), cell=cell.tolist(), spill=spill.tolist(), rooms=np.frombuffer(room, np.uint16).tolist())
    (out / "expected.json").write_text(json.dumps(exp, separators=(",", ":")))
    print(f"{out / 'tile.bin'}: {S * S} columns, {len(runs)} runs, {sum(not c for c in cols)} empty, {len(rooms)} room spans")


if __name__ == "__main__":
    main()
