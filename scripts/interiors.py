"""Rooms: voids carved into a building's solid volume on purpose, to walk, fly or drive into (a nave, a hall, a gate
passage), and the record of them the viewer and the distance levels need.

voxelize.py fills every building solid from its base to its roof. A room is carved out of that at level 1, so that
everything reading the 1 m voxels (the mesher, walking, the drone's and the car's collision) simply finds the void,
as with the tunnels (tunnels.py) and underpasses (underpass.py). Unlike those, a room is recorded: per column the
spans carved and the palette entry that stood there (`fill`). The record goes into the level-1 nodes' `room` section
(tilefile.py) and is what lets

  - the distance levels (tiles.py, tiles_lod.py) be downsampled from the volume with the rooms filled again: a 1-2 m
    shell would thin to a skeleton at 4 m and vanish at 8 m (a quarter of a block must be solid), so from afar a
    building with rooms looks exactly as without;
  - the occlusion culling (web/src/occlusion.ts) count a room as the solid building it is from outside;
  - the viewer tell that the camera is indoors (no rain or snow: web/src/weather.ts).

The registry holds no rooms yet: ROOMS is where curated rooms are declared, and parts (parts.py, the building
overrides) will carve through carve() alike. A room is declared in the project grid (project row, column: region
row + R0, column + C0; voxel z, z 0 at aoi.BASE), so that it is carved alike in every region it reaches
(region.py: the same bytes from any cover):

  Room(name, box=(r0, r1, c0, c1), z0, z1, doors=(Door(box=(r0, r1, c0, c1), z0, z1), ...))

  box, z0, z1   the hollow: project rows r0..r1-1, columns c0..c1-1, voxels z0 (the floor's top: the first free
                voxel) .. z1-1 (the ceiling's underside is z1)
  doors         openings through the shell to the outside, carved and recorded the same way; a door's box reaches
                from the room through the wall

Its materials: the inner face of the shell and what stands in a room are palette entries of material M_INTERIOR (no
facade windows, no weather, no street lamps or floodlight on them, sky light damped: web/src/voxelMaterial.ts),
the inside of a window M_INTERIOR_GLASS. Neither is a wall material (tiles.WALL_MATS) nor paved.

check() is what a declared room must pass (build() runs it on every room wholly in the region): its voxels empty,
each of their six neighbours solid, another room voxel or one of its doors' (enclosed but for its doors), a floor under
every column, and each door touching the room and the open air outside it.

usage: uv run python scripts/interiors.py          the declared rooms
       uv run python scripts/interiors.py --test   synthetic checks: carving, check(), the record's spans, and that the
                                                   distance levels of a building with a room are the same bytes as
                                                   without it (tiles.export_window, tiles_lod.region_volume)
"""
import sys
from dataclasses import dataclass, field

import numpy as np

M_INTERIOR, M_INTERIOR_GLASS = 24, 25  # web/src/voxelMaterial.ts MAT.INTERIOR, MAT.INTERIOR_GLASS


@dataclass(frozen=True)
class Door:
    box: tuple  # (r0, r1, c0, c1) project grid
    z0: int
    z1: int


@dataclass(frozen=True)
class Room:
    name: str
    box: tuple  # (r0, r1, c0, c1) project grid
    z0: int
    z1: int
    doors: tuple = field(default=())


# the curated rooms (none yet)
ROOMS: list = []

# this region's record: (row, col) region cell -> {z: the palette entry that stood there}; reset() per build
SPANS: dict = {}


def reset():
    SPANS.clear()


def carve(vol, rr, cc, z0, z1):
    """empty the voxels z0..z1-1 of the region cells (rr, cc) (clipped to vol) and record what stood there; a voxel
    carved before keeps its first record"""
    H, D, W = vol.shape
    z0, z1 = max(int(z0), 0), min(int(z1), H)
    if z1 <= z0:
        return
    for r, c in zip(np.asarray(rr).ravel().tolist(), np.asarray(cc).ravel().tolist()):
        if not (0 <= r < D and 0 <= c < W):
            continue
        rec = SPANS.setdefault((r, c), {})
        col = vol[z0:z1, r, c]
        for z, v in zip(range(z0, z1), col.tolist()):
            rec.setdefault(z, v)
        col[:] = 0


def _cells(box, R0, C0, D, W):
    r0, r1, c0, c1 = box
    rr, cc = np.mgrid[max(r0 - R0, 0):min(r1 - R0, D), max(c0 - C0, 0):min(c1 - C0, W)]
    return rr.ravel(), cc.ravel()


