"""Probe: hollow ground floors (halls) stamped into the level-1 nodes of a few nodes round one, into a separate data dir,
so their cost can be measured before the pipeline does it for the map (docs/plans/building-looks.md).

A post-pass over the committed level-1 nodes, not the pipeline: the halls are rooms (interiors.py) carved from the
nodes' voxels, recorded in the room section, so the distance levels stay the solid houses' and are linked, not copied.
The out dir is a data dir of links to the source's files but for meta.json (the interior colours appended to the
palette: probe only, palette.json is untouched) and the rewritten level-1 nodes, and beside it halls.json (where each
hall and its doors are). Then node tools/tris.mjs <out>/data (the page's triangle budget reads it) and
web/tools/halls-probe.mjs --public <out> to measure; the default data is never touched.

The layout by size, for play, not from floor plans: a building's footprint less a 2 m shell (the outer metre keeps the
facade and its painted windows, the inner one turns interior, so no window is painted inside), a hall 4 m high (5 m
from LARGE m^2) on the street's level, doors 3-4 m high through walls that face a street at the hall's level (1 door
2 m wide on a small house, more and 3 m wide on larger ones, spread apart), 2 x 2 m pillars as cover in a wide hall
and a partition with a gap across a large one. A building with no wall to a street at its level, or too low for a hall
under its roof, stays solid.

usage: uv run python scripts/halls.py [--node 59_21] [--r 1] [--src web/public/data] --out DIR [--min-area 0] [--doors-only]
       --min-area A: only buildings whose hall would be at least A m^2 (the "chosen ones" variant)
       --doors-only: the doors carved, the halls left solid (the outside view if a hall's faces are drawn only near it)
"""
import argparse
import json
import os
import shutil
import time
from pathlib import Path

import numpy as np
from scipy import ndimage

import interiors
import tilefile
import tiles
from constants import M_INTERIOR, M_INTERIOR_GLASS

N = tilefile.N
S = N + 2
SHELL = 2  # m of wall kept round a hall: the outer metre the facade's, the inner one the interior's
DOOR_H = 3  # the walker is 1.9 m (web/src/sim/solids.ts WALKER_HEAD): a metre over him, from a street STEP m over the
# floor too (the door then STEP m higher: the walker on the sloped street stands up to half a metre over its voxel)
LARGE = 120  # m^2 of hall from which it is 5 m high, has 3 m doors and pillars
PARTITION = 300  # m^2 of hall from which a partition crosses it
TALL = 0  # --height: the hall up to this many m under its roof instead (a low ceiling walks like a cave)
COVER = True  # --no-cover: no pillars
HOLES = False  # --holes: windows open through the wall to the street
RECT = False  # --rect: the hall the largest rectangle in the footprint
LANE = SHELL + 3  # cells a door may cut through (--rect: a rectangle leaves thicker walls)
LIGHT = False  # --light: windows of the day's light in the walls, skylights in the ceiling
WIDE = 0  # --wide: m the narrowest part of a hall may be
DOOR_TOP = 4  # --door-h: m of door over the floor
STEP = 1  # m the street before a door may lie over the floor (a step down in); not under it: the sloped street
# surface (caps) lies up to half a metre under its voxel, more than the walker steps up (1.05 m) from there
# the interior colours (material M_INTERIOR): plaster on walls and ceiling, a stone floor, pillars and partitions
INTERIOR = {"plaster": [214, 206, 190, M_INTERIOR], "floor": [126, 110, 92, M_INTERIOR],
            "pillar": [176, 164, 146, M_INTERIOR], "glass": [150, 175, 190, M_INTERIOR_GLASS]}


