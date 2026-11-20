"""Streamable voxel tiles for the viewer (web/src/stream.ts).

Level 1 is the city at 1 m; levels 2, 4 and 8 (LOD_LEVELS) are the same city in cells of 2, 4 and 8 m, drawn instead of
it far from the camera, where a metre is a pixel or less (web/src/city.ts: 4 m where 2 m would be, beyond ~3 km at the
default switch, the whole map from above or the far end of a view along the valley; there a quarter of 2 m's
triangles), and where the viewer's triangle budget is spent (8 m: the whole map for a fifth of 4 m's triangles).
Every node holds N x N cells (N = 128, so a node spans 128 * s metres) plus a 1-cell apron on each side for face
culling and AO at the node edge.

Node file  tiles/{s}/{nx}_{ny}.bin: the container of scripts/tilefile.py (gzip, a small header and tagged sections):
  cnts    uint16[(N+2)^2]   runs per column (apron included, row-major, row = south)
  grnd    uint8 [(N+2)^2]   ground level in metres (z of the first free voxel at level 1), for the facade shader
  runs    uint16[3 * sum]   (z0, len, palette) per run, z in cells of the level, bottom -> top
  plns    uint16[(N+2)^2]   levels 1, 2, 4 and 8 (not in 1f/): the roof plane of the column's top face, 0 for
                            none -- 1 + slope (2.5 degree steps) x 64 + downhill direction (64 steps), as
                            web/src/mesher.worker.ts lights it; at 2 m the most common plane of the column's 1 m
                            columns (a slope and its direction don't change with the cell size), at 4 m of its 4 x 4
  (bldg, flod, fols, spil: the buildings, the rivers' levels, foliage and window light per cell, added by tile_fields.py)
  room    uint16[4 * spans] level 1 only, in a node with rooms (scripts/interiors.py): (column, z0, len, fill) per span

Foliage at level 1 is its own file, loaded after every building (web/src/city.ts): tiles/1f/{nx}_{ny}.bin, the same
format, holding only trees, trunks and grass (`fol_ids`, `grass_ids`); in tiles/1/ trees and trunks are left out and
grass is bare earth (`bare_id`), the surface the grass is then drawn on.

Levels 2, 4 and 8 hold everything, foliage included (one file per node: far away the trees are not worth a second
mesh, and they come in with the city instead of after it).

Levels 2, 4 and 8 are downsampled from the volume with its rooms filled again (each voxel with the palette entry that
stood there before the room was carved, interiors.py): from afar a building with rooms is the solid one it was.
A cell is solid when at least a quarter of its block is; its colour is the topmost voxel in the
block, so roofs stay roofs and the street stays paving when seen from above. Clock faces colour their whole block.
Levels 4 and 8 also keep a deck over open air that the level below has (downsample's finer).
"""
import interiors
import tilefile

import numpy as np

N = tilefile.N
LEVELS = (1, 2, 4, 8)
LOD_LEVELS = (2, 4, 8)  # the distance levels: with roof planes, meshed like level 1 (slopes, chamfers)
# levels built from the level of half their cell size (downsample's finer): 4 from 2, 8 from 4
CASCADE = (4, 8)
# the materials of buildings' walls (voxelMaterial.ts MAT: SOLID, WALL, GLASS, FLOODLIT, CONCRETE, BRONZE, RIBBON, CLASSIC,
# WINDOW, TENEMENT; as web/src/tile-request.ts WALLS): a distance level's wall blocks wear their own colour (side_walls)
WALL_MATS = (0, 1, 2, 7, 13, 15, 19, 20, 21, 22)


