"""A synthetic node file and what decodeTile should make of it (web/tools/tile-roundtrip.mjs runs this, then decodes).

usage: uv run python scripts/tile_roundtrip.py OUT_DIR [SEED]
  OUT_DIR/tile.bin       a level-1 node file, every section, written as tiles.py and tile_fields.py write them
                         (tiles.column_runs over a volume, tiles.room_section, tilefile.write)
  OUT_DIR/tile_noroom.bin  the same node without its room section (a node without rooms: every node before them)
  OUT_DIR/tile_extra.bin   the node with sections the registry does not decode: two unknown tags (one of odd length,
                         one empty), handed in out of order, and the reserved brik -- kept by tilefile.write (after
                         the registry's, sorted), read back and written again byte for byte; decodeTile's extra
  (each with a caps section: records on ground runs and on decks, negative and positive corners, two in a column;
  and a roof section: records on last runs)
  OUT_DIR/expected.json  N; per column (apron included, row-major) its ground and runs [z0, len, palette] -- the runs
                         the volume was painted from, not column_runs' -- planes, buildings, the fields as
                         tile-data.ts Fields interleaves them, the room spans [column, z0, len, fill] in order, the
                         extra sections (tag, bytes) and the registry's tags (tilefile.SECTIONS, for
                         web/src/core/tile-sections.ts)
Synthetic data only: seeded random columns, plus edge cases -- empty columns, runs from z 0 and up to the top, touching
runs, palette 65535, ground 255, the apron's rows and columns all different; rooms in the gaps of some columns, the
apron's corners included, several to a column, fill 65535.
"""
import json
import sys
from pathlib import Path

import numpy as np

import caps
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
    # caps: on some columns' last run (a deck) and on a run below it (the ground's), corners within +-448 of its top
    cc, cz, cq = [], [], []
    for c, rs in enumerate(cols):
        if not rs or c % 3:
            continue
        for z0, ln, _ in rs[-2:] if c % 2 else rs[-1:]:
            q = (z0 + ln) * 64 + rng.integers(-448, 449, 4)
            q[0] = (z0 + ln) * 64 - 448 if c % 9 == 0 else q[0]
            cc.append(c), cz.append(z0 + ln), cq.append(q)
    cap = caps.encode(cc, cz, cq)
    o = np.lexsort((cz, cc))
    want_caps = np.concatenate([np.array(cc)[o, None], np.array(cz)[o, None], np.array(cq)[o]], 1)
    back_caps = caps.decode(cap)
    assert (np.concatenate([back_caps[0][:, None], back_caps[1][:, None], back_caps[2]], 1) == want_caps).all(), "caps.decode"
    assert len(cc) > 100
    # roof: on other columns' last run, corners within +-448 of its top (as caps.roof_section writes them)
    rc, rzs, rq = [], [], []
    for c, rs in enumerate(cols):
        if rs and c % 5 in (1, 2):  # (pairs of neighbours: corner 0 from the one before)
            z0, ln, _ = rs[-1]
            rc.append(c), rzs.append(z0 + ln), rq.append((z0 + ln) * 64 + rng.integers(-448, 449, 4))
    roof = caps.encode_roof(rc, rzs, rq)
    want_roof = np.concatenate([np.array(rc)[:, None], np.array(rzs)[:, None], np.array(rq)], 1)
    back = caps.decode_roof(roof)
    assert (np.concatenate([back[0][:, None], back[1][:, None], back[2]], 1) == want_roof).all(), "caps.decode_roof"
    assert (np.diff(rc) == 1).any()
    room = tiles.room_section(rooms, 0, 0)
    out.mkdir(parents=True, exist_ok=True)
    sec = dict(cnts=counts.tobytes(), grnd=ground.tobytes(), runs=runs.tobytes(), plns=planes.tobytes(),
               bldg=bld.tobytes(), flod=flod.tobytes(), fols=fols.tobytes(), spil=spil.tobytes(), caps=cap, roof=roof)
    tilefile.write(out / "tile_noroom.bin", sec)
    tilefile.write(out / "tile.bin", dict(sec, room=room))
    # unknown tags kept, after the registry's, sorted (handed in before the known ones, out of order)
    extra = {"zz~9": bytes(rng.integers(0, 256, 7, dtype=np.uint8)), "abcd": b"",
             "brik": bytes(rng.integers(0, 256, 12, dtype=np.uint8))}
    tilefile.write(out / "tile_extra.bin", {"zz~9": extra["zz~9"], **sec, "abcd": extra["abcd"], "room": room,
                                            "brik": extra["brik"]})
    back = tilefile.read(out / "tile_extra.bin", N)
    want_tags = tilefile.ORDER + ["abcd", "zz~9"]
    assert list(back) == want_tags, f"tile_extra.bin: tags {list(back)}, not {want_tags}"
    assert all(back[t] == v for t, v in {**sec, "room": room, **extra}.items()), "tile_extra.bin: a section changed"
    raw = (out / "tile_extra.bin").read_bytes()
    (out / "again").mkdir(exist_ok=True)  # (the same name: gzip's header holds it)
    tilefile.write(out / "again" / "tile_extra.bin", back)
    assert (out / "again" / "tile_extra.bin").read_bytes() == raw, "tile_extra.bin: read -> write not byte for byte"
    # the registry's tags alone: the order as before the registry (ORDER of today's sections)
    assert tilefile.ORDER[:9] == ["cnts", "grnd", "runs", "plns", "bldg", "flod", "fols", "spil", "room"]
    # (the fields interleaved as decodeTile does: cell RGBA = river level, bed, foliage class, tree; spill RG)
    cell = np.stack([flod[:a], flod[a:], fols[:a], fols[a:]], 1).ravel()
    spill = np.stack([spil[:m], spil[m:]], 1).ravel()
    exp = dict(N=N, ground=ground.tolist(), columns=[[list(r) for r in rs] for rs in cols], planes=planes.tolist(),
               bld=bld.tolist(), cell=cell.tolist(), spill=spill.tolist(), rooms=np.frombuffer(room, np.uint16).tolist(),
               extra={t: list(v) for t, v in extra.items()}, registry=[[x.tag, x.reserved] for x in tilefile.SECTIONS],
               caps=np.frombuffer(cap, np.uint16).tolist(), capRecords=want_caps.ravel().tolist(),
               roof=np.frombuffer(roof, np.uint16).tolist(), roofRecords=want_roof.ravel().tolist())
    (out / "expected.json").write_text(json.dumps(exp, separators=(",", ":")))
    print(f"{out / 'tile.bin'}: {S * S} columns, {len(runs)} runs, {sum(not c for c in cols)} empty, {len(rooms)} room spans")


if __name__ == "__main__":
    main()