def _inside(box, R0, C0, D, W):
    r0, r1, c0, c1 = box
    return r0 - R0 >= 1 and c0 - C0 >= 1 and r1 - R0 <= D - 1 and c1 - C0 <= W - 1


def build(vol, R0, C0, note, rooms=None):
    """carve the declared rooms (ROOMS) into the region's volume (R0, C0: its first project row and column) and record
    them; check() each one wholly in the region (with its doors) and fail on the first that does not pass"""
    reset()
    rooms = ROOMS if rooms is None else rooms
    H, D, W = vol.shape
    for rm in rooms:
        for part in (rm, *rm.doors):
            carve(vol, *_cells(part.box, R0, C0, D, W), part.z0, part.z1)
    for rm in rooms:
        if all(_inside(p.box, R0, C0, D, W) for p in (rm, *rm.doors)):
            bad = check(vol, rm, R0, C0)
            if bad:
                raise ValueError(f"interiors: room {rm.name!r}: " + "; ".join(bad[:5]))
    if rooms:
        note(f"interiors: {len(rooms)} rooms, {sum(len(v) for v in SPANS.values())} voxels carved")


def check(vol, room, R0=0, C0=0):
    """what is wrong with a carved room (vol: the region's volume, R0, C0 its corner in the project grid), [] if
    nothing: see the module's doc"""
    H, D, W = vol.shape
    bad = []

    def mask(part):
        m = np.zeros((H, D, W), bool)
        rr, cc = _cells(part.box, R0, C0, D, W)
        m[max(part.z0, 0):min(part.z1, H), rr, cc] = True
        return m

    room_m = mask(room)
    door_m = np.zeros_like(room_m)
    for d in room.doors:
        door_m |= mask(d)
    door_m &= ~room_m
    hollow = room_m | door_m
    if not room_m.any():
        return [f"{room.name}: no voxels"]
    if (vol[hollow] != 0).any():
        z, r, c = np.argwhere(hollow & (vol != 0))[0]
        bad.append(f"not empty at z {z}, row {r + R0}, col {c + C0}")
    # every neighbour of a room voxel: solid, the room, or a door
    for ax in range(3):
        for sh in (1, -1):
            nb = np.zeros_like(room_m)
            src = [slice(None)] * 3
            dst = [slice(None)] * 3
            src[ax], dst[ax] = (slice(0, -1), slice(1, None)) if sh > 0 else (slice(1, None), slice(0, -1))
            nb[tuple(dst)] = room_m[tuple(src)]  # the voxels next to a room voxel on that side
            leak = nb & ~hollow & (vol == 0)
            if leak.any():
                z, r, c = np.argwhere(leak)[0]
                bad.append(f"open to the outside at z {z}, row {r + R0}, col {c + C0} (not a door)")
                break
    # a floor under every column
    zs = np.argmax(room_m, axis=0)
    has = room_m.any(0)
    rr, cc = np.nonzero(has)
    under = zs[rr, cc] - 1
    if (under < 0).any() or (vol[np.maximum(under, 0), rr, cc] == 0).any():
        bad.append("a column without a floor")
    # each door: next to the room, and to open air outside it
    for d in room.doors:
        dm = mask(d) & ~room_m
        grown = np.zeros_like(dm)
        for ax in range(3):
            grown |= np.roll(dm, 1, ax) | np.roll(dm, -1, ax)
        if not (grown & room_m).any():
            bad.append(f"door {d.box} does not reach the room")
        if not (grown & ~hollow & (vol == 0)).any():
            bad.append(f"door {d.box} does not reach the outside")
    return bad


def runs(r0, r1, c0, c1):
    """the record over region rows r0..r1-1, columns c0..c1-1: an (n, 5) array of spans (row - r0, col - c0, z0, len,
    fill), each a run of voxels of one fill, by row, column and z"""
    out = []
    for (r, c) in sorted(k for k in SPANS if r0 <= k[0] < r1 and c0 <= k[1] < c1):
        rec = SPANS[r, c]
        zs = sorted(rec)
        a = zs[0]
        for i in range(1, len(zs) + 1):
            if i == len(zs) or zs[i] != zs[i - 1] + 1 or rec[zs[i]] != rec[a]:
                out.append((r - r0, c - c0, a, zs[i - 1] + 1 - a, rec[a]))
                if i < len(zs):
                    a = zs[i]
    return np.array(out, np.int64).reshape(-1, 5)


