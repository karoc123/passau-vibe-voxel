"""Streamable voxel tiles for the viewer (web/src/stream.ts).

Level 1 is the city at 1 m; level 2 (LOD_LEVELS) is the same city in cells of 2 m, drawn instead of it far from the
camera, where a metre is a pixel or less (web/src/city.ts; a level 4 cost slim towers and spires their tops for a few
per cent of triangles at the far edge, so there is none); level 8 (cells of 8 x 8 x 8 m) is the clay
standing in where the viewer's budget leaves the city out. Every node holds N x N cells (N = 128, so a node spans
128 * s metres) plus a 1-cell apron on each side for face culling and AO at the node edge.

Node file  tiles/{s}/{nx}_{ny}.bin, gzip of:
  counts  uint16[(N+2)^2]   runs per column (apron included, row-major, row = south)
  ground  uint8 [(N+2)^2]   ground level in metres (z of the first free voxel at level 1), for the facade shader
  runs    uint16[3 * sum]   (z0, len, palette) per run, z in cells of the level, bottom -> top
  planes  uint16[(N+2)^2]   levels 1 and 2 (not in 1f/, not level 8): the roof plane of the column's top face, 0 for
                            none -- 1 + slope (2.5 degree steps) x 64 + downhill direction (64 steps), as
                            web/src/mesher.worker.ts lights it; at 2 m the most common plane of the column's 1 m
                            columns (a slope and its direction don't change with the cell size)

Foliage at level 1 is its own file, loaded after every building (web/src/city.ts): tiles/1f/{nx}_{ny}.bin, the same
format, holding only trees, trunks and grass (`fol_ids`, `grass_ids`); in tiles/1/ trees and trunks are left out and
grass is bare earth (`bare_id`), the surface the grass is then drawn on.

Level 2 holds everything, foliage included (one file per node: far away the trees are not worth a second
mesh, and they come in with the city instead of after it).

Levels 2 and 8: a cell is solid when at least a quarter of its block is; its colour is the topmost voxel in the block,
so roofs stay roofs and the street stays paving when seen from above. Clock faces colour their whole block.
"""
import gzip

import numpy as np

N = 128
LEVELS = (1, 2, 8)
LOD_LEVELS = (2,)  # the distance levels: with roof planes, meshed like level 1 (slopes, chamfers)
# the materials of buildings' walls (voxelMaterial.ts MAT: SOLID, WALL, GLASS, FLOODLIT, CONCRETE, BRONZE, RIBBON, CLASSIC,
# WINDOW, TENEMENT; as web/src/stream.ts WALLS): a distance level's wall blocks wear their own colour (side_walls)
WALL_MATS = (0, 1, 2, 7, 13, 15, 19, 20, 21, 22)


def downsample(vol, s, face_ids=(), wall_ids=None):
    """wall_ids (a distance level): palette entries of buildings' walls, see side_walls"""
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