def load(src, nodes):
    """the nodes' own cells (no apron) as one volume (H, rows, cols), its ground and buildings; nodes: (tx, ty) box"""
    tx0, tx1, ty0, ty1 = nodes
    R, C = (ty1 - ty0) * N, (tx1 - tx0) * N
    secs, H = {}, 0
    for ty in range(ty0, ty1):
        for tx in range(tx0, tx1):
            s = tilefile.read(src / "tiles/1" / f"{tx}_{ty}.bin", N)
            secs[tx, ty] = s
            r = np.frombuffer(s["runs"], np.uint16).reshape(-1, 3)
            H = max(H, int((r[:, 0].astype(int) + r[:, 1]).max()) + 1)
    vol = np.zeros((H, R, C), np.uint16)
    g = np.zeros((R, C), np.int16)
    bld = np.zeros((R, C), np.uint16)
    for (tx, ty), s in secs.items():
        cn = np.frombuffer(s["cnts"], np.uint16).astype(np.int64)
        r = np.frombuffer(s["runs"], np.uint16).reshape(-1, 3).astype(np.int64)
        col = np.repeat(np.arange(S * S), cn)
        own = (col // S >= 1) & (col // S <= N) & (col % S >= 1) & (col % S <= N)
        col, r = col[own], r[own]
        ln = r[:, 1]
        z = np.repeat(r[:, 0], ln) + np.arange(int(ln.sum())) - np.repeat(np.cumsum(ln) - ln, ln)
        rr = np.repeat(col // S - 1 + (ty - ty0) * N, ln)
        cc = np.repeat(col % S - 1 + (tx - tx0) * N, ln)
        vol[z, rr, cc] = np.repeat(r[:, 2], ln)
        sl = np.s_[(ty - ty0) * N:(ty - ty0 + 1) * N, (tx - tx0) * N:(tx - tx0 + 1) * N]
        g[sl] = np.frombuffer(s["grnd"], np.uint8).reshape(S, S)[1:-1, 1:-1]
        bld[sl] = np.frombuffer(s["bldg"], np.uint16).reshape(S, S)[1:-1, 1:-1]
    return vol, g, bld, secs


def largest_rect(m):
    """the largest axis-aligned rectangle of True cells in m, as a mask"""
    D, W = m.shape
    hgt = np.zeros(W, int)
    best, box = 0, None
    for r in range(D):
        hgt = np.where(m[r], hgt + 1, 0)
        st = []
        for c in range(W + 1):
            hc = hgt[c] if c < W else 0
            s0 = c
            while st and st[-1][1] >= hc:
                s0, sh = st.pop()
                if sh * (c - s0) > best:
                    best, box = sh * (c - s0), (r - sh + 1, r + 1, s0, c)
            st.append((s0, hc))
    out = np.zeros_like(m)
    if box:
        out[box[0]:box[1], box[2]:box[3]] = True
    return out


def plan_hall(vol, g, bld, sl, b, margin, min_area):
    """building b's hall in the box sl of the volume: ((z of the floor, height, hall, pillars, doors), the doors'
    street cells and outward steps), the cells boolean masks over the box; or why it gets none"""
    H = vol.shape[0]
    sub_b = bld[sl] == b
    rows, cols = sl
    if rows.start < margin or cols.start < margin or rows.stop > bld.shape[0] - margin or cols.stop > bld.shape[1] - margin:
        return "edge"
    gs = g[sl].astype(int)
    vs = vol[:, rows, cols]
    solid = vs != 0
    top = np.where(solid.any(0), H - np.argmax(solid[::-1], 0), 0)  # first free voxel over the column's last solid one
    cross = ndimage.generate_binary_structure(2, 1)
    hall0 = ndimage.binary_erosion(sub_b, cross, SHELL, border_value=0)
    if hall0.sum() < 4:
        return "narrow"
    # the floor at the level of the street round it (on a slope the uphill side's ground under the house is carved:
    # no sloped-ground caps lie under buildings)
    around = ndimage.binary_dilation(sub_b, cross, SHELL + 1) & (bld[sl] == 0)
    if not around.any():
        return "no street"
    zf = int(np.median(gs[around]))
    area = int(hall0.sum())
    h = TALL or (5 if area >= LARGE else 4)
    # under most of the roof (a lower annex or eave is left out of the hall below); every column of the hall and its
    # shell solid from under the floor to over the ceiling (two voxels: the ceiling's inner one interior, the roof's
    # outer one as it was)
    h = min(h, int(np.percentile(top[hall0], 20)) - zf - 2)
    if h < DOOR_H:
        return "low"
    full = sub_b & (solid[zf - 1:zf + h + 2].all(0))
    hall = ndimage.binary_erosion(full, cross, SHELL, border_value=0) & hall0
    hall = ndimage.binary_opening(hall, cross)  # (no 1 m slivers)
    if WIDE:
        # (no arm narrower than WIDE m: a footprint's narrow wings walk like shafts; the largest piece left is the hall)
        hall = ndimage.binary_opening(hall, np.ones((WIDE, WIDE), bool))
        lab, n = ndimage.label(hall, cross)
        if n > 1:
            hall = lab == 1 + int(np.argmax(ndimage.sum(hall, lab, range(1, n + 1))))
    if RECT:
        hall = largest_rect(hall)  # (straight walls: a footprint's own outline, carved, looked dug)
    area = int(hall.sum())
    if area < max(9, min_area):  # (3 x 3 m: room to turn and to stand out of the door)
        return "small"
    # doors: from a hall cell straight out through k = SHELL..SHELL+2 shell cells of the building to a street cell
    # (no building, its ground 0..STEP over the floor, open for the door's height)
    zz = np.arange(H)[:, None, None]
    above = (zz >= gs) & (zz < zf + DOOR_TOP)
    street = (bld[sl] == 0) & (gs >= zf) & (gs - zf <= min(STEP, h - DOOR_H)) & ~(solid & above).any(0)
    D, W = hall.shape
    def lane(r, c, dr, dc):
        """the building's cells from (r, c) straight out to a street cell (the first hall cells skipped), or None"""
        while 0 <= r < D and 0 <= c < W and hall[r, c]:
            r, c = r + dr, c + dc
        out = []
        for _ in range(LANE):
            if not (0 <= r < D and 0 <= c < W) or not full[r, c] or hall[r, c]:
                break
            out.append((r, c))
            r, c = r + dr, c + dc
        # (and a second street cell beyond it: not a door onto a slot between two houses)
        ok = out and 0 <= r + dr < D and 0 <= c + dc < W and street[r, c] and street[r + dr, c + dc]
        return out if ok else None

    n_doors = 1 if area < 60 else 2 if area < LARGE else 3 if area < 400 else 4
    width = 2 if area < LARGE else 3
    fits = []  # (the hall cell it starts at, the door's cells): `width` lanes side by side, each its own depth (a
    # stepped diagonal wall is thicker in some of them)
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        al = (dc, dr)  # (across the way out)
        for r, c in zip(*np.nonzero(hall)):
            r, c = int(r), int(c)
            if hall[min(max(r + dr, 0), D - 1), min(max(c + dc, 0), W - 1)]:
                continue
            lanes = [lane(r + al[0] * i, c + al[1] * i, dr, dc) for i in range(width)]
            if all(lanes) and all(0 <= r + al[0] * i < D and 0 <= c + al[1] * i < W and
                                  (hall[r + al[0] * i, c + al[1] * i] or hall[r + al[0] * i - dr, c + al[1] * i - dc])
                                  for i in range(width)):
                fits.append(((r, c), [x for ln in lanes for x in ln], (lanes[0][-1][0] + dr, lanes[0][-1][1] + dc, dr, dc)))
    if not fits:
        return "no street door"
    cy, cx = np.mean(np.nonzero(hall), axis=1)
    # the first door nearest the hall's middle, then each the farthest from those chosen, at least 6 m apart
    fits.sort(key=lambda f: (len(f[1]) // width if RECT else 0, (f[0][0] - cy) ** 2 + (f[0][1] - cx) ** 2))
    chosen = [fits[0]]
    while len(chosen) < n_doors:
        best, bd = None, 36
        for f in fits:
            d = min((f[0][0] - o[0][0]) ** 2 + (f[0][1] - o[0][1]) ** 2 for o in chosen)
            if d > bd:
                best, bd = f, d
        if best is None:
            break
        chosen.append(best)
    doors = np.zeros_like(hall)
    for _, cells, _ in chosen:
        for r, c in cells:
            doors[r, c] = True
    # cover: 2 x 2 pillars every 7 m in a hall at least 9 m across, 2 m clear of its walls and doors; a partition
    # across a large hall's long axis with a 3 m gap in its middle
    keep = np.zeros_like(hall)
    inner = ndimage.binary_erosion(hall, np.ones((3, 3), bool), 2, border_value=0)
    near_door = ndimage.binary_dilation(doors, np.ones((3, 3), bool), 3)
    rr, cc = np.nonzero(hall)
    if area >= PARTITION:
        if np.ptp(rr) >= np.ptp(cc):
            m = int(np.median(rr)); line = np.zeros_like(hall); line[m, :] = True
        else:
            m = int(np.median(cc)); line = np.zeros_like(hall); line[:, m] = True
        line &= hall & ~near_door
        lr, lc = np.nonzero(line)
        mid = (lc if np.ptp(rr) >= np.ptp(cc) else lr)
        if len(mid):
            gm = int(np.median(mid))
            line[lr[np.abs(mid - gm) <= 1], lc[np.abs(mid - gm) <= 1]] = False
        keep |= line
    if COVER and min(np.ptp(rr), np.ptp(cc)) >= 8:
        grid = np.zeros_like(hall)
        r0, c0 = rr.min() + 3, cc.min() + 3
        for a in range(r0, rr.max() - 2, 7):
            for b_ in range(c0, cc.max() - 2, 7):
                grid[a:a + 2, b_:b_ + 2] = True
        grid &= inner & ~near_door & ~ndimage.binary_dilation(keep, np.ones((3, 3), bool), 2)
        keep |= grid
    return (zf, h, hall, keep, doors), [e for _, _, e in chosen]


def stamp(vol, rows, cols, zf, h, hall, keep, doors, ids, doors_only=False):
    """carve the hall and its doors into vol (recorded: interiors.SPANS), paint its inside"""
    box = vol[:, rows, cols]
    if doors_only:  # (what a house with its hall's faces hidden costs seen from outside: the door recesses alone)
        rr, cc = np.nonzero(doors)
        interiors.carve(vol, rr + rows.start, cc + cols.start, zf, zf + min(DOOR_TOP, h))
        return
    cross = ndimage.generate_binary_structure(2, 1)
    lining = ndimage.binary_dilation(hall, cross) & ~hall & ~doors
    if SHELL > 1:  # (a one-block wall is the facade itself: painted, the street would see plaster)
        box[zf:zf + h][:, lining] = ids["plaster"]
    if HOLES:
        # windows open to the street: 2 m wide every 4 m in the walls with street beyond, two rows in a tall hall
        street = ndimage.binary_dilation(box[zf + 3] == 0, cross) & ~hall
        rr, cc = np.nonzero(lining & street)
        w = (rr + cc) % 4 < 2
        bands = [(2, 5), (6, 9)] if h >= 10 else [(2, h - 1)]
        for a, b_ in bands:
            interiors.carve(vol, rr[w] + rows.start, cc[w] + cols.start, zf + a, zf + b_)
    box[zf + h][hall] = ids["plaster"]
    box[zf - 1][hall] = ids["floor"]
    box[zf:zf + h][:, keep] = ids["pillar"]
    if LIGHT:
        # (no sun reaches a hall: windows of the day's light, M_INTERIOR_GLASS, 1 m wide every 3 m along the walls from
        # 2.5 m to a metre under the ceiling, and a skylight strip every 5 m across the ceiling)
        rr, cc = np.nonzero(lining)
        win = ((rr + cc) % 3 == 0)
        box[zf + 2:zf + h - 1][:, rr[win], cc[win]] = ids["glass"]
        hr, hc = np.nonzero(hall & ~keep)
        sky = (hr % 5 == 2) if np.ptp(hr) <= np.ptp(hc) else (hc % 5 == 2)
        box[zf + h][hr[sky], hc[sky]] = ids["glass"]
    open_ = hall & ~keep
    rr, cc = np.nonzero(open_)
    interiors.carve(vol, rr + rows.start, cc + cols.start, zf, zf + h)
    rr, cc = np.nonzero(doors)
    interiors.carve(vol, rr + rows.start, cc + cols.start, zf, zf + min(DOOR_TOP, h))


def link_tree(src, out):
    """out/data: links to src's files, but meta.json and tiles/1 (a dir of links to be overwritten)"""
    d = out / "data"
    if d.exists():
        shutil.rmtree(d)
    (d / "tiles/1").mkdir(parents=True)
    for p in src.iterdir():
        if p.name not in ("tiles", "meta.json"):
            os.symlink(p.resolve(), d / p.name)
    for p in (src / "tiles").iterdir():
        if p.name != "1":
            os.symlink(p.resolve(), d / "tiles" / p.name)
    for p in (src / "tiles/1").iterdir():
        os.symlink(p.resolve(), d / "tiles/1" / p.name)
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", default="59_21")
    ap.add_argument("--r", type=int, default=1, help="nodes round it rewritten (a ring more is read, not written)")
    ap.add_argument("--src", default=str(Path(__file__).resolve().parent.parent / "web/public/data"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-area", type=int, default=0)
    ap.add_argument("--doors-only", action="store_true")
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--door-h", type=int, default=4)
    ap.add_argument("--wide", type=int, default=0)
    ap.add_argument("--no-partition", action="store_true")
    ap.add_argument("--rect", action="store_true")
    ap.add_argument("--no-cover", action="store_true")
    ap.add_argument("--holes", action="store_true")
    ap.add_argument("--shell", type=int, default=2)
    ap.add_argument("--light", action="store_true")
    a = ap.parse_args()
    global TALL, DOOR_TOP, WIDE, PARTITION, RECT, LANE, LIGHT, COVER, HOLES, SHELL
    COVER, HOLES, SHELL = not a.no_cover, a.holes, a.shell
    TALL, DOOR_TOP, WIDE, RECT, LIGHT = a.height, a.door_h, a.wide, a.rect, a.light
    if RECT:
        LANE = 12
    if a.no_partition:
        PARTITION = 10 ** 9
    src, out = Path(a.src), Path(a.out)
    t0 = time.time()
    cx, cy = map(int, a.node.split("_"))
    R = a.r + 1
    nodes = (cx - R, cx + R + 1, cy - R, cy + R + 1)
    vol, g, bld, secs = load(src, nodes)
    meta = json.loads((src / "meta.json").read_text())
    pal = meta["palette"]
    ids = {}
    for k, v in INTERIOR.items():
        ids[k] = len(pal)
        pal.append(v)
    interiors.reset()
    before = vol.copy()
    margin = N + SHELL + 2  # (the ring is read only: no hall within reach of its nodes' aprons)
    objs = ndimage.find_objects(bld.astype(np.int32))
    n_b, made, areas, why, found = 0, 0, [], {}, []
    for b, sl in enumerate(objs, start=0):
        if sl is None:
            continue
        b += 1
        if not (bld[sl] == b).any():
            continue
        n_b += int(sl[0].start >= margin and sl[1].start >= margin and sl[0].stop <= bld.shape[0] - margin
                   and sl[1].stop <= bld.shape[1] - margin)
        sl = tuple(slice(max(s.start - SHELL - 3, 0), s.stop + SHELL + 3) for s in sl)  # (the street before a door)
        p = plan_hall(vol, g, bld, sl, b, margin, a.min_area)
        if isinstance(p, str):
            why[p] = why.get(p, 0) + 1
            continue
        p, entries = p
        stamp(vol, sl[0], sl[1], *p, ids, a.doors_only)
        made += 1
        areas.append(int(p[2].sum()))
        # (where to stand to walk in, world metres: x east, z south; the probe tools' input)
        x0, z0 = sl[1].start + nodes[0] * N, sl[0].start + nodes[2] * N
        hr, hc = np.argwhere(p[2] & ~p[3])[len(np.argwhere(p[2] & ~p[3])) // 2]
        found.append(dict(building=b, area=areas[-1], floor=p[0], height=p[1], inside=[int(hc) + x0 + .5, int(hr) + z0 + .5],
                          doors=[dict(street=[c + x0 + .5, r + z0 + .5], inward=[-dc, -dr]) for r, c, dr, dc in entries]))
    rooms = interiors.runs(0, vol.shape[1], 0, vol.shape[2])
    d = link_tree(src, out)
    meta["palette"] = pal
    (d / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    (out / "halls.json").write_text(json.dumps(found))
    t_stamp = time.time() - t0
    byt = [0, 0]
    nruns = [0, 0]
    for ty in range(cy - a.r, cy + a.r + 1):
        for tx in range(cx - a.r, cx + a.r + 1):
            s = dict(secs[tx, ty])
            r0, c0 = (ty - nodes[2]) * N - 1, (tx - nodes[0]) * N - 1
            nw = vol[:, r0:r0 + S, c0:c0 + S]
            top = int(np.nonzero(nw.reshape(nw.shape[0], -1).any(1))[0].max()) + 1
            counts, runs = tiles.column_runs(nw[:top])
            if not np.array_equal(tiles.column_runs(before[:, r0:r0 + S, c0:c0 + S][:top])[1].ravel(),
                                  np.frombuffer(secs[tx, ty]["runs"], np.uint16)):
                raise SystemExit(f"{tx}_{ty}: the volume read back is not the node's runs")
            s["cnts"], s["runs"] = counts.tobytes(), runs.tobytes()
            rm = tiles.room_section(rooms, r0, c0)
            if rm:
                s["room"] = rm
            f = d / "tiles/1" / f"{tx}_{ty}.bin"
            f.unlink()
            tilefile.write(f, s)
            byt[0] += (src / "tiles/1" / f.name).stat().st_size
            byt[1] += f.stat().st_size
            nruns[0] += len(secs[tx, ty]["runs"]) // 6
            nruns[1] += len(runs)
    print(f"halls: {made} of {n_b} buildings in {(2 * a.r + 1) ** 2} nodes round {a.node}, hall area median "
          f"{int(np.median(areas)) if areas else 0} m^2, total {sum(areas)} m^2; carved {int((before != 0).sum() - (vol != 0).sum())} voxels; "
          f"left solid: {why}")
    print(f"level 1 bytes {byt[0]} -> {byt[1]} ({100 * (byt[1] / byt[0] - 1):+.1f} %), runs {nruns[0]} -> {nruns[1]} "
          f"({100 * (nruns[1] / nruns[0] - 1):+.1f} %); {t_stamp:.1f} s stamping, {time.time() - t0:.1f} s total")
    print(f"interior palette ids {ids}; data: {d}")


if __name__ == "__main__":
    main()