def fill(vol, rooms):
    """paint the rooms' fill into vol (rooms: runs()' spans in vol's rows and columns, clipped to it); returns what it
    covered, for unfill()"""
    if rooms is None or not len(rooms):
        return None
    H, D, W = vol.shape
    rooms = rooms[(rooms[:, 0] >= 0) & (rooms[:, 0] < D) & (rooms[:, 1] >= 0) & (rooms[:, 1] < W)]
    ln = rooms[:, 3]
    z = np.repeat(rooms[:, 2], ln) + np.arange(int(ln.sum())) - np.repeat(np.cumsum(ln) - ln, ln)
    r, c, v = np.repeat(rooms[:, 0], ln), np.repeat(rooms[:, 1], ln), np.repeat(rooms[:, 4], ln)
    k = z < H
    z, r, c, v = z[k], r[k], c[k], v[k]
    old = vol[z, r, c].copy()
    vol[z, r, c] = v
    return z, r, c, old


def unfill(vol, saved):
    if saved is not None:
        z, r, c, old = saved
        vol[z, r, c] = old


# ---------------------------------------------------------------- synthetic checks (--test)
def _test():
    import tempfile
    from pathlib import Path

    import tilefile
    import tiles
    import tiles_lod
    import window

    N = tilefile.N
    H, D, W = 60, 2 * N, 2 * N
    WALL, ROOF, GROUND, SOIL, PIER = 3, 4, 5, 6, 7

    def city():
        """two level-1 nodes' worth of ground and one building across the nodes' seam, solid"""
        vol = np.zeros((H, D, W), np.uint16)
        vol[:10] = SOIL
        vol[10] = GROUND
        vol[11:40, 100:160, 110:150] = WALL
        vol[40:42, 99:161, 109:151] = ROOF
        return vol

    hall = Room("hall", box=(103, 157, 113, 147), z0=11, z1=37,
                doors=(Door(box=(125, 129, 110, 113), z0=11, z1=15),))
    bad = []
    note = lambda *a: None

    # carving and the record
    vol = city()
    build(vol, 0, 0, note, [hall])
    n_room = 54 * 34 * 26 + 4 * 3 * 4
    if sum(len(v) for v in SPANS.values()) != n_room:
        bad.append(f"record: {sum(len(v) for v in SPANS.values())} voxels, not {n_room}")
    if vol[11:37, 103:157, 113:147].any() or vol[11:15, 125:129, 110:113].any():
        bad.append("carve: the room not empty")
    sp = runs(0, D, 0, W)
    if not (sp[:, 4] == WALL).all() or int(sp[:, 3].sum()) != n_room:
        bad.append("runs: not the wall that stood there")
    # check(): passes; a hole in the wall, a door that leads nowhere, a missing floor fail
    if check(vol, hall):
        bad.append(f"check: a sound room fails: {check(vol, hall)}")
    v2 = vol.copy(); v2[20, 130, 147:150] = 0  # (through the east wall)
    if not any("open to the outside" in b for b in check(v2, hall)):
        bad.append("check: a hole in the wall passes")
    shut = Room("shut", hall.box, hall.z0, hall.z1, (Door(box=(125, 129, 112, 113), z0=11, z1=15),))
    v5 = vol.copy(); v5[11:15, 125:129, 110:112] = WALL  # (the real door walled up but for its inner metre)
    if not any("outside" in b for b in check(v5, shut)):
        bad.append("check: a door that leads nowhere passes")
    v3 = vol.copy(); v3[:11, 130, 130] = 0
    if not any("floor" in b for b in check(v3, hall)):
        bad.append("check: a column without a floor passes")

    # the tiles: level 1 has the void and the section; levels 2, 4, 8 are the solid building's, byte for byte, and
    # tiles_lod.py's path (the volume read back from the level-1 nodes) gives the same bytes
    vol[11:30, 140, 140] = PIER  # (what stands in a room: the distance levels fill over it too)
    g = np.full((D, W), 11, np.int16)
    pl = np.zeros((D, W), np.uint16); pl[100:160, 110:150] = 1 + 8 * 64  # (a roof plane over the building)
    win = window.Window(0, D, 0, W, D, W)
    with tempfile.TemporaryDirectory() as tmp:
        a, b, c = Path(tmp) / "solid", Path(tmp) / "room", Path(tmp) / "lod"
        for d in (a, b, c):
            tiles.remove_stale(d, tiles.manifest(D, W), note, split=True)  # (the levels' folders)
        tiles.export_window(city(), g, pl, (0, D, 0, W), win, a)
        tiles.export_window(vol, g, pl, (0, D, 0, W), win, b, rooms=sp)
        if not np.array_equal(vol[11:30, 140, 140], np.full(19, PIER)) or vol[30:37, 140, 140].any():
            bad.append("export_window: the volume not as it was after the export")
        for s in (2, 4, 8):
            for f in sorted((a / str(s)).glob("*.bin")):
                if f.read_bytes() != (b / str(s) / f.name).read_bytes():
                    bad.append(f"level {s} node {f.name}: not the solid building's bytes")
        nodes = sorted((b / "1").glob("*.bin"))
        secs = {f.name: tilefile.read(f, N) for f in nodes}
        if sum("room" in s for s in secs.values()) != 4:  # (the room lies across both seams)
            bad.append(f"level 1: {sum('room' in s for s in secs.values())} nodes with a room section, not 4")
        sec_solid = tilefile.read(a / "1" / "0_0.bin", N)
        if "room" in sec_solid:
            bad.append("level 1: a room section without rooms")
        # the section: what runs() says, each node its columns (apron included)
        got = 0
        for f, s in secs.items():
            if "room" not in s:
                continue
            tx, ty = map(int, f[:-4].split("_"))
            sp4 = np.frombuffer(s["room"], np.uint16).reshape(-1, 4).astype(np.int64)
            r = sp4[:, 0] // (N + 2) + ty * N - 1
            cc = sp4[:, 0] % (N + 2) + tx * N - 1
            if not (np.diff(sp4[:, 0] * 65536 + sp4[:, 1]) > 0).all():
                bad.append(f"{f}: spans not sorted by column and z")
            for (rr_, c_, z0, ln, fl) in zip(r, cc, sp4[:, 1], sp4[:, 2], sp4[:, 3]):
                if any(SPANS[rr_, c_].get(z) != fl for z in range(z0, z0 + ln)):
                    bad.append(f"{f}: span at {rr_}, {c_} not as recorded"); break
            own = (sp4[:, 0] // (N + 2) >= 1) & (sp4[:, 0] // (N + 2) <= N) & (sp4[:, 0] % (N + 2) >= 1) & (sp4[:, 0] % (N + 2) <= N)
            got += int(sp4[own, 2].sum())
        if got != n_room:
            bad.append(f"level 1: the nodes' own spans hold {got} voxels, not {n_room}")
        # tiles_lod.py: the levels from the level-1 nodes alone
        for f in nodes:  # (and no foliage: empty 1f nodes)
            (c / "1" / f.name).write_bytes(f.read_bytes())
            tilefile.write(c / "1f" / f.name, dict(cnts=np.zeros((N + 2) ** 2, np.uint16).tobytes(),
                                                   grnd=np.zeros((N + 2) ** 2, np.uint8).tobytes(), runs=b""))
        v4, g4, p4, rooms4 = tiles_lod.region_volume(c, N, (0, D, 0, W))
        if not np.array_equal(v4[:vol.shape[0]], vol[:v4.shape[0]]) or not np.array_equal(rooms4, sp):
            bad.append("tiles_lod.region_volume: not the volume and rooms written")
        tiles.export_window(v4, g4, p4, (0, D, 0, W), win, c, levels=(2, 4, 8), rooms=rooms4)
        for s in (2, 4, 8):
            for f in sorted((a / str(s)).glob("*.bin")):
                if tilefile.read(f, N) != tilefile.read(c / str(s) / f.name, N):
                    bad.append(f"tiles_lod level {s} node {f.name}: not the solid building's")
    reset()
    for b_ in bad:
        print("  FAIL", b_)
    print(f"interiors: {'ok' if not bad else f'{len(bad)} failures'}")
    return not bad


def main():
    if "--test" in sys.argv:
        sys.exit(0 if _test() else 1)
    print(f"{len(ROOMS)} rooms declared" + "".join(f"\n  {r.name}: rows {r.box[0]}-{r.box[1]}, cols {r.box[2]}-{r.box[3]}, "
                                                  f"z {r.z0}-{r.z1}, {len(r.doors)} doors" for r in ROOMS))


if __name__ == "__main__":
    main()