def downsample(vol, s, face_ids=(), wall_ids=None, finer=None):
    """wall_ids (a distance level): palette entries of buildings' walls, see side_walls. finer (levels 4 and 8, CASCADE):
    the level of half the cell size, already downsampled: a slab of it over open air stays (see below)"""
    H, D, W = vol.shape
    Hs, Ds, Ws = -(-H // s), -(-D // s), -(-W // s)
    out = np.zeros((Hs, Ds, Ws), np.uint16)
    sides = wall_ids is not None and len(wall_ids)
    if sides:
        is_wall = np.zeros(65536, bool); is_wall[np.asarray(wall_ids, np.int64)] = True
        wmode = np.zeros((Hs, Ds, Ws), np.uint16)  # the block's commonest wall voxel where walls are half of it
    need = s ** 3 // 4
    band = max(1, 256 // s)  # block rows per pass: bounded memory on a large volume
    for rb in range(0, Ds, band):
        r0, r1 = rb * s, min((rb + band) * s, D)
        sub = vol[:, r0:r1, :]
        pad = ((0, Hs * s - H), (0, (-(r1 - r0)) % s), (0, Ws * s - W))
        sub = np.pad(sub, pad)
        hb, db, wb = sub.shape[0] // s, sub.shape[1] // s, sub.shape[2] // s
        blk = sub.reshape(hb, s, db, s, wb, s)
        occ = (blk != 0).sum((1, 3, 5), dtype=np.int32)
        # colour: the topmost non-empty voxel in the block (scan the s layers from the top)
        col = np.zeros((hb, db, wb), np.uint16)
        for dz in range(s - 1, -1, -1):
            layer = blk[:, dz]  # (hb, db, s, wb, s)
            for dy in range(s):
                for dx in range(s):
                    v = layer[:, :, dy, :, dx]
                    col = np.where((col == 0) & (v != 0), v, col)
        if finer is not None:
            # A deck over open air (a footbridge, a gangway; a bridge over a road) is a quarter or less of the 4 m
            # blocks it lies in, but solid at 2 m: it stood there until the switch to 4 m, and there went. The 4 m
            # level keeps such a slab -- 3 of the 4 cells of either 2 m layer of the block solid -- where nothing
            # solid is under the block (not for the thin top of the ground or a roof: that would lift them). 8 m from
            # 4 m alike.
            f = finer[:, rb * 2:(rb + db) * 2, :]
            f = np.pad(f, ((0, hb * 2 - f.shape[0]), (0, db * 2 - f.shape[1]), (0, wb * 2 - f.shape[2])))
            lay = (f != 0).reshape(hb, 2, db, 2, wb, 2).sum((3, 5), dtype=np.int32).max(1)  # (hb, db, wb)
            under = np.zeros_like(occ, bool)
            under[1:] = occ[:-1] >= need
            res = np.where((occ >= need) | ((lay >= 3) & ~under), col, 0)
        else:
            res = np.where(occ >= need, col, 0)
        # a thin surface (ground or roof in the block's bottom layer) is too sparse to keep its own block, which
        # left the block below showing what lies under it (brown soil along the plazas): that block wears it instead
        up = np.zeros_like(col)
        up[:-1] = np.where(res[1:] == 0, col[1:], 0)
        res = np.where((res != 0) & (up != 0), up, res)
        if len(face_ids):  # markings on a wall (clock faces) colour the whole block, not just its top voxel
            fv = blk.max((1, 3, 5), where=np.isin(blk, face_ids), initial=0)
            res = np.where((res != 0) & (fv > 0), fv, res)
        out[:, rb:rb + db, :] = res
        if sides:
            wmode[:, rb:rb + db, :] = wall_mode(blk, is_wall)
    if sides:
        side_walls(out, wmode)
    return out


def level_of(vol, s, face, wall_ids):
    """vol at level s as export() builds it: a CASCADE level from the level of half its cell size"""
    if s == 1:
        return vol
    fin = level_of(vol, s // 2, face, wall_ids) if s in CASCADE else None
    return downsample(vol, s, face, wall_ids if s in LOD_LEVELS else None, fin)


def wall_mode(blk, is_wall):
    """per block (blk: (hb, s, db, s, wb, s)), its commonest wall voxel where walls are at least half of what is in it,
    else 0"""
    hb, s, db, _, wb, _ = blk.shape
    f = blk.transpose(0, 2, 4, 1, 3, 5).reshape(hb, db, wb, s ** 3)
    w = is_wall[f]
    nw, nz = w.sum(3), (f != 0).sum(3)
    best, bestn = np.zeros((hb, db, wb), np.uint16), np.zeros((hb, db, wb), np.int32)
    for k in range(s ** 3):
        c = f[..., k]
        n = ((f == c[..., None]) & w).sum(3)
        better = w[..., k] & (n > bestn)
        best = np.where(better, c, best); bestn = np.where(better, n, bestn)
    return np.where((nw > 0) & (2 * nw >= nz), best, 0).astype(np.uint16)


def side_walls(out, wmode):
    """A block takes the colour of its topmost voxel: on a wall under a roof that was the roof's wherever a roof voxel
    reached into it (a gable's slope, a deep eave), or the roof's thin layer over it was worn down a block, and from
    afar the town read orange, its walls banded with roof colour. A block of a facade -- open air beside it, and beside
    the block under it on the same side (a roof's riser has solid under it) -- with walls for half of it wears its
    commonest wall voxel instead -- the top block of a facade too, under the eave: half wall, its side is mostly wall
    at 1 m, and as roof it laid a 2 m band of roof colour along every eave (seen from above, the roof's outline gives up
    those blocks' width; from afar the facades are what is seen). Measured on the overview, the share of roof-orange
    pixels at 2 m over the same at 1 m: +10 % before, +7 % after; close in on the old town +6 % before, +2 % after."""
    solid = out != 0
    face = np.zeros_like(solid)
    for ax, sh in ((1, 1), (1, -1), (2, 1), (2, -1)):
        o = ~np.roll(solid, sh, axis=ax)  # open air on that side (the map's edge: none)
        if ax == 1:
            o[:, 0 if sh > 0 else -1, :] = False
        else:
            o[:, :, 0 if sh > 0 else -1] = False
        face[1:] |= o[1:] & o[:-1]
    k = solid & face & (wmode != 0)
    out[k] = wmode[k]


def downsample_planes(planes, s):
    """the roof plane per s x s block of 1 m columns: the most common code among them, where at least half of them have
    one (0 elsewhere)"""
    if planes is None or s == 1:
        return planes
    D, W = planes.shape
    p = np.pad(planes, ((0, (-D) % s), (0, (-W) % s)))
    blk = p.reshape(p.shape[0] // s, s, p.shape[1] // s, s).transpose(0, 2, 1, 3).reshape(p.shape[0] // s, p.shape[1] // s, s * s)
    nz = (blk != 0).sum(2)
    best, bestn = np.zeros(blk.shape[:2], np.uint16), np.zeros(blk.shape[:2], np.int32)
    for k in range(s * s):
        c = blk[:, :, k]
        n = (blk == c[:, :, None]).sum(2)
        better = (c != 0) & (n > bestn)
        best = np.where(better, c, best); bestn = np.where(better, n, bestn)
    return np.where(2 * nz >= s * s, best, 0).astype(np.uint16)


def plane_window(planes, r0, c0):
    """the roof plane codes of a node and its apron (r0, c0: the window's first row and column at its level), as bytes"""
    if planes is None:
        return b""
    D, W = planes.shape
    pw = np.zeros((N + 2, N + 2), np.uint16)
    ra, rb, ca, cb = max(r0, 0), min(r0 + N + 2, D), max(c0, 0), min(c0 + N + 2, W)
    if ra < rb and ca < cb:
        pw[ra - r0:rb - r0, ca - c0:cb - c0] = planes[ra:rb, ca:cb]
    return pw.tobytes()


def column_runs(vol_win):
    """vol_win (H, R, C) -> counts (R*C,), runs (n, 3) bottom -> top, row-major columns."""
    H = vol_win.shape[0]
    cols = vol_win.reshape(H, -1).T
    n = cols.shape[0]
    b = np.zeros((n, H + 1), bool)
    b[:, 0] = True
    b[:, 1:H] = cols[:, 1:] != cols[:, :-1]
    b[:, H] = True
    fi = np.flatnonzero(b)
    ci, zi = fi // (H + 1), fi % (H + 1)
    same = ci[:-1] == ci[1:]
    s_ci, s_z0, s_z1 = ci[:-1][same], zi[:-1][same], zi[1:][same]
    val = cols[s_ci, s_z0]
    k = val != 0
    s_ci, s_z0, s_z1, val = s_ci[k], s_z0[k], s_z1[k], val[k]
    counts = np.bincount(s_ci, minlength=n)
    return counts.astype(np.uint16), np.stack([s_z0, s_z1 - s_z0, val], 1).astype(np.uint16)


HALO = 16  # map cells around a window's core that export_window reads (window.py): a level-8 node's apron (8 m) and
# side_walls' look at the block beside it (8 m); the coarser levels' blocks, and the cascade within them, are aligned


def manifest(D, W, levels=None):
    """per level its nodes across and down (meta.json tiles.levels)"""
    return [dict(s=s, nx=-(-(-(-W // s)) // N), ny=-(-(-(-D // s)) // N)) for s in levels or LEVELS]


def export(vol, g, out, note, face_ids=(), fol_ids=(), grass_ids=(), bare_id=0, planes=None, wall_ids=None,
           windows=None, levels=None):
    """vol (H, D, W) level-1 voxels, g (D, W) ground level, planes (D, W) roof plane codes or None -> node files;
    wall_ids: the palette entries of buildings' walls (the distance levels' colours, side_walls). windows: the cover
    of the map to work in (window.py; default one window, the whole map): each window's nodes come from its region of
    vol alone, the bytes are the same. Returns the manifest for meta.json."""
    import window as wmod
    D, W = g.shape
    levels = manifest(D, W, levels)
    remove_stale(out, levels, note, split=bool(len(fol_ids)))
    stats = {lv["s"]: [0, 0, 0] for lv in levels}
    for w in windows or wmod.cover(D, W):
        ra, rb, ca, cb = region = w.region(HALO)
        st = export_window(vol[:, ra:rb, ca:cb], g[ra:rb, ca:cb], None if planes is None else planes[ra:rb, ca:cb],
                           region, w, out, face_ids, fol_ids, grass_ids, bare_id, wall_ids, [lv["s"] for lv in levels])
        for s in st:
            stats[s] = [a + b for a, b in zip(stats[s], st[s])]
    for lv in levels:
        tot, nruns, ftot = stats[lv["s"]]
        note(f"tiles level {lv['s']}: {lv['nx']}x{lv['ny']} nodes, {nruns} runs, {tot / 2 ** 20:.1f} MB gz"
             + (f", foliage {ftot / 2 ** 20:.1f} MB gz" if lv["s"] == 1 and len(fol_ids) else ""))
    return dict(N=N, levels=levels, bytes=sum(st_[0] for st_ in stats.values()))


def remove_stale(out, levels, note, split=True):
    """node files of an earlier, larger map are not in the new manifest: they go, so the folder holds this build only"""
    for lv in levels:
        s, nx, ny = lv["s"], lv["nx"], lv["ny"]
        dirs = [str(s)] + (["1f"] if s == 1 and split else [])
        for d in dirs:
            (out / d).mkdir(parents=True, exist_ok=True)
        stale = [f for d in dirs for f in (out / d).glob("*.bin")
                 if not (lambda tx, ty: tx < nx and ty < ny)(*map(int, f.stem.split("_")))]
        for f in stale:
            f.unlink()
        if stale:
            note(f"tiles level {s}: {len(stale)} stale node files removed")


def room_section(rooms, r0, c0):
    """the room section of the node window whose first row and column (apron included) are r0, c0 in rooms' rows and
    columns (rooms: interiors.runs()' spans), as bytes; b"" when none of them lies in it"""
    if rooms is None or not len(rooms):
        return b""
    S = N + 2
    rr, cc = rooms[:, 0] - r0, rooms[:, 1] - c0
    k = (rr >= 0) & (rr < S) & (cc >= 0) & (cc < S)
    if not k.any():
        return b""
    sp = np.stack([rr[k] * S + cc[k], rooms[k, 2], rooms[k, 3], rooms[k, 4]], 1)
    return sp[np.lexsort((sp[:, 1], sp[:, 0]))].astype(np.uint16).tobytes()


def export_window(vol, g, planes, region, win, out, face_ids=(), fol_ids=(), grass_ids=(), bare_id=0, wall_ids=None,
                  levels=None, rooms=None):
    """The node files (of the given levels) whose first column and row lie in the window's core (window.Window), from
    the window's region = (ra, rb, ca, cb), win.region(HALO) or more, of the level-1 volume (vol: (H, rb - ra, cb - ca)),
    the ground (g) and the roof plane codes (planes, or None). The same bytes as a whole-map export: a node at level s
    is its own blocks and the 1-cell apron round them, and a block is the voxels in it, the block under it and, for its
    colour on a facade (side_walls), whether the blocks beside it are solid. rooms: the rooms carved in vol
    (interiors.runs()' spans, in vol's rows and columns, or None): level 1's room sections, and filled in vol while the
    coarser levels are made (vol is as it was after). Returns per level [bytes, runs, foliage bytes] written."""
    ra, rb, ca, cb = region
    assert ra % max(LEVELS) == 0 and ca % max(LEVELS) == 0, "region not aligned to the coarsest level's blocks"
    D, W = win.D, win.W
    face = np.array(sorted(face_ids), np.uint16)
    if len(fol_ids):
        is_fol = np.zeros(65536, bool); is_fol[list(fol_ids)] = True; is_fol[list(grass_ids)] = True
        is_grass = np.zeros(65536, bool); is_grass[list(grass_ids)] = True
    stats, done = {}, {}
    levels = levels or LEVELS
    filled, saved = False, None  # (the rooms, filled for the coarser levels: interiors.fill)
    try:
        for s in levels:
            if s > 1 and not filled:
                filled, saved = True, interiors.fill(vol, rooms)
            fin = done.get(s // 2) if s in CASCADE else None
            if s in CASCADE and fin is None:
                fin = level_of(vol, s // 2, face, wall_ids)
            vs = vol if s == 1 else downsample(vol, s, face, wall_ids if s in LOD_LEVELS else None, fin)
            del fin
            if s * 2 in CASCADE:
                done[s] = vs
            gs = g if s == 1 else g[::s, ::s]  # ground metres at the block's corner column (shader only)
            ps = downsample_planes(planes, s) if s == 1 or s in LOD_LEVELS else None
            Hs = vs.shape[0]
            Ds, Ws = -(-D // s), -(-W // s)  # the map at this level
            oy, ox = ra // s, ca // s  # the region's corner at this level
            split = s == 1 and len(fol_ids)
            tot, nruns, ftot = 0, 0, 0
            for ty in range(win.r0 // (N * s), -(-win.r1 // (N * s))):
                for tx in range(win.c0 // (N * s), -(-win.c1 // (N * s))):
                    if not win.holds(ty * N * s, tx * N * s):
                        continue
                    r0, c0 = ty * N - 1, tx * N - 1
                    nw = np.zeros((Hs, N + 2, N + 2), np.uint16)
                    gw = np.zeros((N + 2, N + 2), np.uint8)
                    rr0, rr1, cc0, cc1 = max(r0, 0), min(r0 + N + 2, Ds), max(c0, 0), min(c0 + N + 2, Ws)
                    assert rr0 >= oy and cc0 >= ox and rr1 - oy <= vs.shape[1] and cc1 - ox <= vs.shape[2], "halo too small"
                    if rr0 < rr1 and cc0 < cc1:
                        nw[:, rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = vs[:, rr0 - oy:rr1 - oy, cc0 - ox:cc1 - ox]
                        gw[rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = np.clip(gs[rr0 - oy:rr1 - oy, cc0 - ox:cc1 - ox], 0, 255)
                    top = int(np.nonzero(nw.reshape(Hs, -1).any(1))[0].max()) + 1 if nw.any() else 1
                    nw = nw[:top]
                    if split:
                        f = is_fol[nw]
                        fol = np.where(f, nw, 0).astype(np.uint16)
                        nw = np.where(f, np.where(is_grass[nw], bare_id, 0), nw).astype(np.uint16)
                        fc, fr = column_runs(fol)
                        tilefile.write(out / "1f" / f"{tx}_{ty}.bin", dict(cnts=fc.tobytes(), grnd=gw.tobytes(), runs=fr.tobytes()))
                        ftot += (out / "1f" / f"{tx}_{ty}.bin").stat().st_size
                    counts, runs = column_runs(nw)
                    sec = dict(cnts=counts.tobytes(), grnd=gw.tobytes(), runs=runs.tobytes())
                    if ps is not None:
                        # (beyond the region only beyond the map, where plane_window gives 0 as before)
                        sec["plns"] = plane_window(ps, r0 - oy, c0 - ox)
                    if s == 1 and (rm := room_section(rooms, r0 - oy, c0 - ox)):
                        sec["room"] = rm
                    tilefile.write(out / str(s) / f"{tx}_{ty}.bin", sec)
                    tot += (out / str(s) / f"{tx}_{ty}.bin").stat().st_size
                    nruns += len(runs)
            stats[s] = [tot, nruns, ftot]
            del vs, ps
            done.pop(s // 2, None)
    finally:
        interiors.unfill(vol, saved)
    return stats