def export(vol, g, out, note, face_ids=(), fol_ids=(), grass_ids=(), bare_id=0, planes=None, wall_ids=None):
    """vol (H, D, W) level-1 voxels, g (D, W) ground level, planes (D, W) roof plane codes or None -> node files;
    wall_ids: the palette entries of buildings' walls (the distance levels' colours, side_walls). Returns the manifest
    for meta.json."""
    D, W = g.shape
    info = dict(N=N, levels=[], bytes=0)
    for s in LEVELS:
        vs = vol if s == 1 else downsample(vol, s, np.array(sorted(face_ids), np.uint16), wall_ids if s in LOD_LEVELS else None)
        gs = g if s == 1 else g[::s, ::s]  # ground metres at the block's corner column (shader only)
        ps = downsample_planes(planes, s) if s == 1 or s in LOD_LEVELS else None
        Hs, Ds, Ws = vs.shape
        nx, ny = -(-Ws // N), -(-Ds // N)
        (out / str(s)).mkdir(parents=True, exist_ok=True)
        split = s == 1 and len(fol_ids)
        if split:
            (out / "1f").mkdir(parents=True, exist_ok=True)
            is_fol = np.zeros(65536, bool); is_fol[list(fol_ids)] = True; is_fol[list(grass_ids)] = True
            is_grass = np.zeros(65536, bool); is_grass[list(grass_ids)] = True
        tot, nruns, ftot = 0, 0, 0
        # node files of an earlier, larger map are not in the new manifest: they go, so the folder holds this build only
        stale = [f for d in ([str(s), "1f"] if split else [str(s)]) for f in (out / d).glob("*.bin")
                 if not (lambda tx, ty: tx < nx and ty < ny)(*map(int, f.stem.split("_")))]
        for f in stale:
            f.unlink()
        if stale:
            note(f"tiles level {s}: {len(stale)} stale node files removed")
        for ty in range(ny):
            for tx in range(nx):
                r0, c0 = ty * N - 1, tx * N - 1
                win = np.zeros((Hs, N + 2, N + 2), np.uint16)
                gw = np.zeros((N + 2, N + 2), np.uint8)
                rr0, rr1, cc0, cc1 = max(r0, 0), min(r0 + N + 2, Ds), max(c0, 0), min(c0 + N + 2, Ws)
                if rr0 < rr1 and cc0 < cc1:
                    win[:, rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = vs[:, rr0:rr1, cc0:cc1]
                    gw[rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = np.clip(gs[rr0:rr1, cc0:cc1], 0, 255)
                top = int(np.nonzero(win.reshape(Hs, -1).any(1))[0].max()) + 1 if win.any() else 1
                win = win[:top]
                if split:
                    f = is_fol[win]
                    fol = np.where(f, win, 0).astype(np.uint16)
                    win = np.where(f, np.where(is_grass[win], bare_id, 0), win).astype(np.uint16)
                    fc, fr = column_runs(fol)
                    with gzip.GzipFile(out / "1f" / f"{tx}_{ty}.bin", "wb", compresslevel=9, mtime=0) as fh:
                        fh.write(fc.tobytes() + gw.tobytes() + fr.tobytes())
                    ftot += (out / "1f" / f"{tx}_{ty}.bin").stat().st_size
                counts, runs = column_runs(win)
                blob = counts.tobytes() + gw.tobytes() + runs.tobytes() + plane_window(ps, r0, c0)
                with gzip.GzipFile(out / str(s) / f"{tx}_{ty}.bin", "wb", compresslevel=9, mtime=0) as fh:  # mtime 0: rebuilds of unchanged nodes stay byte-identical
                    fh.write(blob)
                tot += (out / str(s) / f"{tx}_{ty}.bin").stat().st_size
                nruns += len(runs)
        info["levels"].append(dict(s=s, nx=nx, ny=ny))
        info["bytes"] += tot
        note(f"tiles level {s}: {nx}x{ny} nodes, {nruns} runs, {tot / 2 ** 20:.1f} MB gz"
             + (f", foliage {ftot / 2 ** 20:.1f} MB gz" if split else ""))
        del vs, ps
    return info


def export_region(vol, g, out, box, note, face_ids=(), fol_ids=(), grass_ids=(), bare_id=0, planes=None, wall_ids=None):
    """Rewrite only the nodes (every level) over box = (r0, r1, c0, c1) of the 1 m grid, from the same volume the
    full export would see (for a fast loop on one landmark); each node is built from its own 1 m window, so the result matches
    export()."""
    H, D, W = vol.shape
    R0, R1, C0, C1 = box
    face = np.array(sorted(face_ids), np.uint16)
    fol = np.zeros(65536, bool); fol[list(fol_ids)] = True; fol[list(grass_ids)] = True
    grass = np.zeros(65536, bool); grass[list(grass_ids)] = True
    n = 0
    for s in LEVELS:
        span = N * s
        for ty in range(max(R0 - s, 0) // span, min(R1 + s, D - 1) // span + 1):
            for tx in range(max(C0 - s, 0) // span, min(C1 + s, W - 1) // span + 1):
                a, c = ty * span - s, tx * span - s  # 1 m window: the node and its one-cell apron, aligned to s
                w1 = np.zeros((H, span + 2 * s, span + 2 * s), np.uint16)
                g1 = np.zeros((span + 2 * s, span + 2 * s), g.dtype)
                ra, rb, ca, cb = max(a, 0), min(a + span + 2 * s, D), max(c, 0), min(c + span + 2 * s, W)
                w1[:, ra - a:rb - a, ca - c:cb - c] = vol[:, ra:rb, ca:cb]
                g1[ra - a:rb - a, ca - c:cb - c] = g[ra:rb, ca:cb]
                win = w1 if s == 1 else downsample(w1, s, face, wall_ids if s in LOD_LEVELS else None)
                gw = np.clip(g1[::s, ::s], 0, 255).astype(np.uint8)
                Hs = win.shape[0]
                top = int(np.nonzero(win.reshape(Hs, -1).any(1))[0].max()) + 1 if win.any() else 1
                win = win[:top]
                if s == 1 and len(fol_ids):
                    f = fol[win]
                    fv = np.where(f, win, 0).astype(np.uint16)
                    win = np.where(f, np.where(grass[win], bare_id, 0), win).astype(np.uint16)
                    fc, fr = column_runs(fv)
                    with gzip.GzipFile(out / "1f" / f"{tx}_{ty}.bin", "wb", compresslevel=9, mtime=0) as fh:
                        fh.write(fc.tobytes() + gw.tobytes() + fr.tobytes())
                counts, runs = column_runs(win)
                pw = None
                if planes is not None and (s == 1 or s in LOD_LEVELS):
                    p1 = np.zeros((span + 2 * s, span + 2 * s), np.uint16)
                    p1[ra - a:rb - a, ca - c:cb - c] = planes[ra:rb, ca:cb]
                    pw = downsample_planes(p1, s)
                blob = counts.tobytes() + gw.tobytes() + runs.tobytes() + plane_window(pw, 0, 0)
                with gzip.GzipFile(out / str(s) / f"{tx}_{ty}.bin", "wb", compresslevel=9, mtime=0) as fh:
                    fh.write(blob)
                n += 1
    note(f"tiles: {n} nodes rewritten over rows {R0}-{R1}, cols {C0}-{C1}")
